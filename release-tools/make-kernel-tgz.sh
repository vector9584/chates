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
# kernel/ 不进 git（.gitignore 21/23 行），新克隆的仓库里没有这个目录。
# 不建就直接 tar czf 写进去 → "Cannot open: No such file or directory"。
mkdir -p "$ROOT/kernel"

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
# CLAUDE.md 是开发期笔记，含本机仓库绝对路径，对最终用户无用
STRIP=( '*.bak-*' '__pycache__' '*.pyc' '.pytest_cache' '.mypy_cache' 'CLAUDE.md' )
# 前端目录不进内核包。
# 理由（2026-11-27）：生产源码树是从本机 hermes-agent 整棵复制来的，自带一份
# app/ui。而 build-exe.sh 已经把仓库的 app/ui 拷到 $RES/app/ui，静态托管读的
# 是后者（monitor.js: STATIC_DIR = ${APP_DIR}/ui）。于是包里出现两份 app/ui，
# 内核那份是死的，却让人反复误判"修复没进包"。内核只提供 python 侧，
# 前端一律以仓库为准，源码树里的副本在这里剥掉。
# 剥掉后 build-exe.sh 的兜底分支也拿不到旧副本，误判不可能再发生。
STRIP_DIRS=( 'app/ui' 'ui' 'app/echo-web' )
# 聊天素材不进安装包（2026-11-27 主人要求）。
# hermes_cli/web_dist/assets/stickers 是 194 个表情包 jpg/gif，属聊天内容产物，
# 不是程序功能。除了体积，中文文件名在 Windows 解压时还会整批报
# "Invalid empty pathname"（tar 对 UTF-8 中文名返回 exit=1），直接拖垮安装。
# 内核只提供 python 侧，这些素材由用户自己积累，不预置。
STRIP_DIRS_GLOB=( 'hermes_cli/web_dist/assets/stickers' 'hermes_cli/web_dist/stickers' )
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

# 剥掉前端目录（内核只供 python 侧，前端以仓库 app/ui 为准）
for d in "${STRIP_DIRS[@]}" "${STRIP_DIRS_GLOB[@]}"; do
  if [ -d "$work/hermes-src/$d" ]; then
    n=$(find "$work/hermes-src/$d" -type f 2>/dev/null | wc -l || true)
    rm -rf "$work/hermes-src/$d"
    echo "[kernel] 剥离前端目录 $d: $n 个文件"
  fi
done

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
if tar xzf "$OUT" -O 2>/dev/null | grep -qE '/vol[0-9]/@apphome/hermes-agent'; then
  echo "ERROR tgz 里还有本机 hermes-agent 数据路径" >&2; bad=1
fi
if [ "$size" -lt 20000000 ]; then
  echo "ERROR 产物只有 $size 字节，缺内核（正常约 29MB）" >&2; bad=1
fi
# 内核包里不许再有前端目录 —— 两份 app/ui 是 2026-11-27 那次误判的根因
n=$(tar tzf "$OUT" | grep -cE '^hermes-src/(app/)?ui/' || true)
if [ "$n" -gt 0 ]; then
  echo "ERROR tgz 里还有 $n 个前端文件（应为 0，前端以仓库为准）" >&2; bad=1
fi
# 聊天素材不进包（2026-11-27 主人要求）：表情包是用户产物，不是功能
n=$(tar tzf "$OUT" | grep -c '/stickers/' || true)
if [ "$n" -gt 0 ]; then
  echo "ERROR tgz 里还有 $n 项聊天素材（stickers 应为 0）" >&2; bad=1
fi

if [ "$bad" -eq 0 ]; then echo "[kernel] 自检通过"; else exit 1; fi

# 出厂审计：按路径/类别判定"这类东西压根不该进包"（stickers/uploads/sessions/.env…）。
# 和上面几条内联检查分工不同：内联的盯具体垃圾和历史教训，这个脚本是通用门禁，
# 加新禁入类别改 audit_kernel_tgz.py 的 FORBIDDEN_DIRS 一处即可。
python3 "$ROOT/release-tools/audit_kernel_tgz.py" "$OUT" || exit 1
