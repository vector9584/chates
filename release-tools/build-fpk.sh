#!/usr/bin/env bash
# ============================================================================
# build-fpk.sh — 从源码构建 fnOS 安装包（chates_<ver>.fpk）
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
#   release-tools/build-fpk.sh --tag 1.20.8              # 构建
#   release-tools/build-fpk.sh --tag 1.20.8 --check-only # 只预检，不产出
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

# 版本号：<代号>.<内核次版本>.<自建序号>，唯一真源 release-tools/version.py
# fnpack 只接受三段整数，四段会被拒（实测 Invalid version "0.20.0.1"）。
# 内核版本从 app/hermes-src/pyproject.toml 读，代号 = 内核 major + 1，
# 避免跟上游 0.20.x 撞车：内核 0.20.0 → 1.20.N，内核 0.21.0 → 1.21.N。
#
# 来源优先级：
#   1. FPK_VERSION 环境变量（CI/临时覆盖）
#   2. --tag 里的三段数字（v1.20.1 → 1.20.1）
#   3. .version-state.json 当前水位（version.py）
FPK_VER="${FPK_VERSION:-}"
if [ -z "$FPK_VER" ]; then
  m=$(printf '%s' "$TAG" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  if [ -n "$m" ]; then
    FPK_VER="$m"
  else
    FPK_VER=$(python3 release-tools/version.py) || die "版本号读取失败"
  fi
fi
case "$FPK_VER" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) die "版本号必须是三段纯数字 X.Y.Z（fnpack 不接受四段），得到: $FPK_VER" ;;
esac

# ------------------------------------------------ 预检
c '1;36' "== fpk 预检 =="
[ -f manifest ] || die "缺 manifest"
[ -d app ]     || die "缺 app/"

# 仓库目录名与 fpk 内部结构一致（cmd/），保持对齐主仓命名。
CMD_SRC=""
for cand in cmd; do [ -d "$cand" ] && { CMD_SRC="$cand"; break; }; done
[ -n "$CMD_SRC" ] || die "缺 cmd/"

# fpk 资产（图标 + privilege + bootstrap）从真 fpk 提取后存在 config/，
# 与主仓 config/ 对齐；避免和 electron 的 icon.ico 混淆。
[ -f config/ICON.PNG ] || die "缺 config/ICON.PNG（从官方 fpk 提取）"
[ -f config/privilege ] || die "缺 config/privilege"
ok "manifest / app / cmd / 图标 齐"

# ------------------------------------------------ 双副本同步（2026-11-26 踩过）
# 仓库里有两份 hermes-src：app/hermes-src（开发改这里）和
# electron/resources/chates/app/hermes-src（build-fpk 实际组包取这里，
# Electron 打包也用它）。以前靠手工同步，必然漂移。
# 实测踩到的后果不只是「版本旧」：electron 那份的 panel_ds_suite.py
# 里还留着真实姓名，而 app/ 那份早已脱敏成「示例用户」——
# 也就是说脱敏根本没进包，包一旦发出去就是泄漏。
# 定则：app/ 为唯一真源，组包前单向同步过去。不带 --delete，
# 避免误删 electron 侧特有的构建产物。
# 注意不只是 hermes-src：electron 侧还有 server/、ui/ 两棵独立副本，
# 实测 electron/.../app/server/panel_ds_suite.py 里同样留着真实姓名
# （fpk 组包取 hermes-src 那份、不受影响，但 Windows exe 打的就是这一份）。
# 三棵都同步，漏一棵就等于漏一条发布通道。
for d in hermes-src server ui; do
  if [ -d "app/$d" ] && [ -d "electron/resources/chates/app/$d" ]; then
    rsync -a \
      --exclude='web_dist' --exclude='node_modules' --exclude='__pycache__' \
      --exclude='*.pyc' --exclude='.git' \
      "app/$d/" "electron/resources/chates/app/$d/" \
      || die "双副本同步失败（app/$d -> electron/resources/chates/app/$d）"
  fi
done
ok "双副本已同步（真源 app/，覆盖 hermes-src/server/ui）"

