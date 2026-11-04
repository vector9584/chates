# Hermes Python 内核（外部改造）

这是 Hermes Agent 的 Python 核心，**独立 git 仓库**，基线提交 `715201b`（0.21.149 快照）。
仓库元数据在 `/vol1/@apphome/hermes-agent/data/workspace/hermes-src.git`，本目录的 `.git` 是指针文件。

```bash
git status / git diff / git log --oneline -5
git checkout -- 某文件          # 单个改动秒回
git reset --hard 715201b       # 整体回基线（会丢所有未提交改动）
```

- 改完先 `python -m py_compile 文件`，再重启：`../data/workspace/fnos-hermes-agent-src/dev/hermes-dev.sh restart`
- editable install：改文件 + 重启即生效，不用 pip install
- **别起第二个 gateway**（`--force` 会写坏共享 state）
- **别动 `/var/apps/hermes-agent/cmd/main`**（PID 属主坑）
- 升级会整目录覆盖本目录 → 升级后跑 `dev/hermes-dev.sh repair` 重建 `.git` 指针

完整纪律与调试手段见：
`/vol1/@apphome/hermes-agent/data/workspace/fnos-hermes-agent-src/dev/外部改造手册.md`
以及 `$HERMES_HOME/skills/fnos-knowledge/fnos-hermes-fpk/SKILL.md`。

改完在 `$HERMES_HOME/knowledge/项目/YYYY-MM-DD-<主题>.md` 写一条改动记录（动了什么/为什么/怎么验证/怎么回滚）。
