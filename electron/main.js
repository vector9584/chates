// CHATÈS 主进程
//
// 设计要点（都是为了「双击就是完整应用」这一条）：
//
// 1. node 是子进程，不是 Electron 自带的 node。
//    面板 monitor.js 依赖 9000+ 行 node 原生逻辑，用 Electron 内嵌 node 去跑会踩
//    ELECTRON_RUN_AS_NODE 一堆坑（路径、原生模块 ABI、process.versions 差异）。
//    我们要的是「像 exe 一样」，不是「把 node 塞进 Electron 进程里」。
//
// 2. 启窗口前必须等端口真的能连上。
//    monitor.js 起来要 2~8 秒（读配置、扫知识库、算 manifest）。
//    直接 loadURL 会白屏一下，用户会以为坏了 —— 所以先显示 splash，探活后再切。
//
// 3. 退出必须把 node 一起带走。
//    Windows 上父进程退出不会自动杀子进程，不处理就会留下孤儿 node 占着 8650，
//    下次启动端口冲突。before-quit + will-quit + 异常退出三处都要兜。
//
// 4. 端口被占时不硬起，先探一下是不是自己的实例。
//    是 → 直接复用（用户双击两次不该起两个）；不是 → 报错让用户知道。

const { app, BrowserWindow, dialog, shell, Menu, nativeImage, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');

const IS_WIN = process.platform === 'win32';

// ── 离线优先：不因 Chromium 的后台联网动作拖慢启动 ────────────────
// 用户 2026-11-26 报"打开后还要做一次联网请求"。除了 electron-updater
// 拉 latest.yml（已改成手动触发），Chromium 自己还会做两件容易被误认为
// "程序在联网"的事，在纯本机应用里都该关掉：
//   1. 联网校验 SSL 证书吊销列表（CRL/OCSP）—— 内网无外网时会等到超时；
//   2. 拼写检查词典下载 —— 我们本就没开 spellcheck，但后台仍可能拉。
// 这两项不影响任何本地功能，关掉只减少启动路上的不确定等待。
app.commandLine.appendSwitch('disable-features', 'SpellcheckService,OptimizationHints,MediaRouter');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('no-pings');

const RES = process.resourcesPath;           // 打包后 = <app>/resources

// userData 默认按 app.getName() 落在 %APPDATA%\<name>。
// 不显式改的话打包态会叫 chates-desktop，用户找不到自己的配置放哪。
// 必须在任何 getPath('userData') 调用之前设定。
app.setName('CHATÈS');
const PORT = Number(process.env.CHATES_PORT || 8650);
const HOST = '127.0.0.1';

let mainWindow = null;
let splashWindow = null;
let child = null;
let quitting = false;

// ── 路径解析 ───────────────────────────────────────────────
// 开发态（electron . 直接跑）与打包态目录结构不同，两边都要能跑，
// 否则每次改壳都得先打包一遍才敢测。
// 安装包里的运行时是单个 tar（见 assemble.sh 第 8 段）。
// 安装器正常会解开它，但用户可能手工 copy 安装目录、或解压中途被打断，
// 所以这里再兜一层：目录不在就自己解一次，而不是直接报"找不到 monitor.js"。
function ensureRuntimeExtracted() {
  const target = path.join(RES, 'chates');
  const tarball = path.join(RES, 'chates.tgz');
  // 2026-11-27：以前只查 monitor.js 就判定"解压完成"，结果被 Windows 的
  // bsdtar 坑过一次——中途失败不回滚，app/ 和 runtime/python/ 目录都建好、
  // monitor.js 也解出来了，唯独 python.exe 没落地。此后每次启动都认这半截，
  // 模型配置 spawn 不到解释器 → /api/panel-models 直接 503 → 页面上 provider
  // 一个都不显示（用户看到的就是"配置全没了"，其实 config.yaml 好端端躺着）。
  // 判据要覆盖真正要用的可执行文件，缺一个就重解。
  const mustHave = [
    ['app', 'server', 'monitor.js'],
    ['runtime', 'python', 'python.exe'],
    ['runtime', 'node.exe'],
  ];
  const intact = () => mustHave.every((p) => fs.existsSync(path.join(target, ...p)));

  if (intact()) return target;
  if (!fs.existsSync(tarball)) return null;
  try {
    // 残缺目录不能就地叠加解压：bsdtar 不会清掉旧根目录，缺的那份可能一直补不上。
    console.log('[chates] extracting runtime tarball -> ' + target);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    const { spawnSync } = require('child_process');
    // Windows 10 1803+ 自带 bsdtar，参数用 GNU 兼容写法。
    // 2026-11-27：不能用 execFileSync —— bsdtar 解这个包时只要遇到一个它处理
    // 不了的条目（186MB 里的 acl/xattr 之类）就返回 exit=1，而实际文件已经
    // 全解出来了。execFileSync 一抛异常，下面的 intact() 根本没机会跑，
    // 于是 ensureRuntimeExtracted 返回 null，应用空壳启动、三个端口都不监听。
    // 实测：exit=1、19354 个文件、python.exe/node.exe/monitor.js 全在。
    // 所以判据只认 intact()，tar 的退出码仅当日志。
    const r = spawnSync('tar', ['-xzf', tarball, '-C', target], {
      stdio: 'ignore', windowsHide: true, timeout: 10 * 60 * 1000,
    });
    if (r.status !== 0) {
      console.warn('[chates] tar exit=' + r.status +
        (r.signal ? ' signal=' + r.signal : '') + '（继续按文件判据校验）');
    }
    if (intact()) return target;
    console.error('[chates] tar 解开后关键文件仍不全: ' +
      mustHave.filter((p) => !fs.existsSync(path.join(target, ...p))).map((p) => p.join('/')).join(', '));
  } catch (e) {
    console.error('[chates] extract failed: ' + e.message);
  }
  return null;
}

function resolveRoots() {
  ensureRuntimeExtracted();
  const candidates = [
    path.join(RES, 'chates'),                    // 打包：resources/chates/
    path.join(__dirname, 'resources', 'chates'), // 开发
  ];
  for (const r of candidates) {
    if (fs.existsSync(path.join(r, 'app', 'server', 'monitor.js'))) {
      // var 也放用户目录：pid / token / shell.log 全是运行时产物，
      // 写在安装目录会因权限和升级覆盖出问题。
      const dataRoot = resolveUserData(path.join(r, 'data'));
      const varDir = path.join(app.getPath('userData'), 'var');
      fs.mkdirSync(varDir, { recursive: true });
      return {
        root: r,
        appDir: path.join(r, 'app'),
        dataDir: dataRoot,
        varDir,
        node: pickRuntime(r, 'node.exe'),
        python: pickRuntime(path.join(r, 'runtime', 'python'), 'python.exe'),
      };
    }
  }
  return null;
}

/**
 * 取运行时可执行文件：先看 <root>/<name>，再看 resources/<name>。
 * 2026-11-27：chates.tgz 曾经只解出一半（目录建了、python.exe 没落地），
 * 而真正完整的 runtime 一直躺在 resources/ 下。两条路都试，别一条不通就认死。
 */
function pickRuntime(root, name) {
  const primary = path.join(root, name);
  if (fs.existsSync(primary)) return primary;
  const fallback = path.join(RES, name);
  return fs.existsSync(fallback) ? fallback : primary;
}

function logLine(msg) {
  const line = `[chates] ${new Date().toISOString()} ${msg}`;
  console.log(line);
  try {
    const r = resolveRoots();
    if (r) {
      fs.mkdirSync(r.varDir, { recursive: true });
      fs.appendFileSync(path.join(r.varDir, 'shell.log'), line + '\r\n');
    }
  } catch {}
}

// ── 端口探活 ───────────────────────────────────────────────
function probePort(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, HOST);
  });
}

