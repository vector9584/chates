# 仓库结构

这个仓库里同时躺着**上游 Hermes 内核**和**我们加的东西**。根目录一打开 100 多项平铺，
分不清哪个是哪个，所以先看这张分区表。

一句话判据：**根目录散落的 `*.py`、`agent/`、`hermes_cli/`、`tools/`、`skills/`、`web/`
都是上游内核本来的样子，不要动**；名字里带 `app/ electron/ win/ cmd/ config/ wizard/
release-tools/ data-skeleton/ kernel/ fpk-bin/` 的才是 CHATES 加的。

---

## A 区 · 上游 Hermes 内核（原样保留，改它会炸 import）

从 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) 来，保持上游布局。

```
agent/            agent 循环与主逻辑
hermes_cli/       命令行入口、web_dist（dashboard 前端构建产物）
tools/            工具实现（终端、文件、搜索……）
skills/           内置技能库
providers/        模型 provider 适配
plugins/          插件机制
gateway/          消息网关
cron/             定时任务
web/              dashboard 前端源码（npm 构建到 hermes_cli/web_dist）
locales/          多语言
tests/  tests-js/ 测试
acp_adapter/  native/  nix/  optional-mcps/  optional-skills/
tui_gateway/  ui-tui/  apps/shared/  docker/  datagen-config-examples/
mcp-research-data/  docs/
```

根目录这些散文件也全是上游的模块，不是垃圾：
`cli.py` `run_agent.py` `mcp_serve.py` `model_tools.py` `toolsets.py`
`hermes_state*.py` `hermes_constants.py` `hermes_logging.py` `hermes_time.py`
`hermes_bootstrap.py` `panel_*.py` `toolset_distributions.py`
`trajectory_compressor.py` `utils.py` `mini_swe_runner.py` `batch_runner.py`
`setup.py` `pyproject.toml` `package.json`

上游自带的文档/配置也别删：`CONTRIBUTING*.md` `SECURITY*.md` `CHANGELOG.md`
`CLAUDE.md` `README.*.md`（多语言）`Dockerfile` `flake.nix` `constraints-termux.txt`
`eslint.config.shared.mjs` `.prettier*` `.hadolint.yaml` `.mailmap` `.npmrc` `.nvmrc`
`.python-version` `.dockerignore` `.envrc` `.plans/`

## B 区 · CHATES 加的（这个项目真正的产出）

```
app/                    控制面板（唯一真源）
├── ui/                 面板前端：静态 HTML + 原生 JS，无打包器、无 CDN
├── server/             panel-* 责任链 + monitor.js 主进程
├── hermes-src/         内核副本（构建时用，不进 git）
├── python/  bin/  echo-web/
electron/               Electron 外壳（Windows 桌面应用的窗口层）
├── main.js  build/  assemble.sh  package.json
win/                    Windows 安装/更新器
├── install.ps1  update.ps1  install.bat  version.json ← 版本号唯一真源
cmd/                    fpk 生命周期回调
├── install_init  install_callback  config_init  config_callback
wizard/                 fpk 安装/卸载向导界面
├── install  uninstall
config/                 fpk 元数据与首装模板
├── ICON.PNG  ICON_256.PNG  hermes-version.env  init/
data-skeleton/          出厂数据骨架（新装用户拿到的初始 data/）
release-tools/          打包与发版工具链
├── build-fpk.sh        fnOS 包（--tag 决定版本）
├── build-exe.sh        Windows 安装包
├── version.py          读版本号（只读 win/version.json）
├── make-kernel-tgz.sh  打内核快照给 CI
├── audit_data_skeleton.py  出厂数据脱敏门禁
└── tests/
fpk-bin/                fpk 内用的面板启动器（hermes-panel.mjs）
kernel/                 CI 用的内核快照 hermes-src.tgz（不进 git）
manifest                fpk 元数据（appname / version / display_name）
```

根目录 `hermes`（无扩展名）是上游的 CLI 启动脚本，不是我们的。

## C 区 · 文档

```
README.md            项目说明 + 下载入口
RELEASE.md           发版流程
ARCHITECTURE.md      本文件
JOURNEY.md           改造历程
WORK-MEMORY.md       项目决策记忆
UPDATE-LOG.md        版本更新记录
release-notes.md     单次发版说明
hermes-already-has-routines.md   上游文档（讲 routines 机制）
log.txt              空文件，待删
```

---

## 版本号只有一个真源

`win/version.json` 的 `version` 字段，形如 `1.20.6-win.1`：

- `1.20.6` → fnOS 应用包版本（fnpack 只认三段整数）
- `-win.1` → Windows 安装包构建序号，重打一次 +1，不影响 fpk 版本

CI 拿这个值打 tag（`v1.20.6-win.1`），`build-fpk.sh` 从 tag 提 `1.20.6`，
`build-exe.sh` 从 tag 提 `1.20.6-win.1`。**一个文件对，三端必然一致。**

`release-tools/version.py` 只读这个文件，不再自己维护计数——历史上它靠
`.version-state.json` 自增，CI 上没有该文件时永远算 `1.20.1`，与本地和 manifest
三方打架，那个机制已废弃。

## 为什么面板在 `app/` 而不是独立仓库

面板启动时按相对路径找内核：`app/home/data/venv`（Python 环境）、`app/server`（自己），
内核模块靠 venv 的 `hermes_root.pth` 指过去。拆成两个仓库，装出来的东西会一半找不到另一半。
历史仓 [fnos-hermes-panel](https://github.com/vector9584/fnos-hermes-panel) 保留为面板原委与
fpk 工具链的档案，日常开发与安装都以本仓库的 `app/` 为准。

## 安装后与源码的对应

```
%APPDATA%\CHATES\app\hermes-src\   ← 本仓库的源码树
%APPDATA%\CHATES\app\ui\           ← app/ui
%APPDATA%\CHATES\app\server\       ← app/server
%APPDATA%\CHATES\data\             ← 数据（不入库，升级不覆盖）
```

`install.ps1` 会把 `app/ui`、`app/server` 复制过去，并在 venv 的 site-packages 里写
`hermes_root.pth` 指向 `hermes-src`，否则顶层模块（如面板桥）导入不到。

## 数据不入库

`config.yaml` 里的自定义 provider、`.env` 里的 key、`skills/`、`knowledge/` 都是个人数据，
`.gitignore` 全部排除。`data-skeleton/` 是**脱敏后的**出厂骨架，由
`release-tools/audit_data_skeleton.py` 在 CI 里按值扫描，命中真实凭据/路径/学校名就拒绝打包。

## 面板的两处 Windows 改造

面板历史上面向 fnOS（Linux）开发，跑 Windows 要动两处，都已改在 `app/server/` 的正式文件里，
不再是旁挂补丁：

1. **`monitor.js`**：`VENV_BIN` 按 `process.platform` 切 `bin` / `Scripts`，
   `python3` 切 `python.exe`，`hermes` 加 `.exe` 后缀。原来这些是写死的 POSIX 路径。
2. **`panel_config_txn.py` / `panel-*.py` / `panel_lifecycle.py`**：
   `fcntl` 与 `pwd` 没有条件导入，Windows 上 import 就炸。改成
   `try: import fcntl except ImportError: fcntl = None` + `msvcrt.locking` 兜底。
