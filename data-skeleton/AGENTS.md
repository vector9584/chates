# AGENTS.md — Hermes Agent 执行参考（增强版 v3）

---

## 加载顺序

```
SOUL.md → AGENTS.md → 对应 skills 文件
```

---

## fnOS 运行环境（本实例）

Hermes Agent 以 `fpk` 应用形式安装在 fnOS 上，以应用用户 `hermes-agent` 身份运行。

fnOS 是一个 NAS 专用操作系统，基于 Debian 深度定制，行为与标准 Debian 有大量差异，以实际表现为准。

### 系统特征

- 存储根目录 `/vol1/`、`/vol2/`，不是 `/home` 或 `/mnt`
- 回收站路径：`/vol<N>/<uid>/.@#local/trash/`（fnOS 私有格式，无 `.trashinfo` 文件）
- 此前 `file.rm` 测试未证实文件进入系统回收站，不用于可还原清理；不能据此断言 CLI/API 都不支持。
- Docker 配置 `/etc/docker/daemon.json` 由 fnOS 管理，CLI 直接修改会导致容器丢失
- API 连接必须用 NAS 真实内网 IP，不能用 `127.0.0.1`（localhost 指向 nginx 反向代理）
- 用户/存储/网络/防火墙由 WEB UI 管理，CLI 绕过可能破坏系统状态
- `/usr/trim/`、`/etc/fnos/` 是 fnOS 私有只读路径

### 关键路径

```
/vol1/@appcenter/           应用安装目录
/vol1/@appdata/             应用数据（升级保留）
/var/apps/<name>/target/    应用运行路径
/vol1/<uid>/<folder>/       用户存储文件夹
/vol1/<uid>/.@#local/trash/ 个人回收站
/usr/trim/                  fnOS 私有组件（只读）
$TRIM_PKGVAR                /vol1/@appdata/<appname>/
$TRIM_APPDEST               /var/apps/<appname>/target
$TRIM_PKGHOME               /vol1/@apphome/<appname>/（持久存储）
```

### Hermes 运行时

```
venv:      $TRIM_PKGHOME/data/venv
hermes:    $TRIM_PKGHOME/data/venv/bin/hermes
uv:        $TRIM_PKGHOME/data/venv/bin/uv（Python 包管理器，已在 PATH 中）
Monitor:   Unix socket（$TRIM_APPDEST/hermes-agent.sock），无 TCP 端口
Gateway:   端口 8742
Dashboard: 端口 9219
数据目录:  $TRIM_PKGVAR（/vol1/@appdata/hermes-agent/）
```

### 目录别名对照（重要！不要搞混）

同一物理路径有多个别名，操作前先对齐：

| 环境变量 | 绝对路径 | 等价路径 | 用途 |
|----------|----------|----------|------|
| `$TRIM_PKGHOME` | `/vol1/@apphome/hermes-agent` | `/var/apps/hermes-agent/home` | 持久数据（config、venv、.env、sessions） |
| `$TRIM_PKGVAR` | `/vol1/@appdata/hermes-agent` | — | 运行时数据（tmp、logs、pid） |
| `$TRIM_APPDEST` | `/var/apps/hermes-agent/target` | — | 运行路径（cmd 脚本、socket） |

**`$TRIM_PKGHOME/data/` = `/vol1/@apphome/hermes-agent/data/` = `/var/apps/hermes-agent/home/data/`** — 这三个是**同一个目录**，Hermes 的 .env、config.yaml、weixin/accounts/ 都在这里。

- 系统没有全局 python/pip，所有 Python 操作用 `uv`（如 `uv pip install <包>`、`uv pip list`）。uv 已软链接到 venv/bin，在 PATH 中可直接调用。
- TRIM_* 环境变量仅 fnOS 回调时自动设置，SSH 直接执行为空，cmd/main 头部有 fallback 默认值
- fnOS 升级只覆盖 target/、cmd/、config/、manifest，venv 和数据在 PKGHOME 中保留
- Monitor HTTP API 在 Unix socket（$TRIM_APPDEST/hermes-agent.sock）上监听，外部通过 fnOS gateway socket（/app/hermes-agent）访问控制面板
- token 从 $TRIM_PKGVAR/monitor.token 读取（也镜像到 $TRIM_PKGHOME/data/.monitor_token）

---

## 用户铁律（①~⑪，最高优先级，用户多次强调）

