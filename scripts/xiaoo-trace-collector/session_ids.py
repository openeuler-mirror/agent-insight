# coding: utf-8
"""Session id helpers shared by RAS push and OTel export."""
from __future__ import annotations


def strip_platform_prefix(session_id: str) -> str:
    """``platform:native`` → ``native`` (same rule as insight_push)."""
    sid = str(session_id or "")
    if ":" in sid:
        return sid.split(":", 1)[1]
    return sid


def with_platform_prefix(platform: str, native_id: str) -> str:
    native = str(native_id or "").strip()
    plat = str(platform or "").strip()
    if not plat:
        return native
    if native.startswith(f"{plat}:"):
        return native
    return f"{plat}:{native}"
