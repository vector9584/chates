#!/usr/bin/env bash
# ============================================================================
# prepare-kernel.sh — 在 CI runner 上把内核 hermes-src 摆到 app/hermes-src
#
# 为什么需要这一步：内核 88MB 的真源在内网 Gitea（192.168.3.110:8418），
# GitHub runner 够不到。所以内核必须经由本仓库传递。三种载体按优先级：
#
#   1. app/hermes-src/          —— 已经作为目录提交（git 能直接管）
#   2. kernel/hermes-src.tgz    —— 压包提交（29.8MB，实测解压无损）
#   3. 都没有                   —— 明确失败
#
# 第 3 条很重要：缺内核时 fpk 会从 39MB 掉到 8.9MB，exe 会缺 half the app。
# 那种「构建成功但产物残缺」比直接失败危险得多，所以这里硬拦。
#
# 用法（workflow 里 source 它）：
#   . scripts/prepare-kernel.sh
# ============================================================================
set -euo pipefail

echo "== 准备内核 hermes-src =="

if [ -d app/hermes-src ]; then
  echo "  载体: app/hermes-src 目录（已在仓库里）"
elif [ -f kernel/hermes-src.tgz ]; then
  echo "  载体: kernel/hermes-src.tgz（压包）"
  mkdir -p app
  tar xzf kernel/hermes-src.tgz -C app
else
  echo "::error::找不到内核。需要以下之一："
  echo "  - app/hermes-src/ 目录"
  echo "  - kernel/hermes-src.tgz 压包"
  echo "生成压包："
  echo "  tar czf kernel/hermes-src.tgz -C electron/resources/chates/app hermes-src"
  exit 1
fi

# 硬校验：文件数太少说明是空包/解压失败
test -d app/hermes-src || { echo "::error::解压后没有 app/hermes-src"; exit 1; }
N=$(find app/hermes-src -type f | wc -l)
echo "  文件数: $N"
[ "$N" -gt 100 ] || { echo "::error::内核文件数异常($N)，疑似空包"; exit 1; }

# 关键文件必须在：这些是 Hermes 的入口，缺了打包出来跑不起来
for must in agent gateway tools hermes_cli; do
  [ -d "app/hermes-src/$must" ] || { echo "::error::内核缺 $must/ 目录"; exit 1; }
done
echo "  关键目录齐全: agent gateway tools hermes_cli"

du -sh app/hermes-src
echo "== 内核就绪 =="
