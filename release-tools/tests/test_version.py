#!/usr/bin/env python3
"""version.py 自检：映射规则、递增、边界。不依赖任何外部状态。"""
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VPY = ROOT / "release-tools" / "version.py"
STATE = ROOT / ".version-state.json"

fails = []


def check(name, got, want):
    if got == want:
        print(f"  PASS {name}: {got}")
    else:
        print(f"  FAIL {name}: got {got!r}, want {want!r}")
        fails.append(name)


def run(*args, state=None):
    """用临时 state 文件跑，不污染真实水位。"""
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin"}
    r = subprocess.run([sys.executable, str(VPY), *args], capture_output=True,
                       text=True, cwd=ROOT, env=env)
    return r.stdout.strip()


# --- 映射规则：内核 0.20.0 → 1.20.x，0.21.0 → 1.21.x，1.0.0 → 2.0.x
sys.path.insert(0, str(ROOT / "release-tools"))
import importlib.util

spec = importlib.util.spec_from_file_location("v", VPY)
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)

check("内核 0.20.0 映射", v.map_kernel((0, 20, 0)), (1, 20))
check("内核 0.21.3 映射", v.map_kernel((0, 21, 3)), (1, 21))
check("内核 1.0.0 映射", v.map_kernel((1, 0, 0)), (2, 0))
check("内核 0.20.0 不撞上游", v.map_kernel((0, 20, 0))[0] != 0, True)

# --- 三段格式（fnpack 硬要求）
check("格式三段", len(run().split(".")), 3)

# --- 递增 / 归位（备份后再跑，跑完还原）
bak = STATE.read_bytes() if STATE.exists() else None
try:
    base = run("--set", "1.20.1")
    check("--set", base, "1.20.1")
    check("--bump", run("--bump"), "1.20.2")
    check("--bump 二次", run("--bump"), "1.20.3")
    check("--sync-kernel 归 1", run("--sync-kernel"), "1.20.1")
    d = json.loads(STATE.read_text(encoding="utf-8"))
    check("state 含 kernel", d.get("kernel"), "0.20.0")
    check("state 字段齐", sorted(d), ["build", "kernel", "major", "minor"])
finally:
    if bak is not None:
        STATE.write_bytes(bak)
    else:
        STATE.unlink(missing_ok=True)

# --- 非法输入必须拒
r = subprocess.run([sys.executable, str(VPY), "--set", "0.20.0.1"],
                   capture_output=True, text=True, cwd=ROOT)
check("四段被拒", r.returncode != 0, True)

# --- build-fpk.sh 的版本正则必须与 fnpack 一致（三段）
sh = (ROOT / "release-tools" / "build-fpk.sh").read_text(encoding="utf-8")
check("脚本正则三段", "'[0-9]+\\.[0-9]+\\.[0-9]+'" in sh, True)
check("脚本无四段正则", "[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+" in sh, False)
check("脚本调 version.py", "python3 release-tools/version.py" in sh, True)
check("脚本版本守卫", "die \"版本号必须是三段纯数字" in sh, True)

print()
print(f"RESULT={'OK' if not fails else 'FAIL:' + ','.join(fails)}")
sys.exit(0 if not fails else 1)
