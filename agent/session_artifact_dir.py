"""会话产物目录：Python 侧唯一入口（2026-11-20）。

为什么要有这个模块
------------------
语音、生图原本各落各的全局目录（``cache/audio``、``assets/generated``），
事后问「这个会话产出了什么」查不出来。面板侧已经把每个会话的产物收进
``sessions/<归类全链>/<会话ID>/<子目录>``，Python 侧得用同一套规则算路径，
否则两边对不上（2026-11-19 实测 28 个目录里 27 个不符）。

分类只有三类（用户 2026-11-20 两次校准）
----------------------------------------
``uploads``   主人发来的文件（后端上传接口写这里）
``artifacts`` 我给出去的成品：图、表、截图、语音、AI 生图、文档
``code``      脚本与代码

``stickers`` 不是分类，是 ``preserveSessionStickers`` 的归档目标，历史消息里
的 URL 直接指着它，只为兼容保留。

只算路径、不建目录；调用方按需 ``mkdir``。预建骨架会把树撑爆
（用户原话：「分类也不要太多，不然你又要建很多空文件夹」）。

归类规则必须和 ``app/server/panel-workspace.js`` 的 ``sessionGroupDir`` 一致：
父链逐级往上（最多 8 层防环），每级把「非字母数字中文连字符」替换成下划线、
去首尾下划线、截 40 字，全空则用「未分类」。
数据源同面板：``<home>/panel-workspace.json`` 打底，
``<var>/panel-state/workspace.json`` 覆盖（面板的 readWorkspace 是 overlay 语义）。
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Optional

_SID_RE = re.compile(r"[A-Za-z0-9_-]{6,64}")
_KEEP = re.compile(r"[^A-Za-z0-9_\u4e00-\u9fa5-]+")


def _slug(value: object) -> str:
    """等价于 panel-workspace.js 的 slugPart()。"""
    return _KEEP.sub("_", str(value or "")).strip("_")[:40]


def _home() -> Path:
    try:
        from hermes_constants import get_hermes_home  # type: ignore

        return Path(get_hermes_home())
    except Exception:
        return Path(os.environ.get("HERMES_HOME") or "/vol1/@apphome/hermes-agent/data")


def _read_workspace() -> dict:
    home = _home()
    var = Path(os.environ.get("HERMES_VAR_DIR") or "/vol1/@appdata/hermes-agent")
    merged: dict = {"folders": [], "sessions": {}}
    for file in (home / "panel-workspace.json", var / "panel-state" / "workspace.json"):
        if not file.is_file():
            continue
        try:
            data = json.loads(file.read_text("utf-8")) or {}
        except Exception:
            continue
        if isinstance(data.get("folders"), list):
            merged["folders"] = data["folders"]
        if isinstance(data.get("sessions"), dict):
            merged["sessions"] = {**merged["sessions"], **data["sessions"]}
    return merged


def group_chain(sid: str, data: Optional[dict] = None) -> list[str]:
    """返回归类全链（自顶向下）；没有归类或查不到会话时返回 ["未分类"]。"""
    data = data if data is not None else _read_workspace()
    folders = [f for f in (data.get("folders") or []) if isinstance(f, dict)]
    meta = (data.get("sessions") or {}).get(sid) or {}
    cur = next((f for f in folders if f.get("id") == meta.get("folder_id")), None)
    chain: list[str] = []
    guard = 0
    while cur and guard < 8:
        guard += 1
        chain.insert(0, _slug(cur.get("name")) or "未分类")
        parent_id = cur.get("parent_id")
        cur = next((f for f in folders if f.get("id") == parent_id), None)
    return chain or ["未分类"]


def _find_workdir(sid: str) -> Optional[Path]:
    """按会话 ID 在 sessions/ 下找已存在的目录（最多 7 层）。

    归类链是从文件夹名现算的，文件夹改名/换父级之后旧目录还留着旧名字。
    只按名字算路径会让新产物写进第二个同名目录，文件列表随后只能认一个
    —— 表现为「图片凭空少了一半」。所以已存在的目录优先，算出来的只做兜底。
    """
    root = _home() / "sessions"
    best: Optional[Path] = None
    for depth_prefix in range(1, 8):
        for candidate in root.glob("/".join(["*"] * depth_prefix) + "/" + sid):
            if candidate.is_dir() and not any(part.startswith(".") for part in candidate.relative_to(root).parts):
                if any((candidate / sub).is_dir() for sub in ("artifacts", "uploads", "code", "stickers")):
                    return candidate
                best = best or candidate
    return best


def session_workdir(sid: str) -> Optional[Path]:
    """``<home>/sessions/<归类全链>/<sid>``；sid 不像面板 ID 时返回 None。"""
    sid = str(sid or "").strip()
    if not _SID_RE.fullmatch(sid):
        return None
    computed = _home() / "sessions" / Path(*group_chain(sid)) / sid
    if computed.is_dir():
        return computed
    return _find_workdir(sid) or computed


def session_artifact_dir(sid: str, kind: str = "artifacts") -> Optional[Path]:
    """会话产物目录（默认 artifacts）；只算路径不建目录。"""
    base = session_workdir(sid)
    if base is None:
        return None
    return base / (_slug(kind) or "artifacts")


def link_into_session(path: Path, sid: str, kind: str = "artifacts") -> Optional[Path]:
    """把已落盘的文件挂一份进会话目录（硬链接，跨设备退化成复制）。

    只挂副本、不动原路径：原有发送/画廊链路仍按老位置找文件。任何失败都
    返回 None 而不抛 —— 文件已经生成成功了，不能因为归档失败把结果丢掉。
    """
    try:
        target_dir = session_artifact_dir(sid, kind)
        if target_dir is None:
            return None
        target_dir.mkdir(parents=True, exist_ok=True)
        dst = target_dir / path.name
        if dst.exists() or not path.is_file():
            return dst if dst.exists() else None
        try:
            os.link(path, dst)
        except OSError:
            import shutil

            shutil.copy2(path, dst)
        return dst
    except Exception:
        return None


def current_ui_session_id() -> str:
    """当前面板会话 ID；非面板环境返回空串。"""
    try:
        from gateway.session_context import get_session_env  # type: ignore

        return (
            get_session_env("HERMES_UI_SESSION_ID")
            or get_session_env("HERMES_SESSION_ID")
            or ""
        ).strip()
    except Exception:
        return ""