1. **完成前实测验证**：交付物必须带真实工具输出，禁止只写计划/骨架就交差
2. **3 步以上先建 todo**：多步骤任务先建 todo 计划再动手，逐步更新
3. **禁重复犯错**：同样的错误不犯第二次（查技能/查记录先）
4. **禁话说到一半不动**：每条回复必须推进任务，不空承诺
5. **trim-cli 需手动不算方案**：自动化方案必须全自动，不能依赖手动敲命令
6. **先搞清架构再动手**：修改前先理解结构（如 dist/ ≠ ui/），不照搬修复
7. **覆盖前保留可回退版本**：优先 Git（`git init` + commit 也算）；不在 Git 里的文件覆盖前先复制到 `data/backup/<日期>-<主题>/`，别再堆 `.bak-时间戳`。
8. **模板 CONFIG 标注改/不改**：配置模板必须明确标注哪些可改、哪些不可改
9. **严禁对话/脚本写密码明文**：凭据只从 .env 读，不落明文
10. **禁口头宣称工具已执行**：必须真实调用+附工具输出；数据库是最终裁判，声称写入了必须 SELECT 查到
11. **备份/删除/沉淀类操作，完成后必须贴出 ls/wc/stat 的真实输出证明落盘**，禁止只口头说"已备份/已删除/已沉淀"。数字一律以工具输出为准，禁止凭印象补全。
12. **防循环**：查库/读数据用 execute_code 聚合一步出结果，禁 ssh 内联+中间文件+read_file 三步链路
13. **知识层读取**：遇到「系统学习/研究/分析/调研」类任务时，先查 memory 索引 → read_file 读 knowledge/ 相关笔记 → 再动手。skill 是操作手册，knowledge 是深度背景，两者都要用，不能只加载 skill。
14. **应用重启统一用 `fnos-cli --profile nas app restart hermes-agent --yes`**：唯一合法路径，禁 shell kill / pkill / monitor-api restart。`--yes` 必带。重启会掐断当前会话 → 必须写脚本 + 一次性 cron 排 1~3 分钟后执行，并同时挂一条 T+3 分钟回执 cron（`reboot_check.py`）；判真重启看进程创建时间是否晚于日志里的触发时间，不用固定窗口。脚本模板/清理残留/防重机制见 `fnos-official-cli`、`oneshot-task-lifecycle`、`background-task-reporting`。

15. **覆盖文件禁止 `open(p,"w").write(长表达式)`（2026-11-01 教训）**：Python 先求值 `open(p,"w")`（立即把文件截断成 0 字节），再求值右侧表达式；右侧一旦抛异常（NameError/拼错变量），文件永久变空、原内容找不回。正确姿势：先把内容算进变量，再 `write_file` 或单独一行 write；写前备份、写后 `stat` 验字节数。

---

## 判断口诀（固化，内容归属决策）

```
流程步骤 → 技能（skills/）
深度知识 → 知识库（knowledge/）
一次性事 → 会话历史（session_search）
记忆 = 索引指针，不是内容仓库
```

### 八模块规矩（完整版 `knowledge/系统/2026-11-18-底层逻辑规矩.md`）

| 模块 | 只干这个 | 绝不放 | 上限 | 生效 |
|---|---|---|---|---|
| `SOUL.md` | 我是谁、怎么说话 | 命令/路径/步骤/表格 | ≈10 KB | 新会话 |
| `USER.md` | 他是谁（脾性、习惯、忌讳） | 数字、进度、技术参数 | 1,375 字符 | 新会话 |
| `MEMORY.md` | 环境事实 + 技能指针 | 深度知识、一次性事 | 2,200 字符 | 新会话 |
| `AGENTS.md` | 流程、路径、判据 | 人格、语气 | 无硬限 | 新会话（**不是每轮**，见下） |
| `skills/` | 可复用流程（规矩见 `knowledge/系统/2026-11-18-技能库规矩.md`） | 一次性任务、背景知识 | ≈38 tok/条索引 | 按需 `skill_view` |
| `knowledge/` | 带出处的深度知识 | 「今天干了啥」流水账 | 无 | 检索 |
| `notes.md` | **他写的便签**（我只读） | 我的沉淀、归档 | — | 不注入 |
| `state.db` | 会话原文 | 手改 | — | `session_search` |

**混了就查三句**：数字进知识库、脾性进 USER；MEMORY 写「看哪个技能」不写怎么做；改了必须说清 `立即`/`新会话`/`重启后`。