# ------------------------------------------------ 脱敏闸（2026-11-26 加）
# 按值反搜，不按 key 名猜。命中即 die —— 宁可不发包，也不发泄漏包。
# 注意 pipefail：grep 无匹配返回 1，管道整体就返回 1，set -e 会当场静默退出。
# 必须用 { grep ... || true; } | wc -l 兜住（和上面 data-skeleton 凭据闸同一个坑）。
LEAK_HITS=""
# electron/resources 是 assemble/build-exe 的生成物（.gitignore 里），会携带注入后的上报地址，
# 不扫它；它本身由 app/ 复制而来，扫 app/ 就够。
SCAN_DIRS="app data-skeleton config/init"
for kw in '王瑞兵' '姜楠' '姜亚楠' '河南大学' '刘彦随' '8232B16C' '4157152D' 'ruibing.wang' '192.168.3.110'; do
  n=$( { grep -rl "$kw" $SCAN_DIRS 2>/dev/null || true; } | wc -l )
  if [ "${n:-0}" -gt 0 ]; then LEAK_HITS="$LEAK_HITS $kw($n)"; fi
done
if [ -n "$LEAK_HITS" ]; then
  c '31' "  脱敏闸命中:$LEAK_HITS"
  for kw in '王瑞兵' '姜楠' '姜亚楠' '河南大学' '刘彦随' '8232B16C' '4157152D' 'ruibing.wang' '192.168.3.110'; do
    { grep -rl "$kw" $SCAN_DIRS 2>/dev/null || true; } | sed 's/^/    /'
  done
  die "仍有真实身份痕迹（app/、electron 副本、data-skeleton、config/init），先脱敏再打包"
fi
ok "脱敏闸通过（真实姓名 0 命中）"

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
# 发布标记：面板顶栏 brandWordmark 与维护页靠 <APPDEST>/app/version.json 显示 GitHub 版本号
# （server/panel-update.js 的 readInstalledVersion 读它；以前这里 cp 一个不存在的源文件，
#  || true 把错误吞了，结果装上永远 not_a_release、顶栏空着 —— 2026-11-26 修）
VER_PLAIN=$(python3 -c "import json;print(json.load(open('win/version.json'))['version'].split('-')[0])")
cat > "$STAGE/app/version.json" <<JSON
{
  "name": "CHATES",
  "tag": "$TAG",
  "version": "$VER_PLAIN",
  "date": "$(date -u +%Y-%m-%d)",
  "repo": "https://github.com/vector9584/chates"
}
JSON
ok "version.json  tag=$TAG  version=$VER_PLAIN"
cp -a app/server app/ui "$STAGE/app/"
# 上报地址注入：源码里是 __CHATES_REPORT_URL__ 占位符（公开仓不能带私有域名），
# 打包时换成真地址。地址来自 env CHATES_REPORT_URL（CI 用仓库变量，本机来自 .env）。
# 没给就留空 → 客户端只写本地收件箱，不静默发错地方。
REPORT_BASE="${CHATES_REPORT_URL:-}"
# 本机构建没有 CI secret：从 release-tools/.report-url（.gitignore 里）取。
# 公开仓里两处都是占位符 + 这个被忽略的文件，谁也不会把域名带进 git。
if [ -z "$REPORT_BASE" ] && [ -f release-tools/.report-url ]; then
  REPORT_BASE=$(tr -d '\r\n ' < release-tools/.report-url)
fi
PJS="$STAGE/app/ui/js/panel-issues-ui.js"
if [ -n "$REPORT_BASE" ]; then
  python3 - "$PJS" "$REPORT_BASE" <<'PY'
import sys
p, base = sys.argv[1], sys.argv[2].rstrip('/') + '/'
s = open(p, encoding='utf-8').read()
n = s.count('__CHATES_REPORT_URL__')
open(p, 'w', encoding='utf-8').write(s.replace('__CHATES_REPORT_URL__', base))
print(f"  上报地址写入 {n} 处")
PY
  ok "上报地址已注入"
else
  warn "未给 CHATES_REPORT_URL，本包不上报（只写本地收件箱）"