function httpGetOk(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, body: '' }); });
    req.on('error', () => resolve({ ok: false, status: 0, body: '' }));
  });
}

async function waitPanelReady(deadlineMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    const r = await httpGetOk(`http://${HOST}:${PORT}/`);
    if (r.ok) return true;
    await new Promise((r2) => setTimeout(r2, 400));
  }
  return false;
}

// ── 用户数据目录 ───────────────────────────────────────────
// 安装目录里的 data 是「出厂数据」（config.yaml / .env / 知识库 / 技能），
// 不能当运行时数据目录用：
//   1. 安装到 AppData\Local\Programs 后，升级会整个覆盖，用户配置全丢；
//   2. 那目录对普通用户可能只读，写 log/pid/会话会失败。
// 所以首次启动把出厂 data 拷到 %APPDATA%\CHATÈS\data，之后只认用户目录。
// 用 app.getPath('userData') 而不是硬拼路径 —— 用户改了 APPDATA 也不会错。
function resolveUserData(factory) {
  const stamped = path.join(app.getPath('userData'), '.seeded');
  const target = path.join(app.getPath('userData'), 'data');
  if (fs.existsSync(stamped) && fs.existsSync(target)) return target;

  // 这里绝不能调 logLine：logLine 内部会调 resolveRoots → resolveUserData，
  // 首启时形成无限递归。种子阶段的输出走到 stderr，由外层决定要不要看。
  console.log('[chates] seeding user data (first run) ...');
  fs.mkdirSync(target, { recursive: true });
  if (factory && fs.existsSync(factory)) {
    // 用 fs.cpSync：node 22 自带，递归复制 + 保留结构，比手写递归稳
    fs.cpSync(factory, target, { recursive: true, force: false, errorOnExist: false });
    console.log('[chates] seeded from ' + factory);
  }
  // 标记文件放 userData 根，不放 data 里 —— 免得被当成用户文件同步出去
  fs.writeFileSync(stamped, new Date().toISOString());
  return target;
}

