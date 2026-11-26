#!/usr/bin/env bash
# ============================================================================
# publish.sh — CHATÈS 一条命令发布：同时产出 fpk（fnOS）和 exe（Windows）
#
# 为什么要有它：以前每次发版都是手工串——NAS 上 assemble 出 516MB 资源、切块传到
# Windows、跑 electron-builder、再手工拼 fpk、再分别上传两个 Release。步骤一多就漏，
# 而且漏了没人发现（比如上次安装包里混进 .env 的 142 条凭据）。
#
# 设计原则：**发布物一律在 CI runner 上从源码现场重建，不从本机搬二进制**。
#   - app / 内核 / 配置  ← git checkout（可复现、有 hash）
#   - python 运行时      ← uv 现场建 venv（204MB，不可能是仓库资产）
#   - node.exe           ← 从 nodejs.org 下载并校验
#   - data 出厂骨架      ← 仓库里的 data-skeleton/（**无 .env、无凭据**）
# 本机只负责「触发 + 验收」，不参与打包内容。
#
# 用法：
#   release-tools/publish.sh --tag 1.20.8          # 完整发布（fpk + exe）
#   release-tools/publish.sh --tag 1.20.8 --dry    # 只校验，不上传
#   release-tools/publish.sh --tag ... --only fpk         # 只出 fpk
#   release-tools/publish.sh --tag ... --local            # 本机构建（调试用，慢）
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TAG=""
DRY=0
ONLY="all"
LOCAL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)   TAG="${2:-}"; shift 2 ;;
    --dry)   DRY=1; shift ;;
    --only)  ONLY="${2:-}"; shift 2 ;;
    --local) LOCAL=1; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[ -n "$TAG" ] || { echo "必须给 --tag（如 1.20.8）" >&2; exit 2; }
case "$ONLY" in all|fpk|exe) ;; *) echo "--only 只能是 all|fpk|exe" >&2; exit 2 ;; esac

c() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
step() { echo; c '1;36' "== $* =="; }
ok()   { c '32' "  OK   $*"; }
die()  { c '31' "  FAIL $*"; exit 1; }

# ------------------------------------------------ 0. 前置校验
step "0. 前置校验"

# tag 必须和两处版本号一致。版本对不上是发版最常见的事故：
# 安装包叫 win.9、里面 version.json 还是 win.8，用户装上就看不到更新。
VER_JSON=$(python3 -c "import json;print(json.load(open('win/version.json'))['version'])")
APP_VER=$(python3 -c "import json;print(json.load(open('electron/package.json'))['version'])")
ok "win/version.json      = $VER_JSON"
ok "electron/package.json = $APP_VER"

# tag 和 win/version.json 的关系：
#   win/version.json = 0.20.0-win.9  →  tag = 1.20.8
# 就是加个 v 前缀。之前用 sed 把 0.20.0-win.9 改写成 0.20.9 是错的——
# 那是 electron-builder 的 semver（0.20.9），和应用内版本不是一回事。
EXPECT_TAG="v$VER_JSON"
[ "$TAG" = "$EXPECT_TAG" ] || die "tag=$TAG 与版本不一致（win/version.json=$VER_JSON，应打 tag $EXPECT_TAG）"
ok "tag 与版本一致: $TAG"

# 凭据泄漏闸：发布物里绝不允许出现 .env / token / 密码。
# 上次安装包混进了 142 条真实凭据，就是这个检查缺位。
#
# 但本机的 electron/resources/chates/data 是组装产物、天然带 .env。
# 所以不是「要求手工清」——那是逼人绕过闸门——而是**自动替换成脱敏骨架**。
step "0b. 凭据闸"
# 不去动 electron/resources/chates/data —— 那是本机自用数据（含 .env、技能库），
# 移走会把已装好的 Windows 版搞坏。发布物里的 data 由 build-fpk/build-exe
# 各自从 data-skeleton 取，跟这份无关。
LEAK=0
for bad in .env auth.json credentials.json; do
  [ -e "data-skeleton/$bad" ] && { c '31' "  data-skeleton 里有 $bad"; LEAK=1; }
done
[ "$LEAK" -eq 0 ] && ok "data-skeleton 干净（只有 .env.example）" || die "骨架里有凭据文件"

# 骨架里的 .env.example 也不能有真值
REAL=$( { grep -rEc "^(QQ_CLIENT_SECRET|NAS_SSH_PASS|SUDO_PASSWORD|GITHUB_PAT)=[^[]" data-skeleton/ 2>/dev/null || true; } | awk -F: '{s+=$2} END{print s+0}')
[ "${REAL:-0}" -eq 0 ] || die "骨架 .env.example 有 $REAL 行明文凭据"
ok "骨架无明文凭据"

# ------------------------------------------------ 1. data 骨架
step "1. data 出厂骨架"
SRC_DATA=electron/resources/chates/data
if [ -d "$SRC_DATA" ] && [ -d "$SRC_DATA/skills" ] && [ "${SKELETON_REGENERATE:-0}" = "1" ]; then
  # 本机有真实数据时可选重新生成（会读本机 .env 做脱敏）
  bash release-tools/make-data-skeleton.py || die "骨架生成失败"
  ok "骨架已重新生成"
elif [ -d data-skeleton ] && [ -n "$(ls -A data-skeleton 2>/dev/null)" ]; then
  ok "复用仓库内 data-skeleton（$(du -sh data-skeleton | cut -f1)）"
else
  die "没有 data-skeleton。本机跑: python3 release-tools/make-data-skeleton.py"
fi

# ------------------------------------------------ 2. fpk
if [ "$ONLY" = "all" ] || [ "$ONLY" = "fpk" ]; then
  step "2. 构建 fpk"
  if [ "$LOCAL" -eq 1 ]; then
    bash release-tools/build-fpk.sh --tag "$TAG" || die "fpk 构建失败"
  else
    c '33' "  跳过本机构建（CI 负责）；本机只做校验"
    bash release-tools/build-fpk.sh --tag "$TAG" --check-only || die "fpk 预检失败"
  fi
  ok "fpk 就绪"
fi

# ------------------------------------------------ 3. exe
if [ "$ONLY" = "all" ] || [ "$ONLY" = "exe" ]; then
  step "3. 构建 exe(NSIS)"
  if [ "$LOCAL" -eq 1 ]; then
    bash release-tools/build-exe.sh --tag "$TAG" || die "exe 构建失败"
  else
    c '33' "  跳过本机构建（CI 的 windows runner 负责）"
    bash release-tools/build-exe.sh --tag "$TAG" --check-only || die "exe 预检失败"
  fi
  ok "exe 就绪"
fi

# ------------------------------------------------ 4. 发布
step "4. 发布 Release"
if [ "$ONLY" != "all" ]; then
  c '33' "  --only $ONLY：只出了一半产物，不发布（Release 必须两个都在）"
  c '1;32' "完成：$TAG（仅 $ONLY）"
  exit 0
fi
if [ "$DRY" -eq 1 ]; then
  c '33' "  --dry：不推送、不上传"
else
  bash release-tools/release.sh --tag "$TAG" || die "发布失败"
  ok "已发布 $TAG"
fi

echo
c '1;32' "完成：$TAG"
