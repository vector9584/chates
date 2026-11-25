// panel-push.js —— 面板 Web Push 客户端：注册 SW、授权、订阅、角标同步
// 只在「已安装到主屏幕」的独立窗口里提示开通知（iOS 16.4+ 的硬要求）。
(function () {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;

  const base = document.baseURI;
  const api = (p) => new URL("api/push/" + p, base).href;
  const standalone = window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);

  async function setBadge(count) {
    try {
      if (count > 0 && navigator.setAppBadge) await navigator.setAppBadge(count);
      else if (navigator.clearAppBadge) await navigator.clearAppBadge();
    } catch (e) { /* 不支持角标就算了，别报错打断面板 */ }
  }

  async function registration() {
    try {
      const reg = await navigator.serviceWorker.register(new URL("sw.js", base).href, { scope: "./" });
      // 浏览器自己的 SW 更新检查最长隔 24h，改完通知格式当天看不到效果；boot 时主动查一次。
      reg.update().catch(() => {});
      return reg;
    } catch (e) { return null; }
  }

  function keyToBytes(b64url) {
    const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
    const raw = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function subscribe(reg) {
    const keyRes = await fetch(api("key"), { credentials: "include" });
    const { key } = await keyRes.json();
    const existing = await reg.pushManager.getSubscription();
    const sub = existing || await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyToBytes(key),
    });
    await fetch(api("subscribe"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub.toJSON()),
    });
    return sub;
  }

  function chip(text, onClick) {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = text;
    el.style.cssText = "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:99999;" +
      "padding:10px 18px;border-radius:999px;border:none;background:#2b6cf6;color:#fff;" +
      "font-size:15px;box-shadow:0 6px 20px rgba(0,0,0,.35)";
    el.onclick = onClick;
    document.body.appendChild(el);
    return el;
  }

  async function askPermission(reg) {
    const perm = await Notification.requestPermission();   // 必须在点击回调里第一行
    if (perm !== "granted") return;
    try { await subscribe(reg); } catch (e) { console.warn("订阅失败", e); }
  }

  // 只清「当前会话」这一个：调用方保证已经滚到该会话底部。
  async function readSession(sid) {
    if (!sid) return;
    try {
      const res = await fetch(api("read"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sid }),
      });
      const data = await res.json();
      await setBadge(Number(data?.count) || 0);
      const reg = await navigator.serviceWorker.ready;
      reg.active?.postMessage({ type: "badge", count: Number(data?.count) || 0 });
      window.dispatchEvent(new CustomEvent("hermes:unread", { detail: data?.sessions || {} }));
    } catch (e) {}
  }
  window.__pwReadSession = readSession;

  // 长按「只看未读」按钮：清空所有会话的未读（2026-11-21 用户需求）。
  // 后端 POST /api/push/read 空 body → session_id 为空 → 清空整份未读账（clearSession("")）。
  async function clearAllUnread() {
    try {
      const res = await fetch(api("read"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      await setBadge(Number(data?.count) || 0);
      const reg = await navigator.serviceWorker.ready;
      reg.active?.postMessage({ type: "badge", count: Number(data?.count) || 0 });
      window.dispatchEvent(new CustomEvent("hermes:unread", { detail: data?.sessions || {} }));
      return data || {};
    } catch (e) { return { ok: false, error: String(e) }; }
  }
  window.__pwClearAllUnread = clearAllUnread;

  async function syncBadge() {
    try {
      const res = await fetch(api("unread"), { credentials: "include" });
      const data = await res.json();
      await setBadge(Number(data?.count) || 0);
      window.dispatchEvent(new CustomEvent("hermes:unread", { detail: data?.sessions || {} }));
    } catch (e) {}
  }

  // 通知点开就落到那条回复所在的会话（2026-11-20 用户提：提示里能写回复什么、点了能直接进那个会话）
  function openSession(sid) {
    if (!sid) return;
    try { if (window.switchPage) window.switchPage("chat"); } catch (e) {}
    const go = () => { try { if (window.openTabCore) { window.openTabCore(sid); return true; } } catch (e) {} return false; };
    if (go()) return;
    let tries = 0;
    const t = setInterval(() => { if (go() || ++tries > 40) clearInterval(t); }, 150);
  }

  // 冷启动：SW 没找到已开的窗口时会 openWindow('#/?s=<sid>')，这里把它接住
  function deepLink() {
    const m = /[#&?]s=([0-9A-Za-z_-]+)/.exec(location.hash || "");
    if (!m) return;
    const sid = m[1];
    let tries = 0;
    const t = setInterval(() => {
      if (window.openTabCore) {
        clearInterval(t);
        openSession(sid);
        try { history.replaceState(null, "", location.pathname + location.search + "#/"); } catch (e) {}
      } else if (++tries > 60) clearInterval(t);   // 9 秒还起不来就放弃，别在后台空转
    }, 150);
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      const data = event.data || {};
      if (data.type === "open-session") openSession(data.sid);
    });
  }
  deepLink();

  async function boot() {
    const reg = await registration();
    if (!reg) return;
    try { await navigator.serviceWorker.ready; } catch (e) {}

    // 打开面板不等于看过：只把角标同步成服务端的真实值，清账由聊天区「滚到底」触发。
    syncBadge();
    window.addEventListener("hashchange", deepLink);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") syncBadge();
    });

    if (!standalone) return;                       // 非独立窗口不弹授权（iOS 上根本订阅不了）
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") {
      try { await subscribe(reg); } catch (e) {}
      return;
    }
    if (Notification.permission !== "default") return;
    const btn = chip("开启新回复通知", async () => {
      btn.remove();
      await askPermission(reg);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