fi
# 内核 hermes-src 不在 app/ 下，在 electron 组装产物里（88MB，61.8MB 压缩后）。
# 它是整个包体积的主体；漏了这层，产物 8.9MB vs 应有的 68MB —— 一眼能看出不对。
SRC_CANDIDATES="electron/resources/chates/app/hermes-src app/hermes-src"
for cand in $SRC_CANDIDATES; do
  if [ -d "$cand" ]; then
    cp -a "$cand" "$STAGE/app/hermes-src"
    SRC_HERMES_USED="$cand"
    break
  fi
done
[ -d "$STAGE/app/hermes-src" ] || die "找不到 hermes-src 内核（试过: $SRC_CANDIDATES）"
ok "内核    $(du -sh "$STAGE/app/hermes-src" | cut -f1)"

# dashboard 前端静态产物（hermes_cli/web_dist）—— 2026-11-26 踩过的坑：
# 它是 web/ 源码的 npm 构建产物，被 .gitignore 排除，源码树里没有；
# 但 monitor.js 起 dashboard 时会检测 ${APP_DIR}/hermes-src/hermes_cli/web_dist/index.html，
# 找不到就退回「源码模式」，而源码模式要 npm 构建 → 机器上 npm 不在 PATH →
# dashboard 直接不起（"Web UI frontend not built and npm is not available"）。
# 表现是 /proxy/dashboard 打不开、面板右上角模型/用量页全灰。
# 所以组包时必须把产物塞进包，来源优先级如下，全都找不到就报错——
# 宁可打包失败，也不要产出一个 dashboard 打不开的包。
WEB_DIST_DST="$STAGE/app/hermes-src/hermes_cli/web_dist"
if [ -f "$WEB_DIST_DST/index.html" ]; then
  ok "web_dist 随内核已带（$(du -sh "$WEB_DIST_DST" | cut -f1)）"
else
  WEB_DIST_SRC=""
  # 顺序讲究：本机构建时 /vol3/@appcenter/chates 属 chates 用户，以 hermes-agent
  # 身份读不了（实测 cp 报 Permission denied，脚本 fail-fast 退出）。
  # 所以可读的原应用副本排在前面；CI 上用 HERMES_WEB_DIST_SRC 显式指定。
  for cand in "${HERMES_WEB_DIST_SRC:-}" \
              /vol1/@appcenter/hermes-agent/hermes-src/hermes_cli/web_dist \
              /vol3/@appcenter/chates/hermes-src/hermes_cli/web_dist \
              app/hermes-src/hermes_cli/web_dist; do
    if [ -n "$cand" ] && [ -f "$cand/index.html" ] && [ -r "$cand/index.html" ]; then
      WEB_DIST_SRC="$cand"; break
    fi
  done
  [ -n "$WEB_DIST_SRC" ] || die "缺 web_dist 构建产物（dashboard 会打不开）。用 HERMES_WEB_DIST_SRC=<path> 指定，或先在 web/ 里 npm run build"
  mkdir -p "$(dirname "$WEB_DIST_DST")"
  cp -a "$WEB_DIST_SRC" "$WEB_DIST_DST" || die "复制 web_dist 失败（源: $WEB_DIST_SRC）"
  ok "web_dist 注入 $(du -sh "$WEB_DIST_DST" | cut -f1)  来源=$WEB_DIST_SRC"
fi

if [ -d app/python ];     then cp -a app/python     "$STAGE/app/"; fi
if [ -d app/bin ];        then cp -a app/bin        "$STAGE/app/"; fi
if [ -f app/package.json ]; then cp app/package.json "$STAGE/app/"; fi
# echo-web 是 dashboard 前端，有就打
if [ -d app/echo-web ];   then cp -a app/echo-web   "$STAGE/app/"; fi
find "$STAGE/app" -name '*.log' -delete 2>/dev/null || true
# init/ —— 首次安装初始化脚本与模板。install_callback 以 <TRIM_APPDEST>/init/init.sh 调用，
# 而 <TRIM_APPDEST> 是 @appcenter/<appname>（app.tgz 的解压目标），所以必须放进 app/ 下。
# 不能放 config/init：fnOS 对 config/ 只挑 privilege/resource/bootstrap/prompts 分发，
# 其余条目在 @appcenter 侧根本不存在（2026-11-26 实测：日志一直报「init.sh 不存在」）。
if [ -d config/init ]; then
  cp -a config/init "$STAGE/app/init"
  ok "init/    首次安装初始化（$(ls config/init | wc -l) 项）"
