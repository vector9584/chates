# 仓库结构

一个仓库装三样东西：内核、面板、安装器。这样做是因为面板和内核必须同版本升级。

```
.
├── agent/  hermes_cli/  gateway/  cron/  tools/    内核（上游 0.20.0 + 27 commit / 44 文件）
├── app/
│   ├── ui/       面板前端：静态 HTML + 原生 JS，无打包器、无 CDN
│   └── server/   面板后端：53 个 panel-* 责任链 + monitor.js 主进程
├── win/
│   ├── install.ps1     Windows 安装器（uv + venv + 内核 + 面板 + 数据）
│   ├── update.ps1      版本化更新（zip 下载覆盖，三源镜像回退）
│   ├── version.json    版本比对基准
│   └── 使用说明.txt
├── docs/ARCHITECTURE.md    本文件
├── README.md               定制版说明 + 上游原文
└── pyproject.toml
```

## 为什么面板在 `app/` 而不是独立仓库

面板启动时按相对路径找内核：`app/home/data/venv`（Python 环境）、`app/server`（自己）、
内核模块靠 venv 的 `hermes_root.pth` 指过去。拆成两个仓库，装出来的东西会一半找不到另一半。
所以历史仓 [fnos-hermes-panel](https://github.com/vector9584/fnos-hermes-panel) 保留为面板原委与
fpk 工具链的档案，日常开发与安装都以本仓库的 `app/` 为准。

## 安装后与源码的对应

```
%LOCALAPPDATA%\HermesWin\app\hermes-src\   ← 本仓库的源码树
%LOCALAPPDATA%\HermesWin\app\ui\           ← app/ui
%LOCALAPPDATA%\HermesWin\app\server\       ← app/server
%LOCALAPPDATA%\HermesWin\app\home\data\    ← 数据（不入库）
```

`install.ps1` 会把 `app/ui`、`app/server` 复制过去，并在 venv 的 site-packages 里写
`hermes_root.pth` 指向 `hermes-src`，否则顶层模块（如面板桥）导入不到。

## 数据不入库

`config.yaml` 里的自定义 provider、`.env` 里的 key、`skills/`、`knowledge/` 都是个人数据，
`.gitignore` 全部排除。安装包里的 `data.zip` 是同一个人的换机备份，不进 git。

## 面板的两处 Windows 改造

面板历史上面向 fnOS（Linux）开发，跑 Windows 要动两处，都已改在 `app/server/` 的正式文件里，
不再是旁挂补丁：

1. **`monitor.js`**：`VENV_BIN` 按 `process.platform` 切 `bin` / `Scripts`，
   `python3` 切 `python.exe`，`hermes` 加 `.exe` 后缀。原来这些是写死的 POSIX 路径。
2. **`panel_config_txn.py` / `panel-*.py` / `panel_lifecycle.py`**：
   `fcntl` 与 `pwd` 没有条件导入，Windows 上 import 就炸。改成
   `try: import fcntl except ImportError: fcntl = None` + `msvcrt.locking` 兜底。
