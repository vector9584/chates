/* 档案 · 密码本后端（2026-11-14）
 *
 * 设计原则（三条，改动前先读）：
 * 1. 真源只有 data/.env —— 不另存一份密文副本，避免「面板改了、Hermes 读的还是旧的」。
 *    查看就是读 .env，编辑就是改 .env 的那一行，走 envReaderWriter 的事务写（快照 + 原子替换 + 差异校验）。
 * 2. 两级口令，明文一次只下发一个键。
 *    一级口令只解锁「列表」（键名、分类、掩码、体积）；二级口令才能看/改某个键的明文。
 *    所以 GET 永远不下发明文，明文只从 /reveal 单键取，且返回一张 5 分钟、绑死该键的写入授权。
 *    两级口令都用 scrypt 存哈希（data/.vault-auth.json，0600），票据只在服务端内存，重启即失效。
 *    —— 不学案例把散列放 localStorage 的做法，那等于把锁挂在门外面。
 * 3. 每次写入记一条审计（键名 + 动作 + 时间，不含值），落 data/.vault-audit.jsonl。
 * 4. 删除（2026-11-19 加）＝ 从 .env 抹掉那一行，同样走事务写；被删的原行先落
 *    data/.vault-trash.jsonl（0600，保留最近 200 条），删错了能捞回来。删除要二级授权。
 */
