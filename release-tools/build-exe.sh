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
#   release-tools/build-exe.sh --tag 1.20.8
#   release-tools/build-exe.sh --tag 1.20.8 --check-only
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
# 与 build-fpk.sh 同一个同步入口：app/ 是唯一真源。
# 以前这段同步只写在 build-fpk.sh 里，只跑 build-exe 时不经过它，
# exe 就会打到上一次 fpk 留下的旧副本 —— "FPK 修好、Windows 忘改"的根因。
bash "$ROOT/release-tools/sync-dual.sh"
RES="electron/resources/chates"
rm -rf "$RES"; mkdir -p "$RES"/{app,runtime,data}

# 1) app —— 面板与服务器代码（从真源 app/ 直接拷，不读副本）
for d in server ui; do
  [ -d "app/$d" ] && cp -a "app/$d" "$RES/app/"
done
# 上报地址注入（与 build-fpk.sh 同一套）：源码用 __CHATES_REPORT_URL__ 占位符，
# 打包时换成 env CHATES_REPORT_URL。源码里本来就有真地址时这一步是空操作。
REPORT_BASE="${CHATES_REPORT_URL:-}"
# 本机构建没有 CI secret：从 release-tools/.report-url（.gitignore 里）取。
# 公开仓里两处都是占位符 + 这个被忽略的文件，谁也不会把域名带进 git。
if [ -z "$REPORT_BASE" ] && [ -f release-tools/.report-url ]; then
  REPORT_BASE=$(tr -d '\r\n ' < release-tools/.report-url)
fi
PJS="$RES/app/ui/js/panel-issues-ui.js"
if [ -n "$REPORT_BASE" ] && [ -f "$PJS" ]; then
  $PYEXE - "$PJS" "$REPORT_BASE" <<'PY'
import sys
p, base = sys.argv[1], sys.argv[2].rstrip('/') + '/'
s = open(p, encoding='utf-8').read()
n = s.count('__CHATES_REPORT_URL__')
open(p, 'w', encoding='utf-8').write(s.replace('__CHATES_REPORT_URL__', base))
print(f"  上报地址写入 {n} 处")
PY
  ok "上报地址已注入"
fi
# panel/server 用 ESM（import ... from），Node 靠这个 package.json 的 type:module 才认；
# 漏了它 Windows 侧 monitor.js 会以 CJS 解析而报 "Cannot use import statement outside a module"。
[ -f app/package.json ] && cp -a app/package.json "$RES/app/" || die "缺 app/package.json（ESM 需要 type:module）"
# 发布标记：Windows 侧顶栏与维护页也靠它显示 GitHub 版本号（与 fpk 同源）
VER_PLAIN=$(python3 -c "import json;print(json.load(open('win/version.json'))['version'].split('-')[0])")
cat > "$RES/app/version.json" <<JSON
{
  "name": "CHATES",
  "tag": "$TAG",
  "version": "$VER_PLAIN",
  "date": "$(date -u +%Y-%m-%d)",
  "repo": "https://github.com/vector9584/chates"
}
JSON
ok "version.json  tag=$TAG"
[ -d app/echo-web ] && cp -a app/echo-web "$RES/app/"
# 内核：优先仓内，其次 electron 已组装产物。
# 内核只供 python 侧；前端一律用仓库 app/ui（第 124 行的 cp 已放好 $RES/app/ui）。
# 内核包里若混进 app/ui（旧副本），静态托管仍读 $RES/app/ui，那份是死的，
# 却让人以为"修复没进包"（2026-11-27 误判两轮）。这里最后再清一次，双保险。
if [ -d app/hermes-src ]; then
  cp -a app/hermes-src "$RES/app/hermes-src"
elif [ -d "$RES/app/hermes-src" ]; then
  : # 已在
else
  for cand in electron/resources/chates/app/hermes-src; do
    [ -d "$cand" ] && cp -a "$cand" "$RES/app/hermes-src" && break
  done
fi
for d in "$RES/app/hermes-src/app/ui" "$RES/app/hermes-src/ui"; do
  [ -d "$d" ] && rm -rf "$d" && warn "清掉内核里的前端死副本: ${d#$RES/}"
done
ok "app/       $(du -sh "$RES/app" 2>/dev/null | cut -f1)"

# 2) data —— 脱敏骨架（绝不拷本机 data）
cp -a data-skeleton/. "$RES/data/"
# version.json 里的版本要对齐 tag
$PYEXE - "$TAG" <<'PY'
import json, sys, re
tag = sys.argv[1]
# 版本号就是 tag 本体：新写法 1.20.8 / 老写法 v1.20.8-win.3 都认。
# 剥掉可选的 v 前缀，不带 -win.N 之后文件名、顶栏、version.json 全用同一个号。
m = re.match(r'v?(\d+\.\d+\.\d+(?:-test\d+)?)$', tag)
if not m:
    print(f"tag 格式不符: {tag}（要 1.20.8 / v1.20.8 / 1.20.8-test1）", file=sys.stderr); sys.exit(1)
