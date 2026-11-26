#!/usr/bin/env bash
# ============================================================================
# release.sh — 把已构建的产物推到 GitHub Release
#
# 不负责构建（那是 build-fpk.sh / build-exe.sh 的事），只负责：
#   1. 核对产物存在、体积合理
#   2. 生成 SHA256SUMS
#   3. 建 tag（如果还没有）/ 建 Release / 上传资产
#
# 用法：
#   release-tools/release.sh --tag 1.20.8
#   release-tools/release.sh --tag 1.20.8 --dry
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TAG=""; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="${2:-}"; shift 2 ;;
    --dry) DRY=1; shift ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done
[ -n "$TAG" ] || { echo "必须给 --tag" >&2; exit 2; }

c() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
ok() { c '32' "  OK   $*"; }
die() { c '31' "  FAIL $*"; exit 1; }

REPO="${GH_REPO:-vector9584/chates}"

# token 只从环境读，不落盘、不打印
TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
if [ -z "$TOKEN" ]; then
  # .env 不一定在仓库根目录。本机 Hermes 的在 data/.env（本仓库的上一两级）。
  for envfile in .env ../.env ../../.env "${HERMES_DATA:-}/.env"; do
    [ -f "$envfile" ] || continue
    TOKEN=$( { grep -oP '^(GITHUB_TOKEN|GITHUB_PAT|GH_TOKEN)=\K.*' "$envfile" 2>/dev/null || true; } | head -1)
    [ -n "$TOKEN" ] && break
  done
fi
[ -n "$TOKEN" ] || die "没有 GitHub token（GITHUB_TOKEN / GH_TOKEN / .env 里的 GITHUB_PAT）"

# ------------------------------------------------ 找产物
c '1;36' "== 收集产物 =="
mkdir -p release
rm -f release/* 2>/dev/null || true

FPK=$(ls dist/*.fpk 2>/dev/null | head -1 || true)
EXE=$(ls electron/dist/*.exe 2>/dev/null | head -1 || true)

[ -n "$FPK" ] || die "没有 fpk（先跑 release-tools/build-fpk.sh）"
[ -n "$EXE" ] || die "没有 exe（先跑 release-tools/build-exe.sh）"

cp "$FPK" release/
cp "$EXE" release/
ok "fpk: $(basename "$FPK")  $(stat -c %s "$FPK") 字节"
ok "exe: $(basename "$EXE")  $(stat -c %s "$EXE") 字节"

# 体积合理性：太小说明漏了内核（曾经 8.9MB vs 应有的 68MB）
FPK_SIZE=$(stat -c %s "$FPK")
[ "$FPK_SIZE" -gt 20000000 ] || die "fpk 只有 $FPK_SIZE 字节，疑似漏了 hermes-src 内核"
ok "fpk 体积合理（>20MB）"

# ------------------------------------------------ 校验文件
c '1;36' "== 生成校验 =="
( cd release && sha256sum * > SHA256SUMS.txt )
cat release/SHA256SUMS.txt
ok "SHA256SUMS.txt"

if [ "$DRY" -eq 1 ]; then
  c '33' "  --dry：不推送"
  exit 0
fi

# ------------------------------------------------ 发布
c '1;36' "== 发布到 $REPO =="
API="https://api.github.com/repos/$REPO"

# 已存在就复用，不要重复建
REL_ID=$(curl -sf -H "Authorization: token $TOKEN" "$API/releases/tags/$TAG" 2>/dev/null \
         | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))" 2>/dev/null || true)

if [ -z "$REL_ID" ]; then
  c '33' "  创建 Release $TAG"
  BODY=$(cat <<'EOF'
## 安装

**Windows**：下载 `CHATES-Setup-*.exe`，双击安装，无需单独装 Node/Python。

**fnOS**：下载 `hermes-agent_*.fpk`，应用中心「手动安装」上传。

两个包由同一份源码现场构建。

## 校验

```
sha256sum -c SHA256SUMS.txt
```
EOF
)
  REL_JSON=$(python3 - "$TAG" "$BODY" <<'PY'
import json, sys
print(json.dumps({"tag_name": sys.argv[1], "name": f"CHATÈS {sys.argv[1]}",
                  "body": sys.argv[2], "draft": False, "prerelease": False}))
PY
)
  RESP=$(curl -sf -X POST -H "Authorization: token $TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -d "$REL_JSON" "$API/releases") || die "建 Release 失败"
  REL_ID=$(printf '%s' "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
  ok "Release id=$REL_ID"
else
  ok "复用已有 Release id=$REL_ID"
fi

# 上传资产
for f in release/*; do
  NAME=$(basename "$f")
  SIZE=$(stat -c %s "$f")
  c '33' "  上传 $NAME ($SIZE 字节)"
  # 已存在同名资产先删，否则 422
  OLD=$(curl -sf -H "Authorization: token $TOKEN" "$API/releases/$REL_ID/assets" 2>/dev/null \
        | python3 -c "
import json,sys
try:
    for a in json.load(sys.stdin):
        if a['name']=='$NAME': print(a['id'])
except Exception: pass
" | head -1)
  [ -n "$OLD" ] && curl -sf -X DELETE -H "Authorization: token $TOKEN" \
    "$API/releases/assets/$OLD" >/dev/null && c '33' "    删了旧资产 $OLD"

  curl -sf -X POST -H "Authorization: token $TOKEN" \
    -H "Content-Type: application/octet-stream" \
    --data-binary @"$f" \
    "https://uploads.github.com/repos/$REPO/releases/$REL_ID/assets?name=$NAME" \
    >/dev/null || die "上传 $NAME 失败"
  ok "$NAME 已上传"
done

c '1;32' "发布完成: https://github.com/$REPO/releases/tag/$TAG"
