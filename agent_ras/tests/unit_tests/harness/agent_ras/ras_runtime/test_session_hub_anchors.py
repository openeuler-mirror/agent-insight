# coding: utf-8
"""SessionHub LLM/tool anchor buckets: thinking-loop must not inherit skill call_id."""
from __future__ import annotations

import asyncio

from ras_runtime.session_hub import SessionHub, _anchor_for_anomaly


def test_observe_keeps_llm_and_tool_anchors_separate() -> None:
    hub = SessionHub()
    hub.hello("s1", "xiaoo", {
        "llm_thinking_loop": {"semantic_content_enabled": False},
    })

    asyncio.run(
        hub.observe(
            "s1",
            {
                "platform": "xiaoo",
                "kind": "tool",
                "tool": {"name": "skill", "phase": "after", "args": {}},
                "trace_anchor": {"call_id": "call_skill_1", "channel": "tool_call"},
            },
        )
    )
    asyncio.run(
        hub.observe(
            "s1",
            {
                "platform": "xiaoo",
                "kind": "assistant_text",
                "channel": "llm_output",
                "text": "hello",
                "mode": "snapshot",
                "trace_anchor": {"message_id": "msg_loop_1", "channel": "llm_output"},
            },
        )
    )
    state = hub.get("s1")
    assert state is not None
    assert state.last_tool_anchor == {"call_id": "call_skill_1", "channel": "tool_call"}
    assert state.last_llm_anchor == {"message_id": "msg_loop_1", "channel": "llm_output"}
    llm_anchor = _anchor_for_anomaly(state, "llm_thinking_loop")
    assert llm_anchor == {"message_id": "msg_loop_1", "channel": "llm_output"}
    assert "call_id" not in llm_anchor
    assert _anchor_for_anomaly(state, "repeat_tool_call") == {
        "call_id": "call_skill_1",
        "channel": "tool_call",
    }


def test_llm_kind_never_falls_back_to_tool_call_id() -> None:
    hub = SessionHub()
    hub.hello("s1", "xiaoo", {
        "llm_thinking_loop": {"semantic_content_enabled": False},
    })
    state = hub.get("s1")
    assert state is not None
    state.last_tool_anchor = {"call_id": "call_skill_1", "channel": "tool_call"}
    state.last_llm_anchor = None
    # Missing LLM anchor → None (do not silently reuse skill call_id).
    assert _anchor_for_anomaly(state, "llm_thinking_loop") is None
    assert _anchor_for_anomaly(state, "llm_thinking_dead_loop") is None
