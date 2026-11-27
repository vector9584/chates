"""把 win/version.json 的版本号同步到 electron/package.json。

为什么需要这一步：exe 的版本号由 electron/package.json 的 version 决定
（build-exe.sh:72 读它），而 fpk 的版本号来自 win/version.json。
两份真源手工维护必然漏改 —— 2026-11-27 就漏过：fpk 显示 1.20.3，
exe 顶栏也 1.20.3，但两边靠的是两次不同的手改。

定则：win/version.json 是唯一真源，electron/package.json 永远从它派生。
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WIN = ROOT / "win" / "version.json"
ELECTRON = ROOT / "electron" / "package.json"

raw = json.loads(WIN.read_text(encoding="utf-8"))
ver = str(raw.get("version", "")).strip()
m = re.fullmatch(r"v?(\d+\.\d+\.\d+)(?:-win\.(\d+))?", ver)
if not m:
    sys.exit("win/version.json 版本格式不对: %r" % ver)
base = m.group(1)

pkg = json.loads(ELECTRON.read_text(encoding="utf-8"))
old = pkg.get("version")
if old == base:
    print("electron/package.json 已是 %s，无需改" % base)
    sys.exit(0)

pkg["version"] = base
ELECTRON.write_text(json.dumps(pkg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("electron/package.json: %s -> %s" % (old, base))
