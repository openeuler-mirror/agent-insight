"""QwenPaw runtime lifecycle hooks for the CoPaw AgentInsight collector."""

from __future__ import annotations

from typing import Any


def _last_user_text(input_msgs: Any) -> str:
    if not isinstance(input_msgs, list) or not input_msgs:
        return ""
    for message in reversed(input_msgs):
        content = getattr(message, "content", None)
        if isinstance(content, list):
            parts = [
                str(block.get("text") if isinstance(block, dict) else getattr(block, "text", ""))
                for block in content
            ]
            text = "\n".join(part for part in parts if part).strip()
            if text:
                return text
        elif isinstance(content, str) and content.strip():
            return content.strip()
    return ""


class AgentInsightRootHook:
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
        session_id = ctx.session_id or getattr(request, "session_id", "") or ""
        is_subagent = bool(request_context.get("_spawn_subagent")) or self._collector.is_subagent_session(session_id)
        parent_session_id = (
            self._collector.parent_session_for(session_id)
            or request_context.get("parent_session_id")
            or None
        )
        self._collector.start_agent(
            session_id=session_id,
            root_session_id=ctx.root_session_id or session_id,
            agent_id=ctx.agent_id or "",
            root_agent_id=ctx.root_agent_id or "",
            user_id=str(getattr(request, "user_id", "") or ""),
            channel=str(getattr(request, "channel", "") or "console"),
            source=str(request_context.get("source") or getattr(request, "source", "") or "chat"),
            query=_last_user_text(ctx.input_msgs),
            channel_meta=getattr(request, "channel_meta", None),
            is_subagent=is_subagent,
            parent_session_id=parent_session_id,
        )
        return HookResult()


class AgentInsightCleanupHook:
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
