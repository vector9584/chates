#!/usr/bin/env python3
"""version.py — 读 CHATÈS 版本号

唯一真源：win/version.json 的 "version" 字段
--------------------------------------------
    形式：X.Y.Z-win.N

        X.Y.Z   fpk / 应用中心版本（fnpack 只认三段整数）
        -win.N  Windows 安装包的构建序号（重打一次 +1，不影响 fpk 版本）

为什么是真源
------------
    win/version.json 决定 CI 的 tag，tag 又同时被
      - release-tools/build-fpk.sh  （提取 X.Y.Z → fpk 版本）
      - release-tools/build-exe.sh  （提取 X.Y.Z-win.N → exe 版本）
    读取。所以只要这一个文件对，三端必然一致。

    历史上 version.py 自己维护 .version-state.json，CI 上没有该文件时
    永远算 1.20.1，与本地 1.20.3、与 manifest 的 0.21.155 三方打架——
    那个机制已废弃，本脚本现在只读不猜。

用法
----
    python3 release-tools/version.py              # 打印 fpk 版本（X.Y.Z）
    python3 release-tools/version.py --full       # 打印完整号（X.Y.Z-win.N）
    python3 release-tools/version.py --bump-win   # Windows 构建序号 +1
    python3 release-tools/version.py --set 1.20.4 # 显式改 fpk 版本段
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WIN_JSON = ROOT / "win" / "version.json"

KERNEL_CANDIDATES = [
    ROOT / "app" / "hermes-src" / "pyproject.toml",
    ROOT / "hermes-src" / "pyproject.toml",
]


def kernel_version():
    for p in KERNEL_CANDIDATES:
        if not p.exists():
            continue
        for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
            m = re.match(r'^\s*version\s*=\s*["\']([0-9]+)\.([0-9]+)\.([0-9]+)["\']', line)
            if m:
                return ".".join(m.groups())
    return "0.20.0"


def read_win():
    """返回 (X.Y.Z, N, 原始 dict)；文件缺失或格式不对直接报错，不猜。"""
    if not WIN_JSON.exists():
        sys.exit(f"找不到版本真源: {WIN_JSON}")
    raw = json.loads(WIN_JSON.read_text(encoding="utf-8"))
    ver = str(raw.get("version", "")).strip()
    m = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)(?:-win\.(\d+))?", ver)
    if not m:
        sys.exit(f"win/version.json 的 version 格式不对: {ver!r}（要 X.Y.Z 或 X.Y.Z-win.N）")
    base = f"{m.group(1)}.{m.group(2)}.{m.group(3)}"
    winno = int(m.group(4) or 1)
    return base, winno, raw


def write_win(base, winno, raw):
    raw["version"] = f"{base}-win.{winno}"
    raw.setdefault("kernel_commit", "")
    text = json.dumps(raw, ensure_ascii=False, indent=2) + "\n"
    WIN_JSON.write_text(text, encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--full", action="store_true", help="打印完整号 X.Y.Z-win.N")
    ap.add_argument("--bump-win", action="store_true", help="Windows 构建序号 +1")
    ap.add_argument("--set", metavar="X.Y.Z", help="显式改 fpk 版本段")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    base, winno, raw = read_win()

    if a.set:
        m = re.fullmatch(r"v?(\d+\.\d+\.\d+)", a.set.strip())
        if not m:
            sys.exit(f"版本号格式不对: {a.set}（要三段 X.Y.Z，fnpack 不接受四段）")
        if m.group(1) != base:
            base = m.group(1)
            winno = 1
            write_win(base, winno, raw)
    elif a.bump_win:
        winno += 1
        write_win(base, winno, raw)

    kv = kernel_version()
    if a.json:
        print(json.dumps({"version": base, "full": f"{base}-win.{winno}",
                          "win_build": winno, "kernel": kv}, ensure_ascii=False))
    elif a.full:
        print(f"{base}-win.{winno}")
    else:
        print(base)


if __name__ == "__main__":
    main()