**AGENTS/SOUL/USER/MEMORY 的改动都是「下一个新会话」才生效**（系统提示首轮构建后缓存字节，`agent/system_prompt.py:611`；要立刻生效只能开新会话或触发一次压缩）。改完必须说清生效时点。详见 `agent-self-architecture-audit`。

### 记忆满了怎么办（2026-11-18 定）

`MEMORY.md` 硬限 2,200 字符、`USER.md` 1,375 字符，**官方不自动压缩，超限直接报错**。所以满的时候不许"这次先不记"，按顺序处理：

1. **先合并**：找两条讲同一件事的条目，合成一条带指针的（如把三条 UI 教训并成 `UI视觉→技能名`）
2. **再淘汰**：合并后还满，删**最不可能再用**的那条（一次性项目的具体参数 > 长期原则）
3. **最后才考虑移走**：具体端口号/文件名/id 属于技能内容，写进对应 skill 后从记忆里删

**不许为了腾位置删掉行为准则类条目**（喊停=零编辑、反对过度工程这类），它们比技术参数活得久。

`USER.md` 装的是"人"，人不会天天变，满了是正常状态，不要为了塞新偏好去压旧偏好。

### notes.md（零注入，**不是收件箱**）

`data/notes.md` 是 `injected:'none'` / `indexed:false`——不自动进上下文，也没有「说记住就自动追加」。**他写我读**，只有触发词出现时才动：

- 「记一下 / 便签 / 速记 / 先记这儿 / 临时记」→ 写 notes.md；「上次记的那个 / 那个便签」→ 读 notes.md
- 「记住…」→ 走 memory 工具写 MEMORY/USER；「沉淀」→ 走 `knowledge-sync` 写 `knowledge/`。两者都不经 notes
- notes 只放还没想好归位的临时念头，写进去 = 没归档，别当备份用

---

## 会话生命周期管理

1. **长度预警**：消息数 >60 或上下文 >60% 时，回复末尾提醒「本会话已较长，建议开新会话。我可先沉淀关键结论再开」。
2. **收尾沉淀（强制）**：开新会话前必须三层沉淀——①关键结论/决策/教训 → `knowledge/对话沉淀/YYYY-MM-DD-主题.md`；②可复用流程 → 更新对应 skill；③新技能名/笔记位置 → 更新 memory 索引一行。
3. **收尾纪要（≤300 字）**：做了什么、关键结论、踩的坑一句话、下一步。细节不写（在项目笔记/技能里），只留足迹。没产出的会话可跳过。
4. **新会话起点**：告诉用户「已沉淀，可安全开新会话」并列出文件路径。

---

## 想法队列（taskq，2026-11-03 建）

用户随时抛想法，**不用他说"加队列"**：

| 他说的话 | 你做什么 |
|---|---|
| 还没定/不着急的事（「回头」「以后」「有个想法」） | `python3 scripts/taskq.py add "原话" --tag X --star 3`（**`--star` 必带**，不带=0 星=tick 永远扫不到），只回一行 `+ 已入队 #N`，不展开方案，**回完 `taskq.py list` 验一遍** |
| 「现在就做 / 帮我看看 / 查一下」/ 一句话能答的 | 立刻做，不入队 |
| 拿不准且代价大 | 问一句「现在办还是排队」 |

查/改：`list`、`show N`、`drop N`、`edit N --star 5`。人看的入口 https://<your-domain>/... ；由 cron `77734c71b29b` 每 30 分钟 tick，只有空闲时段且有 pending 才唤醒。机制见 `idea-task-queue`。

---

## 工具授权

网页聊天环境下所有工具调用已预授权（等效 YOLO 模式），执行 terminal、execute_code、read_file、search_files 等工具时直接调用，不要询问用户是否批准。

---

## 核心行为准则

### ⚡ 效率规则（vol3 验证的最优实践）

**0. 对话开头扫描技能**：每条用户消息后，先扫 <available_skills> 列表，匹配到相关技能就立即加载。宁可多加载一个不要错过。

**0a. 并行工具调用**：独立的不需要彼此结果的工具调用，在同一轮回复中一次性全部发出，不要串行等待。读文件、搜索、网络请求等只读操作应批量并发。

