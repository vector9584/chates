#!/bin/bash
# init.sh — 首次安装初始化：部署知识模板 + 记忆模板 + 镜像脚本 + knowledge-sync 技能 + crontab
# 由 cmd/install 调用（fpk 安装时）；copy_if_new 语义：目标已存在则保留（升级不覆盖用户内容）
# 作者：Hermes Agent 方案（2026-08-07），千问整合进 fpk

set -u
# 路径环境变量：优先用 fnOS 标准回调传入的 TRIM_PKGHOME/TRIM_APPDEST/TRIM_PKGVAR。
# 没传时从本脚本位置推导（<APP_DIR>/config/init/init.sh），不写死某个应用的绝对路径——
# 原来默认值是 /vol3/@apphome/chates 和 /var/apps/hermes-agent/target，换个应用名或卷就全错。
_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 兼容两种落位：安装后 <APP_DIR>/init（build-fpk 打进 app/init），
# 开发仓里 <APP_DIR>/config/init。按父目录名判断，两种情况都能推出 APP_DIR。
if [ "$(basename "$(dirname "${_SELF_DIR}")")" = "config" ]; then
    _APP_DIR_DERIVED="$(cd "${_SELF_DIR}/../.." && pwd)"   # <APP_DIR>/config/init
else
    _APP_DIR_DERIVED="$(cd "${_SELF_DIR}/.." && pwd)"      # <APP_DIR>/init
fi
INIT_DIR="${_SELF_DIR}"
DATA_DIR="${TRIM_PKGHOME:-${_APP_DIR_DERIVED}/home}/data"
LOG_FILE="${TRIM_PKGVAR:-${_APP_DIR_DERIVED}/var}/info.log"

log_msg() {
    local msg="$(date '+%Y-%m-%d %H:%M:%S') - [init] $1"
    echo "$msg" >> "${LOG_FILE}" 2>/dev/null || true
}

copy_if_new() {
    local src="$1" dst="$2"
    if [ ! -f "$dst" ]; then
        mkdir -p "$(dirname "$dst")"
        cp "$src" "$dst" 2>/dev/null && log_msg "部署: $dst" || log_msg "WARNING: 复制失败 $src"
    else
        log_msg "跳过（已存在）: $dst"
    fi
}

log_msg "=== init.sh start ==="
log_msg "DATA_DIR=${DATA_DIR}"
log_msg "INIT_DIR=${INIT_DIR}"

# 0. 会话状态库 state.db（2026-11-27 修）
# 为什么必须有这一步：库是 gateway 第一次真正写会话记录时才惰性创建的。
# 全新安装后一条消息都没发过，data/state.db 就不存在 —— 于是
#   · 面板「本会话文件」→ validFileSession 探测 DB 抛错 → 503 → 前端显示「获取会话目录失败」
#   · 会话里的图片 → session-file 走同一条 resolveSessionFileDir → 同样 503 → 图裂
#   · 搜索所有会话 → panel-search 打不开库，异常被吞成空结果 + partial:true → 永远搜不到还不报错
# 一次把三个症状一起治：这里先把库和表结构建出来，面板首次打开就能用。
# 用 SessionDB 构造而不是手写 CREATE TABLE —— 表结构随内核演进，手抄一份必然过期。
PYTHON_BIN="${TRIM_PKGHOME:-${_APP_DIR_DERIVED}/home}/data/venv/bin/python3"
HERMES_SRC="${TRIM_APPDEST:-${_APP_DIR_DERIVED}}/hermes-src"
if [ ! -f "$DATA_DIR/state.db" ]; then
    if [ -x "$PYTHON_BIN" ] && [ -d "$HERMES_SRC" ]; then
        HERMES_HOME="$DATA_DIR" "$PYTHON_BIN" -c "
import sys
sys.path.insert(0, '$HERMES_SRC')
from hermes_state import SessionDB
SessionDB()
print('state.db created')
" >> "${LOG_FILE}" 2>&1 \
            && log_msg "已建立会话状态库 state.db" \
            || log_msg "WARNING: state.db 建立失败（面板首次打开可能报会话目录错误）"
        # init.sh 由 root 调起，建出来的库会归 root —— 应用以 chates 身份跑，
        # 读不了就等于没建。属主跟随 data 目录本身，不写死用户名（换应用名照样对）。
        _OWNER="$(stat -c '%U:%G' "$DATA_DIR" 2>/dev/null || true)"
        if [ -n "${_OWNER:-}" ] && [ "$_OWNER" != "root:root" ]; then
            chown "$_OWNER" "$DATA_DIR/state.db" "$DATA_DIR"/state.db-* 2>/dev/null || true
            log_msg "state.db 属主修正为 $_OWNER"
        fi
    else
        log_msg "WARNING: venv python 或 hermes-src 缺失，跳过 state.db 初始化"
    fi
else
    log_msg "跳过（已存在）: $DATA_DIR/state.db"
fi

# 1. 记忆文件（持久化）
copy_if_new "$INIT_DIR/memories/MEMORY.md" "$DATA_DIR/memories/MEMORY.md"
copy_if_new "$INIT_DIR/memories/USER.md"   "$DATA_DIR/memories/USER.md"

# 2. 知识系统模板（Obsidian 格式，整个 knowledge/ 树）
mkdir -p "$DATA_DIR/knowledge"
find "$INIT_DIR/knowledge" -name "*.md" | while read -r f; do
    rel="${f#$INIT_DIR/knowledge/}"
    copy_if_new "$f" "$DATA_DIR/knowledge/$rel"
done

# 3. 镜像脚本
copy_if_new "$INIT_DIR/scripts/knowledge-sync/mirror.py" \
            "$DATA_DIR/scripts/knowledge-sync/mirror.py"

# 4. knowledge-sync skill（持久数据层，升级不覆盖）
copy_if_new "$INIT_DIR/skills/knowledge-sync/SKILL.md" \
            "$DATA_DIR/skills/knowledge-sync/SKILL.md"

# 5. 注册 crontab（每 30 分钟镜像 memories → knowledge），以 hermes-agent 用户写入
CRON_LINE="*/30 * * * * HERMES_DATA_DIR=$DATA_DIR python3 $DATA_DIR/scripts/knowledge-sync/mirror.py >> $DATA_DIR/logs/knowledge-mirror.log 2>&1"
APP_USER="${TRIM_USERNAME:-$(basename "${_APP_DIR_DERIVED}")}"
if crontab -u "$APP_USER" -l 2>/dev/null | grep -qF "knowledge-sync/mirror.py"; then
    log_msg "crontab 镜像任务已存在，跳过"
else
    (crontab -u "$APP_USER" -l 2>/dev/null; echo "$CRON_LINE") | crontab -u "$APP_USER" - 2>/dev/null \
        && log_msg "已注册 crontab 镜像任务（每 30 分钟）" \
        || log_msg "WARNING: crontab 注册失败（可能需要 root 权限）"
fi

# 6. 立即跑一次镜像，开箱即有内容
if [ -f "$DATA_DIR/scripts/knowledge-sync/mirror.py" ]; then
    HERMES_DATA_DIR="$DATA_DIR" python3 "$DATA_DIR/scripts/knowledge-sync/mirror.py" >> "$DATA_DIR/logs/knowledge-mirror.log" 2>&1 \
        && log_msg "首次镜像完成" || log_msg "WARNING: 首次镜像失败"
fi

log_msg "=== init.sh end ==="
exit 0
