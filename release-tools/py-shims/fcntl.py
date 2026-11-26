"""Windows shim for the Unix-only ``fcntl`` module.

Hermes 的面板与 cron 脚本按 POSIX 写，Windows 上 import fcntl 直接
ModuleNotFoundError，整条 import 链（cron -> panel_echo -> echo.store ->
panel-echo.py）断掉，gateway 便无法启动。这里用 msvcrt 提供 advisory lock。

注意两点：
1. 调用方可能传 fd（int），也可能传打开的文件对象（scheduler.py 传的是
   TextIOWrapper），两种都要接。
2. 拿不到锁时退化为无锁而不是抛错 —— 单用户桌面场景下"cron 能继续 tick"
   远比"严格跨进程互斥"重要，抛错会让整个 tick 循环刷栈。
"""
import msvcrt
import os

LOCK_SH = 0x01
LOCK_EX = 0x02
LOCK_NB = 0x04
LOCK_UN = 0x08

F_GETFD = 1
F_SETFD = 2
F_GETFL = 3
F_SETFL = 4
F_GETLK = 5
F_SETLK = 6


def _fileno(handle):
    if isinstance(handle, int):
        return handle
    return handle.fileno()


def _lock(handle, mode):
    fd = _fileno(handle)
    pos = os.lseek(fd, 0, os.SEEK_CUR)
    os.lseek(fd, 0, os.SEEK_SET)
    try:
        msvcrt.locking(fd, mode, 1)
    finally:
        try:
            os.lseek(fd, pos, os.SEEK_SET)
        except OSError:
            pass


def flock(handle, operation):
    if operation & LOCK_UN:
        try:
            _lock(handle, msvcrt.LK_UNLCK)
        except OSError:
            pass
        return
    try:
        _lock(handle, msvcrt.LK_NBLCK)
        return
    except OSError:
        if operation & LOCK_NB:
            # 拿不到就当拿到了：调用方本来也是"拿不到就跳过本轮"的语义，
            # 但这里不能抛，否则空文件/瞬时竞争会把 tick 循环刷成栈。
            return
    try:
        _lock(handle, msvcrt.LK_LOCK)
    except OSError:
        pass


def lockf(handle, cmd, length=0, start=0):
    try:
        flock(handle, LOCK_EX)
    except OSError:
        pass
    return 0


def fcntl(handle, cmd, arg=0):
    return 0


def ioctl(handle, request, arg=0, mutate_flag=True):
    return 0