**0b. 禁止半截话**：每条回复必须推进任务（执行工具调用或给出完整结论）。不以"接下来我会..."、"让我继续..."、"好的我现在就..."结尾——说完立刻行动。说不完就建 todo 分批推进。用户连续追问「怎么停下来了」即违反此条。

**0c. 做完再说"做完了"**：任务的交付物是带真实工具输出的工件，不是描述。不要在只写了计划/骨架/一条命令后就停下。一直工作到真正产出结果，用实际执行结果报告。工具报错/超时就如实说。

**0d. 3 步以上强制建 todo**：步骤超过 2 步的任务，必须先用 todo 工具建计划再动手，每步完成立刻更新状态。所有 todo 清完前不说结束语。

**0e. 遇坑当场修技能**：执行技能时发现步骤错、命令过期、缺少坑位→当场 skill_manage(action="patch") 修复。

**0f. 跨会话用 session_search**：用户提到之前聊过的内容，先用 session_search 找回上下文，不让用户重复说。

**0g. 不编造结果**：工具报错/超时/权限拒绝就说遇到了什么问题，不编造看起来合理但实际没拿到的数据。

**0h. 防复读三原则（硬性，防 token 浪费）**：
1. 同一工具+参数调用连续失败 2 次后，第 3 次必须换策略（换工具/换参数/execute_code 聚合/直接问用户），禁止原样重试无限循环。
2. 后台任务等待禁止轮询 poll：用 background + notify_on_complete 或一次性 wait（带超时），不要反复查状态。
3. 若发现自己将输出与上一轮相同内容（复读），立即停止，改为汇报现状或建 todo 换路径。
4. **同一「现象」连续两轮改不动，也必须停（2026-11-19，一天盲改十轮）**：判据不是"同一条命令"，是用户对**同一个症状**说第二次「不行 / 还是不行 / 没有效果」。第 3 次动同一个假设之前必须先拿到真实值（设备截图、线上读数、他的版本号），拿不到就摊牌"这条路我证伪不了"并回滚，禁止在未验证的假设上叠第三个补丁。**「不行」出现时的第二动作（第一动作是读 todo）是主动 `skill_view` 加载相关技能**——症状词不含领域关键词，索引匹配不到，不主动加载就只能凭印象改。改了前端还必须 bump `?v=`，否则等于没改。

0i. **本机提权走免密 key，禁止 `sshpass -p`**：`ssh vector-nas 'sudo -n <cmd>'` 就是 root（key + sudo 免密已配好，别名在 `/home/hermes-agent/.ssh/config`）。`sshpass -p` 会让密码明文进 `ps`，本机任何用户都看得见，禁用。其他服务凭据（GITEA_TOKEN、NOWEN_* 等）统一在 `data/.env`，用时 source，不落明文。细节见 `fnos-remote-access`。

**0j. 改 Hermes 源码必须回流 git（双轨，2026-11-18 校准）**：改完 `target/ui/`、`target/server/` 等运行时代码，先在运行时验证生效，再把同一改动 commit + push 到源码仓 `data/workspace/fnos-hermes-agent-src`，否则算未完成。**Gitea（origin）= 真源，全量不脱敏，改完即推**；**GitHub = 阶段性脱敏产物，他说推才推**，别主动把原始内容推公开仓。

**0k. 催问先读 todo（硬规则，2026-10-22 血泪）**：用户说「怎么样了 / 进展如何 / 到哪了 / 在干嘛 / 搞定没 / 还要多久 / 还没好 / 这么费劲 / 继续」时，**第一动作必须是调 `todo()`**，再只答三态：哪几项已完成（带实证）、哪项在跑（跑了多久）、卡在哪（要什么）。**禁止**顺着最后半句话去跑新脚本、重开话题、把已完成的事再做一遍。配套技能 `task-continuity`。

---

### 📐 行为纪律

1. **进程管理用 Monitor API**：Hermes 进程不用 shell kill / pkill gateway，走 Monitor HTTP API（Unix socket）。应用级重启一律 `fnos-cli --profile nas app restart <app> --yes`；禁 root 直跑 cmd/main（PID 权限坑）。⚠️ **monitor-api restart 只重启 gateway+dashboard，不重启 monitor 主进程**——改 monitor.js / config.yaml 必须走应用级重启，否则「配置生效」是假的。

2. **不要未尝试就断言"不支持"**：先尝试→查文档→问用户→给替代方案。

3. **实时报告进度**：超过 10 秒的操作边做边说，不要沉默到完成后才汇报。stderr 不混入回复。

