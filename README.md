<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="app/ui/images/logo-cat-full-light.png">
    <img src="app/ui/images/logo-cat-full-dark.png" alt="CHATÈS — 一只猫拉着小车" width="300">
  </picture>
</p>

<p align="center">
  <b>把一台 NAS 变成你自己能拆能改的 AI 工作台</b><br/>
  <sub>Hermes Agent 的控制面板 · 网页 / fnOS 应用 / Windows 桌面三种装法 · 静态 HTML + 原生 JS，无打包器、无 CDN</sub>
</p>

<p align="center">
  <img alt="manifest" src="https://img.shields.io/badge/manifest-0.21.102-71dbc0">
  <img alt="desktop" src="https://img.shields.io/badge/desktop-1.20.4-71dbc0">
  <img alt="license" src="https://img.shields.io/badge/license-GPL--3.0-5e64f3">
  <img alt="platform" src="https://img.shields.io/badge/platform-fnOS%20%7C%20Windows-2f3a46">
  <img alt="tests" src="https://img.shields.io/badge/tests-192-71dbc0">
</p>

<p align="center">
  <a href="https://github.com/vector9584/chates">仓库</a> ·
  <a href="https://s27.fnnas.net/s/70bb0c6f5b3d4a88a6">下载安装包</a> ·
  <a href="docs/index.html">单页介绍</a> ·
  <a href="app/ui/ARCHITECTURE.md">前端架构</a> ·
  <a href="JOURNEY.md">改造历程</a>
</p>

<img src="promo/img/panel-overview.png" alt="CHATÈS 面板：左侧八个板块，中间会话列表，右侧对话">

---

## 先看这个