ver = m.group(1)
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
  ok "python/    uv 建好"
else
  die "既没有现成 python/，也没有 uv"
fi

# 依赖必须真的装进去，两个分支都要装（复用不等于依赖齐全）。
# 2026-11-26 教训：uv 装的 python 带 PEP 668 标记，`pip install` 会以
# "externally-managed-environment" 直接退出；原先这里用 `2>/dev/null || true`
# 把错误吞了，发出去的 exe 里是个只有 pip/setuptools 的裸 python ——
# panel-models.py 报 No module named 'ruamel'，gateway 报 No module named 'fcntl'，
# 面板"连不上服务"、模型配置读不出来，全套后台功能失效。
# 另外必须用非 editable 安装：CI 的 build 路径（D:\a\...）与安装后的
# resources 路径不同，-e 生成的 .pth 会把用户机器指向一个不存在的目录。
c '1;36' "== 安装 runtime python 依赖 =="
SITE="$RES/runtime/python/Lib/site-packages"
# hermes 的 pyproject 主动拒绝非 editable 安装（构建时直接 RuntimeError:
# "Building wheels or sdists for hermes-agent is not supported"），所以只能 -e。
# 但 -e 生成的 __editable__* 锚点里写的是构建机绝对路径（D:\a\chates\...），
# 用户机器上没有那个目录，装上去 hermes.exe 一跑就 ImportError。
# 解法：-e 装（拿到全部依赖 + 生成 Scripts/hermes.exe），装完删掉绝对路径锚点，
# 换成用 sys.prefix 相对定位的 .pth：依赖已经在 site-packages 里，源码靠相对路径找。
"$RES/runtime/python/python.exe" -m pip install -q --break-system-packages --no-warn-script-location \
  -e "app/hermes-src[all]" || die "runtime python 依赖安装失败（hermes-src[all]）"
rm -f "$SITE"/__editable__*hermes*.py "$SITE"/__editable__*hermes*.pth 2>/dev/null || true
printf "import os,sys;sys.path.insert(0,os.path.abspath(os.path.join(sys.prefix,'..','..','app','hermes-src')))\n" \
  > "$SITE/zz-hermes-src-path.pth"
ok "python/ 依赖就位（editable 锚点已换成相对路径）"

# Unix 专有模块垫片：Windows 没有 fcntl，cron/panel-echo 的 import 链会整条断掉。
SHIM_DIR="release-tools/py-shims"
if [ -f "$SHIM_DIR/fcntl.py" ]; then
  cp -f "$SHIM_DIR/fcntl.py" "$SITE/fcntl.py"
  ok "shim/    fcntl.py"
else
  die "缺 $SHIM_DIR/fcntl.py（Windows 无 fcntl，cron 会 import 失败）"
fi

# 校验放在锚点替换之后，否则测的还是安装时的绝对路径
"$RES/runtime/python/python.exe" -c "import fcntl, hermes_cli, gateway, cron, ruamel.yaml, aiohttp, dotenv" \
  || die "runtime python 依赖校验失败"
"$RES/runtime/python/Scripts/hermes.exe" --version >/dev/null 2>&1 \
  || die "Scripts/hermes.exe 不可用"
ok "校验 依赖+hermes.exe"

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

# ------------------------------------------------ 打运行时 tar
# 为什么打 tar：resources/chates 是 Python 运行时 + node + 内核源码，两万多
# 个碎文件。electron-builder 把它们逐个塞进 NSIS，安装进度条按文件条目推进：
# 解压阶段先走满一次，落盘阶段又从 60% 附近重新算，然后几分钟不动。用户
# 2026-11-26 实际反馈"进度条走满又退回 60%，等好几分钟，我以为卡住了"。
# 合成单文件后 NSIS 只搬一个条目，进度条单调递增。解开后的目录结构不变，
# main.js 的 resolveRoots() 与 installer.nsh 的 customInstall 都按原布局取。
c '1;36' "== 打运行时 tar =="
# TARF 必须是绝对路径：下面 subshell 先 cd 进 $RES，相对路径会指向
# $RES/electron/resources/... 这个不存在的层级 → 2026-11-27 CI 首跑就死在这。
TARF="$(pwd)/$RES.tgz"
rm -f "$TARF"
# tgz 打的是 $RES 的根内容（./app ./runtime ./data），installer 和 main.js 都解到
# resources/chates/ 下（见 installer.nsh customInstall 与 main.js ensureRuntimeExtracted），
# 全应用只有这一处 runtime，没有重复。
( cd "$RES" && tar -czf "$TARF" . ) || die "打 tar 失败"
ok "chates.tgz $(du -h "$TARF" | cut -f1)  $(tar -tzf "$TARF" | wc -l) 条目"
rm -rf "$RES"

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
