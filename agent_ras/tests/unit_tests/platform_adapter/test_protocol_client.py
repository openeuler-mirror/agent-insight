# coding: utf-8
"""Shared protocol L3 factory: CallableHostControl + build_protocol_ras_client."""
from __future__ import annotations

from platform_adapter.common.protocol_client import (
    CallableHostControl,
    apply_wire_actions,
    build_protocol_ras_client,
)


def test_callable_host_abort_notice_steer_channels() -> None:
    calls: list[tuple[str, str | None]] = []

    host = CallableHostControl(
        platform="xiaoo",
        abort_fn=lambda: calls.append(("abort", None)),
        notice_fn=lambda msg: calls.append(("notice", msg)),
        steer_fn=lambda msg: calls.append(("steer", msg)),
    )

    abort = host.request_abort_stream()
    notice = host.emit_user_notice("n1")
    steer = host.push_steering("s1")

    assert abort == {"ok": True, "channel": "xiaoo.abort"}
    assert notice["ok"] is True
    assert notice["channel"] == "xiaoo.notice"
    assert notice["delivery_anchor"]["channel"] == "ras_notice"
    assert steer["ok"] is True
    assert steer["channel"] == "xiaoo.steer"
    assert calls == [("abort", None), ("notice", "n1"), ("steer", "s1")]


def test_callable_host_unwired_returns_ok_false() -> None:
    host = CallableHostControl(platform="xiaoo")
    assert host.request_abort_stream()["ok"] is False
    assert host.emit_user_notice("x")["ok"] is False
    assert host.push_steering("y")["ok"] is False


def test_apply_wire_actions_dispatches_in_order() -> None:
    host = CallableHostControl(
        platform="openclaw",
        abort_fn=lambda: None,
        notice_fn=lambda _m: None,
        steer_fn=lambda _m: None,
    )
    results = apply_wire_actions(
        host,
        [
            {"type": "abort_stream"},
            {"type": "emit_notice", "message": "hello"},
            {"type": "push_steering", "message": "steer"},
        ],
    )
    assert [r["action"] for r in results] == [
        "abort_stream",
        "emit_notice",
        "push_steering",
    ]
    assert all(r["ok"] for r in results)


def test_build_protocol_ras_client_wires_on_actions() -> None:
    noticed: list[str] = []
    client, host = build_protocol_ras_client(
        platform="hermes",
        abort_fn=lambda: None,
        notice_fn=noticed.append,
        steer_fn=lambda _m: None,
    )
    assert host is not None
    assert client.on_actions is not None
    client.on_actions(
        "hermes:s1",
        [
            {"type": "abort_stream"},
            {"type": "emit_notice", "message": "hi"},
        ],
        None,
    )
    assert noticed == ["hi"]
