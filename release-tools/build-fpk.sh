#!/usr/bin/env bash
# ============================================================================
# build-fpk.sh — 从源码构建 fnOS 安装包（hermes-agent_<ver>.fpk）
#
# fpk 本质是个 gzip tar，结构固定：
#   app.tgz          运行代码（解到 /var/apps/<name>/target）
#   cmd/             生命周期脚本 main/install_*/upgrade_* ...
#   config/          privilege、prompts(SOUL/AGENTS/skills/config.yaml)、bootstrap
#   manifest         元信息（appname/version/install_dep_apps/...）
#   ICON.PNG
#
# 两条路：
#   1. 有 fnpack   → fnpack build（官方，校验最全）
#   2. 没有 fnpack → 手工 tar（CI runner 上常见，行为等价，自己拼同样的结构）
#
# 用法：
#   release-tools/build-fpk.sh --tag v0.20.0-win.9              # 构建
#   release-tools/build-fpk.sh --tag v0.20.0-win.9 --check-only # 只预检，不产出
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
die() { c '31' "  FAIL $*"; exit 1; }

# 版本号：fpk 的 manifest.version 用三段纯数字（0.21.149 这种），
# 不能带 win.9 后缀——fnOS 应用中心按数字比对版本做升级判断。
#
# 语义映射：exe 用 semver 0.20.8，fpk 用 0.21.149 这一系。
# 两边是不同分发通道，各自版本线性递增，不需要相等。
FPK_VER="${FPK_VERSION:-$(python3 -c "
import json,re
d=json.load(open('electron/package.json', encoding='utf-8'))
v=d['version']                     # 0.20.8
maj,minor,patch=v.split('.')
print(f'{maj}.{int(minor)+1}.{patch}')
")}"

# ------------------------------------------------ 预检
c '1;36' "== fpk 预检 =="
[ -f manifest ] || die "缺 manifest"
[ -d app ]     || die "缺 app/"

# 仓库里目录名带 fpk- 前缀（fpk-cmd/fpk-bin/fpk-init/fpk-wizard），
# 而 fpk 内部结构要求叫 cmd/。这里做一次映射，别去改仓库目录名。
CMD_SRC=""
for cand in cmd fpk-cmd; do [ -d "$cand" ] && { CMD_SRC="$cand"; break; }; done
[ -n "$CMD_SRC" ] || die "缺 cmd/（或 fpk-cmd/）"

# fpk 资产（图标 + privilege + bootstrap）从真 fpk 提取后存在 fpk-assets/，
# 不在仓库根目录乱放，也避免和 electron 的 icon.ico 混淆。
[ -f fpk-assets/ICON.PNG ] || die "缺 fpk-assets/ICON.PNG（从官方 fpk 提取）"
[ -f fpk-assets/privilege ] || die "缺 fpk-assets/privilege"
ok "manifest / app / cmd / 图标 齐"

ok "fpk 资产齐全"

# config/prompts 是 fpk 的出厂人格与配置，必须用脱敏后的骨架，
# 绝不能用本机 data/（含 .env 真凭据 + 169 个含指纹的技能）。
if [ -d data-skeleton ]; then
  ok "data-skeleton 存在（$(( $(du -sk data-skeleton | cut -f1) / 1024 ))MB）"
else
  die "缺 data-skeleton，先跑 release-tools/make-data-skeleton.py"
fi

# 凭据闸：骨架里不允许出现真凭据形态
# grep -c 无匹配时返回 1；set -e 会当场退出，且因为已在管道里看不到任何输出。
# 必须 || true 兜住退出码，再判断数字。这个坑今天让脚本「静默退出无报错」过一次。
LEAK=$( { grep -rEc "^(QQ_CLIENT_SECRET|NAS_SSH_PASS|SUDO_PASSWORD|GITHUB_PAT)=[^[]" data-skeleton/ 2>/dev/null || true; } | awk -F: '{s+=$2} END{print s+0}')
[ "${LEAK:-0}" -eq 0 ] || die "data-skeleton 里有明文凭据 ($LEAK 行)"
ok "凭据闸通过"

echo "  fpk 版本: $FPK_VER"

if [ "$CHECK_ONLY" -eq 1 ]; then
  c '33' "  --check-only：预检通过，不产出 fpk"
  exit 0
fi

# ------------------------------------------------ 组装暂存区
c '1;36' "== 组装 fpk 暂存区 =="
STAGE="build/fpk-stage"
rm -rf "$STAGE"; mkdir -p "$STAGE"

