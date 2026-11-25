// Panel-owned state lives in VAR. Nothing in this module writes to HERMES_HOME.
import * as fs from 'node:fs';
import {dirname, join} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';

export const clone = value => JSON.parse(JSON.stringify(value));
export function stableJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJSON).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .filter(key => value[key] !== undefined)
    .map(key => JSON.stringify(key) + ':' + stableJSON(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(stableJSON(value)).digest('hex');
export function stateError(message, status = 400, code = 'invalid_state') {
  return Object.assign(new Error(message), {status, code});
}
export function safeId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) {
    throw stateError('无效的记录标识');
  }
  return id;
}

// Rename is the commit point. A failed pre-commit write leaves the old file intact.
// No "repair to empty" fallback: corrupt data must remain available for recovery.
export function atomicWriteJSON(file, value, io = fs) {
  return atomicWrite(file, JSON.stringify(value) + '\n', io);
}
export function atomicWrite(file, contents, io = fs) {
  const dir = dirname(file);
  io.mkdirSync(dir, {recursive: true, mode: 0o700});
  const temp = file + '.' + randomUUID() + '.tmp';
  let fd;
  try {
    fd = io.openSync(temp, 'wx', 0o600);
    // 必须显式 utf8。省略编码时 Node 用「系统代码页」写：
    // Windows 上是 CP936(GBK)，中文设备名（如「飞牛浏览器」）里的字编不出来，
    // 被替换成 '?'，引号前的半个字符直接吃掉，JSON 字符串失去闭合 ——
    // 读端固定 utf8，于是整个 auth.json 解析失败，面板一路 503
    // 「设备授权记录读取失败」，Electron 壳等 60 秒报「面板启动超时」。
    // Linux/macOS 默认就是 utf8，所以这个坑只在 Windows 现形（2026-11-25 实测）。
    io.writeFileSync(fd, contents, 'utf8');
    io.fsyncSync(fd);
    io.closeSync(fd); fd = undefined;
    io.renameSync(temp, file);
    // Persist the directory entry on Linux. macOS also supports directory fsync.
    // Windows: 目录不能用 openSync(dir,'r') 打开（EISDIR/EPERM），而且 NTFS 本身
    // 不掉目录项，跳过即可。之前这里必抛，导致 bootstrap 一直 500「设备授权记录失败」。
    if (process.platform !== 'win32') {
      fd = io.openSync(dir, 'r');
      io.fsyncSync(fd);
      io.closeSync(fd); fd = undefined;
    }
  } finally {
    if (fd !== undefined) io.closeSync(fd);
    if (io.existsSync(temp)) io.unlinkSync(temp);
  }
}

export class StateFile {
  constructor(file, initial, {io = fs, validate = () => true} = {}) {
    this.file = file;
    this.io = io;
    this.initial = initial;
    this.validate = validate;
  }
  read() {
    if (!this.io.existsSync(this.file)) return clone(this.initial());
    let value;
    try { value = JSON.parse(this.io.readFileSync(this.file, 'utf8')); }
    catch (e) { throw stateError('状态文件无法读取，原文件已保留：' + e.message, 503, 'state_unreadable'); }
    if (!this.validate(value)) throw stateError('状态文件结构不完整，原文件已保留', 503, 'state_invalid');
    return value;
  }
  write(value) {
    if (!this.validate(value)) throw stateError('拒绝保存不完整的状态', 500, 'state_invalid');
    atomicWriteJSON(this.file, value, this.io);
    return clone(value);
  }
  update(fn) {
    const next = this.read();
    const result = fn(next);
    if (result && typeof result.then === 'function') throw Error('StateFile.update must be synchronous');
    this.write(next);
    return result;
  }
}

export class SessionDrafts {
  constructor(root, options = {}) { this.root = root; this.options = options; }
  file(id) {
    return new StateFile(join(this.root, 'drafts', safeId(id) + '.json'),
      () => ({revision: 0, text: '', attachments: [], options: {}, conflicts: []}),
      {...this.options, validate: d => Number.isInteger(d.revision) && typeof d.text === 'string' && Array.isArray(d.conflicts)});
  }
  get(id) { return this.file(id).read(); }
  put(id, body) {
    if (!Number.isInteger(body.revision) || body.revision < 0) throw stateError('缺少草稿版本，请重新读取草稿');
    if (typeof body.text !== 'string') throw stateError('草稿内容必须是文本');
    if (this.options.maxTextBytes ? Buffer.byteLength(body.text) > this.options.maxTextBytes : body.text.length > 200000) throw stateError(this.options.maxTextBytes ? '资料草稿超过8MB' : '草稿超过 200000 字');
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    if (attachments.length > 30 || JSON.stringify(attachments).length > 64000) throw stateError('草稿附件过多');
    const options = body.options && typeof body.options === 'object' && !Array.isArray(body.options) ? body.options : {};
    if (JSON.stringify(options).length > (this.options.maxOptionsLength || 64000)) throw stateError('会话选项过大');
    const incoming = {text: body.text, attachments: clone(attachments), options: clone(options)};
    const store = this.file(id), current = store.read();
    const same = digest(incoming) === digest({text: current.text, attachments: current.attachments, options: current.options});
    if (same && !body.resolve_key) return {ok: true, draft: current};
    if (body.revision !== current.revision) {
      // 空草稿或与服务器完全一致的内容不构成冲突：另一台设备只是打开过会话、
      // 发过一条空内容，revision 就变了，旧版本号回写会把空内容摆成"其他设备也改了草稿"。
      /* 2026-11-19（用户实测「草稿里那个『继续』删了又回来，怎么改都在」）：
         以前这里对空内容一律「静默返回旧稿、不落盘」。可版本号落后是常态
         （多标签页、发送后清空、切会话都会推版本），于是「删空输入框」这个动作
         永远推不上去 —— 服务端还留着上一份非空稿，下次打开又被回填。
         空内容是合法意图（我要清空），但对方那份非空时不能盲清（可能是别的设备
         正在写的字）：服务端也空就静默对齐，非空就回冲突，让前端认领版本号后重推一次。 */
      const incomingEmpty = !incoming.text.trim() && !incoming.attachments.length;
      if (incomingEmpty) {
        const currentEmpty = !current.text.trim() && !current.attachments.length;
        if (currentEmpty) return { ok: true, draft: current };
        return { ok: false, conflict: true, draft: current };
      }
      // Store the second version rather than silently overwriting another device.
      const key = digest(incoming);
      if (!current.conflicts.some(c => c.key === key)) {
        current.conflicts.push({...incoming, key, saved_at: Date.now(), client_id: String(body.client_id || '').slice(0,80)});
        store.write(current);
      }
      return {ok: false, conflict: true, draft: current};
    }
    const next = {...current, ...incoming, revision: current.revision + 1, updated_at: Date.now()};
    // Resolving a conflict consumes only the explicitly chosen copy.
    if (body.resolve_key) next.conflicts = next.conflicts.filter(c => c.key !== body.resolve_key);
    store.write(next);
    return {ok: true, draft: next};
  }
}
