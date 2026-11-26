// 发布版更新检查（Windows / fpk 通用）。
// 只读 GitHub Release 的公开元数据，不做下载动作——下载交给 win/update.ps1 或用户手动。
// 设计取舍：
//   - 不缓存到磁盘，每次现查；Release API 匿名 60 次/小时足够面板按钮用
//   - 网络不通就返回 ok:false + 原因，不抛异常、不阻塞面板其他功能

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const REPO = 'vector9584/chates';
const API = [
  `https://api.github.com/repos/${REPO}/releases/latest`,
  `https://gh-proxy.com/https://api.github.com/repos/${REPO}/releases/latest`,
];
const TIMEOUT_MS = 12000;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// 版本比较：只比数字段，"0.20.0-win.6" 里 win 后面的数字也参与比较
function verParts(v) {
  return String(v || '')
    .replace(/^v/i, '')
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number);
}

// 读本机已安装版本的元信息。
// 发布版会在应用根目录带 version.json（我们打 exe/fpk 时写进去的），
// 其内容形如 {"tag":"v0.20.0-win.9","date":"2026-11-25T...","name":"..."}。
// 没有这个文件说明是开发检出，直接返回 null，面板就不显示 GitHub 版标记。
function readInstalledVersion() {
  const roots = [
    process.env.CHATES_APP_ROOT,
    fileURLToPath(new URL('..', import.meta.url)),
  ].filter(Boolean);
  for (const root of roots) {
    for (const name of ['version.json', 'app/version.json']) {
      try {
        const p = join(root, name);
        if (!existsSync(p)) continue;
        const j = JSON.parse(readFileSync(p, 'utf8'));
        const tag = j.tag || j.version || '';
        if (!tag) continue;
        return { tag, date: j.date || j.published || '', name: j.name || '' };
      } catch {
        /* 换下一个候选 */
      }
    }
  }
  return null;
}

export function compareVersion(a, b) {
  const pa = verParts(a);
  const pb = verParts(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

async function fetchLatest() {
  let lastErr = '';
  for (const url of API) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      const r = await fetch(url, {
        signal: ctl.signal,
        headers: { 'User-Agent': 'chates-panel', Accept: 'application/vnd.github+json' },
      }).finally(() => clearTimeout(timer));
      if (!r.ok) { lastErr = `HTTP ${r.status}`; continue; }
      const j = await r.json();
      if (!j || !j.tag_name) { lastErr = 'no tag_name'; continue; }
      return {
        tag: j.tag_name,
        name: j.name || j.tag_name,
        published: j.published_at || '',
        notes: String(j.body || '').slice(0, 4000),
        assets: (j.assets || []).map((a) => ({
          name: a.name,
          size: a.size,
          url: a.browser_download_url,
          downloads: a.download_count || 0,
        })),
      };
    } catch (e) {
      lastErr = e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e));
    }
  }
  return { error: lastErr || 'unreachable' };
}

export function createUpdateHandler({ currentVersion, platform }) {
  return async function handleUpdate(req, path) {
    // GET /api/update/check —— 版本对比 + 该平台对应资产
    if (req.method === 'GET' && path === '/api/update/check') {
      const cur = typeof currentVersion === 'function' ? currentVersion() : currentVersion;
      const rel = await fetchLatest();
      if (rel.error) {
        return json({ ok: false, current: cur, error: rel.error });
      }
      const latest = rel.tag.replace(/^v/i, '');
      const outdated = compareVersion(cur, latest) < 0;
      // 按平台挑资产：Windows 看 Setup-*.zip，fnOS 看 *.fpk
      const want = platform === 'win32'
        ? (n) => /^HermesWin-Setup-.*\.zip$/i.test(n)
        : (n) => /\.fpk$/i.test(n);
      const picked = rel.assets.filter((a) => want(a.name));
      return json({
        ok: true,
        current: cur,
        latest: rel.tag,
        latestVersion: latest,
        outdated,
        published: rel.published,
        notes: rel.notes,
        assets: picked.length ? picked : rel.assets,
        pickup: picked.length ? 'matched' : 'none_for_platform',
      });
    }

    // GET /api/update/current —— 当前这份代码的发布版本（不联网，本地读）
    // 面板拿它渲染 GitHub 版标记：装的是发布版就显示 tag，跑源码开发就不显示。
    if (req.method === 'GET' && path === '/api/update/current') {
      try {
        const info = readInstalledVersion();
        if (!info || !info.tag) return json({ ok: false, error: 'not_a_release' });
        return json({ ok: true, ...info });
      } catch (e) {
        return json({ ok: false, error: e?.message || 'unreadable' });
      }
    }

    // GET /api/update/releases —— 最近几版，便于手动翻
    if (req.method === 'GET' && path === '/api/update/releases') {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
        const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=5`, {
          signal: ctl.signal,
          headers: { 'User-Agent': 'chates-panel', Accept: 'application/vnd.github+json' },
        }).finally(() => clearTimeout(timer));
        if (!r.ok) return json({ ok: false, error: `HTTP ${r.status}` });
        const list = await r.json();
        return json({
          ok: true,
          releases: (list || []).map((x) => ({
            tag: x.tag_name,
            name: x.name,
            published: x.published_at,
            prerelease: x.prerelease,
            assets: (x.assets || []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url })),
          })),
        });
      } catch (e) {
        return json({ ok: false, error: e?.message || 'unreachable' });
      }
    }

    return null;
  };
}
