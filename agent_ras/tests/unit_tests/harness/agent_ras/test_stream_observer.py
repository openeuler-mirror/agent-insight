# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""Unit tests for harness StreamObserver attach/detach via write_stream trigger."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from openjiuwen.core.runner import Runner
from openjiuwen.core.runner.callback import trigger
from openjiuwen.core.session.stream.base import OutputSchema
from platform_adapter.openjiuwen.stream_observer import StreamObserver


def _ctx_for_session(session_id: str, label: str = "") -> SimpleNamespace:
    return SimpleNamespace(
        label=label,
        session=SimpleNamespace(get_session_id=lambda: session_id),
        inputs=None,
    )


@pytest.mark.asyncio
async def test_stream_observer_attach_receives_write_stream_trigger() -> None:
    session_id = "ras_stream_observer_ut"
    event = f"{session_id}write_stream"
    seen: list[tuple[str, str]] = []

    async def on_chunk(chunk_type, chunk_text, chunk, _ctx):
        seen.append((chunk_type, chunk_text))
        payload = chunk.payload if hasattr(chunk, "payload") else None
        if isinstance(payload, dict):
            payload["content"] = "TRUNCATED"

    observer = StreamObserver(on_chunk)
    observer.bind_ctx(_ctx_for_session(session_id))
    try:
        await observer.attach(session_id)
        chunk = OutputSchema(
            type="llm_output",
            index=0,
            payload={"content": "loop loop loop", "result_type": "answer"},
        )
        await trigger(event, data=chunk)
        assert seen == [("llm_output", "loop loop loop")]
        assert chunk.payload["content"] == "TRUNCATED"
    finally:
        await observer.detach()
        await Runner.callback_framework.unregister_event(event)


@pytest.mark.asyncio
async def test_stream_observer_detach_stops_delivery() -> None:
    session_id = "ras_stream_observer_detach_ut"
    event = f"{session_id}write_stream"
    calls = 0

    async def on_chunk(*_args):
        nonlocal calls
        calls += 1

    observer = StreamObserver(on_chunk)
    observer.bind_ctx(_ctx_for_session(session_id))
    try:
        await observer.attach(session_id)
        await observer.detach()
        await trigger(
            event,
            data=OutputSchema(
                type="llm_output",
                index=0,
                payload={"content": "x", "result_type": "answer"},
            ),
        )
        assert calls == 0
    finally:
        await Runner.callback_framework.unregister_event(event)


@pytest.mark.asyncio
async def test_stream_observer_allows_same_session_rebind() -> None:
    """before_invoke → before_model_call may use different ctx objects (same session)."""
    session_id = "ras_stream_observer_same_session_ut"
    event = f"{session_id}write_stream"
    seen_ctx_ids: list[int] = []

    async def on_chunk(_t, _text, _chunk, ctx):
        seen_ctx_ids.append(id(ctx))

    observer = StreamObserver(on_chunk)
    ctx_a = _ctx_for_session(session_id, "a")
    ctx_b = _ctx_for_session(session_id, "b")
    observer.bind_ctx(ctx_a)
    try:
        await observer.attach(session_id)
        assert observer.bind_ctx(ctx_b) is True
        await trigger(
            event,
            data=OutputSchema(
                type="llm_output",
                index=0,
                payload={"content": "x", "result_type": "answer"},
            ),
        )
        assert seen_ctx_ids == [id(ctx_b)]
    finally:
        await observer.detach()
        await Runner.callback_framework.unregister_event(event)


@pytest.mark.asyncio
async def test_stream_observer_rejects_cross_session_bind_ctx(caplog) -> None:
    """Attached observer rejects a ctx belonging to another session."""
    import logging

    session_id = "ras_stream_observer_cross_session_ut"
    event = f"{session_id}write_stream"
    seen_ctx_ids: list[int] = []

    async def on_chunk(_t, _text, _chunk, ctx):
        seen_ctx_ids.append(id(ctx))

    observer = StreamObserver(on_chunk)
    ctx_a = _ctx_for_session(session_id, "a")
    ctx_other = _ctx_for_session("other_session", "b")
    observer.bind_ctx(ctx_a)
    try:
        await observer.attach(session_id)
        with caplog.at_level(logging.WARNING):
            assert observer.bind_ctx(ctx_other) is False
        assert observer.bind_ctx(ctx_a) is True
        await trigger(
            event,
            data=OutputSchema(
                type="llm_output",
                index=0,
                payload={"content": "x", "result_type": "answer"},
            ),
        )
        assert seen_ctx_ids == [id(ctx_a)]
        assert any("reject bind_ctx" in r.message for r in caplog.records)
    finally:
        await observer.detach()
        await Runner.callback_framework.unregister_event(event)
