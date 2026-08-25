"""In-process span collector for CoPaw (QwenPaw).

The collector owns the session/span registry and the OTLP exporter. It is
intentionally dependency-light: QwenPaw modules are only imported lazily by
hooks/patches so the package can be unit-tested standalone.
"""

from __future__ import annotations

import threading
import time
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

from .config import CollectorConfig
from .exporter import DeltaExporter
from .otlp import (
    attributes,
    decode_attributes,
    finish_span,
    json_text,
    limited_text,
    new_span,
    now_ns,
    otlp_payload,
    stable_hex,
)
from .sanitize import sanitize_value

MAX_SESSIONS = 5000


@dataclass
class _TraceContext:
    session_id: str
    root_session_id: str
    span_id: str
    parent_session_id: str | None = None


class Collector:
    """Collects spans and submits them to AgentInsight through the exporter."""

    def __init__(self, config: CollectorConfig, exporter: Any | None = None):
        self.config = config
        self.exporter = exporter or DeltaExporter(config)
        self.lock = threading.RLock()
        self.sessions: dict[str, dict[str, Any]] = {}
        self.spans: dict[str, dict[str, Any]] = {}
        self.subagent_relations: dict[str, str] = {}
        self.session_totals: dict[str, dict[str, int]] = {}
        self.react_steps: dict[str, int] = {}
        self._minted_roots: dict[str, tuple[str, float]] = {}
        self._current: ContextVar[Optional[_TraceContext]] = ContextVar(
            "copaw_trace",
            default=None,
        )

    # ------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        # Exporter is started in __init__; start() is the plugin startup hook.
        return None

    def flush(self, timeout: float = 3.0) -> None:
        self.exporter.flush(timeout)

    def close(self) -> None:
        # AC21: never lose data on shutdown - finalize any spans still open,
        # spool them, then stop the exporter.
        with self.lock:
            open_span_ids = list(self.spans.keys())
        for span_id in open_span_ids:
            self._finish(
                span_id,
                {"agent.insight.status": "interrupted"},
                error="collector closed with open span",
            )
        self.flush(timeout=5.0)
        self.exporter.close()

    # ------------------------------------------------------------------
    # context helpers
    # ------------------------------------------------------------------

    def current_session_id(self) -> str | None:
        current = self._current.get()
        return current.session_id if current else None

    def register_subagent_relation(self, child: str, parent: str | None) -> None:
        if not child:
            return
        with self.lock:
            self.subagent_relations[child] = parent or ""

    def is_subagent_session(self, session_id: str) -> bool:
        with self.lock:
            return bool(self.subagent_relations.get(session_id))

    def parent_session_for(self, session_id: str) -> str | None:
        with self.lock:
            parent = self.subagent_relations.get(session_id) or ""
            state = self.sessions.get(session_id)
            return parent or (state or {}).get("parent_session_id") or None

    def _root_id(self, session_id: str) -> str:
        with self.lock:
            state = self.sessions.get(session_id)
            return str((state or {}).get("root_session_id") or session_id)

    def _session_state(self, session_id: str, defaults: dict[str, Any] | None = None) -> dict[str, Any]:
        with self.lock:
            state = self.sessions.get(session_id)
            if state is None:
                if len(self.sessions) >= MAX_SESSIONS:
                    self.sessions.pop(next(iter(self.sessions)))
                    self._prune_session_metadata()
                state = dict(defaults or {})
                self.sessions[session_id] = state
            return state

    def _prune_session_metadata(self) -> None:
        """Bound per-session metadata so long-running processes do not leak.

        Session states are already capped by :data:`MAX_SESSIONS`; the
        relation/token/step/mint registries are kept to the same bound and
        stale mint entries are dropped by age.
        """
        limit = max(MAX_SESSIONS, 1000)
        for mapping in (self.subagent_relations, self.session_totals, self.react_steps):
            while len(mapping) > limit:
                mapping.pop(next(iter(mapping)))
        now = time.monotonic()
        stale = [sid for sid, (_, ts) in self._minted_roots.items() if now - ts > 300.0]
        for sid in stale:
            self._minted_roots.pop(sid, None)
        while len(self._minted_roots) > limit:
            self._minted_roots.pop(next(iter(self._minted_roots)))

    def _trace_id(self, root_session_id: str) -> str:
        return stable_hex(f"agent-insight:copaw:trace:{root_session_id}", 32)

    def _span_id(self, *parts: Any) -> str:
        return stable_hex("agent-insight:copaw:span:" + ":".join(map(str, parts)), 16)

    @staticmethod
    def _is_placeholder_session_id(value: Any) -> bool:
        """True when a QwenPaw context did not provide a real session id."""
        return not value or str(value).strip().lower() in ("", "unknown", "none", "null", "undefined")

    def _new_root_session_id(self) -> str:
        """Unique per-request root session for chats that omit a session id."""
        return f"qwenpaw-{now_ns()}"

    def _mint_root_session_id(self, session_id: str) -> str:
        """Reuse the most recent minted root for the session within a short
        window so one user request (title generation + ReAct LLM calls)
        shares one trace, while a new question gets a fresh trace."""
        now = time.monotonic()
        with self.lock:
            last = self._minted_roots.get(session_id)
            if last and now - last[1] < 30.0:
                return last[0]
            root = f"qwenpaw-{now_ns()}"
            self._minted_roots[session_id] = (root, now)
            return root

    def _ensure_root_id(self, session_id: str) -> str:
        """Return a real root session id for *session_id*, minting one when
        the session has no root yet (console chats only emit LLM spans)."""
        with self.lock:
            state = self.sessions.get(session_id)
            root = str((state or {}).get("root_session_id") or "")
            if not self._is_placeholder_session_id(root):
                return root
            root = self._mint_root_session_id(session_id)
            if state is None:
                state = self._session_state(session_id)
            state["root_session_id"] = root
            return root

    def _base_attributes(self, session_id: str) -> dict[str, Any]:
        with self.lock:
            state = self.sessions.get(session_id, {})
        root_id = str(state.get("root_session_id") or session_id)
        attrs: dict[str, Any] = {
            "service.name": self.config.service_name,
            "agent.insight.framework": "qwenpaw",
            "session.id": root_id,
            "qwenpaw.session_id": session_id,
            "qwenpaw.root_session_id": root_id,
        }
        if state.get("parent_session_id"):
            attrs["qwenpaw.parent_session_id"] = state["parent_session_id"]
        if state.get("agent_id"):
            attrs["qwenpaw.agent_id"] = state["agent_id"]
        if state.get("root_agent_id"):
            attrs["qwenpaw.root_agent_id"] = state["root_agent_id"]
        if state.get("agent_name"):
            attrs["qwenpaw.agent.name"] = state["agent_name"]
        if state.get("user_id"):
            attrs["qwenpaw.user_id"] = state["user_id"]
        if state.get("channel"):
            attrs["qwenpaw.channel"] = state["channel"]
        if state.get("source"):
            attrs["qwenpaw.source"] = state["source"]
        if state.get("channel_meta"):
            attrs["qwenpaw.channel_meta"] = json_text(sanitize_value(state["channel_meta"]))
        if state.get("model"):
            attrs["gen_ai.request.model"] = state["model"]
        return attrs

    def _new(self, name: str, session_id: str, parent_span_id: str | None, attrs: dict[str, Any]) -> str:
        root_id = self._ensure_root_id(session_id)
        start = now_ns()
        span_id = self._span_id(session_id, name, start)
        span = new_span(
            name=name,
            span_id=span_id,
            trace_id=self._trace_id(root_id),
            parent_span_id=parent_span_id,
            span_attributes=attrs,
            start_ns=start,
        )
        with self.lock:
            self.spans[span_id] = span
        return span_id

    def _finish(
        self,
        span_id: str,
        attrs: dict[str, Any],
        *,
        error: Optional[BaseException | str] = None,
        end_ns: int | None = None,
    ) -> None:
        with self.lock:
            span = self.spans.pop(span_id, None)
            if span is None:
                return
            session_id = self._session_id_for_span(span)
            root_id = self._root_id(session_id)
            if error:
                span["status"] = {"code": 2, "message": str(error)}
            finish_span(span, attrs, end_ns=end_ns)
            self.exporter.submit(
                f"{root_id}:{span_id}",
                otlp_payload(
                    self.config.service_name,
                    root_id,
                    self._user_id_for_session(session_id),
                    "0.2.0",
                    [span],
                ),
            )

    def _merge_span_attributes(self, span_id: str, attrs: dict[str, Any]) -> bool:
        """Update attributes of an open span (e.g. backfill the model used)."""
        with self.lock:
            span = self.spans.get(span_id)
            if span is None:
                return False
            merged = decode_attributes(span.get("attributes", []))
            merged.update(attrs)
            span["attributes"] = attributes(merged)
            return True

    def _session_id_for_span(self, span: dict[str, Any]) -> str:
        for item in span.get("attributes", []):
            if item.get("key") == "qwenpaw.session_id":
                value = item.get("value", {})
                return str(next(iter(value.values()), ""))
        return ""

    def _user_id_for_session(self, session_id: str) -> str:
        with self.lock:
            state = self.sessions.get(session_id, {})
        return str(state.get("user_id") or "")

    @staticmethod
    def _message_text(value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, str):
            return value
        if isinstance(value, bytes):
            return value.decode("utf-8", errors="replace")
        content = getattr(value, "content", None)
        if isinstance(content, list):
            parts: list[str] = []
            for block in content:
                if isinstance(block, dict):
                    text = block.get("text") or block.get("thinking")
                    if text:
                        parts.append(str(text))
                    name = block.get("name")
                    if name:
                        action = f"Action: {name}"
                        tool_input = block.get("input")
                        if tool_input:
                            action += f" {tool_input}"
                        parts.append(action)
                else:
                    text = getattr(block, "text", None) or getattr(block, "thinking", None)
                    if text:
                        parts.append(str(text))
                    name = getattr(block, "name", None)
                    if name:
                        action = f"Action: {name}"
                        tool_input = getattr(block, "input", None)
                        if tool_input:
                            action += f" {tool_input}"
                        parts.append(action)
            return "\n".join(parts)
        if isinstance(value, dict):
            return json_text(value.get("content") or value)
        return json_text(value)

    @staticmethod
    def _normalize_usage(usage: Any) -> dict[str, int]:
        if usage is None:
            return {"input_tokens": 0, "output_tokens": 0, "reasoning_tokens": 0, "total_tokens": 0}
        get = lambda key: getattr(usage, key, None)  # noqa: E731
        if isinstance(usage, dict):
            get = usage.get  # type: ignore[assignment]
        input_tokens = int(get("input_tokens") or get("prompt_tokens") or 0)
        output_tokens = int(get("output_tokens") or get("completion_tokens") or 0)
        reasoning_tokens = int(get("reasoning_tokens") or 0)
        total = int(get("total_tokens") or 0)
        if not total:
            total = input_tokens + output_tokens + reasoning_tokens
        return {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "reasoning_tokens": reasoning_tokens,
            "total_tokens": total,
        }

    # ------------------------------------------------------------------
    # AC12: sanitize then truncate
    # ------------------------------------------------------------------

    def _safe_text(self, value: Any) -> tuple[str, bool, int]:
        clean = sanitize_value(value)
        text = json_text(clean)
        return limited_text(text, self.config.max_content_chars)

    # ------------------------------------------------------------------
    # AC7: per-session ReAct step counter
    # ------------------------------------------------------------------

    def _react_step(self, session_id: str, advance: bool = False) -> int:
        # 1-based step index: the first LLM call of a ReAct loop is step 1.
        with self.lock:
            step = self.react_steps.get(session_id, 0)
            if advance:
                step += 1
                self.react_steps[session_id] = step
            return step

    # ------------------------------------------------------------------
    # agent
    # ------------------------------------------------------------------

    def start_agent(
        self,
        *,
        session_id: str,
        root_session_id: str | None = None,
        agent_id: str | None = None,
        root_agent_id: str | None = None,
        user_id: str | None = None,
        channel: str | None = None,
        source: str | None = None,
        query: Any = None,
        channel_meta: Any = None,
        is_subagent: bool = False,
        parent_session_id: str | None = None,
        model: str | None = None,
    ) -> str:
        root_id = root_session_id or session_id
        parent = parent_session_id or (self.parent_session_for(session_id) if is_subagent else None)
        with self.lock:
            if parent:
                parent_root = str(self.sessions.get(str(parent), {}).get("root_session_id") or "")
                if parent_root and not self._is_placeholder_session_id(parent_root):
                    root_id = parent_root
            if self._is_placeholder_session_id(root_id):
                # QwenPaw 真实对话不传会话 id（统一为 "unknown"）：给每个根请求
                # 分配唯一根会话，避免所有聊天合并进同一条 trace；请求内子 span 仍共享。
                root_id = self._new_root_session_id()
            state = self._session_state(
                session_id,
                {
                    "root_session_id": root_id,
                    "agent_id": agent_id or "",
                    "root_agent_id": root_agent_id or "",
                    "user_id": user_id or "",
                    "channel": channel or "",
                    "source": source or "",
                    "agent_name": agent_id or "qwenpaw",
                },
            )
            state["root_session_id"] = root_id
            state["agent_id"] = agent_id or state.get("agent_id") or ""
            state["root_agent_id"] = root_agent_id or state.get("root_agent_id") or ""
            state["user_id"] = user_id or state.get("user_id") or ""
            state["channel"] = channel or state.get("channel") or ""
            state["source"] = source or state.get("source") or ""
            if model:
                state["model"] = model
            if channel_meta:
                state["channel_meta"] = channel_meta
            if parent:
                state["parent_session_id"] = parent
            else:
                state.setdefault("parent_session_id", "")

        text, truncated, original_chars = self._safe_text(query)
        attrs = self._base_attributes(session_id)
        attrs.update(
            {
                "gen_ai.span.kind": "AGENT",
                "openinference.span.kind": "AGENT",
                "input.value": text,
                "agent.insight.content.truncated": truncated,
                "qwenpaw.query_chars": original_chars,
            }
        )
        if is_subagent or parent:
            attrs["agent.subagent"] = True
            attrs["subagent.session.id"] = session_id
            attrs["subagent.parent.session.id"] = parent or ""
        parent_span_id = None
        with self.lock:
            state = self.sessions.get(session_id, {})
            if state.get("parent_session_id"):
                parent_state = self.sessions.get(str(state["parent_session_id"]))
                if parent_state and parent_state.get("agent_span_id"):
                    parent_span_id = parent_state["agent_span_id"]
        span_id = self._new("agent", session_id, parent_span_id, attrs)
        with self.lock:
            self.sessions[session_id]["agent_span_id"] = span_id
        self._current.set(
            _TraceContext(
                session_id=session_id,
                root_session_id=root_id,
                span_id=span_id,
                parent_session_id=parent,
            )
        )
        return span_id

    def _descendant_sessions(self, session_id: str) -> list[str]:
        """All sub-agent sessions nested (transitively) under ``session_id``."""
        with self.lock:
            children = [
                sid
                for sid, state in self.sessions.items()
                if str((state or {}).get("parent_session_id") or "") == session_id
            ]
            for sid, parent in self.subagent_relations.items():
                if parent == session_id and sid not in children:
                    children.append(sid)
        descendants: list[str] = []
        for child in children:
            descendants.append(child)
            descendants.extend(self._descendant_sessions(child))
        return descendants

    def _aggregate_totals(self, session_id: str) -> dict[str, int]:
        """AC5/AC33: agent totals include LLM usage from its sub-agent tree."""
        keys = ("input_tokens", "output_tokens", "reasoning_tokens", "total_tokens")
        totals = dict(self.session_totals.get(session_id, {}))
        for descendant in self._descendant_sessions(session_id):
            child_totals = self.session_totals.get(descendant, {})
            for key in keys:
                totals[key] = totals.get(key, 0) + child_totals.get(key, 0)
        return totals

    def finish_agent_for_session(self, session_id: str, output: Any = None, error: Optional[BaseException | str] = None) -> None:
        with self.lock:
            state = self.sessions.get(session_id)
            span_id = (state or {}).get("agent_span_id")
            if not span_id:
                return
            output = output if output is not None else (state or {}).get("last_output") or ""
            totals = self._aggregate_totals(session_id)
        span = self.spans.get(span_id)
        start_ns = int(span.get("startTimeUnixNano", "0")) if span else 0
        latency_ms = max(0, (now_ns() - start_ns) // 1_000_000) if start_ns else 0
        text, truncated, original_chars = self._safe_text(output)
        attrs = {
            "output.value": text,
            "agent.insight.content.truncated": truncated,
            "qwenpaw.output_chars": original_chars,
            "qwenpaw.latency_ms": latency_ms,
            "llm.token_count.total": totals.get("total_tokens", 0),
            "qwenpaw.react.steps": self.react_steps.get(session_id, 0),
        }
        if error:
            attrs["error.message"] = str(error)
        self._finish(span_id, attrs, error=error)
        current = self._current.get()
        if current and current.session_id == session_id:
            self._current.set(None)

    # ------------------------------------------------------------------
    # llm
    # ------------------------------------------------------------------

    def start_llm(
        self,
        *,
        session_id: str | None = None,
        model: str | None = None,
        provider: str | None = None,
        input: Any = None,  # noqa: A002
        parent_span_id: str | None = None,
    ) -> str:
        current = self._current.get()
        sid = session_id or (current.session_id if current else "unknown")
        parent = parent_span_id or (current.span_id if current and current.session_id == sid else None)
        step = self._react_step(sid, advance=True)
        text, truncated, original_chars = self._safe_text(input)
        attrs = {
            **self._base_attributes(sid),
            "gen_ai.span.kind": "LLM",
            "openinference.span.kind": "LLM",
            "input.value": text,
            "agent.insight.content.truncated": truncated,
            "qwenpaw.input_chars": original_chars,
            "qwenpaw.react.step": step,
        }
        agent_span_id = None
        if model:
            attrs["llm.model_name"] = model
            attrs["gen_ai.request.model"] = model
            with self.lock:
                state = self.sessions.get(sid)
                if state is not None:
                    state["model"] = model
                    agent_span_id = state.get("agent_span_id")
        if provider:
            attrs["qwenpaw.provider"] = provider
        backfill: dict[str, Any] = {}
        if model:
            backfill["llm.model_name"] = model
            backfill["gen_ai.request.model"] = model
        if provider:
            backfill["qwenpaw.provider"] = provider
        if backfill and agent_span_id:
            # AC5: the agent span carries the model used for the session even
            # though it was opened before the first LLM call.
            self._merge_span_attributes(agent_span_id, backfill)
        return self._new(f"llm.{model or 'unknown'}", sid, parent, attrs)

    def finish_llm(self, span_id: str, output: Any = None, usage: Any = None, error: Optional[BaseException | str] = None) -> None:
        span = self.spans.get(span_id)
        if span is None:
            return
        session_id = self._session_id_for_span(span)
        text, truncated, original_chars = self._safe_text(self._message_text(output))
        usage_values = self._normalize_usage(usage)
        with self.lock:
            totals = self.session_totals.setdefault(
                session_id,
                {"input_tokens": 0, "output_tokens": 0, "reasoning_tokens": 0, "total_tokens": 0},
            )
            for key, value in usage_values.items():
                totals[key] = totals.get(key, 0) + value
            state = self.sessions.get(session_id)
            if state is not None and text:
                state["last_output"] = text
        attrs = {
            "output.value": text,
            "agent.insight.content.truncated": truncated,
            "qwenpaw.output_chars": original_chars,
            "llm.token_count.prompt": usage_values["input_tokens"],
            "llm.token_count.completion": usage_values["output_tokens"],
            "llm.token_count.total": usage_values["total_tokens"],
        }
        if usage_values.get("reasoning_tokens"):
            attrs["llm.token_count.reasoning"] = usage_values["reasoning_tokens"]
        if error:
            attrs["error.message"] = str(error)
        self._finish(span_id, attrs, error=error)

    # ------------------------------------------------------------------
    # tool / mcp / skill
    # ------------------------------------------------------------------

    def start_tool(
        self,
        *,
        session_id: str | None = None,
        tool_name: str = "unknown",
        tool_input: Any = None,
        kind: str = "general",
        parent_span_id: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> str:
        current = self._current.get()
        sid = session_id or (current.session_id if current else "unknown")
        parent = parent_span_id or (current.span_id if current and current.session_id == sid else None)
        step = self._react_step(sid)
        text, truncated, original_chars = self._safe_text(tool_input)
        attrs: dict[str, Any] = {
            **self._base_attributes(sid),
            "gen_ai.span.kind": "TOOL",
            "openinference.span.kind": "TOOL",
            "tool.name": tool_name,
            "tool.input": text,
            "qwenpaw.tool.kind": kind,
            "qwenpaw.react.step": step,
            "agent.insight.content.truncated": truncated,
            "qwenpaw.tool_input_chars": original_chars,
        }
        if extra:
            for key, value in extra.items():
                if isinstance(value, (dict, list)) or value is not None:
                    attrs[key] = sanitize_value(value) if value is not None else None
        return self._new(f"tool.{tool_name}", sid, parent, attrs)

    def finish_tool(
        self,
        span_id: str,
        output: Any = None,
        status: str = "success",
        exit_code: int | None = None,
        error: Optional[BaseException | str] = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        text, truncated, original_chars = self._safe_text(output)
        attrs: dict[str, Any] = {
            "tool.output": text,
            "tool.status": status,
            "agent.insight.content.truncated": truncated,
            "qwenpaw.tool_output_chars": original_chars,
        }
        if exit_code is not None:
            attrs["tool.exit_code"] = exit_code
        if error:
            attrs["error.message"] = str(error)
        if extra:
            for key, value in extra.items():
                attrs[key] = sanitize_value(value) if value is not None else None
        if error or status in ("error", "failed"):
            self._finish(span_id, attrs, error=error or f"tool failed: {status}")
        else:
            self._finish(span_id, attrs)

    def start_skill(
        self,
        *,
        session_id: str | None = None,
        name: str = "",
        version: Any = None,
        trigger: str | None = None,
        args: Any = None,
    ) -> str:
        return self.start_tool(
            session_id=session_id,
            tool_name="skill",
            tool_input=args,
            kind="skill",
            extra={
                "skill.name": name,
                "skill.version": version,
                "skill.trigger": trigger,
                "skill.input": args,
            },
        )

    def finish_skill(
        self,
        span_id: str,
        output: Any = None,
        status: str = "success",
        error: Optional[BaseException | str] = None,
    ) -> None:
        self.finish_tool(span_id, output=output, status=status, error=error, extra={"skill.output": output})

    def start_mcp(
        self,
        *,
        server_name: str,
        tool_name: str,
        arguments: Any = None,
        session_id: str | None = None,
        parent_span_id: str | None = None,
    ) -> str:
        return self.start_tool(
            session_id=session_id,
            tool_name=f"mcp__{server_name}__{tool_name}",
            tool_input=arguments,
            kind="mcp",
            parent_span_id=parent_span_id,
            extra={
                "mcp.server.name": server_name,
                "mcp.tool.name": tool_name,
                "mcp.arguments": arguments,
                "protocol": "mcp",
            },
        )

    def finish_mcp(
        self,
        span_id: str,
        result: Any = None,
        status: str = "success",
        error: Optional[BaseException | str] = None,
    ) -> None:
        self.finish_tool(
            span_id,
            output=result,
            status=status,
            error=error,
            extra={"mcp.result": result},
        )

    # ------------------------------------------------------------------
    # cron
    # ------------------------------------------------------------------

    def start_cron(
        self,
        *,
        job_id: str,
        job_name: str = "",
        task_type: str = "",
        trigger: str = "scheduled",
        channel: str = "",
        session_id: str | None = None,
    ) -> str:
        sid = session_id or f"cron:{job_id}"
        with self.lock:
            state = self._session_state(
                sid,
                {
                    "root_session_id": sid,
                    "channel": channel or "",
                    "source": "cron",
                },
            )
            state["channel"] = channel or state.get("channel") or ""
            state["source"] = "cron"
        attrs = {
            **self._base_attributes(sid),
            "gen_ai.span.kind": "AGENT",
            "openinference.span.kind": "AGENT",
            "cron.job_id": job_id,
            "cron.job_name": job_name,
            "cron.trigger": trigger,
            "input.value": task_type or job_name,
        }
        span_id = self._new("cron", sid, None, attrs)
        with self.lock:
            self.sessions[sid]["agent_span_id"] = span_id
        return span_id

    def finish_cron(
        self,
        span_id: str,
        status: str = "success",
        output: Any = None,
        error: Optional[BaseException | str] = None,
    ) -> None:
        text, truncated, original_chars = self._safe_text(output)
        attrs = {
            "cron.status": status,
            "cron.output": text,
            "output.value": text,
            "agent.insight.content.truncated": truncated,
            "qwenpaw.cron_output_chars": original_chars,
        }
        if error:
            attrs["error.message"] = str(error)
        self._finish(span_id, attrs, error=error)

    def on_session_end(
        self,
        session_id: str,
        is_subagent: bool | None = None,
        error: Optional[BaseException | str] = None,
    ) -> None:
        """Emit the explicit session-end marker for the root trace.

        The marker is a zero-content span that AgentInsight maps to
        ``trace_completed_at``, so a finished answer immediately gets a
        ``Session.endTime`` instead of waiting for the quiet window.
        """
        with self.lock:
            state = self.sessions.get(session_id)
            if state is None:
                self.flush()
                return
            if state.get("end_marker_submitted"):
                self.flush()
                return
            if is_subagent is None:
                is_subagent = bool(state.get("parent_session_id")) or bool(
                    self.subagent_relations.get(session_id)
                )
            if is_subagent:
                # Sub-agent spans already belong to the parent trace; only the
                # root request carries the explicit completion marker.
                self.flush()
                return
            state["end_marker_submitted"] = True

        completed_at = datetime.now(timezone.utc).isoformat()
        attrs = {
            **self._base_attributes(session_id),
            "qwenpaw.session.end": True,
            "qwenpaw.completed_at": completed_at,
        }
        if error:
            attrs["error.message"] = str(error)
        span_id = self._new("qwenpaw.session.end", session_id, None, attrs)
        self._finish(span_id, attrs, error=error)
        self.flush()
