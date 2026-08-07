"""Resolve FI↔reliability join key (= product Trace ID).

Public association key is the bare platform session id that Insight stores as
``Execution.taskId`` / ``Session.taskId`` / OTel ``session.id`` (OpenCode
``ses_…``, xiaoo gateway UUID). UI labels this **Trace ID**.

``raw/session.json`` is an *optional OpenCode plugin snapshot* (messages +
``session_id``). It is not a public association artifact and must not be
advertised as a new session-id join file. Prefer in-memory platform capture and
``interactions.json.taskId``; read the snapshot only as a fallback when those
are missing or polluted (e.g. ``msg_…``).

FI ``runId`` (``ras-…``) identifies the experiment only and must never silently
impersonate the Trace ID / ``Session.taskId``.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

# FI experiment ids: ras-20260806T140959-abcdef12
_FI_RUN_ID_RE = re.compile(r"^ras-\d{8}T[0-9a-zA-Z_-]+$")
_MESSAGE_ID_RE = re.compile(r"^msg_[0-9a-zA-Z_-]+$")
_PART_ID_RE = re.compile(r"^prt_[0-9a-zA-Z_-]+$")


def looks_like_fi_run_id(value: str) -> bool:
    return bool(_FI_RUN_ID_RE.match(value.strip()))


def looks_like_message_or_part_id(value: str) -> bool:
    s = value.strip()
    return bool(_MESSAGE_ID_RE.match(s) or _PART_ID_RE.match(s))


def is_platform_session_id(value: str | None) -> bool:
    """True when ``value`` is usable as Trace ID / FI↔RAS join key."""

    if not isinstance(value, str):
        return False
    s = value.strip()
    if not s:
        return False
    if looks_like_fi_run_id(s) or looks_like_message_or_part_id(s):
        return False
    return True


def normalize_session_candidate(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    s = value.strip()
    return s if is_platform_session_id(s) else None


def read_session_file_id(session_file: Path) -> str | None:
    """Best-effort Trace ID from OpenCode snapshot (internal artifact)."""

    if not session_file.is_file():
        return None
    try:
        payload = json.loads(session_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(payload, dict):
        return None
    for key in ("session_id", "sessionID", "sessionId"):
        sid = normalize_session_candidate(payload.get(key))
        if sid:
            return sid
    return None


def resolve_platform_session_id(
    *,
    session_file: Path | None = None,
    interactions_task_id: str | None = None,
    platform_session_id: str | None = None,
) -> tuple[str | None, bool]:
    """Resolve Trace ID (= bare platform session).

    Priority: platform capture → interactions ``taskId`` → OpenCode
    ``session.json`` snapshot (fallback only).

    Returns ``(trace_id | None, aligned)``. When unaligned, callers must not
    write ``runId`` into RAS-shared ``Session.taskId``.
    """

    for candidate in (platform_session_id, interactions_task_id):
        sid = normalize_session_candidate(candidate)
        if sid:
            return sid, True
    if session_file is not None:
        sid = read_session_file_id(session_file)
        if sid:
            return sid, True
    return None, False
