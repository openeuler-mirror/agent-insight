# coding: utf-8
"""TDD: HostCallbackAgentAdapter parks invoke_skill until Host fulfills."""
from __future__ import annotations

import asyncio

import pytest

from core.agents.host_callback_adapter import HostCallbackAgentAdapter


@pytest.mark.asyncio
async def test_invoke_skill_registers_pending_and_fulfill_returns_result():
    adapter = HostCallbackAgentAdapter()
    task = asyncio.create_task(
        adapter.invoke_skill(
            role="detection",
            skill_name="llm-loop-detection",
            payload="excerpt-text",
            timeout=2.0,
        )
    )
    await asyncio.sleep(0)
    pending = adapter.drain_pending_requests()
    assert len(pending) == 1
    req = pending[0]
    assert req["role"] == "detection"
    assert req["skill_name"] == "llm-loop-detection"
    assert req["payload"] == "excerpt-text"
    assert req["request_id"]

    ok = adapter.fulfill(
        req["request_id"],
        {"abnormal": True, "primary_fault": "semantic_deadlock"},
    )
    assert ok is True
    result = await task
    assert result["abnormal"] is True
    assert result["primary_fault"] == "semantic_deadlock"


@pytest.mark.asyncio
async def test_fulfill_unknown_id_returns_false():
    adapter = HostCallbackAgentAdapter()
    assert adapter.fulfill("missing", {"abnormal": False}) is False


@pytest.mark.asyncio
async def test_drain_pending_requests_hands_out_each_id_once():
    adapter = HostCallbackAgentAdapter()
    task = asyncio.create_task(
        adapter.invoke_skill(
            role="detection",
            skill_name="llm-loop-detection",
            payload="excerpt",
            timeout=2.0,
        )
    )
    await asyncio.sleep(0)
    first = adapter.drain_pending_requests()
    second = adapter.drain_pending_requests()
    assert len(first) == 1
    assert second == []
    adapter.fulfill(first[0]["request_id"], {"abnormal": False, "primary_fault": "none"})
    await task


@pytest.mark.asyncio
async def test_invoke_skill_timeout_fail_open_empty_dict():
    adapter = HostCallbackAgentAdapter()
    result = await adapter.invoke_skill(
        role="detection",
        skill_name="llm-loop-detection",
        payload="x",
        timeout=0.05,
    )
    assert result == {}
    assert adapter.drain_pending_requests() == []
