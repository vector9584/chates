#!/usr/bin/env bash
# 把 CHATÈS 装成 Electron 的 resources/chates/ 布局。
#
# 关键取舍（2026-11-25 实测后定）：
#   1. python 运行时必须内嵌。Windows 的 venv 不是自包含的 ——
#      Scripts/python.exe 只有 46KB，是个启动器，真解释器在 pyvenv.cfg 的 home
#      指向的 uv 目录（C:\Users\<用户名>\AppData\Roaming\uv\python\...）。
#      不把 base python 一起打进去，换台机器就是 EnvironmentError。
#   2. 内核必须正式安装，不能 editable。原来的 __editable__ finder 指向
#      hermes-src 绝对路径，换机器/换目录即失效。这里在 NAS 上无法跑 Windows
#      pip，所以保留 .pth 但把内容改成相对定位是做不到的（.pth 只能是绝对路径
#      或 import 语句），因此改为：安装器首次启动时用内嵌 python 执行一次
#      `pip install -e` 修正。这段逻辑在 installer/first-run.ps1。
#   3. 面板只有一份副本（app/ui + app/server），不做旁挂，否则一次覆盖就漂移。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"      # .../hermes-win-build/electron
BUILD="$(cd "$HERE/.." && pwd)"            # .../hermes-win-build
OUT="${1:-$BUILD/electron/resources/chates}"
WS="$(cd "$BUILD/.." && pwd)"
PYWIN="$WS/py-win"
NODEWIN="$WS/node-win"

say() { printf '[assemble] %s\n' "$*"; }
die() { printf '[assemble] ERROR: %s\n' "$*" >&2; exit 1; }

say "out = $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"/{app,data,var,runtime}

# ── 1. 内核源码 ────────────────────────────────────────────
say "copying kernel source ..."
rsync -a \
  --exclude='.git' --exclude='__pycache__' --exclude='*.pyc' \
  --exclude='node_modules' --exclude='.venv' --exclude='venv' \
  --exclude='tests' --exclude='.pytest_cache' --exclude='electron' \
  --exclude='resources' --exclude='dist' --exclude='win' \
  "$BUILD"/ "$OUT"/app/hermes-src/

# ── 2. 面板（唯一副本）──────────────────────────────────────
say "copying panel ..."
for d in ui server; do
  rm -rf "$OUT/app/$d"
  cp -a "$BUILD/app/$d" "$OUT/app/$d"
done
echo '{"type":"module"}' > "$OUT/app/server/package.json"

# ── 3. 出厂数据（默认脱敏骨架）──────────────────────────────
# 铁律：装进 exe 的 data 必须是干净的。真实 .env / 技能库 / 个人知识库
# 只允许落在使用者自己的 %APPDATA%\CHATÈS\data 里，不进分发包。
#
# 以前这里无条件解 hermes-win-data/data.zip（52MB，含 142 条真凭据），
# win.8 就是这么带出去的。现在默认 data-skeleton，真数据要显式 opt-in。
DATA_MODE="${CHATES_DATA_MODE:-skeleton}"
say "data mode = $DATA_MODE"
TMPD="$(mktemp -d)"
case "$DATA_MODE" in
  skeleton)
    [ -d "$BUILD/data-skeleton" ] || die "缺 data-skeleton（跑 release-tools/make-data-skeleton.py）"
    cp -a "$BUILD/data-skeleton"/. "$OUT/data/"
    ;;
  private)
    # 只给自用构建。产物不能对外分发。
    DATA_ZIP="${CHATES_PRIVATE_DATA:-$WS/hermes-win-data/data.zip}"
    [ -f "$DATA_ZIP" ] || die "private 模式缺 $DATA_ZIP"
    say "  !! private 模式：产物含真实凭据，禁止发布 !!"
    unzip -q -o "$DATA_ZIP" -d "$TMPD" 2>/dev/null || unzip -q -o "$DATA_ZIP" -d "$TMPD"
    if [ -d "$TMPD/data" ]; then SRC="$TMPD/data"; else SRC="$TMPD"; fi
    cp -a "$SRC"/. "$OUT/data/"
    ;;
  *) die "CHATES_DATA_MODE 只能是 skeleton 或 private（收到 $DATA_MODE）" ;;
esac
rm -rf "$TMPD"