fi
# 组包前最后一道：dashboard 静态产物必须在暂存区，否则又是打不开的包
[ -f "$STAGE/app/hermes-src/hermes_cli/web_dist/index.html" ] \
  || die "暂存区缺 hermes_cli/web_dist/index.html（dashboard 会打不开）"
ok "web_dist 在包内"
ok "app/     $(du -sh "$STAGE/app" | cut -f1)（fnpack 自行压成 app.tgz）"

# 2) cmd/ —— 生命周期脚本，原样（目录名换成 fpk 要求的 cmd）
cp -a "$CMD_SRC" "$STAGE/cmd"
ok "cmd/     $(ls "$CMD_SRC" | wc -l) 个脚本"

# 3) config/ —— privilege + bootstrap + prompts(骨架) + resource(空占位)
# config/resource 是 fpk 声明共享数据目录的 JSON 文件（不是目录）。
# 内容必须和 config/privilege 的 username 一致，否则装完数据目录归错属主。
mkdir -p "$STAGE/config/prompts" "$STAGE/config/bootstrap"
PKG_USER=$(python3 -c "import json;print(json.load(open('config/privilege', encoding='utf-8'))['username'])")
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
cp config/privilege "$STAGE/config/privilege"
if [ -f config/hermes-version.env ]; then
  cp config/hermes-version.env "$STAGE/config/bootstrap/"
fi
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
cp config/ICON.PNG "$STAGE/"
if [ -f config/ICON_256.PNG ]; then
  cp config/ICON_256.PNG "$STAGE/"
fi
ok "ICON.PNG + ICON_256.PNG"

# 6) LICENSE + wizard
[ -f LICENSE ] && cp LICENSE "$STAGE/" || true
# wizard 是应用中心的安装引导页（JSON 数组），缺了安装时会少一步说明
if [ -d wizard ]; then
  mkdir -p "$STAGE/wizard"
  cp -a wizard/. "$STAGE/wizard/" 2>/dev/null || true
  ok "wizard/  $(ls "$STAGE/wizard" | tr '\n' ' ')"
fi

# 7) 凭据终闸：暂存区里不许有 .env 明文值
if grep -rqE "^(QQ_CLIENT_SECRET|NAS_SSH_PASS|SUDO_PASSWORD|GITHUB_PAT)=[^[]" "$STAGE/config" 2>/dev/null; then
  die "暂存区 config/ 里有明文凭据"
fi
ok "暂存区无明文凭据"

# ------------------------------------------------ 打包
c '1;36' "== 打包 =="
OUT="dist/chates_${FPK_VER}.fpk"
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
  if [ -f "$STAGE/ICON_256.PNG" ]; then MEMBERS="$MEMBERS ICON_256.PNG"; fi
  if [ -f "$STAGE/LICENSE" ];      then MEMBERS="$MEMBERS LICENSE"; fi
  if [ -d "$STAGE/wizard" ];       then MEMBERS="$MEMBERS wizard"; fi
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
MV=$( { tar xzOf "$OUT" manifest 2>/dev/null || true; } | { grep -oP '^version\s*=\s*\K\S+' || true; } )
[ "$MV" = "$FPK_VER" ] || die "manifest 版本 $MV != $FPK_VER"
ok "manifest 版本 = $MV"

# 版本递增校验（2026-11-25 教训）
# 应用中心按数字比大小判断能不能升级，打出来的包必须比已装版本大，
# 否则装上去显示「回退」甚至被拒。实测踩过：装 0.21.149，包是 0.21.10。
if [ -d /vol3/@appcenter/chates ] || [ -d /vol1/@appcenter/chates ]; then
  INSTALLED=$(fnos-cli --profile nas --allow-insecure-http app list 2>/dev/null \
    | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    for a in d.get('list',[]):
        if a.get('appName')=='chates':
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