# 1) app/ —— 运行代码，fnpack 会自己压成 app.tgz
#    关键：别自己预先打 app.tgz。fnpack 期望看到 app/ 目录并自行压缩；
#    预先压好的 app.tgz 会被它当普通文件再压一层，导致内部 bin/ 找不到。
mkdir -p "$STAGE/app"
cp -a app/server app/ui app/version.json "$STAGE/app/" 2>/dev/null || true
# 内核 hermes-src 不在 app/ 下，在 electron 组装产物里（88MB，61.8MB 压缩后）。
# 它是整个包体积的主体；漏了这层，产物 8.9MB vs 应有的 68MB —— 一眼能看出不对。
SRC_CANDIDATES="electron/resources/chates/app/hermes-src app/hermes-src"
for cand in $SRC_CANDIDATES; do
  [ -d "$cand" ] && { cp -a "$cand" "$STAGE/app/hermes-src"; break; }
done
[ -d "$STAGE/app/hermes-src" ] || die "找不到 hermes-src 内核（试过: $SRC_CANDIDATES）"
ok "内核    $(du -sh "$STAGE/app/hermes-src" | cut -f1)"

[ -d app/python ]     && cp -a app/python     "$STAGE/app/"
[ -d app/bin ]        && cp -a app/bin        "$STAGE/app/"
[ -f app/package.json ] && cp app/package.json "$STAGE/app/"
# echo-web 是 dashboard 前端，有就打
[ -d app/echo-web ]   && cp -a app/echo-web   "$STAGE/app/"
find "$STAGE/app" -name '*.log' -delete 2>/dev/null || true
ok "app/     $(du -sh "$STAGE/app" | cut -f1)（fnpack 自行压成 app.tgz）"

# 2) cmd/ —— 生命周期脚本，原样（目录名换成 fpk 要求的 cmd）
cp -a "$CMD_SRC" "$STAGE/cmd"
ok "cmd/     $(ls "$CMD_SRC" | wc -l) 个脚本"

# 3) config/ —— privilege + bootstrap + prompts(骨架) + resource(空占位)
# config/resource 是 fpk 声明共享数据目录的 JSON 文件（不是目录）。
# 内容必须和 config/privilege 的 username 一致，否则装完数据目录归错属主。
mkdir -p "$STAGE/config/prompts" "$STAGE/config/bootstrap"
PKG_USER=$(python3 -c "import json;print(json.load(open('fpk-assets/privilege', encoding='utf-8'))['username'])")
cat > "$STAGE/config/resource" <<EOF
{
    "data-share": {
        "shares": [
            {
                "name": "$PKG_USER"
            }
        ]
    },
    "usr-local-linker": {
        "bin": [
            "bin/hermes"
        ]
    }
}
EOF
cp fpk-assets/privilege "$STAGE/config/privilege"
[ -f fpk-assets/hermes-version.env ] && cp fpk-assets/hermes-version.env "$STAGE/config/bootstrap/"
# prompts 用脱敏骨架，不用本机 data（本机 data 有 169 个含指纹的技能 + .env 真凭据）
cp data-skeleton/SOUL.md      "$STAGE/config/prompts/SOUL.md"
cp data-skeleton/AGENTS.md    "$STAGE/config/prompts/AGENTS.md"
cp data-skeleton/config.yaml  "$STAGE/config/prompts/config.yaml"
ok "config/ privilege + bootstrap + prompts(脱敏骨架)"

# 4) manifest —— 版本号替换
python3 - "$FPK_VER" <<'PY'
import re, sys, shutil
ver = sys.argv[1]
src = open('manifest', encoding='utf-8').read()
out = re.sub(r'(?m)^version\s*=.*$', f'version               = {ver}', src)
open('build/fpk-stage/manifest', 'w', encoding='utf-8').write(out)
PY
ok "manifest version = $FPK_VER"

# 5) 图标（两个尺寸，应用中心要 ICON_256.PNG）
cp fpk-assets/ICON.PNG "$STAGE/"
[ -f fpk-assets/ICON_256.PNG ] && cp fpk-assets/ICON_256.PNG "$STAGE/"
ok "ICON.PNG + ICON_256.PNG"

# 6) LICENSE + wizard
[ -f LICENSE ] && cp LICENSE "$STAGE/" || true
# wizard 是应用中心的安装引导页（JSON 数组），缺了安装时会少一步说明
if [ -d fpk-wizard ]; then
  mkdir -p "$STAGE/wizard"
  cp -a fpk-wizard/. "$STAGE/wizard/" 2>/dev/null || true
  ok "wizard/  $(ls "$STAGE/wizard" | tr '\n' ' ')"
fi

# 7) 凭据终闸：暂存区里不许有 .env 明文值
if grep -rqE "^(QQ_CLIENT_SECRET|NAS_SSH_PASS|SUDO_PASSWORD|GITHUB_PAT)=[^[]" "$STAGE/config" 2>/dev/null; then
  die "暂存区 config/ 里有明文凭据"
