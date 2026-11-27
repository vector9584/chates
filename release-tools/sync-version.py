"""把两份版本号对齐成同一个值（release.yml 门禁要求完全相同）。

背景（2026-11-27 踩过）：
  release.yml:58 的门禁是 `[ "$V" = "$E" ]`——win/version.json 与
  electron/package.json 必须逐字相等。而 release-tools/version.py --set
  会写成 1.20.4-win.1（带 Windows 构建序号），直接撞门禁。

  11-26 已定规矩：版本号就是 tag，不加 -win.N 后缀。--set 的老行为没跟上，
  这里统一抹平：X.Y.Z-win.N → X.Y.Z。
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WIN = ROOT / "win" / "version.json"
EL = ROOT / "electron" / "package.json"

raw = json.loads(WIN.read_text(encoding="utf-8"))
ver = str(raw.get("version", "")).strip()

m = re.fullmatch(r"v?(\d+\.\d+\.\d+)(?:-win\.\d+)?", ver)
if not m:
    sys.exit("版本格式不对: %r" % ver)
base = m.group(1)

changed = []
if ver != base:
    raw["version"] = base
    WIN.write_text(json.dumps(raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    changed.append("win/version.json: %s -> %s" % (ver, base))

pkg = json.loads(EL.read_text(encoding="utf-8"))
if pkg.get("version") != base:
    old = pkg.get("version")
    pkg["version"] = base
    EL.write_text(json.dumps(pkg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    changed.append("electron/package.json: %s -> %s" % (old, base))

# manifest 也要跟（build-fpk 会替换，但源码里留旧值 test_version.py 报 FAIL）
MAN = ROOT / "manifest"
txt = MAN.read_text(encoding="utf-8")
new_txt = re.sub(r"(?m)^version\s*=\s*\S+", "version               = " + base, txt, count=1)
if new_txt != txt:
    MAN.write_text(new_txt, encoding="utf-8")
    changed.append("manifest -> %s" % base)

if changed:
    print("\n".join(changed))
else:
    print("三处版本号已是 %s，无需改" % base)

# 门禁等价断言
v = json.loads(WIN.read_text(encoding="utf-8"))["version"]
e = json.loads(EL.read_text(encoding="utf-8"))["version"]
print()
print("门禁校验: win=%r electron=%r  相等=%s" % (v, e, v == e))
sys.exit(0 if v == e else 1)