| 你想要 | 去哪 |
|---|---|
| Windows 上双击就能用 | [下载 `CHATES-Setup-1.20.4.exe`](https://s27.fnnas.net/s/70bb0c6f5b3d4a88a6)，一路下一步 |
| fnOS 上装成应用中心里的一个 app | 同一个目录里拿 `chates_1.20.4.fpk`，应用中心右上角「手动安装」 |
| 只想在浏览器里点着看 | `node bin/hermes-panel.mjs --port 9000`，不装任何东西 |
| 想改代码 | 看下面的[改代码](#改代码)和 [CONTRIBUTING.md](CONTRIBUTING.md) |

安装包都在同一个分享目录里，校验值是目录内的 `SHA256SUMS.txt`。包里**不带任何 API Key**，装完必须自己配模型。

## 这是什么东西

装在自己机器上的 AI 助手，大部分时间你只能隔着命令行跟它说话。这个仓库给它配了一个真正的控制台：八个板块、二十一个页面，对话、定时任务、专家讨论、技能开关、模型凭据全在里面点。

面板不替换 Hermes 内核。推理和消息网关仍由上游提供，面板通过 Unix socket 和 HTTP 代理它们。仓库里的 `app/python/` 是对上游 Python 层的补丁，不是另写一套。

前端是静态 HTML + CSS + 原生 JS，**没有打包器**。`index.html` 里 `<script>` 的顺序就是依赖顺序。这样做的好处是改一行刷新就能看见，坏处是顺序不能乱挪——`app/ui/ARCHITECTURE.md` 把这条写成了规矩。

## 三种装法

| 形态 | 产物 | 装在哪 | 什么时候选它 |
|---|---|---|---|
| Windows 桌面 | `CHATES-Setup-<版本>.exe`（约 213 MB） | 用户目录，NSIS 安装，自带 Electron 与本机运行时 | 只想用，不想碰命令行 |
| fnOS 应用 | `chates_<版本>.fpk`（约 60 MB） | `/vol1/@appcenter/chates`，桌面图标进面板 | NAS 常开机，要和影视、相册、笔记放一起 |
| 纯网页 | `bin/hermes-panel.mjs` | 随便哪台机器，数据目录与代码分离 | 开发、只调样式、或在没装 fnOS 的机器上跑 |

三个形态共用同一份 `app/ui` 与 `app/server`。区别只在宿主：Windows 走 Electron 主进程，fnOS 走应用 socket，纯网页走 TCP。

## 现在能做什么

导航以 `app/ui/js/panel-navigation.js` 顶部的 `groups` 数组为唯一真源，当前 **8 个板块、21 个页面**。

| 板块 | 页面 | 干什么 |
|---|---|---|
| 对话 | 会话 | 流式输出、工具卡、气泡状态、发送队列与断线续发、斜杠命令、选项卡片、画布视图 |
| 协作 | 专家库 · 专家讨论 · 任务方案 | 角色库、圆桌多 Agent 讨论、把讨论结论落成任务方案 |
| 任务 | 定时任务 | cron 与自然语言建任务、执行历史、前后置钩子、结果投递 |
| 档案 | 提示词 · 知识库 · 留痕录 | `SOUL.md`、`MEMORY.md`、`AGENTS.md` 都是纯文本，技能与记忆直接改 |
| 能力 | 消息渠道 · 外接工具 · 工具集 · 技能 | 逐项启用、关闭、配置，对应上游 toolsets 与通道接口 |
| 模型 | 概览 · 模型选择 · 服务商 · 能力后端 · 配置 | 供应商凭据、模型池、按域绑定生图与语音等能力后端 |
| 维护 | 运行状态 · 用量统计 · 本地版本 | 进程状态、日志按级别与组件筛、每次会话 token 用量 |
| 设置 | 偏好设置 | 主题与界面偏好 |

<table>
<tr>
<td width="50%"><img src="promo/img/collab.jpg" alt="专家库页面"></td>
<td width="50%"><img src="promo/img/tools.jpg" alt="技能与工具页面"></td>
</tr>
<tr>
<td align="center"><sub>协作 · 315 位专家，按分类筛，一键加入讨论</sub></td>
<td align="center"><sub>能力 · 二十多个工具集逐个开关，状态写在卡上</sub></td>
</tr>
</table>

### 几个重做过的机制

**加载与缓存。** 没有模块系统，改任何 JS/CSS 都要同步改引用上的 `?v=`（文件 md5 前 8 位），否则浏览器继续用旧文件。`dev/hermes-dev.sh deploy ui` 会比对并部署整组文件。

**移动端。** 导航两级折叠、胶囊栏横滑、`100dvh` 动态视口、弹窗独立滚动与底部安全区。这块主要在 `panel-navigation.js` 与 `css/base.css`。

**语音。** 录音、朗读、开口打断在 `js/chat/message-ops.js`，后端是 `app/server/panel-speech*.js`、`panel-voice-settings.js`，配置走 `/api/voice/config`，识别链路有兜底和回归测试。

**画布。** `js/chat/canvas.js` + `css/canvas.css`。它是**会话的一种呈现方式**，不是新页面也不是新会话体系：左侧会话树、顶部 header、发送链路全部沿用原实现，`#chatBody` 保留在 DOM 里只是隐藏。一轮对话画成一个节点加一条连线；点一张图即引用它，换生图模型后基于它生成下一张；同一节点能分出多条枝；支持拖拽、缩放 0.25–2.5、上→下 / 左→右两种布局。生图模型来自 `/api/workspace-ui/image-targets`，唯一真源是 `config.yaml` 的 `image_gen` 段。

**配置事务。** 写配置不是直接覆盖文件。`panel-config-txn.js` / `panel_config_txn.py` 带 `raw_hash` 冲突检测，`panel-config-recovery.*` 负责崩溃后恢复。Windows 上备份目录不可写时不再吞成「未收到保存确认」，而是直接回 403 并告诉你哪个目录、怎么授权。

**问题上报。** 面板里的「提个问题」先落本地收件箱，再同步到 GitHub Issue，两边都能追溯。反馈入口在维护板块，提交时自动带上版本、系统与来源，附件不带凭据。

## 怎么证明没改坏

拆单文件这种事最怕"看起来一样、其实少了半条逻辑"。所以每次改动都过三层：

| 层 | 手段 | 判据 |
|---|---|---|
| 静态 | `dev/arch_lint.py` | 命名与组件契约门禁；存量债登记在 `arch_lint_baseline.json`，新增违规必须处理 |
| 结构 | `dev/arch_symbols.py` | 全局符号集合与死代码体检；拆完符号数不能少 |
| 运行时 | `dev/ui_probe.py` | 计算样式与截图对比；先验资源加载、符号数、禁动画，防"两个空壳也全绿" |
| 生产 | `dev/verify-prod.sh` | 生产目录 vs git 快照逐文件比对（UI/server/bin + Python 层） |

`dev/tests/` 下 **192 个测试**（115 个 `.py`、76 个 `.mjs`、1 个 `.cjs`）以 `rebuild/` 回归为主。动过会话落盘或中断逻辑就顺手跑：

```bash
node dev/tests/interrupted-tools.cjs app/server/monitor.js
```

## 跑起来

### 一、Windows 桌面版

1. 从[下载目录](https://s27.fnnas.net/s/70bb0c6f5b3d4a88a6)取 `CHATES-Setup-1.20.4.exe` 与 `SHA256SUMS.txt`
2. `certutil -hashfile CHATES-Setup-1.20.4.exe SHA256` 对一遍
3. 双击安装，一路下一步；装完桌面一个图标
4. 打开后在「模型」页填供应商 API Key，启动服务

升级只换程序本体，`%APPDATA%\CHATÈS` 里的 `.env`、`config.yaml`、笔记、知识库一个字节不动。

### 二、fnOS 上装 `.fpk`（常规用法）

前提：fnOS、约 1 GB 空间、先在应用中心装好 `nodejs_v24`（包清单不声明这个依赖，不会自动装）。

1. 同一个[下载目录](https://s27.fnnas.net/s/70bb0c6f5b3d4a88a6)取 `chates_1.20.4.fpk`
2. `sha256sum -c` 对一遍校验值
3. 应用中心 → 右上角「手动安装」→ 选文件 → 下一步到底；装完应用名是 `chates`
4. 桌面图标打开面板，「模型」页填供应商 API Key，启动服务

包内不带任何密钥，装完必须自己配；不配模型时网关不起属正常。

运行时：面板走应用运行目录下的 `chates.sock`；`monitor.js` 把请求代理到 Gateway。写操作（改配置、重启进程）必须带 `monitor.token`，只读查询免鉴权，token 每次启动重新生成。

### 三、本地起面板（不依赖 fnOS）

```bash
node bin/hermes-panel.mjs --port 9000 --no-open
```

纯 TCP 模式拉起 `app/server/monitor.js`，默认端口 8650、自动找空闲端口；数据目录默认 `~/.hermes-panel/data`，与代码分开，升级不丢配置。`--data`、`--var` 可覆盖。完整对话能力仍需要本机有 Hermes 运行时与 Python venv。

### 四、只调前端样式

```bash
dev/hermes-dev.sh preview 8917
```

只读 `app/ui` 起静态服务，不碰后端与生产数据。能看到配色、间距、侧栏、按钮、空状态；看不到需要真实数据才渲染的气泡和工具卡。带数据验收用 `dev/hermes-dev.sh probe`。

页面里有 `<base href="/app/hermes-agent/">`，用 `file://` 直接打开会把相对路径解析错、资源全 404。验证必须走 HTTP。

## 仓库结构

```
app/ui/       前端：静态 HTML + CSS + 原生 JS（96 个 js，顺序写在 index.html）
app/server/   后端：按域拆 63 个 panel-*.js，monitor.js 保留跨域编排
app/python/   对上游 Python 层的补丁（editable 安装，改文件 + 重启生效）
dev/          开发脚本、门禁、192 个测试
docs/         项目主页（单文件自包含）与架构、下载说明
electron/     Windows 桌面壳与 NSIS 安装器
win/          Windows 侧的批处理与更新脚本
promo/        README 与主页用的截图
```

## 想一起改？

先说清楚要什么、不要什么，省得你写完才被打回。

**受欢迎的**：能用一句话说清症状的 bug 修复、面板本身的交互/排版/性能改进、文档订正。

**直接拒的**：纯格式化 PR（只改空格引号，会把 `git blame` 冲烂）、引入外部 CDN 或在线字体（自托管要断网可用）、一个 PR 混三件事、把密钥或内网地址带进来。

**先开 issue 商量**：跨文件重构、改公开接口、新增依赖、超过 300 行的改动。

规矩全文在 [CONTRIBUTING.md](CONTRIBUTING.md)，最该看的三节：

- [Commit 怎么写](CONTRIBUTING.md#二commit-怎么写) —— 标题 72 字以内，大改动必须写清「为什么改 / 改成什么 / 怎么验证」
- [PR 怎么提](CONTRIBUTING.md#三pr-怎么提) —— 一个 PR 一件事，贴命令输出而不是「本地测过了」
- [评审看什么](CONTRIBUTING.md#五评审看什么) —— 只看四件事：意图读不读得懂、有没有验证证据、有没有破坏已有契约、diff 里有没有夹带

PR 进来会自动跑三道检查：commit 说明是否说得清、架构门禁（只拦新增，存量 115 条不追究）、敏感信息与外链扫描。

## 改代码

### 前端四条规矩

以下路径均相对 `app/ui/`。

1. **分层**：`core/`（基础设施）→ `chat/`（对话）→ `panels/`（页面）→ `panel-*.js`（历史补丁）。顺序写死在 `index.html`，不能随便挪。
2. **组件**：新代码用 `ui.modal()` / `ui.confirm()` / `ui.toast()`（`js/core/ui-kit.js`），不要手拼弹窗，不要用原生 `confirm()` / `alert()`。
3. **加页面**：在 `panel-navigation.js` 的 `groups` 加一条 + 在 `index.html` 建静态 `#page-<id>` 容器 + 一个属主 JS。页面容器不许运行时 `createElement` 造。
4. **改完改版本号**：JS/CSS 引用上的 `?v=` 同步改；颜色走 `var(--token)`，别写死 hex。

改之前先对照 `app/ui/ARCHITECTURE.md`：板块→页面→属主文件的表、覆盖链（哪些符号改了不生效）、组件契约都在里面。里面的数字是快照，以脚本输出为准。

### 后端

接口按域拆在 `app/server/panel-<域>.js`（63 个），多数以 handler 工厂导出，外部依赖（Python 路径、数据根、队列文件、`checkToken`）以参数注入，便于单测。`monitor.js` 保留跨域编排：进程管理、渠道接入、自动更新。Python 层补丁在 `app/python/`（4 个 `panel*.py`），editable 安装，改文件 + 重启即生效。

### 部署与验证

`dev/hermes-dev.sh` 是唯一入口，身份与提权在脚本内处理：

```bash
dev/hermes-dev.sh status                         # 进程 / 端口 / 运行文件 vs 源码 md5
dev/hermes-dev.sh check app/ui/js/chat/tabs.js   # node --check / py_compile
dev/hermes-dev.sh deploy ui                      # 或 server / python
dev/hermes-dev.sh probe --viewports 375x812,414x896,1440x900
dev/hermes-dev.sh restart
dev/hermes-dev.sh logs 80
```

`deploy server` 和 `restart` 会掐断活跃会话；UI 改动刷新浏览器即可。不要 `pkill gateway`，不要 root 直跑 `cmd/main`，不要用 `monitor-api restart` 冒充 monitor 已生效——它只重启 gateway 和 dashboard，monitor 主进程还跑着旧代码。

### 检查器与发布

| 脚本 | 作用 |
|---|---|
| `dev/arch_lint.py` | 命名与组件契约门禁 |
| `dev/arch_symbols.py` | 全局符号集合与死代码体检 |
| `dev/ui_probe.py` | 计算样式与截图对比 |
| `dev/verify-prod.sh` | 生产目录 vs git 快照逐文件比对 |
| `dev/deploy-workspace.sh` | 按 `git ls-files` 铺完整运行树，保留文件属主 |
| `dev/make-release.sh` | `git archive` 出干净源码包，硬检查排除 `.env` / `node_modules` / `__pycache__` |
| `release-tools/build-fpk.sh` | 打 fnOS `.fpk`，出厂前跑敏感词与骨架审计 |
| `release-tools/build-exe.sh` | 打 Windows `.exe`，打包后做同一套脱敏检查 |
| `.github/workflows/release.yml` | 由 GitHub Actions 自动出 fpk + exe 并挂 Release |

发版流程：推脱敏仓 → CI 打包 → Release 出资产。本地不打分发件，出厂的配置骨架由 `release-tools/make-data-skeleton.py` 生成并硬审计（`mcp_servers` 为空、无内网地址、无真实凭据）。

## 已知限制

- 前端没有模块系统，靠 `<script>` 顺序。漏改 `?v=` 等于没改。
- `js/panel-*.js` 历史模块与 `js/panels/` 职责重叠，动同一面板要两处都看。部分页面有多个补丁层，存在被后面文件覆盖的符号。
- `app/server/monitor.js` 仍是 576 KB 单文件（跨域编排，故意没拆），单测困难。
- 原生 `confirm()` / `alert()` 仍有残留，数量以 `dev/arch_lint.py` 输出为准。
- 画布节点树按会话存在浏览器 `localStorage`，换浏览器或清缓存不携带；生成的图片本身走工作区目录。
- 画布是会话视图切换，不新增后端会话类型。生图依赖 `config.yaml` 的 `image_gen` 配置。
- Windows 面板的配置备份目录若由高权限装出来，当前用户可能没有写权限；症状是保存报 403，修法见 `docs/` 与安装器说明。
- 部分运维脚本写死 fnOS 路径，非 fnOS 环境请用 `bin/hermes-panel.mjs`。
- 文档之间偶有数字出入（页面数、历史模块数）。以代码和检查器输出为准。

## 文档

| 文件 | 用途 |
|---|---|
| `app/ui/ARCHITECTURE.md` | 前端架构唯一真源：板块→页面→属主、覆盖链、组件契约、已知债 |
| `app/ui/README.md` | 前端文件索引与加载顺序 |
| `docs/ARCHITECTURE.md` | 项目主页与 `docs/index.html` 的结构说明 |
| `docs/DOWNLOAD.md` | 安装包下载与校验、国内加速链路说明 |
| `dev/外部改造手册.md` | 真机上改 UI / monitor / Python 的命令、调试、备份与回滚 |
| `JOURNEY.md` | 为什么这么拆、试过哪些没成 |
| `UPDATE-LOG.md` | 逐版本改动记录 |
| `WORK-MEMORY.md` | 工作记忆：当前进度、待办、约定 |
| `CHANGELOG*.md` | 上游 Hermes Agent 的变更 |
| `AGENTS.md` / `CLAUDE.md` | 给 AI 助手看的仓库约定 |

## 上游与许可

- [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) — Agent 运行时本体
- [veenyi/fnos-hermes-agent](https://github.com/veenyi/fnos-hermes-agent) — fnOS `.fpk` 打包与基座适配
- fnOS / 飞牛 OS — 应用运行环境

本仓库以 **GPL-3.0** 发布（见 `LICENSE`）。面板之外的 Hermes 内核、模型服务与消息平台由各自上游提供。
