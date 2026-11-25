#!/usr/bin/env bash
# ============================================================================
# build-exe.sh — 构建 Windows NSIS 安装器（CHATES-Setup-<ver>.exe）
#
# 必须在 Windows 上跑（electron-builder 的 NSIS 只出 Windows 目标；
# Linux 交叉编译 NSIS 能出包但签不了名、跑不了 /S 静默验收）。
#
# 资源树 516MB 不能进 git，所以这里**现场重建**：
#   app/      ← git（本仓库）
#   hermes-src← git（内核源码）
#   python/   ← uv 现场建（Windows 上 uv 下载 embeddable + venv）
#   node.exe  ← nodejs.org 下载
#   data/     ← data-skeleton（脱敏，无 .env 真值、无技能指纹）
#
# 用法（Windows Git Bash 或 CI）：
#   release-tools/build-exe.sh --tag v0.20.0-win.9
#   release-tools/build-exe.sh --tag v0.20.0-win.9 --check-only
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TAG=""; CHECK_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="${2:-}"; shift 2 ;;
    --check-only) CHECK_ONLY=1; shift ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done
[ -n "$TAG" ] || { echo "必须给 --tag" >&2; exit 2; }

c() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
ok() { c '32' "  OK   $*"; }
warn() { c '33' "$*"; }
die() { c '31' "  FAIL $*"; exit 1; }

# ── Python 调用统一出口 ────────────────────────────────────────────
# Windows runner 上 python3 走 cp936 解码，读带中文的 json 直接 charmap 报错
# （实测 2026-11-25 CI 第一次跑 exe 就死在这）。这里统一钉死 UTF-8 三个变量，
# 并优先用 py（Windows 官方 launcher，Git Bash 下 python3 常是 App 别名空壳）。
if command -v py >/dev/null 2>&1; then
  PYEXE="py -3"
elif command -v python3 >/dev/null 2>&1; then
  PYEXE="python3"
else
  PYEXE="python"
fi
export PYTHONIOENCODING=utf-8
export PYTHONUTF8=1
export PYTHONLEGACYWINDOWSSTDIO=0
# py_file <heredoc 脚本> [args...]  —— 用 python 跑 heredoc
py_run() { $PYEXE "$@"; }

# 平台检查：这套流程只能在 Windows 上跑
if [ "${OS:-}" != "Windows_NT" ] && [ "$(uname -s 2>/dev/null)" != "MINGW64_NT"* ] \
   && [ "$(uname -s 2>/dev/null)" != "MSYS_NT"* ]; then
  if [ "$CHECK_ONLY" -eq 0 ]; then
    c '33' "不是 Windows。exe 只能在 windows-latest runner 或本机 Windows 构建。"
    c '33' "本环境只做预检；真构建请走 GitHub Actions 或 --local on Windows。"
    CHECK_ONLY=1
  fi
fi

# ------------------------------------------------ 预检
c '1;36' "== exe 预检 =="
[ -f electron/package.json ] || die "缺 electron/package.json"
[ -f electron/main.js ]      || die "缺 electron/main.js"
[ -d data-skeleton ]         || die "缺 data-skeleton（先跑 release-tools/make-data-skeleton.py）"

APP_VER=$($PYEXE -c "import json;print(json.load(open('electron/package.json',encoding='utf-8'))['version'])")
ok "electron 版本 $APP_VER"

# 凭据闸：反向搜索真 .env 的每个值（≥8 字符），命中即失败。
# 不能只按 key 名单列 —— 曾漏过 ROUTER_PWD / STUDENT_NAME / *_USER，
# 因为这些 key 名看着不像凭据，值却是真的。
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
    if grep -rqF -- "$v" data-skeleton/ 2>/dev/null; then
      warn "  data-skeleton 泄漏: ${line%%=*}"
      LEAK=$((LEAK+1))
    fi
  done < "$REAL_ENV"
  [ "$LEAK" -eq 0 ] || die "data-skeleton 有 $LEAK 条真凭据"
  ok "凭据闸通过（反向搜索 0 泄漏）"
else
  warn "  无 $REAL_ENV，跳过反向搜索"
fi

# 分发包只许 .env.example，不许 .env 本体
[ -f data-skeleton/.env ] && die "data-skeleton 里有 .env（只许 .env.example）"

# 环境指纹
for pat in "王瑞兵" "ruibing.wang" "192.168.3.110" "vector9584"; do
  grep -rqF -- "$pat" data-skeleton/ 2>/dev/null && die "data-skeleton 命中指纹: $pat"
done
ok "指纹闸通过"

# 内核必须找得到
[ -d app/hermes-src ] || [ -d electron/resources/chates/app/hermes-src ] || die "找不到 hermes-src 内核"
ok "内核就位"

if [ "$CHECK_ONLY" -eq 1 ]; then
  c '33' "  --check-only：预检通过，不产出 exe"
  exit 0
fi

# ------------------------------------------------ 组装资源树
c '1;36' "== 组装 resources/chates =="
RES="electron/resources/chates"
rm -rf "$RES"; mkdir -p "$RES"/{app,runtime,data}

