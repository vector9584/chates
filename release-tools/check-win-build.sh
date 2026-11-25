#!/usr/bin/env bash
# hermes-win-build 自检：改完 electron/ 或 app/server/ 的 Windows 兼容层后跑这个。
#
# 为什么需要它：这个仓库的 `npm run check` 依赖 web/node_modules（本机没装），
# pytest 只覆盖 Python 侧，五个改动文件全在 JS/shell/NSIS 层，没有任何现成套件管它们。
# 结果是「改了但没证据」。这个脚本把能在这里验的全串起来，一条命令给结论。
#
# 用法： bash release-tools/check-win-build.sh          # 退出码 0 = 全绿
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
FAIL=0
ok(){ printf '  \033[32mOK\033[0m   %s\n' "$1"; }
no(){ printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=1; }

echo "── 语法 ─────────────────────────────────────────"
for f in electron/main.js electron/preload.js \
         app/server/monitor.js app/server/panel-update.js \
         app/server/panel-process-guard.js app/server/panel-auth.js; do
  [ -f "$f" ] || { no "$f 缺失"; continue; }
  node --check "$f" 2>/dev/null && ok "$f" || no "$f 语法错误"
done
bash -n electron/assemble.sh 2>/dev/null && ok "assemble.sh" || no "assemble.sh 语法错误"

# NSIS 按系统 ANSI 码页解析，任何非 ASCII 字节都会吞掉换行、把下一条语句并进注释。
# 这类错误编译期不报，运行时表现为安装器崩 0xC0000005 且日志全空 —— 必须静态拦。
# grep -c 无匹配时打印 0 并返回 1；带 || echo 0 会变成 "0\n0"。用变量接住再兜底。
N=$(LC_ALL=C grep -c '[^ -~]' electron/build/installer.nsh 2>/dev/null); N=${N:-0}
[ "$N" -eq 0 ] && ok "installer.nsh 纯 ASCII" || no "installer.nsh 有 $N 行非 ASCII"

echo "── 配置 ─────────────────────────────────────────"
node -e '
const d=require("./electron/package.json");
if(!d.main) throw new Error("main 字段缺失");
if(!/^\d+\.\d+\.\d+$/.test(d.version)) throw new Error("version 不是合法 semver: "+d.version);
if(!d.build||!d.build.extraResources) throw new Error("build.extraResources 缺失");
' 2>/dev/null && ok "package.json (main/semver/extraResources)" || no "package.json 不合法"

echo "── 跨平台运行时定位 ─────────────────────────────"
# monitor.js 必须同时认得 fpk 的 venv/bin|Scripts 和独立版的 runtime/python，
# 写死一边，另一边就是「版本 unknown / 模型配置服务无法启动」。
grep -q "CHATES_PYTHON_ROOT" app/server/monitor.js && ok "monitor.js 支持 CHATES_PYTHON_ROOT" \
  || no "monitor.js 缺 CHATES_PYTHON_ROOT"
! grep -q "join(VENV_BIN,'python3')" app/server/monitor.js \
  && ok "monitor.js 无写死 python3" || no "monitor.js 仍有 join(VENV_BIN,'python3')"

# Windows 没有 ss / /proc，探测失败必须区别于「端口被占」。
grep -q "process.platform === 'win32'" app/server/panel-process-guard.js \
  && ok "guard 有 Windows 分支" || no "guard 缺 Windows 分支"
grep -q "netstat" app/server/panel-process-guard.js \
  && ok "guard 用 netstat" || no "guard 未用 netstat"

# 独立版只 bind 127.0.0.1，loopback 不可信会让 bootstrap 恒 401（而授权码要先登录 → 死锁）。
grep -q "HERMES_PANEL_TRUST_LOOPBACK" electron/main.js \
  && grep -q "HERMES_PANEL_TRUST_LOOPBACK" app/server/panel-auth.js \
  && ok "loopback 开关两端对齐" || no "loopback 开关未对齐"

# resolveUserData 若调 logLine 会 resolveRoots → resolveUserData 无限递归。
awk '/function resolveUserData/,/^}/' electron/main.js | grep -q "^\s*logLine(" \
  && no "resolveUserData 内调 logLine（会递归）" || ok "resolveUserData 无递归"

echo "── Python 测试 ──────────────────────────────────"
PY="${HERMES_VENV:-/vol1/@apphome/hermes-agent/data/venv}/bin/python"
if [ -x "$PY" ] && [ -d tests ]; then
  OUT=$("$PY" -m pytest tests -q --no-header 2>&1 | tail -1)
  case "$OUT" in *failed*|*error*) no "pytest: $OUT";; *) ok "pytest: $OUT";; esac
else
  echo "  --   pytest 跳过（无 venv 或无 tests/）"
fi

echo "── 组装产物 ─────────────────────────────────────"
R=electron/resources/chates
if [ -d "$R" ]; then
  for f in app/server/monitor.js app/version.json runtime/node.exe \
           runtime/python/python.exe runtime/python/Scripts/hermes.exe; do
    [ -f "$R/$f" ] || no "产物缺 $f"
  done
  # 这个文件一出现，python 就把自己当 venv，prefix 指到上一层，import 全挂。
  find "$R/runtime" -name pyvenv.cfg 2>/dev/null | grep -q . \
    && no "产物里有 pyvenv.cfg（会导致 import 失败）" \
    || ok "产物无 pyvenv.cfg"
  ok "产物关键文件齐"
else
  echo "  --   未组装，跳过（先跑 electron/assemble.sh）"
fi

echo "────────────────────────────────────────────────"
[ "$FAIL" -eq 0 ] && { echo "全部通过"; exit 0; } || { echo "有失败项"; exit 1; }
