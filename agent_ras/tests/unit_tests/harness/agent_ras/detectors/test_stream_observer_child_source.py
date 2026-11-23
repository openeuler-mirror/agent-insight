# coding: utf-8
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""StreamObserver unit tests — child stream_source_id skip for parent RAS."""
from __future__ import annotations

import pytest

from openjiuwen.core.single_agent.rail.base import AgentCallbackContext
from platform_adapter.openjiuwen.stream_observer import StreamObserver


class TestStreamObserverSkipChildSource:
    @pytest.mark.asyncio
    async def test_skips_chunk_with_stream_source_id(self):
        calls: list[tuple[str, str]] = []

        async def on_chunk(chunk_type, chunk_text, data, ctx):
            calls.append((chunk_type, chunk_text))

        observer = StreamObserver(on_chunk)
        observer.bind_ctx(AgentCallbackContext(agent=None))
        await observer._on_write_stream(
            data={
                "type": "llm_reasoning",
                "payload": {
                    "content": "child reasoning that would trip L2",
                    "stream_source_id": "subagent_abc",
                },
            },
        )
        assert calls == []

    @pytest.mark.asyncio
    async def test_forwards_parent_chunk_without_source_id(self):
        calls: list[tuple[str, str]] = []

        async def on_chunk(chunk_type, chunk_text, data, ctx):
            calls.append((chunk_type, chunk_text))

        observer = StreamObserver(on_chunk)
        observer.bind_ctx(AgentCallbackContext(agent=None))
        await observer._on_write_stream(
            data={
                "type": "llm_reasoning",
                "payload": {"content": "parent own reasoning"},
            },
        )
        assert calls == [("llm_reasoning", "parent own reasoning")]

    @pytest.mark.asyncio
    async def test_blank_stream_source_id_still_forwarded(self):
        calls: list[tuple[str, str]] = []

        async def on_chunk(chunk_type, chunk_text, data, ctx):
            calls.append((chunk_type, chunk_text))

        observer = StreamObserver(on_chunk)
        observer.bind_ctx(AgentCallbackContext(agent=None))
        await observer._on_write_stream(
            data={
                "type": "llm_output",
                "payload": {"content": "hello", "stream_source_id": "  "},
            },
        )
        assert calls == [("llm_output", "hello")]


class TestAbortStaleClear:
    def test_consume_clears_stale_abort_before_stream(self):
        """Mirrors ReActAgent: consume_abort_stream() before async for."""
        ctx = AgentCallbackContext(agent=None)
        ctx.request_abort_stream()
        assert ctx.has_abort_stream_request is True
        cleared = ctx.consume_abort_stream()
        assert cleared is True
        assert ctx.has_abort_stream_request is False
