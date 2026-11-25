// panel-push.js —— 面板 Web Push（VAPID，空载荷）+ 未读角标计数
//
// 设计要点：
// 1. 未读的定义（2026-11-20 用户定）：助手「完成一条回复」算 1 条新回复。
//    完成 = 会话 JSON 里最后一条 assistant 消息存在、非空、且没有 _streaming 标记。
// 2. 触发靠 fs.watch 监听 chat/sessions，不轮询、不改 Python 侧。
// 3. 推送用空载荷（zero-length body）：iOS 只要求 SW 里弹一条可见通知，
//    不需要 aes128gcm 加密，省掉一整套 payload 加密实现。
// 4. 角标数字由 SW 收到 push 后回查 /api/push/unread 得到，再 setAppBadge。
import { existsSync, mkdirSync, readFileSync, readdirSync, chmodSync, watch } from "node:fs";
// 写字符串一律 utf8：Windows 省略 encoding 会按 GBK 写。
import {writeFileSync} from "./panel-fs-utf8.js";
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { request as httpsRequest } from "node:https";

const b64u = (buf) => Buffer.from(buf).toString("base64url");

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch (e) { return fallback; }
}
function writeJson(file, value) {
  try { writeFileSync(file, JSON.stringify(value, null, 2)); } catch (e) { /* 忽略：下次再写 */ }
}

