"""Windows shim for the POSIX fcntl advisory-lock API (msvcrt based).

Hermes panel Python helpers do `import fcntl`; Windows has no fcntl module.
This shim keeps those call sites untouched.
"""
import os
import time

LOCK_SH = 1
LOCK_EX = 2
LOCK_NB = 4
LOCK_UN = 8

_LK_UNLCK = 0
_LK_NBLCK = 2


def _locked(fd, mode):
    import msvcrt
    try:
        os.lseek(fd, 0, os.SEEK_SET)
    except OSError:
        pass
    msvcrt.locking(fd, mode, 1)


def flock(fd, op):
    if op & LOCK_UN:
        try:
            _locked(fd, _LK_UNLCK)
        except OSError:
            pass
        return
    if op & LOCK_NB:
        try:
            _locked(fd, _LK_NBLCK)
        except OSError as exc:
            raise BlockingIOError(str(exc))
        return
    while True:
        try:
            _locked(fd, _LK_NBLCK)
            return
        except OSError:
            time.sleep(0.05)


def lockf(fd, cmd, length=0, start=0, whence=0):
    try:
        os.lseek(fd, start, whence)
    except OSError:
        pass
    return flock(fd, LOCK_EX)


def ioctl(fd, request, arg=0):
    raise OSError("ioctl is not supported on Windows shim")