import * as fs from 'node:fs';
// 写字符串一律 utf8（Windows 省略 encoding 会按 GBK 写）。见 panel-fs-utf8.js。
import {writeFileSync as _writeUtf8, appendFileSync as _appendUtf8} from './panel-fs-utf8.js';
import {join} from 'node:path';
import {randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';
import {stateError} from './panel-state.js';
import {envReaderWriter} from './panel-env-txn.js';

const TICKET_TTL = 10 * 60 * 1000;
/* 二级授权只覆盖「刚看过的那一个键」，5 分钟。写操作必须拿它，光有一级票据不够。 */
const GRANT_TTL = 5 * 60 * 1000;
const MAX_VALUE = 8192;

/* 分类只影响界面分组，不影响读写。按前缀从长到短匹配，先命中先得。 */
const CATEGORIES = [
  ['代码仓库', ['GITHUB_', 'GITEA_', 'GIT_', 'GH_']],
  ['通道通知', ['QQ_', 'FEISHU_', 'DISCORD_', 'TELEGRAM_', 'WEIXIN_', 'WECHAT_', 'SMS_', 'NOTIFY_', 'BARK_', 'MAIL_']],
  ['学校学务', ['CUGB_', 'CAS_', 'SCHOOL_', 'CARSI_']],
  ['主机设备', ['NAS_', 'ECS_', 'SSH_', 'ROUTER_', 'QB_', 'BDPAN_', 'XUNLEI_', 'TRIM_']],
  ['站点账号', ['JABLE_', 'JAVLIBRARY_', 'MISSAV_', 'PICK_', 'MADOU_', 'XCHINA_', 'ANIME', 'SUWAYOMI', 'YHDM_']],
  ['外部服务', ['ZOTERO_', 'BAIKAL_', 'NOWEN_', 'MEITUAN_', 'BAIDU_', 'GAODE_', 'AMAP_', 'FLIGGY_']],
  ['模型接口', ['CUSTOM_', 'OPENAI_', 'ANTHROPIC_', 'DEEPSEEK_', 'MOONSHOT_', 'QWEN_', 'DASHSCOPE_', 'HF_']],
];
const SENSITIVE = /(TOKEN|KEY|SECRET|PASS|PWD|PAT|COOKIE|CRED|AUTH|TICKET)/i;

function categoryOf(key) {
  const upper = key.toUpperCase();
  for (const [name, prefixes] of CATEGORIES) {
    if (prefixes.some(p => upper.startsWith(p))) return name;
  }
  if (/(_API_KEY|_TOKEN|_SECRET)$/.test(upper)) return '模型接口';
  return '其他';
}

/* 掩码：短值不留头尾，长值留首尾各 2 位，够人认出来是哪一个即可。 */
function maskOf(value) {
  const text = String(value == null ? '' : value);
  if (!text) return '（空）';
  if (text.length <= 6) return '•'.repeat(Math.min(text.length, 6));
  return text.slice(0, 2) + '•'.repeat(Math.min(8, text.length - 4)) + text.slice(-2);
}

function unquote(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
  }
  return value.replace(/\s+#.*$/, '').trim();
}

/* 写回时保守处理：含空白、引号或 # 就加双引号，其余保持裸值，避免把简单键写成带引号的样子。 */
function quoteFor(value) {
  if (/[\s"'#\\]/.test(value) || value === '') return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
  return value;
}

function parseEnv(text) {
  const lines = String(text || '').split('\n');
  const entries = [];
  lines.forEach((line, index) => {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) return;
    entries.push({ key: m[1], raw: m[2], value: unquote(m[2]), line: index });
  });
  return { lines, entries };
}

/* 只改目标行，其余字节原样保留（含注释、空行、顺序）。键不存在则追加。 */
function replaceEnvValue(text, key, value) {
  const { lines, entries } = parseEnv(text);
  const found = entries.find(e => e.key === key);
  const rendered = key + '=' + quoteFor(value);
  if (found) lines[found.line] = rendered;
  else {
    if (lines.length && lines[lines.length - 1] === '') lines.splice(lines.length - 1, 0, rendered);
    else lines.push(rendered);
  }
  return lines.join('\n');
}

/* 删键：只删目标行，其余字节原样保留（含注释、空行、顺序）。 */
function removeEnvKey(text, key) {
  const { lines, entries } = parseEnv(text);
  const found = entries.find(e => e.key === key);
  if (!found) return { text, removed: null };
  const after = lines.filter((_, index) => index !== found.line).join('\n');
  return { text: after, removed: lines[found.line], value: found.value };
}

function audit(file, row) {
  try {
    _appendUtf8(file, JSON.stringify(row) + '\n', { mode: 0o600 });
  } catch (_) { /* 审计失败不阻断写操作，但要能看出来 */ }
}

export function createArchiveVault({ dataDir, checkToken, python, serverRoot, state }) {
  const envFile = join(dataDir, '.env');
  const authFile = join(dataDir, '.vault-auth.json');
  const auditFile = join(dataDir, '.vault-audit.jsonl');
  const trashFile = join(dataDir, '.vault-trash.jsonl');
  /* 人工改过的分类：{ "KEY": "分类名" }。没记录的键照 categoryOf() 猜，
     所以这个文件只装「跟自动判定不一致」的那些，删了也不丢数据。 */
  const catsFile = join(dataDir, '.vault-cats.json');
  const tickets = new Map();   // 一级解锁票：token -> 到期时间
  const grants = new Map();    // 二级单键授权：token -> {exp, key}
  const failures = [];         // 最近一分钟的失败时间戳，用于限速
  const rw = envReaderWriter({ python, serverRoot, state, getFile: () => envFile });

  const hashOf = (password, salt) => scryptSync(String(password), Buffer.from(salt, 'hex'), 64).toString('hex');
  const same = (a, b) => {
    const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b), 'hex');
    return x.length === y.length && timingSafeEqual(x, y);
  };
  const makeCred = password => {
    const salt = randomBytes(16).toString('hex');
    return { salt, hash: hashOf(password, salt) };
  };
  const verify = (cred, password) => {
    if (!cred || !cred.salt || !cred.hash) return false;
    try { return same(hashOf(String(password == null ? '' : password), cred.salt), cred.hash); } catch (_) { return false; }
  };

  /* 口令文件：v2 才是真两级；v1（单口令）读出来当「两级同一个口令」，不打断老安装。
     注意这里只在内存里补 shape，不回写——回写会让「重设口令」多一条不可预期路径。 */
  function readAuth() {
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(authFile, 'utf8')); } catch (_) { return null; }
    if (!raw) return null;
    if (raw.level1 && raw.level2) return { version: 2, level1: raw.level1, level2: raw.level2, created_at: raw.created_at };
    if (raw.salt && raw.hash) {
      const cred = { salt: raw.salt, hash: raw.hash };
      return { version: 1, level1: cred, level2: cred, created_at: raw.created_at };
    }
    return null;
  }
  const writeAuth = data => {
    const temp = authFile + '.tmp';
    _writeUtf8(temp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(temp, authFile);
  };

  /* 失败限速：一分钟 10 次就拒。挡的不是人，是拿字典跑接口的脚本。 */
  function guardAttempts() {
    const now = Date.now();
    while (failures.length && now - failures[0] > 60000) failures.shift();
    if (failures.length >= 10) throw stateError('尝试过于频繁，请一分钟后再试', 429);
  }
  const noteFailure = () => { failures.push(Date.now()); };

  const activeTicket = req => {
    const token = req.headers.get('x-vault-ticket') || '';
    const expires = tickets.get(token);
    if (!expires || expires < Date.now()) { if (token) tickets.delete(token); return ''; }
    return token;
  };
  const requireTicket = req => {
    if (!activeTicket(req)) throw stateError('密码本已锁定，请先输入一级口令', 401);
  };
  /* 二级授权只对被 reveal 过的那一个键有效，且 5 分钟过期：写操作不能靠一级票据蒙过去。 */
  const grantFor = (req, key) => {
    const token = req.headers.get('x-vault-grant') || '';
    const row = grants.get(token);
    if (!row || row.exp < Date.now() || row.key !== key) { if (token) grants.delete(token); return false; }
    return true;
  };

  const CAT_MAX = 12;

  function readCats() {
    try {
      const raw = JSON.parse(fs.readFileSync(catsFile, 'utf8'));
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (_) { return {}; }
  }
  function writeCats(map) {
    const temp = catsFile + '.tmp';
    _writeUtf8(temp, JSON.stringify(map, null, 0), { mode: 0o600 });
    fs.renameSync(temp, catsFile);
  }
  /* 分类名：允许中文/字母/数字/短横，去掉控制字符，最长 12 个字。
     空串＝清掉人工分类，回到 categoryOf() 的自动判定。 */
  function normalizeCat(value) {
    const text = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!text) return '';
    if ([...text].length > CAT_MAX) throw stateError(`分类名最长 ${CAT_MAX} 个字`, 400);
    if (!/^[\u4e00-\u9fa5A-Za-z0-9 ·_/-]+$/.test(text)) throw stateError('分类名只能用中英文、数字和 - _ / 空格', 400);
    return text;
  }
  /* 设/清一个键的人工分类，返回最终生效的分类。 */
  function setCat(key, value) {
    const cats = readCats();
    const next = normalizeCat(value);
    if (next) cats[key] = next; else delete cats[key];
    writeCats(cats);
    return next || categoryOf(key);
  }

  function envItems() {
    let text = '';
    try { text = fs.readFileSync(envFile, 'utf8'); } catch (_) { text = ''; }
    const cats = readCats();
    const { entries } = parseEnv(text);
    const items = entries.map(entry => ({
      key: entry.key,
      category: cats[entry.key] || categoryOf(entry.key),
      autoCategory: categoryOf(entry.key),
      manualCat: Boolean(cats[entry.key]),
      sensitive: SENSITIVE.test(entry.key),
      masked: maskOf(entry.value),
      bytes: Buffer.byteLength(entry.value),
    }));
    const groups = {};
    items.forEach(item => { groups[item.category] = (groups[item.category] || 0) + 1; });
    /* 分类下拉的候选：内置判定表 + 其他 + 已手改过的分类，前端不用自己维护清单 */
    const catOptions = [...new Set([...CATEGORIES.map(c => c[0]), '其他', ...Object.values(cats)])];
    return { items, groups, catOptions, count: items.length, bytes: Buffer.byteLength(text), raw: entries };
  }

  function readAudit(limit = 60) {
    try {
      return fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).reverse()
        .map(line => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean);
    } catch (_) { return []; }
  }

  /* 从 .env 现状里取某个键的值；键不存在返回 null（用于区分「空值」和「没这个键」）。 */
  function valueOf(entries, key) {
    const hit = entries.find(e => e.key === key);
    return hit ? hit.value : null;
  }

  return async function handle(req, path) {
    if (!path.startsWith('/api/archive/vault')) return null;
    const reply = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
    if (!checkToken(req)) return reply({ error: '请重新登录后查看' }, 401);
    try {
      const auth = readAuth();
      if (path === '/api/archive/vault' && req.method === 'GET') {
        const unlocked = !!activeTicket(req);
        const data = envItems();
        /* setup = 「还没有口令文件」（= !auth），名字容易看反，2026-11-14 前端就栽在这上面：
           把 !data.setup 当成「未设置」，结果永远只给「输入口令」。同时给一个正向别名 needsSetup。
           未解锁只给数量与分组（左侧入口要显示条数），绝不给键名清单，更不给值。 */
        const base = {
          ok: true, setup: !auth, needsSetup: !auth, hasPassword: !!auth, locked: !unlocked,
          twoLevel: !!auth && auth.version === 2, split: !!(auth && auth.version === 2 && auth.level1.hash !== auth.level2.hash),
          count: data.count, bytes: data.bytes, groups: data.groups, items: [],
          catOptions: data.catOptions,
        };
        if (!unlocked) return reply(base);
        return reply({ ...base, items: data.items });
      }
      if (path === '/api/archive/vault/setup' && req.method === 'POST') {
        if (auth) throw stateError('口令已设置，如需重设请先删除 data/.vault-auth.json', 409);
        const body = await req.json();
        const level1 = String(body.level1 == null ? (body.password || '') : body.level1);
        const level2 = String(body.level2 == null ? '' : body.level2) || level1;
        if (level1.length < 6) throw stateError('一级口令至少 6 位', 400);
        if (level2.length < 6) throw stateError('二级口令至少 6 位', 400);
        writeAuth({ version: 2, created_at: Date.now(), level1: makeCred(level1), level2: makeCred(level2) });
        const ticket = randomBytes(24).toString('hex');
        tickets.set(ticket, Date.now() + TICKET_TTL);
        audit(auditFile, { at: Date.now(), action: level1 === level2 ? 'setup-same' : 'setup', key: '-' });
        return reply({ ok: true, ticket, expires: TICKET_TTL });
      }
      if (path === '/api/archive/vault/unlock' && req.method === 'POST') {
        if (!auth) throw stateError('尚未设置一级口令', 409);
        guardAttempts();
        const body = await req.json();
        if (!verify(auth.level1, body.password)) {
          noteFailure();
          audit(auditFile, { at: Date.now(), action: 'unlock-failed', key: '-' });
          throw stateError('一级口令不正确', 401);
        }
        const ticket = randomBytes(24).toString('hex');
        tickets.set(ticket, Date.now() + TICKET_TTL);
        audit(auditFile, { at: Date.now(), action: 'unlock', key: '-' });
        return reply({ ok: true, ticket, expires: TICKET_TTL });
      }
      if (path === '/api/archive/vault/lock' && req.method === 'POST') {
        const token = req.headers.get('x-vault-ticket') || '';
        if (token) tickets.delete(token);
        grants.clear();
        return reply({ ok: true });
      }
      /* 二级校验：验口令 + 只返回这一个键的明文 + 发一张绑死该键的写入授权。 */
      if (path === '/api/archive/vault/reveal' && req.method === 'POST') {
        if (!auth) throw stateError('尚未设置口令', 409);
        requireTicket(req);
        guardAttempts();
        const body = await req.json();
        const key = String(body.key || '');
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,120}$/.test(key)) throw stateError('键名不合法', 400);
        if (!verify(auth.level2, body.password)) {
          noteFailure();
          audit(auditFile, { at: Date.now(), action: 'reveal-failed', key });
          throw stateError('二级口令不正确', 401);
        }
        const data = envItems();
        const value = valueOf(data.raw, key);
        if (value === null) throw stateError('键不存在', 404);
        const grant = randomBytes(24).toString('hex');
        grants.set(grant, { exp: Date.now() + GRANT_TTL, key });
        audit(auditFile, { at: Date.now(), action: 'reveal', key });
        return reply({ ok: true, key, value, masked: maskOf(value), grant, expires: GRANT_TTL });
      }
      /* 改分类：只是给键贴个标签，不涉及值，所以只要一级票据（二级留给看/改明文）。
         category 传空串＝回到自动判定。 */
      if (path === '/api/archive/vault/category' && req.method === 'POST') {
        requireTicket(req);
        const body = await req.json();
        const key = String(body.key || '');
        const { entries } = parseEnv(rw.read());
        if (!entries.some(e => e.key === key)) throw stateError('没有这个键', 404);
        const finalCat = setCat(key, body.category);
        audit(auditFile, { at: Date.now(), action: 'category', key, category: finalCat });
        const items = envItems();
        return reply({ ok: true, key, category: finalCat, autoCategory: categoryOf(key),
          groups: items.groups, catOptions: items.catOptions });
      }
      if (path === '/api/archive/vault' && req.method === 'PUT') {
        requireTicket(req);
        const body = await req.json();
        const key = String(body.key || '');
        const value = String(body.value == null ? '' : body.value);
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,120}$/.test(key)) throw stateError('键名不合法', 400);
        if (value.length > MAX_VALUE) throw stateError('值过长（上限 8KB）', 413);
        if (/[\r\n]/.test(value)) throw stateError('值里不能有换行', 400);
        /* 两条合法路径：改已有的键＝先用 /reveal 换到授权；新增键不可能有授权
           （reveal 要求键已存在），所以允许当场用二级口令写。 */
        if (!grantFor(req, key)) {
          const typed = String(body.password || '');
          guardAttempts();
          if (!typed || !verify(auth.level2, typed)) {
            if (typed) { noteFailure(); audit(auditFile, { at: Date.now(), action: 'write-failed', key }); }
            throw stateError('需要二级口令：请再输入一次二级口令后保存', 403);
          }
        }
        const before = rw.read();
        const { entries } = parseEnv(before);
        const current = entries.find(e => e.key === key);
        /* category 可选：新增条目时一起带上，省一次往返。只改分类、值没动时不写 .env。 */
        const wantsCat = body.category !== undefined;
        if (current && current.value === value && !wantsCat) return reply({ ok: true, unchanged: true, key, masked: maskOf(value) });
        if (!current && body.create !== true) throw stateError('键不存在；新增请显式确认', 404);
        if (!current || current.value !== value) rw.write(replaceEnvValue(before, key, value));
        const finalCat = wantsCat ? setCat(key, body.category) : (readCats()[key] || categoryOf(key));
        audit(auditFile, { at: Date.now(), action: current ? 'edit' : 'create', key, ...(wantsCat ? { category: finalCat } : {}) });
        return reply({ ok: true, key, masked: maskOf(value), created: !current, category: finalCat });
      }
      /* 删除：从 .env 抹掉那一行。授权同 PUT（二级授权，或当场输二级口令）。
         原行先落 .vault-trash.jsonl（0600，留最近 200 条），删错能捞回来。 */
      if (path === '/api/archive/vault' && req.method === 'DELETE') {
        requireTicket(req);
        const body = await req.json();
        const key = String(body.key || '');
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,120}$/.test(key)) throw stateError('键名不合法', 400);
        if (!grantFor(req, key)) {
          const typed = String(body.password || '');
          guardAttempts();
          if (!typed || !verify(auth.level2, typed)) {
            if (typed) { noteFailure(); audit(auditFile, { at: Date.now(), action: 'delete-failed', key }); }
            throw stateError('需要二级口令：请输入二级口令后再删除', 403);
          }
        }
        const before = rw.read();
        const cut = removeEnvKey(before, key);
        if (!cut.removed) throw stateError('键不存在', 404);
        try {
          const old = fs.existsSync(trashFile)
            ? fs.readFileSync(trashFile, 'utf8').trim().split('\n').filter(Boolean) : [];
          const keep = old.concat([JSON.stringify({ at: Date.now(), key, raw: cut.removed, value: cut.value })]).slice(-200);
          _writeUtf8(trashFile, keep.join('\n') + '\n', { mode: 0o600 });
        } catch (_) { /* 回收失败不阻断删除；审计里仍有这一条 */ }
        rw.write(cut.text);
        /* 键没了，人工分类也跟着删；留着会在同名键重建时冒出旧标签 */
        const leftCats = readCats();
        if (leftCats[key]) { delete leftCats[key]; writeCats(leftCats); }
        audit(auditFile, { at: Date.now(), action: 'delete', key });
        return reply({ ok: true, key, deleted: true, count: envItems().count });
      }
      if (path === '/api/archive/vault/audit' && req.method === 'GET') {
        requireTicket(req);
        return reply({ ok: true, items: readAudit(60) });
      }
      throw stateError('密码本操作不存在', 404);
    } catch (error) {
      return reply({ ok: false, error: error.message }, error.status || 500);
    }
  };
}
