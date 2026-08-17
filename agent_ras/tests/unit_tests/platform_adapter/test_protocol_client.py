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
    assert notice == {"ok": True, "channel": "xiaoo.notice"}
    assert "delivery_anchor" not in notice
    assert steer == {"ok": True, "channel": "xiaoo.steer"}
    assert "delivery_anchor" not in steer
    assert calls == [("abort", None), ("notice", "n1"), ("steer", "s1")]


def test_callable_host_forwards_delivery_anchor_from_fn() -> None:
    anchor = {"message_id": "msg_platform_1", "channel": "ras_notice"}
    host = CallableHostControl(
        platform="xiaoo",
        notice_fn=lambda _m: {"ok": True, "delivery_anchor": anchor},
        steer_fn=lambda _m: {
            "ok": True,
            "delivery_anchor": {"message_id": "msg_platform_2", "channel": "ras_steering"},
        },
    )
    notice = host.emit_user_notice("n1")
    steer = host.push_steering("s1")
    assert notice["ok"] is True
    assert notice["delivery_anchor"] == anchor
    assert steer["delivery_anchor"]["message_id"] == "msg_platform_2"
    assert steer["delivery_anchor"]["channel"] == "ras_steering"


def test_callable_host_unwired_returns_ok_false() -> None:
    host = CallableHostControl(platform="xiaoo")
    assert host.request_abort_stream()["ok"] is False
    assert host.emit_user_notice("x")["ok"] is False
    assert host.push_steering("y")["ok"] is False


def test_callable_host_fn_self_reported_failure_propagates() -> None:
    host = CallableHostControl(
        platform="xiaoo",
        abort_fn=lambda: {"ok": False, "error": "no_ack: gateway gave no execution confirmation"},
        notice_fn=lambda _m: {"ok": False, "error": "socket unavailable"},
        steer_fn=lambda _m: {"ok": False, "error": "cancel rejected"},
    )
    abort = host.request_abort_stream()
    assert abort["ok"] is False
    assert "no_ack" in abort["error"]
    assert abort["channel"] == "xiaoo.abort"
    assert host.emit_user_notice("n1")["ok"] is False
    assert host.push_steering("s1")["ok"] is False


def test_apply_wire_actions_propagates_fn_failure() -> None:
    host = CallableHostControl(
        platform="xiaoo",
        abort_fn=lambda: {"ok": False, "error": "no_ack"},
        notice_fn=lambda _m: {"ok": True},
        steer_fn=lambda _m: {"ok": True},
    )
    results = apply_wire_actions(host, [{"type": "abort_stream"}])
    assert results[0]["ok"] is False
    assert results[0]["error"] == "no_ack"


def test_apply_wire_actions_dispatches_in_order() -> None:
    host = CallableHostControl(
        platform="other",
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
        platform="other",
        abort_fn=lambda: None,
        notice_fn=noticed.append,
        steer_fn=lambda _m: None,
    )
    assert host is not None
    assert client.on_actions is not None
    client.on_actions(
        "other:s1",
        [
            {"type": "abort_stream"},
            {"type": "emit_notice", "message": "hi"},
        ],
        None,
    )
    assert noticed == ["hi"]


def test_build_protocol_ras_client_flushes_after_reporting_action_results() -> None:
    calls: list[str] = []
    client, _host = build_protocol_ras_client(
        platform="hermes",
        abort_fn=lambda: None,
    )
    client.report_action_result = lambda _sid, _result: calls.append("result") or True
    client.flush = lambda _sid: calls.append("flush") or {}

    assert client.on_actions is not None
    client.on_actions("hermes:s1", [{"type": "abort_stream"}], None)

    assert calls == ["result", "flush"]
