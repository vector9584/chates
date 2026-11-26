"""ECHO storage shared by the panel, scheduler and CLI. No service startup."""
import copy
import hashlib
import importlib.util
import json
import os
from contextlib import contextmanager
from pathlib import Path
# Windows 兼容：这些 os 接口只在 POSIX 上存在，缺了就静默跳过。
# 权限位是尽力而为的语义，不该让整个保存流程崩掉。
def _fchmod(fd, mode):
    fn = getattr(os, 'fchmod', None)
    if fn:
        try:
            fn(fd, mode)
        except OSError:
            pass


def _fchown(fd, uid, gid):
    fn = getattr(os, 'fchown', None)
    if fn:
        try:
            fn(fd, uid, gid)
        except OSError:
            pass


def _geteuid():
    fn = getattr(os, 'geteuid', None)
    return fn() if fn else 0

_spec = importlib.util.spec_from_file_location('echo_panel_storage', Path(__file__).parents[1] / 'panel-echo.py')
panel = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(panel)


def read(path):
    raw = Path(path).read_bytes()
    data = json.loads(raw)
    panel.validate(data)
    return raw, data


@contextmanager
def transaction(path, backups):
    path, backups = Path(path), Path(backups)
    with panel.locked(path, True):
        raw, data = read(path)
        before = copy.deepcopy(data)
        yield data
        panel.validate(data)
        if data == before:
            return
        backups.mkdir(parents=True, exist_ok=True)
        target = backups / (hashlib.sha256(raw).hexdigest() + '.json')
        try:
            with target.open('xb') as handle:
                _fchmod(handle.fileno(), 0o600)
                handle.write(raw)
                handle.flush()
                os.fsync(handle.fileno())
        except FileExistsError:
            if target.read_bytes() != raw:
                raise ValueError('队列备份校验不一致，未修改原文件')
        panel.save(path, data)


def process_identity(pid=None):
    pid = pid or os.getpid()
    # Linux boot ID + /proc starttime disambiguate PID reuse and reboots.
    try:
        boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        stat = Path('/proc/{}/stat'.format(pid)).read_text().rsplit(')', 1)[1].split()
        return {'pid': pid, 'boot': boot, 'start': stat[19]}
    except (OSError, IndexError):
        return None


def owner_alive(owner):
    if not isinstance(owner, dict) or not owner.get('pid'):
        return None
    actual = process_identity(owner['pid'])
    if actual:
        return actual == owner
    try:
        os.kill(owner['pid'], 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return None
    return None
