"""Minimal pwd shim for Windows."""
import os
from collections import namedtuple

struct_passwd = namedtuple("struct_passwd", "pw_name pw_passwd pw_uid pw_gid pw_gecos pw_dir pw_shell")


def _current():
    name = os.environ.get("USERNAME", "user")
    home = os.environ.get("USERPROFILE", "C:\\")
    return struct_passwd(name, "x", 0, 0, name, home, "")


def getpwuid(uid=None):
    return _current()


def getpwnam(name=None):
    return _current()


def getpwall():
    return [_current()]