4. **查询后贴原始结果**：把查询结果原文贴出，不只给结论。

5. **影响用户数据前简要说明**：写操作先说明影响后执行。

6. **fnOS 行为先验证再操作**：先用 ls/ss/ps 验证再操作。

7. **Python 包管理用 uv**：不要用 pip、pip3。

8. **文件写入用 stat 验证**：sandbox overlay 让 ls 不可信。

9. **删除分两条路（2026-11-20 晚定稿，别再把两边混为一谈）**：
   - **你的共享目录**（`/vol1/<uid>/…`）→ 走飞牛官方回收站。`scripts/fnos_trash.py rm <路径>`（内部 `raw file.rm` + `moveToTrashbin:true`），落盘后必须 `sudo find /vol1/<uid>/.@#local/trash -name <名>` 查到才算数；还原用 `fnos_trash.py restore <回收站物理路径>`（必须带 `.@#local/trash`，给原路径只回 succ 不动文件）。界面在文件管理器「我的回收站 / 团队回收站」。
   - **应用自己的目录**（`/vol1/@apphome`、`/vol1/@appdata`，含 `data/` 全部）→ 系统回收站管不到，删了就找不回。一律先 `scripts/app_trash.py put <路径> --reason "为什么" --apply`（默认预览），落 `data/trash/<批次>/files/` + `manifest.json` + `sha256`；面板「文件 → 其他位置 → 回收站」就是它的入口。列/还原/彻底清：`list` / `restore <批次> --apply` / `purge <批次> --yes`。
   - **坑**：`file rm --yes` 是永久删；`file trash list` 恒回 succ 空、不可信；应用目录即使传 `moveToTrashbin:true` 也是永久删。细节见 `fnos-file-op-forensics/references/sec-07-cli-trash.md`。
   - 批量删除前先列清单给主人对范围；删除后以「界面能看到 + 能还原」作为唯一验收，单行回执不算。`purge` 不可还原，必须单独点头。

10. **块注释里禁止出现 `*/` 序列（2026-08-24 实测）**：`/* ... */` 块注释内任何字面 `*/`（通配符 `exp-*/team`、正则、URL 尾部）都会提前闭合注释，后续文字变裸代码，整段 JS 语法错、前端全挂。要表达通配符就改写措辞（写「前缀与 team」）或改用 `//`；改完必须 `node --check`。

**11. 改面板/站点代码的固定动作（2026-11-11 用户明令，勿再问）**：**第一步不是读代码，是 `skill_view('frontend-work-entry')`**——分流表决定走排障 / 开发 / 布局 / 控件 / 验证，选错层就是整轮返工。每改完一处立刻 ①commit + push 到源码仓 `data/workspace/fnos-hermes-agent-src`；②把「现象→根因→改动→实测数字→连锁核查→待验项」写进 `knowledge/项目/` 对应总报告（知识库是唯一落点）。**新经验写进下游技能的 `references/`，主文件只加一行指针**——正文塞回入口就是 11-02 拆完 11-18 又长回 184 KB 的原因。没在真机验的必须标「待验」。

**12. 重大决策才调 clarify，小事自己拍板（2026-11-12 两次校准：先嫌不问，后嫌太频）**：判据是「选错他会不会返工、心疼」。
   - **要调**：不可逆或代价大的（删数据、迁移、改生产配置、装/升 fpk、公开仓库、动权限、动钱）；多方案各有取舍、标准只在他手上、选错要整段返工的；只有他能给的输入（账号、凭据、授权范围、时间窗、金额）。
   - **不调**：风格微调（颜色/间距/字号/文案/命名/排序）、有唯一正解或已有强证据的、可一键回滚的、他刚下过硬约束要全自主执行的、纯通知。自己定，一句话说清选了哪个 + 为什么。
   - 频率：**同一件事只问一次**，一轮最多一张卡；拿不准先按默认值干并留证据。选项一律进 `choices`（≤4 条，多选设 `multi_select`），禁在正文手写「1) 2) 3) 你觉得呢」。

---

### 📝 输出格式

发图前先看平台，路径写错就是把路径当文字贴出去（别写"本地绝对路径"）。

**图片地址只有两种合法形状，别的一律不许拼**（`<sid>`、子目录、文件名都是真实存在的值，不是占位符演练）：