// ── 起 node 子进程 ─────────────────────────────────────────
function startBackend(roots) {
  const monitor = path.join(roots.appDir, 'server', 'monitor.js');
  if (!fs.existsSync(roots.node)) {
    throw new Error(`找不到 node 运行时：${roots.node}`);
  }
  const env = {
    ...process.env,
    APP_DIR: roots.appDir,
    HERMES_HOME: roots.dataDir,
    DATA_DIR: roots.dataDir,
    VAR_DIR: roots.varDir,
    HERMES_VAR_DIR: roots.varDir,
    UI_HOST: HOST,
    UI_PORT: String(PORT),
    // 独立版只 bind 127.0.0.1，对端就是本机用户本人，没有隧道风险。
    // 不开这个开关 panel-auth 会把 loopback 判成不可信 → bootstrap 恒 401，
    // 而生成设备授权码又必须先登录 —— 死锁，全新安装直接进不去面板。
    // fpk/生产环境不设这个变量，保持 2026-11-17 的隧道防护。
    HERMES_PANEL_TRUST_LOOPBACK: '1',
    // 独立版 python 布局跟 fpk 版不同，两个位置都要告诉 monitor：
    //   python.exe  在 runtime/python/        （monitor 用它跑 panel-models.py 等脚本）
    //   hermes.exe  在 runtime/python/Scripts/（monitor 用它 --version / profile / gateway）
    // fpk 版两个在同一个 venv/Scripts 下，所以以前一个变量就够。
    CHATES_PYTHON_ROOT: path.dirname(roots.python),
    CHATES_PYTHON_SCRIPT: path.join(path.dirname(roots.python), 'Scripts'),
  };
  // Electron 自己的 ELECTRON_RUN_AS_NODE 会污染子进程，必须清掉
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;

  logLine(`starting backend: ${roots.node} ${monitor}`);
  child = spawn(roots.node, [monitor], {
    cwd: roots.appDir,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => logLine('out ' + d.toString().trimEnd()));
  child.stderr.on('data', (d) => logLine('err ' + d.toString().trimEnd()));
  child.on('exit', (code, sig) => {
    logLine(`backend exited code=${code} sig=${sig} quitting=${quitting}`);
    child = null;
    if (!quitting) {
      dialog.showErrorBox('CHATÈS 后端已退出',
        `面板服务意外停止（code=${code}）。\n\n详细日志：${path.join(roots.varDir, 'shell.log')}`);
      app.quit();
    }
  });
  return child;
}

function stopBackend() {
  if (!child) return;
  logLine('stopping backend');
  try {
    if (IS_WIN) {
      // Windows 上 kill() 只杀 node 本身，monitor 起的 python 子进程会活下来。
      // /T 杀整棵树，/F 强制 —— 这两个参数缺一个就会留孤儿。
      const { execFileSync } = require('child_process');
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch (e) {
    logLine('stop backend failed: ' + e.message);
  }
  child = null;
}

// ── 窗口 ───────────────────────────────────────────────────
function createSplash() {
  splashWindow = new BrowserWindow({
    width: 460,
    height: 280,
    frame: false,
    resizable: false,
    show: false,
    backgroundColor: '#0b1220',
    webPreferences: { contextIsolation: true },
  });
  const f = path.join(__dirname, 'splash.html');
  if (fs.existsSync(f)) splashWindow.loadFile(f);
  splashWindow.once('ready-to-show', () => splashWindow && splashWindow.show());
}

function closeSplash() {
  if (splashWindow) {
    try { splashWindow.close(); } catch {}
    splashWindow = null;
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b1220',
    title: 'CHATÈS',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  // 页面 <title> 不要覆盖窗口标题（2026-11-26 用户报"窗口左上角怎么还
  // 写的 Hermes"）。虽然 index.html 的 <title> 已经改成 CHATÈS，但只要
  // 网页里任何脚本改了 document.title，Electron 默认就会同步到窗口，
  // 左上角又跑偏。这里显式接管：窗口标题永远是我们设的那个。
  mainWindow.on('page-title-updated', (e) => { e.preventDefault(); });

  // 站内链接窗口内开，站外链接交给系统浏览器 —— 否则用户点个文档链接
  // 整个应用就变成网页浏览器了，回不来。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://${HOST}:${PORT}`)) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 窗口可见性必须可观测。`ready-to-show` 只在页面完成首帧绘制后才触发，
  // 一旦加载失败（端口还没起、白页、DNS 解析失败）它就永远不来 ——
  // 现象是「进程活着、服务 200、但用户看不到窗口」，极难定位。
  // 所以三条路任一条先到就显示，并全部写日志。
  let shown = false;
  const showOnce = (why) => {
    if (shown || !mainWindow) return;
    shown = true;
    try { mainWindow.show(); mainWindow.focus(); } catch (e) { logLine('show failed: ' + e.message); }
    closeSplash();
    logLine('window shown (' + why + ')');
  };

  mainWindow.once('ready-to-show', () => showOnce('ready-to-show'));
  mainWindow.webContents.on('did-finish-load', () => showOnce('did-finish-load'));
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logLine('did-fail-load ' + code + ' ' + desc + ' ' + url);
    // 失败也给窗口：让用户看到错误页而不是什么都没有
    showOnce('did-fail-load');
  });
  // 兜底：2.5 秒还没就绪就直接显示，宁可看到空白也别看不到窗口
  setTimeout(() => showOnce('timeout-fallback'), 2500);

  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

// ── 应用菜单 ───────────────────────────────────────────────
// ── 更新 ───────────────────────────────────────────────────
// 不自己写下载器。electron-updater 负责 latest.yml 比对、分块下载、静默安装、
// 装完重启回新版本 —— 这条链在 NSIS 生态里被磨了很多年，自己造只会多一处出错的地方。
//
// 依赖只在打包态用得上；开发态（electron .）没装也不该炸，所以 require 放 try 里。
// latest.yml 由 electron-builder 在 publish 配置存在时自动产出，和 Setup.exe 一起传上
// Release —— 少了它 autoUpdater 会一直说"没有新版本"，这是最容易漏的一步。
let updater = null;

function loadUpdater() {
  if (!app.isPackaged) return null;
  if (updater !== null) return updater || null;
  try {
    updater = require('electron-updater').autoUpdater;
  } catch (e) {
    logLine('updater 载入失败: ' + (e && e.message));
    updater = false;
    return null;
  }
  const logger = { info: logLine, warn: logLine, error: logLine, debug: () => {} };
  updater.logger = logger;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  // 手动检查时也别无限等：GitHub 在国内经常连不上，卡住不如早点告诉他。
  updater.requestHeaders = { 'Cache-Control': 'no-cache' };

  /* 常驻监听只记日志。给用户的提示统一由 checkUpdates 的 finish() 弹，
     否则手动检查时这里弹一个、那边弹一个，一次点击两个框。 */
  updater.on('error', (e) => {
    logLine('update error: ' + (e && e.message));
  });
  updater.on('update-available', (info) => {
    logLine(`update available: ${info && info.version}`);
  });
  updater.on('update-not-available', () => {
    logLine('update: 已是最新');
  });
  updater.on('download-progress', (p) => {
    if (p && p.percent) logLine(`update download ${p.percent.toFixed(1)}%`);
  });
  updater.on('update-downloaded', (info) => {
    logLine('update downloaded: ' + (info && info.version));
    const choice = dialog.showMessageBoxSync({
      type: 'info', title: '更新已就绪',
      message: `新版本 ${info && info.version} 已下载完成。`,
      detail: '现在重启会关闭当前会话并安装新版本。选「稍后」则下次退出时自动安装。',
      buttons: ['立即重启并安装', '稍后'], defaultId: 0, cancelId: 1,
    });
    if (choice === 0) {
      quitting = true;
      stopBackend();
      // isSilent=false：让用户看见安装进度；isForceRunAfter=true：装完自己回来
      setImmediate(() => updater.quitAndInstall(false, true));
    }
  });
  return updater;
}

/* 检查更新。返回 Promise<{status, version?, message?}>，status 取值：
     dev | update | latest | error | timeout
   两条调用路径共用它：
     - 菜单「帮助 → 检查更新」：quiet=false，自己弹系统对话框
     - 顶栏版本号药丸（IPC）：quiet=true，结果回给页面，用页面内的 toast 提示
   为什么改成返回 Promise：原来它只弹 dialog 不返回结果，页面那头只能干等，
   最后落到 30 秒超时 —— 看不出到底是"已是最新"还是"连不上"。
   updater 的事件回调在 updater.js 里（update-available / update-not-available /
   error），这里用一次性监听把结果等出来，超时兜底。 */
function checkUpdates(manual, quiet) {
  const u = loadUpdater();
  if (!u) {
    if (manual && !quiet) dialog.showMessageBox({ type: 'info', title: '当前为开发模式',
      message: '开发态不检查更新，打包安装后才生效。' });
    return Promise.resolve({ status: 'dev' });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      try { u.removeListener('update-available', onAvail); } catch (_) {}
      try { u.removeListener('update-not-available', onNone); } catch (_) {}
      try { u.removeListener('error', onErr); } catch (_) {}
      if (manual && !quiet) {
        if (r.status === 'update') {
          dialog.showMessageBox({ type: 'info', title: '发现新版本',
            message: `发现新版本 ${r.version || ''}，正在后台下载。`,
            detail: '下载完成后会提示重启安装。' });
        } else if (r.status === 'latest') {
          dialog.showMessageBox({ type: 'info', title: '已是最新版本',
            message: `当前 ${app.getVersion()} 已是最新。` });
        } else if (r.status === 'timeout') {
          dialog.showMessageBox({ type: 'warning', title: '检查更新超时',
            message: '连不上更新服务器（30 秒无响应）。',
            detail: '国内访问 GitHub 常常不通。这不影响本地功能，联网后点顶栏版本号重试。' });
        } else if (r.status === 'error') {
          dialog.showMessageBox({ type: 'warning', title: '检查更新失败',
            message: String(r.message || '未知错误') });
        }
      }
      resolve(r);
    };
    const onAvail = (info) => finish({ status: 'update', version: (info && info.version) || '' });
    const onNone = () => finish({ status: 'latest' });
    const onErr = (e) => { logLine('checkForUpdates 抛出: ' + (e && e.message)); finish({ status: 'error', message: String(e && e.message || e) }); };
    const guard = setTimeout(() => {
      logLine('checkForUpdates 超时（30s），按无网处理');
      finish({ status: 'timeout' });
    }, 30000);

    try {
      u.on('update-available', onAvail);
      u.on('update-not-available', onNone);
      u.on('error', onErr);
    } catch (_) {}

    u.checkForUpdates()
      .then((res) => {
        /* electron-updater 的返回值里通常带 updateInfo，
           但事件也可能先触发。谁先到谁说话，finish 幂等。 */
        if (res && res.updateInfo && !settled) {
          const cur = app.getVersion();
          const nv = res.updateInfo.version || '';
          if (nv && nv !== cur) finish({ status: 'update', version: nv });
          else if (nv) finish({ status: 'latest' });
        }
      })
      .catch(onErr);
  });
}

/* 顶栏「GitHub 版本号」点一下触发检查更新（2026-11-26）。
   原来这个功能只在「帮助 → 检查更新」，但主窗口 autoHideMenuBar: true，
   菜单栏默认不显示，用户压根找不到 —— 报"你是不是乱说的"。
   改成同时提供 IPC 入口，页面上的版本号药丸就是按钮。
   返回 { ok, status, message }，页面据此提示；永远 resolve，不抛。 */
ipcMain.handle('chates:check-updates', async () => {
  try {
    const r = await checkUpdates(true, true);
    const map = {
      dev: '开发模式下不检查更新',
      update: `发现新版本 ${(r && r.version) || ''}，正在后台下载`,
      latest: '已是最新版本',
      timeout: '连不上更新服务器（30 秒无响应）',
      error: (r && r.message) || '检查更新失败',
    };
    return {
      ok: !!(r && (r.status === 'update' || r.status === 'latest')),
      status: (r && r.status) || 'unknown',
      version: (r && r.version) || '',
      message: map[(r && r.status)] || '检查完成',
    };
  } catch (e) {
    return { ok: false, status: 'error', message: String(e && e.message || e) };
  }
});

function buildMenu() {
  // 只留必要项。默认菜单里 Electron 自带的 "Toggle Developer Tools"
  // 给普通用户点进 DevTools 是灾难，但排查问题又需要 —— 放「帮助」里加密码不合算，
  // 改成 --dev 启动参数才给。
  const dev = process.argv.includes('--dev');
  const tmpl = [
    {
      label: '文件',
      submenu: [
        { label: '在浏览器中打开', click: () => shell.openExternal(`http://${HOST}:${PORT}/`) },
        { label: '打开数据目录', click: () => { const r = resolveRoots(); if (r) shell.openPath(r.dataDir); } },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '刷新', role: 'reload' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
        ...(dev ? [{ type: 'separator' }, { label: '开发者工具', role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '打开日志目录', click: () => { const r = resolveRoots(); if (r) shell.openPath(r.varDir); } },
        { type: 'separator' },
        { label: '检查更新', click: () => checkUpdates(true) },
        { label: `版本 ${app.getVersion()}`, enabled: false },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tmpl));
}

// ── 主流程 ─────────────────────────────────────────────────
async function boot() {
  const roots = resolveRoots();
  if (!roots) {
    dialog.showErrorBox('安装不完整',
      '找不到面板文件（app/server/monitor.js）。\n\n请重新运行安装程序。');
    app.quit();
    return;
  }
  logLine(`roots root=${roots.root}`);

  // 已经有一份在跑就直接复用，用户双击两次不该起两个实例
  const already = await probePort(PORT);
  if (already) {
    const r = await httpGetOk(`http://${HOST}:${PORT}/`);
    if (r.ok) {
      logLine('existing instance detected, reusing');
      createMainWindow();
      mainWindow.loadURL(`http://${HOST}:${PORT}/`);
      return;
    }
    dialog.showErrorBox('端口被占用',
      `端口 ${PORT} 被其他程序占用，CHATÈS 无法启动。\n\n请关闭占用该端口的程序后重试。`);
    app.quit();
    return;
  }

  createSplash();
  try {
    startBackend(roots);
  } catch (e) {
    closeSplash();
    dialog.showErrorBox('后端启动失败', e.message);
    app.quit();
    return;
  }

  const ok = await waitPanelReady(60000);
  if (!ok) {
    closeSplash();
    dialog.showErrorBox('面板启动超时',
      `等了 60 秒面板仍未就绪。\n\n日志：${path.join(roots.varDir, 'shell.log')}`);
    stopBackend();
    app.quit();
    return;
  }
  logLine('panel ready');

  createMainWindow();
  mainWindow.loadURL(`http://${HOST}:${PORT}/`);
}

// 单实例锁：第二次双击直接把已有窗口拉到前台
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    buildMenu();
    boot();
    // 启动 20 秒后静默查一次：错开启动高峰。失败不弹窗——
    // 首次安装当天没网很常见，等用户手动查再报。
    // 不在启动后自动联网检查（2026-11-26 用户报"打开后还要做一次联网请求"）。
    // 原因：electron-updater 会去 github.com 拉 latest.yml。国内网络下这一步
    // 要么等很久，要么一直挂着，用户看到的就是"启动完还在转"。
    // 改成只在「帮助 → 检查更新」里手动触发；有网的时候顺手去点一次即可。
    // 不想联网就完全不会发请求，本地功能一概不受影响。
  });

  app.on('window-all-closed', () => {
    // 不给 mac 那套「关窗不退」的逻辑 —— 这是个本地服务壳，
    // 窗口关了后端还在跑，用户会以为没退出。
    quitting = true;
    stopBackend();
    app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    stopBackend();
  });

  // 兜底：进程被强杀/崩溃时也尽量带走子进程
  process.on('exit', () => { if (!quitting) stopBackend(); });
  process.on('SIGINT', () => { quitting = true; stopBackend(); app.quit(); });
  process.on('uncaughtException', (e) => {
    logLine('uncaught: ' + (e && e.stack || e));
  });
}
