# Copyright (c) 2026 Huawei Technologies Co., Ltd.
#
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

"""QwenPaw runtime lifecycle hooks for the QwenPaw AgentInsight collector."""

from __future__ import annotations

from typing import Any

from .messages import extract_user_input

try:
    from qwenpaw.runtime.hooks import HookBase as _HookBase  # type: ignore[import-not-found]
except Exception:  # noqa: BLE001
    class _HookBase:
        """Fallback when QwenPaw is unavailable in standalone tests."""


def _text(value: Any) -> str:
    return str(value or "").strip()


def _agent_display_name(ctx: Any) -> str:
    cfg = getattr(ctx, "agent_config", None)
    return (
        _text(getattr(cfg, "name", None))
        or _text(getattr(cfg, "display_name", None))
        or _text(getattr(cfg, "title", None))
        or _text(getattr(ctx, "agent_id", None))
    )


class AgentInsightRootHook(_HookBase):
    """Open the agent root span before each QwenPaw request."""

    phase = None  # assigned at runtime to avoid importing qwenpaw at module load
    name = "agent_insight_root"
    priority = 12

    def __init__(self, collector: Any):
        self._collector = collector
        from qwenpaw.runtime.phases import Phase  # type: ignore[import-not-found]

        self.phase = Phase.PRE_EXECUTE

    async def run(self, ctx: Any) -> Any:
        from qwenpaw.runtime.hooks import HookResult  # type: ignore[import-not-found]

        request = getattr(ctx, "request", None)
        request_context = (
            dict(getattr(request, "request_context", None) or {})
            if request is not None
            else {}
        )
        session_id = _text(getattr(ctx, "session_id", None) or getattr(request, "session_id", ""))
        root_session_id = _text(
            getattr(ctx, "root_session_id", None)
            or request_context.get("root_session_id")
            or getattr(request, "root_session_id", "")
            or session_id
        )
        agent_id = _text(getattr(ctx, "agent_id", None))
        root_agent_id = _text(getattr(ctx, "root_agent_id", None) or request_context.get("root_agent_id"))
        agent_name = _agent_display_name(ctx)
        relation = self._collector.subagent_relation_for(session_id)
        is_subagent = bool(request_context.get("_spawn_subagent")) or bool(relation)
        parent_session_id = (
            self._collector.parent_session_for(session_id)
            or request_context.get("parent_session_id")
            or None
        )
        if is_subagent and agent_name and (request_context.get("_spawn_subagent") or relation.get("kind") in ("spawn", "batch", "fork")):
            suffix = "Fork Subagent" if request_context.get("fork_project_dir") else "Subagent"
            agent_name = f"{agent_name} · {suffix}"
        self._collector.start_agent(
            session_id=session_id,
            root_session_id=root_session_id,
            agent_id=agent_id,
            agent_name=agent_name,
            root_agent_id=root_agent_id,
            user_id=str(getattr(request, "user_id", "") or ""),
            channel=str(getattr(request, "channel", "") or "console"),
            source=str(request_context.get("source") or getattr(request, "source", "") or "chat"),
            query=extract_user_input(ctx.input_msgs),
            channel_meta=getattr(request, "channel_meta", None),
            is_subagent=is_subagent,
            parent_session_id=parent_session_id,
        )
        return HookResult()


class AgentInsightCleanupHook(_HookBase):
    """Close the agent root span and flush after each request."""

    phase = None
    name = "agent_insight_cleanup"
    priority = 50

    def __init__(self, collector: Any):
        self._collector = collector
        from qwenpaw.runtime.phases import Phase  # type: ignore[import-not-found]

        self.phase = Phase.FINALLY

    async def run(self, ctx: Any) -> Any:
        from qwenpaw.runtime.hooks import HookResult  # type: ignore[import-not-found]

        session_id = getattr(ctx, "session_id", None)
        if session_id:
            self._collector.finish_agent_for_session(session_id, error=ctx.error)
            self._collector.on_session_end(
                session_id,
                is_subagent=bool(
                    getattr(ctx, "root_session_id", None)
                    and ctx.root_session_id != session_id
                ),
                error=ctx.error,
            )
        return HookResult()