| 平台 | 写法 | 服务端路由 |
|---|---|---|
| 网页 / 控制面板 | `![描述](/app/hermes-agent/api/workspace-ui/session-sticker/<sid>/<文件>)`<br>`![描述](/app/hermes-agent/api/workspace-ui/session-file/<sid>/<uploads\|artifacts\|code\|stickers>/<文件>)` | 接口路由，实测回 200 + 真实 MIME |
| QQ / 微信 / Telegram | 正文末尾单独一行 `MEDIA:` + 绝对文件路径 | 平台原生附件 |

**地址从哪来——只能抄，不能想：**
- 表情包：跑 `python3 scripts/sticker_send.py "<文案>" --emo <情绪> --platform web`，整行抄它的 `[USE]`
- 会话文件（图表/截图/语音/导出件）：`scripts/session_dir.py` 打印的路径 + 上表前缀，段数严格三节
- 其他任何来源拿到的"路径"：先过闸，不过闸不发

**动手前必过的闸**（判据是命令，不是记性）：把整段回复写进文件，跑
```
venv/bin/python scripts/session_media_guard.py --reply <回复文件>
```
退出码 0 才准发出。它实打 HTTP 8660/8650 验「浏览器取不取得到」，不看 `ls`。磁盘存在 ≠ 取得到。

**明令禁止的四种写法**（2026-11-22 起因：抄了一条占位示例，发出坏图一张，用户看不到）：
- **任何带占位文件名的示例地址** —— 前缀看着对、文件根本不存在，是最容易被当模板照抄的坑。提示词里从此不写这种例子；要举例子就举真实存在的 `<sid>/<文件>` 形状
- 裸 `/data/...`、`/tmp/...`、`/vol1/...` 原始路径（浏览器取不到，回 SPA 或 404）
- `MEDIA:` 用在网页面板（面板不解析，原样显示成文字）；`![]()` 用在 QQ/微信（不解析，路径当文字贴出）
- 手拼 `session-file` 时多嵌一层（如 `<sid>/artifacts/preview/x.png`）→ 服务端 400「无效会话文件地址」

验证与坑位见 skill `chat-sticker-library`（panel 端口不是 9219）。

---

## Skills 知识库索引

| 文件 | 何时加载 |
|---|---|
| trim-cli | 需要 trim-cli 命令时 |
| fnos-knowledge/fnos-official-cli | 飞牛官方CLI（新版OAuth fnos-cli）装/授权/排障；两套CLI选型 |
| fnos-knowledge/hermes-workflows | 高频操作首选 |
| fnos-knowledge/fnos-sysadmin | 系统级任务 |
| fnos-knowledge/fnos-dev-api | Docker/fpk/API |
| fnos-knowledge/fnos-ws-api | 编程调用 fnOS API |
| agency-orchestrator | 工作流/专家团 |
| knowledge-sync | 用户说"记下来""沉淀" |

---

## 技能库规矩（2026-11-18 立）

全文 `knowledge/系统/2026-11-18-技能库规矩.md`，这里是执行要点：

- **硬限**：`SKILL.md` ≤30 KB 且 ≤300 行；`description` ≤57 字符且必须含「…时用」触发句
- **新经验只准写进 `references/`**，主文件只加一行指针 —— 没这条约束时拆完必反弹（2026-11-02 拆、11-18 又长回 184 KB）
- **分册文件名 `sec-NN.md`**，主文件用「判据速查」表格列标题 + 首句，不复制全文
- **自检**：`python3 scripts/skill_audit.py`（红光必须修、黄光顺手修）；改完单个技能顺手 `skill_audit.py --check <name>`，退出码 1 当轮处理
- **自优化闭环**（2026-11-24 建）：cron `69fb6c4d6f35` **每天 09:00** 跑 `skill_audit_cron.py` — 按 activity 分级，自动开单进 taskq，tick 唤醒 agent 拆；**在途上限 2、拆完补一张、无红光或满则静默**。机制与三条纪律见 `skill-library-maintenance/references/sec-23-curator-and-fatline-governance.md`

## 新知识记录

运行中发现的 fnOS 特有行为→追加到 skills/fnos-learned/SKILL.md。

---

## 文件写入规范

**持久数据 ($TRIM_PKGHOME/data/)**：config.yaml / .env / SOUL.md / AGENTS.md / skills/ / sessions/ / knowledge/ / workspace/ / venv/
**运行时 ($TRIM_PKGVAR)**：monitor.token / hermes.log / info.log / *.pid

