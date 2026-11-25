/**
 * 客户端取证收件箱（2026-11-20）
 *
 * 背景：iPhone 上「切会话画面上下闪动」在无头浏览器里复现不出来（桌面 1440x900、
 * 390x844 移动模拟、3G+4x 降速都试过，scrollTop 序列干净），只能在真机抓现场。
 * 前端 app/ui/js/panel-scroll-diag.js 检测到短时间内反复上下滚动时，把那一小段
 * 采样 POST 到 /api/client-diag，这里落 JSON，事后由我读取。
 *
 * 只收几何/时序数据，不含消息正文。单文件 256KB 上限，最多留 30 份。
 */
import fs from "node:fs";
import path from "node:path";

const MAX_FILES = 30;
const MAX_BYTES = 256 * 1024;
const PREFIX = "/api/client-diag";

export function createClientDiag({ dataDir, log = () => {} }) {
  const dir = path.join(dataDir, "tmp", "client-diag");

  function ensureDir() {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  }

  function prune() {
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
        .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      files.slice(MAX_FILES).forEach((x) => { try { fs.unlinkSync(path.join(dir, x.f)); } catch (e) {} });
    } catch (e) {}
  }

  async function handle(req, checkToken, pathname) {
    if (!pathname.startsWith(PREFIX)) return null;
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
    if (!checkToken(req)) return json({ ok: false, error: "unauthorized" }, 401);
    ensureDir();

    if (req.method === "GET") {
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse().slice(0, 10); } catch (e) {}
      return json({ ok: true, dir, files });
    }

    if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);

    let payload;
    try {
      const raw = await req.text();
      if (raw.length > MAX_BYTES) return json({ ok: false, error: "too_large" }, 413);
      payload = JSON.parse(raw);
    } catch (e) {
      return json({ ok: false, error: "bad json" }, 400);
    }
    payload.received_at = new Date().toISOString();
    payload.ua_header = String(req.headers.get("user-agent") || "").slice(0, 240);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `${stamp}.json`);
    try { fs.writeFileSync(file, JSON.stringify(payload, null, 1)); } catch (e) {
      log(`写入失败：${e?.message || e}`);
      return json({ ok: false, error: "write_failed" }, 500);
    }
    prune();
    log(`收到客户端取证 ${path.basename(file)}（${Math.round(JSON.stringify(payload).length / 1024)}KB）`);
    return json({ ok: true, file: path.basename(file) });
  }

  return { handle, dir };
}
