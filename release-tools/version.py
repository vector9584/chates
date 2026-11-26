#!/usr/bin/env python3
"""version.py — CHATÈS 版本号唯一真源

格式（fnpack 硬限制：只接受 x.y.z 三段整数，四段会被拒）
----
    <major>.<kernel_minor>.<build>

    0 . 20 . 1
    │    │    └─ 自建序号：同内核线第几次打包，单调递增
    │    └────── 内核次版本（上游 pyproject 的 minor）
    └─────────── 第一代

为什么这么映射
--------------
    上游内核 0.20.0 的 major 是 0，直接拿 0.20.x 当自己的号会跟上游撞车
    （上游升 0.20.1 就分不清是谁的）。所以把 major 提到 1：

        内核 0.20.0  →  CHATÈS 1.20.N
        内核 0.21.0  →  CHATÈS 1.21.N
        内核 1.0.0   →  CHATÈS 2.0.N   （major+1）

    第二段跟内核 minor 走，换个内核线一眼看得出版本代际。
    第三段是自建序号，重打包就 +1。

    例：1.20.1 → 1.20.2 → 内核升 0.21 → 1.21.1

与旧版的关系
------------
    旧版是 0.21.155 这种三段号。1.20.1 > 0.21.155（第一段 1 > 0），
    天然是升级，不会被应用中心拒绝——不过 vol3 要卸载重装，这条不影响。

用法
----
    python3 release-tools/version.py                 # 打印当前版本
    python3 release-tools/version.py --bump          # 自建序号 +1
    python3 release-tools/version.py --sync-kernel   # 重读内核，序号归 1
    python3 release-tools/version.py --set 1.20.5    # 显式指定
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / ".version-state.json"

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
                return tuple(int(g) for g in m.groups())
    return (0, 20, 0)


def map_kernel(kv):
    """"内核版本 → CHATÈS 前两段（major+1，minor 跟内核）"""
    maj, mnr, _ = kv
    return maj + 1, mnr


def load():
    if STATE.exists():
        try:
            d = json.loads(STATE.read_text(encoding="utf-8"))
            if isinstance(d.get("major"), int) and isinstance(d.get("minor"), int) and isinstance(d.get("build"), int):
                return d
        except Exception:
            pass
    maj, mnr = map_kernel(kernel_version())
    return {"major": maj, "minor": mnr, "build": 1,
            "kernel": ".".join(map(str, kernel_version()))}


def save(d):
    d["kernel"] = ".".join(map(str, kernel_version()))
    STATE.write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def fmt(d):
    return f"{d['major']}.{d['minor']}.{d['build']}"


def parse(s):
    m = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", s.strip())
    if not m:
        sys.exit(f"版本号格式不对: {s}（要三段 X.Y.Z，fnpack 不接受四段）")
    return {"major": int(m.group(1)), "minor": int(m.group(2)), "build": int(m.group(3))}


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--bump", action="store_true", help="自建序号 +1")
    ap.add_argument("--sync-kernel", action="store_true", help="重读内核版本线，序号归 1")
    ap.add_argument("--set", metavar="X.Y.Z", help="显式指定版本")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    d = load()
    if a.set:
        d = parse(a.set)
    elif a.sync_kernel:
        maj, mnr = map_kernel(kernel_version())
        d = {"major": maj, "minor": mnr, "build": 1}
    elif a.bump:
        d = {"major": d["major"], "minor": d["minor"], "build": d["build"] + 1}

    if a.set or a.sync_kernel or a.bump or not STATE.exists():
        save(d)

    print(json.dumps({**d, "kernel": ".".join(map(str, kernel_version()))}, ensure_ascii=False)
          if a.json else fmt(d))


if __name__ == "__main__":
    main()