# 1) app —— 面板与服务器代码
for d in server ui; do
  [ -d "app/$d" ] && cp -a "app/$d" "$RES/app/"
done
[ -f app/version.json ] && cp app/version.json "$RES/app/"
[ -d app/echo-web ] && cp -a app/echo-web "$RES/app/"
# 内核：优先仓内，其次 electron 已组装产物
if [ -d app/hermes-src ]; then
  cp -a app/hermes-src "$RES/app/hermes-src"
elif [ -d "$RES/app/hermes-src" ]; then
  : # 已在
else
  for cand in electron/resources/chates/app/hermes-src; do
    [ -d "$cand" ] && cp -a "$cand" "$RES/app/hermes-src" && break
  done
fi
ok "app/       $(du -sh "$RES/app" 2>/dev/null | cut -f1)"

# 2) data —— 脱敏骨架（绝不拷本机 data）
cp -a data-skeleton/. "$RES/data/"
# version.json 里的版本要对齐 tag
$PYEXE - "$TAG" <<'PY'
import json, sys, re
tag = sys.argv[1]
m = re.match(r'v(\d+\.\d+\.\d+)-win\.(\d+)', tag)
if not m:
    print(f"tag 格式不符: {tag}", file=sys.stderr); sys.exit(1)
ver = f"{m.group(1)}-win.{m.group(2)}"
p = 'electron/resources/chates/app/version.json'
try:
    d = json.load(open(p, encoding='utf-8'))
    d['version'] = ver
    json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    print(f"  version.json -> {ver}")
except FileNotFoundError:
    print(f"  警告：{p} 不存在", file=sys.stderr)
PY
ok "data/      $(du -sh "$RES/data" 2>/dev/null | cut -f1)（脱敏骨架）"

# 3) python 运行时 —— CI 上用 uv 现场建
# uv 探测：PATH 里没有就找 Windows 默认安装位置（Git Bash 的 PATH 偶尔漏）
if ! command -v uv >/dev/null 2>&1; then
  for u in "$USERPROFILE/.local/bin/uv.exe" "$HOME/.local/bin/uv.exe" "$LOCALAPPDATA/Microsoft/WinGet/Links/uv.exe"; do
    [ -f "$u" ] && { UV="$u"; break; }
  done
  UV="${UV:-uv}"
else
  UV="uv"
fi
if [ -d electron/resources/chates/runtime/python ]; then
  cp -a electron/resources/chates/runtime/python "$RES/runtime/python"
  ok "python/    复用已有（$(du -sh "$RES/runtime/python" | cut -f1)）"
elif command -v "$UV" >/dev/null 2>&1 || [ -f "$UV" ]; then
  c '33' "  用 uv 下载 Windows python（$UV）"
  "$UV" python install 3.11 2>/dev/null || true
  PYBASE=$("$UV" python find 3.11 2>/dev/null || true)
  [ -n "$PYBASE" ] || die "uv 没找到 python 3.11"
  mkdir -p "$RES/runtime/python"
  cp -a "$(dirname "$PYBASE")/." "$RES/runtime/python/"
  # 装 Hermes 依赖
  "$RES/runtime/python/python.exe" -m pip install -q -e "app/hermes-src[all]" 2>/dev/null || \
    "$RES/runtime/python/python.exe" -m pip install -q pyyaml requests 2>/dev/null || true
  ok "python/    uv 建好"
else
  die "既没有现成 python/，也没有 uv"
fi

# 关键：绝不写 pyvenv.cfg（写了 python 会认成 venv，prefix 错到上一层）
rm -f "$RES/runtime/python/pyvenv.cfg" 2>/dev/null || true
ok "无 pyvenv.cfg"

# 4) node
if [ -f electron/resources/chates/runtime/node.exe ]; then
  cp electron/resources/chates/runtime/node.exe "$RES/runtime/"
  ok "node.exe   复用"
else
  NODE_VER="${NODE_VER:-v20.18.1}"
  c '33' "  下载 node $NODE_VER"
  curl -fsSL -o /tmp/node.zip "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-win-x64.zip" \
    || die "node 下载失败"
  unzip -q -o -j /tmp/node.zip "node-$NODE_VER-win-x64/node.exe" -d "$RES/runtime/" || die "解压 node 失败"
  ok "node.exe   下载完成"
fi

# ------------------------------------------------ electron-builder
c '1;36' "== electron-builder =="
cd electron
[ -d node_modules ] || npm install --no-audit --no-fund || die "npm install 失败"
npx electron-builder --win nsis --x64 --publish never || die "electron-builder 失败"
cd ..

# ------------------------------------------------ 校验
c '1;36' "== 校验 =="
OUT=$(find electron/dist -maxdepth 1 -name "*.exe" 2>/dev/null | head -1)
[ -n "$OUT" ] || die "没找到 exe"
SIZE=$(stat -c %s "$OUT" 2>/dev/null || stat -f %z "$OUT")
ok "产物 $(basename "$OUT")  ${SIZE} 字节"
mkdir -p build
echo "$OUT" > build/.exe-out
c '1;32' "exe 完成: $OUT (${SIZE} 字节)"
