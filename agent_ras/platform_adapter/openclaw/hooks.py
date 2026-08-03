# coding: utf-8
"""OpenClaw inproc hooks scaffold: RasClient + OpenClawHostControl."""
from __future__ import annotations

from typing import Any, Callable

from platform_adapter.common.ras_client import RasClient
from platform_adapter.openclaw.host_control import OpenClawHostControl


def build_openclaw_ras_client(
    *,
    abort_fn: Callable[[], Any] | None = None,
    notice_fn: Callable[[str], Any] | None = None,
    steer_fn: Callable[[str], Any] | None = None,
) -> tuple[RasClient, OpenClawHostControl]:
    """Create a RasClient whose on_actions dispatch through OpenClawHostControl.

    Hosts should call ``client.hello(session_id, \"openclaw\")`` then ``observe``.
    """
    host = OpenClawHostControl(abort_fn=abort_fn, notice_fn=notice_fn, steer_fn=steer_fn)

    def on_actions(session_id: str, actions: list[dict[str, Any]], anomaly: Any) -> None:
        del session_id, anomaly
        for action in actions or []:
            typ = str(action.get("type") or "")
            if typ == "abort_stream":
                host.request_abort_stream()
            elif typ == "emit_notice":
                host.emit_user_notice(str(action.get("message") or ""))
            elif typ == "push_steering":
                host.push_steering(str(action.get("message") or ""))

    client = RasClient(on_actions=on_actions)
    return client, host
