#!/usr/bin/env python3
"""version.py 自检：唯一真源契约。

核心断言不是"版本号等于某个字面值"，而是 **三处必须一致**：
    win/version.json  →  tag  →  build-fpk.sh 提的 fpk 版本  →  manifest
历史上这三处分家，导致 Windows / GitHub / NAS 版本号互相打架，所以这里逐条锁死。
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
VPY = ROOT / "release-tools" / "version.py"
WIN_JSON = ROOT / "win" / "version.json"
MANIFEST = ROOT / "manifest"

fails = []


def check(name, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" != {want!r}"))
    if not ok:
        fails.append(name)


def run(*args):
    r = subprocess.run([sys.executable, str(VPY), *args], capture_output=True, text=True, cwd=ROOT)
    if r.returncode != 0:
        print(f"FAIL version.py {' '.join(args)} 退出码 {r.returncode}\n{r.stderr}")
        fails.append(f"run{' '.join(args)}")
        return ""
    return r.stdout.strip()


# ---- 1. 真源可读 ----
raw = json.loads(WIN_JSON.read_text(encoding="utf-8"))
win_full = raw["version"]
m = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:-win\.(\d+))?", win_full)
check("win/version.json 格式合法", bool(m), True)
if not m:
    print("真源格式不对，后续跳过")
    sys.exit(1)
base = f"{m.group(1)}.{m.group(2)}.{m.group(3)}"
winno = int(m.group(4) or 1)

# ---- 2. version.py 必须复述真源 ----
check("version.py = 真源 X.Y.Z", run(), base)
check("version.py --full = 真源完整号", run("--full"), f"{base}-win.{winno}")

# ---- 3. JSON 契约 ----
j = json.loads(run("--json"))
check("--json version", j["version"], base)
check("--json full", j["full"], f"{base}-win.{winno}")
check("--json win_build", j["win_build"], winno)
check("--json 带 kernel", "kernel" in j, True)

# ---- 4. tag → fpk 版本（CI 的真实路径）----
tag = f"v{base}-win.{winno}"
mt = re.match(r"v(\d+\.\d+\.\d+)", tag)
check("tag 能提出 fpk 三段号", mt.group(1) if mt else None, base)
check("fpk 版本是三段纯数字", bool(re.fullmatch(r"\d+\.\d+\.\d+", base)), True)

# ---- 5. manifest 不能落后 ----
mf = MANIFEST.read_text(encoding="utf-8")
mm = re.search(r"^version\s*=\s*(\S+)", mf, re.M)
check("manifest version 存在", bool(mm), True)
if mm:
    check("manifest version = fpk 版本", mm.group(1), base)

# ---- 6. 拒绝四段 ----
r = subprocess.run([sys.executable, str(VPY), "--set", "1.20.3.1"],
                   capture_output=True, text=True, cwd=ROOT)
check("四段版本被拒", r.returncode != 0, True)

print()
if fails:
    print(f"RESULT=FAIL ({len(fails)} 项)")
    sys.exit(1)
print("RESULT=OK")
