#!/usr/bin/env bash
# 单一真源同步：把仓库 app/{hermes-src,server,ui} 单向灌进 electron 组装树。
#
# 为什么要有这个脚本（2026-11-27）：
#   仓库里前端只有一份真源 app/ui、后端只有一份 app/server，但 electron 的
#   组装树 electron/resources/chates/app/ 里还有一份构建副本。以前这个同步
#   只写在 build-fpk.sh 里，于是：
#     - 先跑 build-fpk → 副本被同步，exe 打到的是新代码
#     - 只跑 build-exe → 没人同步，exe 打到的是上次 fpk 留下的旧副本
#   两条链路谁先跑决定 exe 里是哪份代码，这就是"FPK 修好了、Windows 忘改了"
#   的机制原因，不是人忘，是链路少了一环。
#
# 定则：app/ 是唯一真源，永远是 app/ → electron 单方向。
#       CI 里 build-fpk 和 build-exe 各自调一次，谁先跑都拿到同一份。
#
# 用法：bash release-tools/sync-dual.sh [--check]
#   --check  只报告差异，不写（给 CI 门禁用）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DEST="electron/resources/chates/app"
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

# hermes-src 侧特有产物，不能覆盖
EXCLUDES=( --exclude='web_dist' --exclude='node_modules'
           --exclude='__pycache__' --exclude='*.pyc' --exclude='.git' )

drift=0
for d in hermes-src server ui; do
  [ -d "app/$d" ] || continue

  if [ ! -d "$DEST/$d" ]; then
    # 目标还没建（干净克隆 / build-exe 刚 rm -rf 过）——不算漂移，
    # build-*.sh 会直接从 app/ 拷，不需要这里预先建。
    echo "[sync] $d: 目标未组装，跳过（构建脚本会直接从 app/ 取）"
    continue
  fi

  if [ "$CHECK" = "1" ]; then
    if diff -rq -x web_dist -x node_modules -x __pycache__ -x '*.pyc' -x .git \
         "app/$d" "$DEST/$d" >/dev/null 2>&1; then
      echo "[sync] $d: 一致"
    else
      echo "[sync] $d: 漂移！"
      diff -rq -x web_dist -x node_modules -x __pycache__ -x '*.pyc' -x .git \
        "app/$d" "$DEST/$d" 2>/dev/null | head -5 | sed 's/^/    /'
      drift=1
    fi
  else
    rsync -a "${EXCLUDES[@]}" "app/$d/" "$DEST/$d/"
    echo "[sync] $d: app/ → $DEST/$d"
  fi
done

if [ "$CHECK" = "1" ] && [ "$drift" -ne 0 ]; then
  echo "[sync] ERROR 检测到副本漂移，先跑 bash release-tools/sync-dual.sh" >&2
  exit 1
fi
