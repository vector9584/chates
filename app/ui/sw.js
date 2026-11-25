// sw.js —— 面板 Service Worker：Web Push 角标 + 通知内容/点击直达会话
// scope = 面板根（/app/hermes-agent/），所有路径都用相对 registration.scope 拼。
const SCOPE = self.registration.scope;

self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim()); });

const api = (p) => new URL("api/" + p, SCOPE).href;
const getJson = async (url) => {
  const res = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
};

async function unreadInfo() {
  try { return await getJson(api("push/unread")); } catch (e) { return { count: 0, sessions: {} }; }
}

async function applyBadge(count) {
  try {
    if (count > 0 && self.navigator?.setAppBadge) await self.navigator.setAppBadge(count);
    else if (self.navigator?.clearAppBadge) await self.navigator.clearAppBadge();
  } catch (e) { /* 旧系统没有 Badging API，忽略 */ }
}

// 通知正文 = 那条回复的第一句。markdown 全剥掉：通知栏只有两行，代码块和表格只会占满还看不懂。
function plain(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[图片]")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[\s>*\-+]+/gm, " ")
    .replace(/[#`*_~|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// 找「该提示哪个会话」：未读里最近更新的那个（push 时未读表里通常只有一个）。
async function pickTarget(sessions) {
  const sids = Object.keys(sessions || {});
  if (!sids.length) return null;
  try {
    const list = await getJson(api("sessions"));
    const arr = Array.isArray(list) ? list : (list?.sessions || []);
    const hit = arr.filter((s) => sids.includes(s.id)).sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))[0];
    if (hit) return { sid: hit.id, title: hit.title || "", count: sessions[hit.id] || 1 };
  } catch (e) { /* 列不到就退到第一个未读 */ }
  return { sid: sids[0], title: "", count: sessions[sids[0]] || 1 };
}

async function replyPreview(sid) {
  if (!sid) return { title: "", text: "" };
  try {
    const s = await getJson(api("sessions/" + encodeURIComponent(sid)));
    const msgs = Array.isArray(s?.messages) ? s.messages : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.role !== "assistant" || m._streaming) continue;
      const text = plain(m.content);
      if (text) return { title: s.title || "", text };
    }
    return { title: s?.title || "", text: "" };
  } catch (e) { return { title: "", text: "" }; }
}

// 通知只占标题一行 + 正文两行（2026-11-20 用户要求）：
// 标题就是会话名，不前缀不加来源；正文压掉换行再截 44 字，正好两行。
function brief(text, max) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

async function notifyPayload() {
  const info = await unreadInfo();
  const count = Number(info?.count) || 0;
  const target = await pickTarget(info?.sessions);
  const preview = await replyPreview(target?.sid);
  const title = preview.title || target?.title || "";
  const body = preview.text ? brief(preview.text, 44)
    : (count > 1 ? `${count} 条新回复` : "有 1 条新回复");
  return {
    title: title || "小肥鱼回复了",
    body,
    count,
    sid: target?.sid || "",
    url: SCOPE + (target?.sid ? "#/?s=" + encodeURIComponent(target.sid) : ""),
  };
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    const p = await notifyPayload();
    await applyBadge(p.count);
    await self.registration.showNotification(p.title, {
      body: p.body,
      tag: "hermes-unread",          // 同一个 tag：多条回复只留最新一条，不在通知中心排队
      renotify: true,
      icon: new URL("images/favicon-app-192.png", SCOPE).href,
      badge: new URL("images/favicon-app-192.png", SCOPE).href,
      data: { url: p.url, sid: p.sid },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sid = event.notification?.data?.sid || "";
  const target = event.notification?.data?.url || SCOPE;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = wins.find((w) => w.url.startsWith(SCOPE));
    if (open) {
      await open.focus();
      // 已开着的窗口不重新加载：让它自己切会话，草稿和缓存都不丢
      if (sid) open.postMessage({ type: "open-session", sid });
      return;
    }
    await self.clients.openWindow(target);
  })());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "badge") event.waitUntil(applyBadge(Number(data.count) || 0));
  // 自检用：把「下一次通知会长什么样」算出来，不用真的等一条回复
  if (data.type === "notify-preview") {
    event.waitUntil((async () => {
      let payload = null;
      try { payload = await notifyPayload(); } catch (e) { payload = { error: String(e) }; }
      if (event.source) event.source.postMessage({ type: "notify-preview", payload });
    })());
  }
});