fi
ok "暂存区无明文凭据"

# ------------------------------------------------ 打包
c '1;36' "== 打包 =="
OUT="dist/hermes-agent_${FPK_VER}.fpk"
mkdir -p dist

# fnpack 是飞牛专有工具，但**静态编译的 x86-64 单文件**（3.7MB，无动态依赖）。
# 所以随仓库带一份 release-tools/vendor/fnpack，CI runner 直接用，不用额外装。
# 优先级：仓库内 vendor > 系统 PATH > 手工 tar 兜底
FNPACK=""
for cand in release-tools/vendor/fnpack fnpack; do
  if command -v "$cand" >/dev/null 2>&1 || [ -x "$cand" ]; then FNPACK="$cand"; break; fi
done

if [ -n "$FNPACK" ]; then
  # 官方工具：fnpack build 需要一个带 manifest 的目录
  ABS_FNPACK="$FNPACK"
  case "$FNPACK" in /*) ;; *) ABS_FNPACK="$ROOT/$FNPACK" ;; esac
  ( cd "$STAGE" && "$ABS_FNPACK" build ) || die "fnpack build 失败"
  # fnpack 产物名不一定带版本，统一改名
  FOUND=$(find "$STAGE" -maxdepth 1 -name "*.fpk" | head -1)
  [ -n "$FOUND" ] || die "fnpack 没产出 fpk"
  mv "$FOUND" "$OUT"
  ok "fnpack build"
else
  # 手工 tar：结构与 fnpack 等价。需要自己压 app.tgz（fnpack 才自动压）。
  c '33' "  本机无 fnpack，用手工 tar（结构等价）"
  ( cd "$STAGE" && tar czf app.tgz app ) || die "压 app.tgz 失败"
  rm -rf "$STAGE/app"
  MEMBERS="app.tgz cmd config manifest ICON.PNG"
  [ -f "$STAGE/ICON_256.PNG" ] && MEMBERS="$MEMBERS ICON_256.PNG"
  [ -f "$STAGE/LICENSE" ] && MEMBERS="$MEMBERS LICENSE"
  [ -d "$STAGE/wizard" ] && MEMBERS="$MEMBERS wizard"
  ( cd "$STAGE" && tar czf "$ROOT/$OUT" $MEMBERS ) || die "tar 打包失败"
fi

# ------------------------------------------------ 校验
c '1;36' "== 校验 =="
[ -f "$OUT" ] || die "产物不存在"
SIZE=$(stat -c %s "$OUT")
ok "产物 $OUT  ${SIZE} 字节"

# 结构校验：先把成员列表取到变量，不要每次 tar | grep（管道 + set -e 会误杀）
MEMBERS_LIST=$(tar tzf "$OUT" 2>/dev/null || true)
for m in app.tgz manifest cmd/main config/privilege config/resource; do
  printf '%s\n' "$MEMBERS_LIST" | grep -qx "$m" || die "fpk 缺成员: $m"
done
ok "结构完整（app.tgz / manifest / cmd/main / config/{privilege,resource}）"

# 版本校验：manifest 里的版本和文件名一致
MV=$(tar xzOf "$OUT" manifest 2>/dev/null | grep -oP '^version\s*=\s*\K\S+')
[ "$MV" = "$FPK_VER" ] || die "manifest 版本 $MV != $FPK_VER"
ok "manifest 版本 = $MV"

# 版本递增校验（2026-11-25 教训）
# 应用中心按数字比大小判断能不能升级，打出来的包必须比已装版本大，
# 否则装上去显示「回退」甚至被拒。实测踩过：装 0.21.149，包是 0.21.10。
if [ -d /vol1/@appcenter/hermes-agent ]; then
  INSTALLED=$(fnos-cli --profile nas --allow-insecure-http app list 2>/dev/null \
    | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    for a in d.get('list',[]):
        if a.get('appName')=='hermes-agent':
            print(a.get('version','')); break
except Exception:
    pass
" 2>/dev/null)
  if [ -n "$INSTALLED" ]; then
    NEWER=$(python3 -c "
import sys
def k(v):
    try: return tuple(int(x) for x in v.split('.'))
    except: return (0,)
print(1 if k('$MV') > k('$INSTALLED') else 0)
")
    ok "已装版本 = $INSTALLED"
    if [ "$NEWER" != "1" ]; then
      c '33' "  警告：$MV 不大于已装 $INSTALLED，应用中心可能拒绝升级"
      c '33' "  用 FPK_VERSION=<更高的版本> 重打"
    else
      ok "版本递增 $INSTALLED -> $MV"
    fi
  fi
fi

mkdir -p build
echo "$OUT" > build/.fpk-out
c '1;32' "fpk 完成: $OUT (${SIZE} 字节)"
