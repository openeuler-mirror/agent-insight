# coding: utf-8
"""abort 生效性探针：abort 后窗口内仍有流 → no_effect；窗口后安静 → 结案。"""
from __future__ import annotations

import asyncio
import time

from ras_embed import session_hub as hub_module
from ras_embed.session_hub import ABORT_PROBE_WINDOW_S, SessionHub


def _make_hub(monkeypatch) -> tuple[SessionHub, list[dict]]:
    pushed: list[dict] = []
    monkeypatch.setattr(
        hub_module, "fire_push_action_result",
        lambda sid, platform, body: pushed.append({"sid": sid, **body}),
    )
    hub = SessionHub()
    hub.hello("s1", "xiaoo", {"semantic_content_enabled": False})
    return hub, pushed


def _observe(hub: SessionHub, text: str = "still streaming") -> dict:
    return asyncio.run(
        hub.observe("s1", {"platform": "xiaoo", "kind": "assistant_text", "text": text})
    )


def test_probe_reports_no_effect_on_traffic_after_abort(monkeypatch) -> None:
    hub, pushed = _make_hub(monkeypatch)
    state = hub.get("s1")
    assert state is not None
    state.last_abort_ts = time.time()

    _observe(hub)

    assert len(pushed) == 1
    assert pushed[0]["action"] == "abort_stream"
    assert pushed[0]["ok"] is False
    assert "no_effect" in pushed[0]["error"]
    assert state.abort_no_effect_reported is True

    _observe(hub)
    assert len(pushed) == 1  # 同一次 abort 只报一次


def test_probe_settles_when_stream_stops(monkeypatch) -> None:
    hub, pushed = _make_hub(monkeypatch)
    state = hub.get("s1")
    assert state is not None
    state.last_abort_ts = time.time() - (ABORT_PROBE_WINDOW_S + 1.0)

    _observe(hub)

    assert pushed == []
    assert state.last_abort_ts is None  # 窗口内无流量，视为生效并结案


def test_probe_disarmed_by_session_reset(monkeypatch) -> None:
    hub, pushed = _make_hub(monkeypatch)
    state = hub.get("s1")
    assert state is not None
    state.last_abort_ts = time.time()

    hub.reset("s1")
    assert state.last_abort_ts is None  # idle/reset = 轮次真的结束 = abort 生效

    _observe(hub)
    assert pushed == []  # 下一轮（如 steering 重燃）的文本不误报 no_effect


def test_mark_abort_requested_arms_probe() -> None:
    hub = SessionHub()
    hub.hello("s1", "xiaoo", {"semantic_content_enabled": False})
    state = hub.get("s1")
    assert state is not None
    assert state.last_abort_ts is None

    SessionHub._mark_abort_requested(state, [{"type": "push_steering", "message": "x"}])
    assert state.last_abort_ts is None

    SessionHub._mark_abort_requested(
        state, [{"type": "abort_stream"}, {"type": "push_steering", "message": "x"}]
    )
    assert state.last_abort_ts is not None
    assert state.abort_no_effect_reported is False