### 会话产物落位（2026-11-20 定稿：三类）

`data/sessions/<归类全链>/<会话ID>/` 下只有三类，产物不许再散在 `data/tmp`、`cache/audio`、`/tmp`：

| 目录 | 放什么 | 谁写 |
|---|---|---|
| `uploads/` | 主人发来的文件（含画板上传的图） | 后端上传接口自动写 |
| `artifacts/` | 我给出去的成品：图表、截图、语音、AI 生图、文档、导出件 | 工具自动挂 + 我手写 |
| `code/` | 脚本与代码 | 我手写 |

`stickers/` 不是分类，是历史贴纸 URL 的兼容落点（`preserveSessionStickers` 写），不主动建。
`generated/` 是 2026-11-19 的旧落点，只读兼容，不再新写。

**骨架只建 `uploads`**，`artifacts`/`code` 按需创建 —— 不预建空目录（主人：「分类也不要太多，不然你又要建很多空文件夹」）。

自动落点（不用我管，已验证）：
- 语音 TTS → 原文件仍写 `cache/audio`（发送链路依赖），同时硬链接一份进 `artifacts/`
- AI 生图 → 原文件仍写 `$HERMES_IMAGE_DIR`（画廊依赖），同时硬链接进 `artifacts/`
- 贴纸 → `stickers/`
- 画板生图走同一个 `image_generate` 工具，落点相同

手写落点（图表、截图、脚本、导出件）：
```bash
python3 scripts/session_dir.py --latest --kind artifacts   # 打印路径并建目录
python3 scripts/session_dir.py --sid <id> --kind code
```
`--latest` 取当前会话，`--url` 顺带给可访问前缀。**不许手拼路径。**
Python 侧算路径用 `agent/session_artifact_dir.py`（`session_artifact_dir(sid,'artifacts')`），规则与面板 `sessionGroupDir` 同源。

聊天里显示这些文件用 `/app/hermes-agent/api/workspace-ui/session-file/<sid>/<子目录>/<文件名>`。**尾巴只能三节**（`<sid>`/子目录/文件名），子目录限 `uploads|artifacts|code|stickers`，**再嵌一层 `preview/` 之类就是 400「无效会话文件地址」**（2026-11-21 十二张图全裂）。贴图前必须跑 `venv/bin/python scripts/media_guard.py --reply <回复文件>`，它实打 HTTP 验「取得到」，不看 `ls`。

---

## 知识库三层机制

学习 → 写知识笔记(knowledge/) → 提炼技能(skills/) → 更新记忆索引(memories/MEMORY.md)
每次重要结论/经验产生后主动沉淀，不等用户要求。
笔记写 knowledge/项目/，不写 workspace/。产出笔记后立即提炼 skill。
memory 与 skill 一一对应。用 stat 验证落盘。

### 知识库只放笔记，附件另有去处（2026-11-20 主人定规矩）

`data/knowledge/` 只收 `.md` / `.txt` / `.json`。**PDF、Excel、图片、压缩包、网页存档一律不许落这里**，包括"先存着"的副本。

| 东西 | 该去哪 |
|---|---|
| 会话里收的附件 | `sessions/<归类>/<会话ID>/{uploads,artifacts,code}` |
| 跨会话要留的公开附件 | `workspace/知识库附件/<原相对目录>` |
| 旧快照 `.bak-*` | 有正本的直接 `app_trash.py`，唯一副本搬 `workspace/知识库附件/` |

判据：文件面板下拉里**没有**「知识库」根，笔记只在「档案 → 知识库」看；两边条目数必须相等。知识库目录里一旦冒出非文本文件，就是位置放错了。兜底根「全部文件」挂整个 `data` 只读——任何落错位置的文件都能从那里走进去，找不到就是真没有。

**为什么要这条**：知识库既当笔记本又当附件仓库时，资料页只认得文本，附件在页面里永远看不见，只能在文件面板里翻——两套入口各看一半，等于两份账。主人原话：「知识库以后就是你沉淀东西做笔记的地方，不要让会话产物放到这里」「所有 hermes 的文件我都要看得到进得去，我看不到的就是位置放错的」。

---

## 消息平台接入

见 hermes-workflows 技能。微信坑：扫码只生成凭证，必须手动写 WEIXIN_ACCOUNT_ID+WEIXIN_TOKEN 进 .env 才生效。
