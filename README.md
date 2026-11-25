<p align="center">
  <img src="app/ui/images/logo-cat-full-dark.png" alt="CHATÈS — 一只猫拉着小车" width="300">
</p>

<h1 align="center">CHATÈS</h1>

<p align="center">
  <b>把一台 NAS 变成你自己能拆能改的 AI 工作台</b><br/>
  <sub>Hermes Agent 内核 + 自建控制面板 + Windows 安装器 + fnOS fpk · 静态 HTML + 原生 JS · 无打包器 · 无 CDN</sub>
</p>

<p align="center">
  <img alt="kernel" src="https://img.shields.io/badge/kernel-0.20.0-71dbc0">
  <img alt="panel" src="https://img.shields.io/badge/panel-0.21.149-5e64f3">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20fnOS-2f3a46">
  <img alt="license" src="https://img.shields.io/badge/license-MIT%20%2B%20GPL--3.0-green">
</p>

<p align="center">
  <a href="win/使用说明.txt">Windows 安装说明</a> ·
  <a href="docs/ARCHITECTURE.md">仓库结构</a> ·
  <a href="https://github.com/NousResearch/hermes-agent">上游 Hermes</a>
</p>

---

## 这是什么

这是 [Nous Research 的 Hermes Agent](https://github.com/NousResearch/hermes-agent) 的**个人改造分支**，
跑在我自己的一台 fnOS NAS 上，日活在用。这个仓库是它的完整可运行版本，不是一个「demo 版」或「精简版」。

和上游的差别有三块：

| 块 | 在哪 | 是什么 |
|---|---|---|
| **内核改造** | 仓库根 | 27 个 commit，44 个文件。Windows 兼容层、面板配置事务、会话状态拆分、cron 与 gateway 的若干修复 |
| **控制面板** | `app/ui/`、`app/server/` | 从 53 个 `panel-*.js` 责任链重写出来的整套面板，静态 HTML + 原生 JS，无打包器、无 CDN。<br/>面板原委在 [fnos-hermes-panel](https://github.com/vector9584/fnos-hermes-panel) |
| **安装器** | `win/` | Windows 一键安装 + 版本化更新，`install.ps1` / `update.ps1` |

面板和内核**放在同一个仓库**，因为它们必须同版本一起升级：面板靠相对路径找内核文件
（`app/home/data/venv`、`app/server`），拆成两个仓库就会装出一个半残的东西。

### 一个仓库，三种产物

以前面板是单独一个仓（`fnos-hermes-panel`），现在并进来了，因为面板靠相对路径找内核，拆开必装出半残。

| 目录 | 是什么 |
|---|---|
| `agent/` `hermes_cli/` `gateway/` … | Hermes 内核（官方 0.20.0 + 本地改造） |
| `app/ui` `app/server` | 控制面板（静态 HTML + 原生 JS，无打包器） |
| `app/python` | 对上游 Python 层的补丁层 |
| `win/` | Windows 安装器、更新器、使用说明 |
| `fpk-bin` `fpk-cmd` `fpk-init` `fpk-wizard` `manifest` `build-slim.sh` | fnOS fpk 打包链 |
| `JOURNEY.md` `UPDATE-LOG.md` `CHANGELOG.md` | 改造历程与版本记录 |

**fpk 也在 Release 里**：`v0.21.149` 那个 tag 挂的是 `hermes-agent_0.21.149.fpk`，给 NAS 装。

### 装哪儿

- **Windows**：下 `HermesWin-Setup-*.zip`，解压双击 `安装(双击).bat`，桌面出一个图标
- **fnOS**：下 `hermes-agent_*.fpk`，应用中心手动安装

两边共用同一个内核和面板，只是打包方式不同。

## 装到 Windows

不需要 WSL、不需要 Git、不需要管理员权限。下载

**[HermesWin-Setup-0.20.0-win.2.zip](https://github.com/vector9584/chates/releases/latest)**

解压，双击 `install.bat`。装完桌面会有两个快捷方式：面板、终端。

装在 `%LOCALAPPDATA%\HermesWin`，布局刻意照 NAS 的 APP_DIR 摆：

```
%LOCALAPPDATA%\HermesWin\
  app\hermes-src\     内核源码（本仓库的 clone/解包）
  app\server\ app\ui\  面板
  app\home\data\     你的数据：config.yaml / .env / skills / knowledge / venv
  app\var\            运行时 token 与日志
```

**更新**：双击 `检查更新.bat`，或者

```powershell
powershell -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\HermesWin\update.ps1"
```

更新走 GitHub archive zip 下载 + 覆盖内核目录，比对 `win/version.json` 的版本号决定要不要动。
用镜像源是因为实测这台机器直连 `github.com` 超时（12s 失败），而 `gh-proxy.com` / `ghfast.top` /
`codeload` 都通。

## 装到 fnOS

面板那侧的 fpk 打包与工具链在 [fnos-hermes-panel](https://github.com/vector9584/fnos-hermes-panel)，
内核在 fnOS 上就是本仓库的源码写进 `$TRIM_PKGHOME`。这一路没有做成双击安装，因为 fnOS 上装应用
得走应用中心或 fpk 手动安装。

## 敏感信息怎么处理

**`.env`、API key、token、密码一律不入库**，`.gitignore` 卡死。仓库里只有代码和示例配置。

你要的 key 装好之后自己在 `app\home\data\.env` 里填，或者用 `hermes setup` 走一遍向导。
skills 和 knowledge 是个人数据，同样不入库——安装包里的 `data.zip` 是给同一个人换机器用的，
不在这个 git 仓库里。

## Windows 上踩过的坑（已经修好，写在这里省你一次）

- 面板配置事务层用 `fcntl.flock` 加锁，Windows 没有这个模块 → 条件导入 + `msvcrt.locking` 垫片；
  `os.O_NOFOLLOW` 同样要 `getattr` 兜底
- `panel-echo/auxiliary/cron/files.py` 和 `panel_lifecycle.py` 的 `import fcntl`、`import pwd` 同理
- 往 `@contextmanager` 修饰的函数上方插辅助函数时，别插在装饰器和 `def` 之间——装饰器会挂到辅助函数上，
  被修饰的函数变成普通生成器，运行时报 `'generator' object does not support the context manager protocol`
- 面板进程不能用 `Start-Process` 拉起（SSH 断开会被带走），改走计划任务 `schtasks /Run`
- `.ps1` 必须 UTF-8 **带 BOM**，且只加一次；双 BOM 会让 `param()` 解析失败
- `$ErrorActionPreference = "Stop"` 会被 uv 的 stderr 触发 `NativeCommandError`，用 `Continue` + 查 `$LASTEXITCODE`

## 已知还瘸的地方

- gateway 不会自动起（面板显示「模型配置尚未收到启动确认」），渠道要在面板里手动开一次
- fnOS 专属的脚本（`fnos_trash.py`、`trim-cli`、`/vol1` 路径）在 Windows 上无效，删除类操作要另配
- Windows 侧改的 skills 不会回流到 NAS，两边数据靠手工同步

## 授权

内核继承上游 [MIT](LICENSE)。`app/` 下面的面板代码来自
[fnos-hermes-panel](https://github.com/vector9584/fnos-hermes-panel)，GPL-3.0。
两者混在一个仓库里，各自的原授权不变：改内核按 MIT，改面板按 GPL-3.0。

---

下面这段是上游 README 的原文，内核本身的能力说明都在这里。

---

**The self-improving AI agent built by [Nous Research](https://nousresearch.com).** It's the only agent with a built-in learning loop — it creates skills from experience, improves them during use, nudges itself to persist knowledge, searches its own past conversations, and builds a deepening model of who you are across sessions. Run it on a $5 VPS, a GPU cluster, or serverless infrastructure that costs nearly nothing when idle. It's not tied to your laptop — talk to it from Telegram while it works on a cloud VM.

Use any model you want — [Nous Portal](https://portal.nousresearch.com), OpenRouter, OpenAI, your own endpoint, and [many others](https://hermes-agent.nousresearch.com/docs/integrations/providers). Switch with `hermes model` — no code changes, no lock-in.

<table>
<tr><td><b>A real terminal interface</b></td><td>Full TUI with multiline editing, slash-command autocomplete, conversation history, interrupt-and-redirect, and streaming tool output.</td></tr>
<tr><td><b>Lives where you do</b></td><td>Telegram, Discord, Slack, WhatsApp, Signal, and CLI — all from a single gateway process. Voice memo transcription, cross-platform conversation continuity.</td></tr>
<tr><td><b>A closed learning loop</b></td><td>Agent-curated memory with periodic nudges. Autonomous skill creation after complex tasks. Skills self-improve during use. FTS5 session search with LLM summarization for cross-session recall. <a href="https://github.com/plastic-labs/honcho">Honcho</a> dialectic user modeling. Compatible with the <a href="https://agentskills.io">agentskills.io</a> open standard.</td></tr>
<tr><td><b>Scheduled automations</b></td><td>Built-in cron scheduler with delivery to any platform. Daily reports, nightly backups, weekly audits — all in natural language, running unattended.</td></tr>
<tr><td><b>Delegates and parallelizes</b></td><td>Spawn isolated subagents for parallel workstreams. Write Python scripts that call tools via RPC, collapsing multi-step pipelines into zero-context-cost turns.</td></tr>
<tr><td><b>Runs anywhere, not just your laptop</b></td><td>Seven terminal backends — local, Docker, SSH, Singularity, Modal, Daytona, and Vercel Sandbox. Daytona and Modal offer serverless persistence — your agent's environment hibernates when idle and wakes on demand, costing nearly nothing between sessions. Run it on a $5 VPS or a GPU cluster.</td></tr>
<tr><td><b>Research-ready</b></td><td>Batch trajectory generation, trajectory compression for training the next generation of tool-calling models.</td></tr>
</table>

---

## Quick Install

### Linux, macOS, WSL2, Termux

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

### Windows (native, PowerShell)

> **Heads up:** Native Windows runs Hermes without WSL — CLI, gateway, TUI, and tools all work natively. If you'd rather use WSL2, the Linux/macOS one-liner above works there too. Found a bug? Please [file issues](https://github.com/NousResearch/hermes-agent/issues).

Run this in PowerShell:

```powershell
iex (irm https://hermes-agent.nousresearch.com/install.ps1)
```

The installer handles everything: uv, Python 3.11, Node.js, ripgrep, ffmpeg, **and a portable Git Bash** (MinGit, unpacked to `%LOCALAPPDATA%\hermes\git` — no admin required, completely isolated from any system Git install). Hermes uses this bundled Git Bash to run shell commands.

If you already have Git installed, the installer detects it and uses that instead. Otherwise a ~45MB MinGit download is all you need — it won't touch or interfere with any system Git.

> **Android / Termux:** The tested manual path is documented in the [Termux guide](https://hermes-agent.nousresearch.com/docs/getting-started/termux). On Termux, Hermes installs a curated `.[termux]` extra because the full `.[all]` extra currently pulls Android-incompatible voice dependencies.
>
> **Windows:** Native Windows is fully supported — the PowerShell one-liner above installs everything. If you'd rather use WSL2, the Linux command works there too. Native Windows install lives under `%LOCALAPPDATA%\hermes`; WSL2 installs under `~/.hermes` as on Linux.

After installation:

```bash
source ~/.bashrc    # reload shell (or: source ~/.zshrc)
hermes              # start chatting!
```

### Troubleshooting

#### Windows Defender or antivirus flags `uv.exe` as malware

If your antivirus (Bitdefender, Windows Defender, etc.) quarantines `uv.exe` from the Hermes `bin` folder (`%LOCALAPPDATA%\hermes\bin\uv.exe`), this is a **false positive**. The file is Astral's `uv` — the Rust Python package manager Hermes bundles to manage its Python environment. ML-based antivirus engines commonly flag unsigned Rust binaries that download and install packages.

**To verify your copy is authentic:**

```powershell
# Install GitHub CLI if needed
winget install --id GitHub.cli

# Login to GitHub
gh auth login

# Run verification
$uv = "$env:LOCALAPPDATA\hermes\bin\uv.exe"
$ver = (& $uv --version).Split(' ')[1]
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$zip = "$env:TEMP\uv.zip"
Invoke-WebRequest "https://github.com/astral-sh/uv/releases/download/$ver/uv-x86_64-pc-windows-msvc.zip" -OutFile $zip -UseBasicParsing
gh attestation verify $zip --repo astral-sh/uv
Expand-Archive $zip "$env:TEMP\uv_x" -Force
(Get-FileHash "$env:TEMP\uv_x\uv.exe").Hash -eq (Get-FileHash $uv).Hash
```

If attestation says "Verification succeeded" and the last line prints `True`, you're good.

**To whitelist Hermes:**
- **Windows Defender:** Run PowerShell as Admin → `Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\hermes\bin"`
- **Bitdefender:** Add an exception in the Bitdefender console (Protection > Antivirus > Settings > Manage Exceptions)
- Whitelist the **folder**, not the file hash — Hermes updates `uv` and the hash changes every version

For more context, see the upstream Astral reports: [astral-sh/uv#13553](https://github.com/astral-sh/uv/issues/13553), [astral-sh/uv#15011](https://github.com/astral-sh/uv/issues/15011), [astral-sh/uv#10079](https://github.com/astral-sh/uv/issues/10079).

---

## Getting Started

```bash
hermes              # Interactive CLI — start a conversation
hermes model        # Choose your LLM provider and model
hermes tools        # Configure which tools are enabled
hermes config set   # Set individual config values
hermes config get   # Print individual config values
hermes gateway      # Start the messaging gateway (Telegram, Discord, etc.)
hermes setup        # Run the full setup wizard (configures everything at once)
hermes claw migrate # Migrate from OpenClaw (if coming from OpenClaw)
hermes update       # Update to the latest version
hermes doctor       # Diagnose any issues
```

📖 **[Full documentation →](https://hermes-agent.nousresearch.com/docs/)**

---

## Skip the API-key collection — Nous Portal

Hermes works with whatever provider you want — that's not changing. But if you'd rather not collect five separate API keys for the model, web search, image generation, TTS, and a cloud browser, **[Nous Portal](https://portal.nousresearch.com)** covers all of them under one subscription:

- **300+ models** — pick any of them with `/model <name>`
- **Tool Gateway** — web search (Firecrawl), image generation (FAL), text-to-speech (OpenAI), cloud browser (Browser Use), all routed through your sub. No extra accounts.

One command from a fresh install:

```bash
hermes setup --portal
```

That logs you in via OAuth, sets Nous as your provider, and turns on the Tool Gateway. Check what's wired up any time with `hermes portal info`. Full details on the [Tool Gateway docs page](https://hermes-agent.nousresearch.com/docs/user-guide/features/tool-gateway).

You can still bring your own keys per-tool whenever you want — the gateway is per-backend, not all-or-nothing.

---

## CLI vs Messaging Quick Reference

Hermes has two entry points: start the terminal UI with `hermes`, or run the gateway and talk to it from Telegram, Discord, Slack, WhatsApp, Signal, or Email. Once you're in a conversation, many slash commands are shared across both interfaces.

| Action                         | CLI                                           | Messaging platforms                                                              |
| ------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------------- |
| Start chatting                 | `hermes`                                      | Run `hermes gateway setup` + `hermes gateway start`, then send the bot a message |
| Start fresh conversation       | `/new` or `/reset`                            | `/new` or `/reset`                                                               |
| Change model                   | `/model [provider:model]`                     | `/model [provider:model]`                                                        |
| Set a personality              | `/personality [name]`                         | `/personality [name]`                                                            |
| Retry or undo the last turn    | `/retry`, `/undo`                             | `/retry`, `/undo`                                                                |
| Compress context / check usage | `/compress`, `/usage`, `/insights [--days N]` | `/compress`, `/usage`, `/insights [days]`                                        |
| Browse skills                  | `/skills` or `/<skill-name>`                  | `/<skill-name>`                                                                  |
| Interrupt current work         | `Ctrl+C` or send a new message                | `/stop` or send a new message                                                    |
| Platform-specific status       | `/platforms`                                  | `/status`, `/sethome`                                                            |

For the full command lists, see the [CLI guide](https://hermes-agent.nousresearch.com/docs/user-guide/cli) and the [Messaging Gateway guide](https://hermes-agent.nousresearch.com/docs/user-guide/messaging).

---

## Documentation

All documentation lives at **[hermes-agent.nousresearch.com/docs](https://hermes-agent.nousresearch.com/docs/)**:

| Section                                                                                             | What's Covered                                             |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [Quickstart](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart)                 | Install → setup → first conversation in 2 minutes          |
| [CLI Usage](https://hermes-agent.nousresearch.com/docs/user-guide/cli)                              | Commands, keybindings, personalities, sessions             |
| [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)                | Config file, providers, models, all options                |
| [Messaging Gateway](https://hermes-agent.nousresearch.com/docs/user-guide/messaging)                | Telegram, Discord, Slack, WhatsApp, Signal, Home Assistant |
| [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)                          | Command approval, DM pairing, container isolation          |
| [Tools & Toolsets](https://hermes-agent.nousresearch.com/docs/user-guide/features/tools)            | 40+ tools, toolset system, terminal backends               |
| [Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)              | Procedural memory, Skills Hub, creating skills             |
| [Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)                     | Persistent memory, user profiles, best practices           |
| [MCP Integration](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)               | Connect any MCP server for extended capabilities           |
| [Cron Scheduling](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)              | Scheduled tasks with platform delivery                     |
| [Context Files](https://hermes-agent.nousresearch.com/docs/user-guide/features/context-files)       | Project context that shapes every conversation             |
| [Architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)             | Project structure, agent loop, key classes                 |
| [Contributing](https://hermes-agent.nousresearch.com/docs/developer-guide/contributing)             | Development setup, PR process, code style                  |
| [CLI Reference](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)                  | All commands and flags                                     |
| [Environment Variables](https://hermes-agent.nousresearch.com/docs/reference/environment-variables) | Complete env var reference                                 |

---

## Migrating from OpenClaw

If you're coming from OpenClaw, Hermes can automatically import your settings, memories, skills, and API keys.

**During first-time setup:** The setup wizard (`hermes setup`) automatically detects `~/.openclaw` and offers to migrate before configuration begins.

**Anytime after install:**

```bash
hermes claw migrate              # Interactive migration (full preset)
hermes claw migrate --dry-run    # Preview what would be migrated
hermes claw migrate --preset user-data   # Migrate without secrets
hermes claw migrate --overwrite  # Overwrite existing conflicts
```

What gets imported:

- **SOUL.md** — persona file
- **Memories** — MEMORY.md and USER.md entries
- **Skills** — user-created skills → `~/.hermes/skills/openclaw-imports/`
- **Command allowlist** — approval patterns
- **Messaging settings** — platform configs, allowed users, working directory
- **API keys** — allowlisted secrets (Telegram, OpenRouter, OpenAI, Anthropic, ElevenLabs)
- **TTS assets** — workspace audio files
- **Workspace instructions** — AGENTS.md (with `--workspace-target`)

See `hermes claw migrate --help` for all options, or use the `openclaw-migration` skill for an interactive agent-guided migration with dry-run previews.

---

## Contributing

We welcome contributions! See the [Contributing Guide](https://hermes-agent.nousresearch.com/docs/developer-guide/contributing) for development setup, code style, and PR process.

Quick start for contributors — use the standard installer, then work from the
full git checkout it creates at `$HERMES_HOME/hermes-agent` (usually
`~/.hermes/hermes-agent`). This matches the layout used by `hermes update`, the
managed venv, lazy dependencies, gateway, and docs tooling.

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
cd "${HERMES_HOME:-$HOME/.hermes}/hermes-agent"
uv pip install -e ".[all,dev]"
scripts/run_tests.sh
```

Manual clone fallback (for throwaway clones/CI where you intentionally do not
want the managed install layout):

Create the venv outside the cloned source tree — a venv inside the directory
the agent operates from can be wiped by a relative-path command the agent runs
against its own checkout, destroying the running runtime mid-session.

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
uv venv ~/.hermes/venvs/hermes-dev --python 3.11
source ~/.hermes/venvs/hermes-dev/bin/activate
uv pip install -e ".[all,dev]"
scripts/run_tests.sh
```

---

## Community

- 💬 [Discord](https://discord.gg/NousResearch)
- 📚 [Skills Hub](https://agentskills.io)
- 🐛 [Issues](https://github.com/NousResearch/hermes-agent/issues)
- 🔌 [computer-use-linux](https://github.com/avifenesh/computer-use-linux) — Linux desktop-control MCP server for Hermes and other MCP hosts, with AT-SPI accessibility trees, Wayland/X11 input, screenshots, and compositor window targeting.
- 🔌 [HermesClaw](https://github.com/AaronWong1999/hermesclaw) — Community WeChat bridge: Run Hermes Agent and OpenClaw on the same WeChat account.

---

## License

MIT — see [LICENSE](LICENSE).

Built by [Nous Research](https://nousresearch.com).
