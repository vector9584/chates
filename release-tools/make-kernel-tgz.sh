#!/usr/bin/env bash
# 从生产源码生成 kernel/hermes-src.tgz —— CI 靠这个 tgz 拿内核。
#
# 为什么要这道加工：生产仓是 NAS 上跑了两个月的真实工作树，里面混着
# 20 个 *.bak-*（3.2MB，每次改文件留下的历史副本）和演示提示词里的真名。
# 这些在私有仓无所谓，进公开 Release 就是指纹。
#
# set -e 纪律：本脚本里每个计数/grep 都必须 `|| true` 收尾。
# grep 无匹配返回 1，pipefail 会把 `n=$(grep … | wc -l)` 整句判失败，
# 脚本就死在那行赋值上，连后面的 if 都走不到 —— 踩过一次，别再踩。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/kernel/hermes-src.tgz"

# 源码树候选：CI 从仓库解出来的，或本机组装产物
SRC="${1:-}"
if [ -z "$SRC" ]; then
  for c in "$ROOT/app/hermes-src" "$ROOT/electron/resources/chates/app/hermes-src"; do
    if [ -d "$c" ]; then SRC="$c"; break; fi
  done
fi
if [ -z "$SRC" ] || [ ! -d "$SRC" ]; then
  echo "ERROR 找不到内核源码树。先跑 scripts/prepare-kernel.sh 或用参数指定。" >&2
  exit 1
fi

# 出厂前必须消失的东西
STRIP=( '*.bak-*' '__pycache__' '*.pyc' '.pytest_cache' '.mypy_cache' )
# 不该出现在别人机器上的词（演示提示词、调试样例里的真实身份）
NEUTRALIZE=( '王瑞兵:示例用户' '姜亚楠:示例用户' '姜楠:示例用户' )

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "[kernel] 源: $SRC"
cp -a "$SRC" "$work/hermes-src"

for pat in "${STRIP[@]}"; do
  n=$(find "$work/hermes-src" -name "$pat" 2>/dev/null | wc -l || true)
  if [ "$n" -eq 0 ]; then continue; fi
  find "$work/hermes-src" -name "$pat" -exec rm -rf {} + 2>/dev/null || true
  echo "[kernel] 删除 $pat: $n 项"
done

for pair in "${NEUTRALIZE[@]}"; do
  from="${pair%%:*}"; to="${pair##*:}"
  hits=$(grep -rlF "$from" "$work/hermes-src" 2>/dev/null || true)
  if [ -z "$hits" ]; then continue; fi
  printf '%s\n' "$hits" | while IFS= read -r f; do
    python3 - "$f" "$from" "$to" <<'PY'
import sys
p, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
with open(p, encoding='utf-8', errors='surrogateescape') as fh:
    t = fh.read()
with open(p, 'w', encoding='utf-8', errors='surrogateescape') as fh:
    fh.write(t.replace(a, b))
PY
  done
  echo "[kernel] 中性化 $from: $(printf '%s\n' "$hits" | wc -l) 个文件"
done

# 真实 .env 绝不能进包
if [ -f "$work/hermes-src/.env" ]; then
  rm -f "$work/hermes-src/.env"
  echo "[kernel] 删除 .env"
fi

(cd "$work" && tar czf "$OUT" hermes-src)

files=$(tar tzf "$OUT" | grep -vc '/$' || true)
size=$(stat -c %s "$OUT")
echo "[kernel] 产物: $(basename "$OUT")  ${size} 字节  ${files} 个文件"

# 出厂自检
bad=0
n=$(tar tzf "$OUT" | grep -c '\.bak-\|__pycache__\|\.pyc$' || true)
if [ "$n" -gt 0 ]; then
  echo "ERROR tgz 里还有 $n 项垃圾" >&2; bad=1
fi
if tar xzf "$OUT" -O 2>/dev/null | grep -qF '王瑞兵'; then
  echo "ERROR tgz 里还有真实姓名" >&2; bad=1
fi
if [ "$size" -lt 20000000 ]; then
  echo "ERROR 产物只有 $size 字节，缺内核（正常约 29MB）" >&2; bad=1
fi

if [ "$bad" -eq 0 ]; then echo "[kernel] 自检通过"; else exit 1; fi