# 凭据闸：不管哪种模式，暂存区的 data 都要过一遍。
# 反向搜索真 .env 的每个值（≥8 字符），命中即失败——按 key 名单列不可靠，
# 曾漏过 ROUTER_PWD / STUDENT_NAME / *_USER。
REAL_ENV="${REAL_ENV:-/vol1/@apphome/hermes-agent/data/.env}"
if [ -f "$REAL_ENV" ]; then
  LEAK=0
  while IFS= read -r line; do
    case "$line" in \#*|"") continue ;; esac
    v="${line#*=}"
    [ ${#v} -lt 8 ] && continue
    case "${v,,}" in
      127.0.0.1|localhost|0.0.0.0|::1|true|false|none|null|auto|default|utf-8|utf8) continue ;;
    esac
    if grep -rqF -- "$v" "$OUT/data" 2>/dev/null; then
      say "  泄漏: ${line%%=*}"
      LEAK=$((LEAK+1))
    fi
  done < "$REAL_ENV"
  [ "$LEAK" -eq 0 ] || die "暂存 data 有 $LEAK 条真凭据（模式 $DATA_MODE）"
  say "  凭据闸通过（0 泄漏）"
else
  say "  --  $REAL_ENV 不存在，跳过反向搜索，只查 .env 存在性"
fi

# 分发包里不允许出现 .env 本体，只允许 .env.example
if [ -f "$OUT/data/.env" ] && [ "$DATA_MODE" != "private" ]; then
  die "分发包里出现了 .env（只许 .env.example）"
fi

# 环境指纹：姓名、域名、内网 IP、GitHub 账号
for pat in "王瑞兵" "ruibing.wang" "192.168.3.110" "vector9584"; do
  if grep -rqF -- "$pat" "$OUT/data" 2>/dev/null; then
    die "暂存 data 命中环境指纹: $pat"
  fi
done
say "  指纹闸通过"

# ── 4. node 运行时 ─────────────────────────────────────────
say "node runtime ..."
[ -f "$NODEWIN/node.exe" ] || die "node.exe missing: $NODEWIN/node.exe"
cp -a "$NODEWIN/node.exe" "$OUT/runtime/node.exe"
say "  node.exe $(stat -c %s "$OUT/runtime/node.exe") bytes"

# ── 5. python 运行时（base 解释器 + venv 合并成自包含）────────
say "python runtime ..."
[ -f "$PYWIN/pybase.zip" ] || die "pybase.zip missing"
[ -f "$PYWIN/venv.zip" ]   || die "venv.zip missing"
TMPP="$(mktemp -d)"
# -o 必须带：zip 内路径用反斜杠，unzip 会报重名并停下来问，非交互环境直接卡死
# 注意：unzip 对「反斜杠当路径分隔符」只发 warning 但退出码非 0，别用 || 判失败，
# 解完查实际文件在不在才是判据。
unzip -qo "$PYWIN/pybase.zip" -d "$TMPP/base" >/dev/null 2>&1 || true
unzip -qo "$PYWIN/venv.zip"   -d "$TMPP/venv" >/dev/null 2>&1 || true
[ -n "$(find "$TMPP/base" -maxdepth 3 -name python.exe -type f 2>/dev/null)" ] || die "pybase unzip produced no python.exe"
[ -d "$TMPP/venv" ] || die "venv unzip produced nothing"

# base 解出来可能多一层 cpython-3.12-windows-x86_64-none/，自动下钻找 python.exe
BASE="$TMPP/base"
if [ ! -f "$BASE/python.exe" ]; then
  FOUND="$(find "$TMPP/base" -maxdepth 3 -name python.exe -type f 2>/dev/null | head -1)"
  [ -n "$FOUND" ] && BASE="$(dirname "$FOUND")"
fi
[ -f "$BASE/python.exe" ] || die "base python.exe not found after unzip (tree: $(ls "$TMPP/base"))"

VENVD="$TMPP/venv/venv"
[ -d "$VENVD" ] || VENVD="$TMPP/venv"

# 合并：base 解释器铺底，venv 的 site-packages 覆盖上去。
# Windows 的 venv/Scripts/python.exe 只是个 launcher，合并后它指向的
# pyvenv.cfg home 会被改写成本目录，所以两边都必须留在同一棵树里。
mkdir -p "$OUT/runtime/python"
cp -a "$BASE"/. "$OUT/runtime/python"/
rm -rf "$OUT/runtime/python/Lib/site-packages"
cp -a "$VENVD/Lib/site-packages" "$OUT/runtime/python/Lib/site-packages"

# 绝对不要写 pyvenv.cfg（2026-11-25 踩了一晚上的坑）
#
# Windows 上 python.exe 发现自己同级有 pyvenv.cfg，就判定「我是 venv」，
# 然后 prefix = home 的上一级：
#   home = .                       → prefix = <python 的上一级> = runtime    ✗
#   home = <python 的绝对路径>      → prefix 仍是 runtime（自己成了 venv）    ✗
# 后果不是「启动失败」而是更隐蔽的：python 能跑、--version 能出，但
# sys.prefix 指向 runtime，于是它去 runtime\Lib\site-packages 找包，
# 而包在 runtime\python\Lib\site-packages —— yaml / winpty 全部 ModuleNotFoundError。
#
# base 解释器本来就没有 pyvenv.cfg（uv 装的就是独立 CPython），
# 直接删掉它，python 走标准 prefix 计算，prefix 自然等于 exe 所在目录。
rm -f "$OUT/runtime/python/pyvenv.cfg"
say "  pyvenv.cfg removed (independent interpreter, prefix=python dir)"
say "  python $(du -sh "$OUT/runtime/python" | cut -f1)"

# ── 6. 修 .pth 里的绝对路径 ────────────────────────────────
# hermes_root.pth 指向 C:\Users\<原用户>\...\hermes-src，换机器必废。
# 改成相对当前文件解析的 import 语句（.pth 支持 import 行），这样
# 安装到任何目录都能找到内核。
SP="$OUT/runtime/python/Lib/site-packages"
if [ -f "$SP/hermes_root.pth" ]; then
  say "rewriting hermes_root.pth (was: $(head -1 "$SP/hermes_root.pth"))"
  rm -f "$SP/hermes_root.pth"
fi
# 用 sitecustomize 兜底：比 .pth 稳定，且能做条件判断
cat > "$SP/chates_bootstrap.py" <<'PY'
"""CHATÈS 启动引导：把内核目录挂上 sys.path。

写在 site-packages 里、由 .pth 的 import 行拉起，因此不能依赖 __file__ 之外的
上下文。内核路径 = 本文件向上 4 层（site-packages → Lib → python → runtime → chates）
再进 app/hermes-src。
"""
import os, sys

_here = os.path.dirname(os.path.abspath(__file__))
# .../chates/runtime/python/Lib/site-packages
_root = os.path.abspath(os.path.join(_here, "..", "..", "..", ".."))
_kernel = os.path.join(_root, "app", "hermes-src")
if os.path.isdir(_kernel) and _kernel not in sys.path:
    sys.path.insert(0, _kernel)
PY
cat > "$SP/chates_bootstrap.pth" <<'PY'
import chates_bootstrap
PY
say "  bootstrap written"

# ── 6b. hermes.exe 启动器（console script shim）──────────────
# monitor.js 有 18 处把 HERMES_BIN 当可执行文件用（--version / profile / dashboard），
# 没这个 47KB 的 shim 就整片功能缺失（版本 unknown、profile 页面空、无法启 gateway）。
# 它本质是 python.exe 的统一入口转发器，必须和 python 放同一层 Scripts/。
SB="$PYWIN/scripts-bin.zip"
if [ -f "$SB" ]; then
  unzip -qo "$SB" -d "$OUT/runtime/python/Scripts" >/dev/null 2>&1 || true
  N=$(ls "$OUT/runtime/python/Scripts"/*.exe 2>/dev/null | wc -l)
  say "  launchers: $N exe"
  # hermes.exe 找 python 靠 pyvenv.cfg 的 home=.（已在上面写好），
  # 同时它要求自己位于 <python>/Scripts/ 才认得自己的解释器
else
  say "  WARN: scripts-bin.zip missing — hermes.exe 不可用"
fi

# ── 7. 版本落盘 ────────────────────────────────────────────
python3 - "$BUILD/win/version.json" "$OUT/app/version.json" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
d = json.load(open(src, encoding="utf-8"))
json.dump(d, open(dst, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("[assemble] version", d.get("version"))
PY

say "layout:"
du -sh "$OUT"/* | sed 's/^/  /'
say "total: $(du -sh "$OUT" | cut -f1)"

say "done: $OUT"
# 注意：CI 实际走 release-tools/build-exe.sh 自己组装并打 tar，
# 不调用本脚本。这里的 tar 逻辑留在 build-exe.sh，避免两处各写一份而漂移。