export function createPushHub({ stateDir, sessionsDir, log = () => {} }) {
  const dir = `${stateDir}/push`;
  const keyFile = `${dir}/vapid.json`;
  const subFile = `${dir}/subs.json`;
  const unreadFile = `${dir}/unread.json`;
  const seenFile = `${dir}/seen.json`;
  const watchers = [];
  const timers = new Map();
  let seen = readJson(seenFile, {});
  // 未读按会话记：{ sessions: { <sid>: <条数> }, updated_at }
  // 只有「滚到会话底部」才算清掉一个会话（2026-11-20 用户定），跨端共享同一份计数。
  let unread = readJson(unreadFile, { sessions: {}, updated_at: 0 });
  if (!unread || typeof unread.sessions !== "object" || unread.sessions === null) unread = { sessions: {}, updated_at: 0 };

  function ensureDir() { try { mkdirSync(dir, { recursive: true }); } catch (e) {} }

  function keys() {
    ensureDir();
    let saved = readJson(keyFile, null);
    if (!saved || !saved.private_pem || !saved.public_key) {
      const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const der = publicKey.export({ type: "spki", format: "der" });
      saved = {
        private_pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        public_key: b64u(der.subarray(-65)),   // 未压缩 P-256 点，65 字节
        created_at: Date.now(),
      };
      writeJson(keyFile, saved);
      try { chmodSync(keyFile, 0o600); } catch (e) {}
      log("已生成 VAPID 密钥对");
    }
    return saved;
  }

  function subs() { const v = readJson(subFile, []); return Array.isArray(v) ? v : []; }
  function saveSubs(list) { ensureDir(); writeJson(subFile, list.slice(-20)); }

  function unreadMap() {
    const out = {};
    for (const [sid, n] of Object.entries(unread.sessions || {})) {
      const v = Number(n) || 0;
      if (v > 0) out[sid] = v;
    }
    return out;
  }
  function unreadCount() {
    return Object.values(unreadMap()).reduce((a, b) => a + b, 0);
  }
  function saveUnreadMap(map) {
    unread = { sessions: map, updated_at: Date.now() };
    writeJson(unreadFile, unread);
    return unreadCount();
  }
  function clearSession(sid) {
    const map = unreadMap();
    if (sid) delete map[sid]; else return saveUnreadMap({});
    return saveUnreadMap(map);
  }

  // ---- VAPID JWT（ES256）----
  function vapidHeaders(endpoint) {
    const k = keys();
    const header = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
    const payload = b64u(JSON.stringify({
      aud: new URL(endpoint).origin,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      sub: "mailto:hermes@ruibing.wang",
    }));
    const data = `${header}.${payload}`;
    const privateKey = createPrivateKey(k.private_pem);
    const sig = sign("sha256", Buffer.from(data), { key: privateKey, dsaEncoding: "ieee-p1363" });
    return {
      Authorization: `vapid t=${data}.${b64u(sig)},k=${k.public_key}`,
      TTL: "600",
      Urgency: "normal",
      "Content-Length": "0",
    };
  }

  // 空载荷推送：不加密、不写 Content-Encoding
  function sendOne(sub) {
    return new Promise((resolve) => {
      let headers;
      try { headers = vapidHeaders(sub.endpoint); }
      catch (e) { return resolve({ ok: false, status: 0, error: `jwt:${e.message}` }); }
      const req = httpsRequest(sub.endpoint, { method: "POST", headers }, (res) => {
        res.resume();
        res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
      });
      req.on("error", (e) => resolve({ ok: false, status: 0, error: e.message }));
      req.setTimeout(10000, () => { req.destroy(new Error("timeout")); });
      req.end();
    });
  }

  async function pushAll() {
    const list = subs();
    if (!list.length) return { sent: 0, results: [] };
    const results = await Promise.all(list.map(async (sub) => ({ endpoint: sub.endpoint, ...(await sendOne(sub)) })));
    const dead = results.filter((r) => r.status === 404 || r.status === 410).map((r) => r.endpoint);
    if (dead.length) saveSubs(list.filter((s) => !dead.includes(s.endpoint)));
    const sent = results.filter((r) => r.ok).length;
    if (sent) log(`推送成功 ${sent}/${list.length}`);
    else log(`推送全部失败：${JSON.stringify(results.map((r) => r.status || r.error)).slice(0, 200)}`);
    return { sent, results };
  }

  async function bumpUnread(sid, n = 1) {
    const map = unreadMap();
    if (sid) map[sid] = (map[sid] || 0) + n;
    const count = saveUnreadMap(map);
    pushAll().catch(() => {});
    return count;
  }

  // ---- 会话文件变化 → 判定「完成一条回复」----
  function lastFinishedTs(data) {
    const msgs = Array.isArray(data?.messages) ? data.messages : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.role !== "assistant") continue;
      if (m._streaming) return 0;
      if (!String(m.content || "").trim()) return 0;
      return Number(m.ts) || 0;
    }
    return 0;
  }

  function scanOne(sid, { silent = false } = {}) {
    const file = `${sessionsDir}/${sid}.json`;
    if (!existsSync(file)) return;
    let data;
    try { data = JSON.parse(readFileSync(file, "utf8")); } catch (e) { return; } // 写入中，等下一次事件
    const ts = lastFinishedTs(data);
    if (!ts) return;
    if ((seen[sid] || 0) >= ts) return;
    seen[sid] = ts;
    writeJson(seenFile, seen);
    if (silent) return;
    bumpUnread(sid, 1);
  }

  function scanAll({ silent = false } = {}) {
    let names = [];
    try { names = readdirSync(sessionsDir).filter((n) => n.endsWith(".json")); } catch (e) { return; }
    for (const name of names) scanOne(name.replace(/\.json$/, ""), { silent });
  }

  function start() {
    ensureDir();
    keys();
    scanAll({ silent: true });   // 启动基线：把当前已有的最后一条回复记为已见，避免重启即推送
    try {
      const w = watch(sessionsDir, (_evt, name) => {
        if (!name || !String(name).endsWith(".json")) return;
        const sid = String(name).replace(/\.json$/, "");
        clearTimeout(timers.get(sid));
        timers.set(sid, setTimeout(() => { timers.delete(sid); scanOne(sid); }, 2500));
      });
      w.on("error", (e) => log(`sessions 监听失败：${e.message}`));
      watchers.push(w);
      log(`开始监听 ${sessionsDir}`);
    } catch (e) { log(`无法监听 sessions：${e.message}`); }
  }

  function stop() {
    for (const w of watchers) { try { w.close(); } catch (e) {} }
    watchers.length = 0;
  }

  // ---- HTTP 路由：/api/push/* ----
  async function handle(req, checkToken, path) {
    if (!path.startsWith("/api/push/")) return null;
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
    if (!checkToken(req)) return json({ ok: false, error: "unauthorized" }, 401);
    const sub = path.slice("/api/push/".length);

    if (sub === "key" && req.method === "GET") {
      return json({ ok: true, key: keys().public_key });
    }
    if (sub === "subscribe" && req.method === "POST") {
      let body;
      try { body = await req.json(); } catch (e) { return json({ ok: false, error: "bad json" }, 400); }
      const ep = String(body?.endpoint || "");
      if (!/^https:\/\//.test(ep)) return json({ ok: false, error: "endpoint must be https" }, 400);
      const list = subs().filter((s) => s.endpoint !== ep);
      list.push({
        endpoint: ep,
        keys: { p256dh: String(body?.keys?.p256dh || ""), auth: String(body?.keys?.auth || "") },
        ua: String(req.headers.get("user-agent") || "").slice(0, 200),
        created_at: Date.now(),
      });
      saveSubs(list);
      return json({ ok: true, count: list.length });
    }
    if (sub === "unsubscribe" && req.method === "POST") {
      let body = {};
      try { body = await req.json(); } catch (e) {}
      const ep = String(body?.endpoint || "");
      const list = subs().filter((s) => s.endpoint !== ep);
      saveSubs(list);
      return json({ ok: true, count: list.length });
    }
    if (sub === "unread" && req.method === "GET") {
      return json({ ok: true, count: unreadCount(), sessions: unreadMap() });
    }
    if (sub === "read" && req.method === "POST") {
      let body = {};
      try { body = await req.json(); } catch (e) {}
      const sid = String(body?.session_id || "");
      return json({ ok: true, count: clearSession(sid), sessions: unreadMap(), cleared: sid || "*" });
    }
    if (sub === "bump" && req.method === "POST") {   // 自测用：手动 +1
      let body = {};
      try { body = await req.json(); } catch (e) {}
      return json({ ok: true, count: await bumpUnread(String(body?.session_id || "selftest"), 1) });
    }
    if (sub === "test" && req.method === "POST") {
      return json({ ok: true, ...(await pushAll()) });
    }
    return json({ ok: false, error: "not found" }, 404);
  }

  return { handle, start, stop, keys, subs, unreadCount, pushAll, bumpUnread, scanAll, vapidHeaderFor: vapidHeaders };
}
