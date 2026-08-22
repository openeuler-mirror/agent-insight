# coding: utf-8
"""Build OTLP/HTTP JSON spans compatible with Insight normalize + generic adapter.

Required for existing Insight (no server change):
  - resource/span ``session.id`` (= RAS taskId / native session)
  - ``service.name``
  - LLM: gen_ai.* (or gen_ai.span.kind=llm)
  - Tool: tool.name (+ input/output)

Optional dual-write: witty.session.id / witty.tool.* / witty.agent.*

Timestamps: each LLM turn and tool records its own start/end (wall-clock ns)
so Insight Trace sorting by startTimeMs stays ordered across multi-turn sessions.
"""
from __future__ import annotations

import hashlib
import time
from typing import Any

from session_ids import strip_platform_prefix


def _now_ns() -> int:
    return time.time_ns()


def _otel_value(value: Any) -> dict[str, Any]:
    if isinstance(value, bool):
        return {"boolValue": value}
    if isinstance(value, int) and not isinstance(value, bool):
        return {"intValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    return {"stringValue": "" if value is None else str(value)}


def otel_attributes(values: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for key, value in values.items():
        if value is None or value == "":
            continue
        out.append({"key": key, "value": _otel_value(value)})
    return out


def stable_hex(seed: str, n: int) -> str:
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()
    return digest[:n]


def truncate(text: str, limit: int = 4096) -> str:
    s = str(text or "")
    if len(s) <= limit:
        return s
    return s[: limit - 3] + "..."


def _append_text(existing: str, chunk: str, *, snapshot_prefer: bool) -> str:
    if not chunk:
        return existing
    if snapshot_prefer and len(chunk) >= len(existing):
        return chunk
    return existing + chunk


class SessionSpanBuffer:
    """Accumulate agent/llm/tool spans for one native session, flush as one OTLP body."""

    def __init__(
        self,
        session_id: str,
        *,
        service_name: str = "xiaoo",
        agent_name: str = "xiaoo",
    ) -> None:
        self.native_id = strip_platform_prefix(session_id)
        self.service_name = service_name
        self.agent_name = agent_name
        self.trace_id = stable_hex(f"xiaoo-otel-trace:{self.native_id}", 32)
        self.root_span_id = stable_hex(f"xiaoo-otel-root:{self.native_id}", 16)
        self.started_ns = _now_ns()
        self.user_text: str = ""
        # Per-turn records: llm text + tools that closed that turn.
        self.turns: list[dict[str, Any]] = []
        self._closed = False

    def _open_turn(self) -> dict[str, Any]:
        turn = {
            "started_ns": _now_ns(),
            "ended_ns": None,
            "assistant_text": "",
            "reasoning_text": "",
            "tools": [],
            "closed": False,
        }
        self.turns.append(turn)
        return turn

    def _current_turn(self) -> dict[str, Any]:
        if not self.turns or self.turns[-1].get("closed"):
            return self._open_turn()
        return self.turns[-1]

    def _close_turn(self, turn: dict[str, Any]) -> None:
        if turn.get("closed"):
            return
        turn["ended_ns"] = _now_ns()
        turn["closed"] = True

    def on_user_message(self, text: str) -> None:
        if text and not self.user_text:
            self.user_text = str(text)

    def on_assistant_text(self, text: str, *, channel: str = "llm_output") -> None:
        chunk = str(text or "")
        if not chunk:
            return
        turn = self._current_turn()
        if channel == "llm_reasoning":
            # stream_delta often sends full snapshots; keep the longer snapshot.
            turn["reasoning_text"] = _append_text(
                str(turn.get("reasoning_text") or ""),
                chunk,
                snapshot_prefer=True,
            )
        else:
            turn["assistant_text"] = _append_text(
                str(turn.get("assistant_text") or ""),
                chunk,
                snapshot_prefer=True,
            )

    def on_tool(
        self,
        *,
        name: str,
        arguments: Any = None,
        output: Any = None,
        error: bool = False,
        call_id: str | None = None,
    ) -> None:
        now = _now_ns()
        turn = self._current_turn()
        turn["tools"].append(
            {
                "name": str(name or "unknown"),
                "arguments": arguments,
                "output": output,
                "error": bool(error),
                "call_id": call_id,
                "started_ns": now,
                "ended_ns": now,
            }
        )
        # Tool boundary closes the current LLM turn so the next stream opens a new span.
        self._close_turn(turn)

    def _base_session_attrs(self) -> dict[str, Any]:
        return {
            "session.id": self.native_id,
            "witty.session.id": self.native_id,
            "witty.agent.name": self.agent_name,
            "witty.agent.id": f"{self.service_name}-{self.agent_name}",
            "gen_ai.system": self.service_name,
        }

    def _span(
        self,
        *,
        name: str,
        span_id: str,
        parent_span_id: str | None,
        attributes: dict[str, Any],
        start_ns: int,
        end_ns: int,
    ) -> dict[str, Any]:
        return {
            "traceId": self.trace_id,
            "spanId": span_id,
            "parentSpanId": parent_span_id or "",
            "name": name,
            "kind": 1,
            "startTimeUnixNano": str(start_ns),
            "endTimeUnixNano": str(end_ns),
            "attributes": otel_attributes(attributes),
            "status": {"code": 1},
        }

    def _llm_span_id(self, turn_index: int) -> str:
        return stable_hex(f"xiaoo-otel-llm:{self.native_id}:{turn_index}", 16)

    def build_resource_spans(self) -> dict[str, Any]:
        end_ns = _now_ns()
        spans: list[dict[str, Any]] = []
        root_attrs = {
            **self._base_session_attrs(),
            "gen_ai.span.kind": "agent",
        }
        spans.append(
            self._span(
                name=f"agent {self.agent_name}",
                span_id=self.root_span_id,
                parent_span_id=None,
                attributes=root_attrs,
                start_ns=self.started_ns,
                end_ns=end_ns,
            )
        )

        prompt = self.user_text
        for idx, turn in enumerate(self.turns):
            assistant = str(turn.get("assistant_text") or "")
            reasoning = str(turn.get("reasoning_text") or "")
            completion = assistant or reasoning
            tools = turn.get("tools") if isinstance(turn.get("tools"), list) else []
            if not (prompt or completion or tools):
                continue

            turn_start = int(turn.get("started_ns") or self.started_ns)
            turn_end = int(turn.get("ended_ns") or end_ns)
            if turn_end < turn_start:
                turn_end = turn_start
            llm_span_id = self._llm_span_id(idx)

            if prompt or completion:
                llm_attrs = {
                    **self._base_session_attrs(),
                    "gen_ai.span.kind": "llm",
                    "gen_ai.request.model": "unknown",
                }
                # Only attach the user prompt on the first LLM turn.
                if prompt and idx == 0:
                    llm_attrs["gen_ai.prompt"] = truncate(prompt)
                    llm_attrs["input.value"] = truncate(prompt)
                if completion:
                    llm_attrs["gen_ai.completion"] = truncate(completion)
                    llm_attrs["output.value"] = truncate(completion)
                if reasoning and reasoning != completion:
                    llm_attrs["gen_ai.reasoning"] = truncate(reasoning)
                spans.append(
                    self._span(
                        name="llm unknown",
                        span_id=llm_span_id,
                        parent_span_id=self.root_span_id,
                        attributes=llm_attrs,
                        start_ns=turn_start,
                        end_ns=turn_end,
                    )
                )

            parent = llm_span_id if (prompt or completion) else self.root_span_id
            for t_idx, tool in enumerate(tools):
                if not isinstance(tool, dict):
                    continue
                tool_span_id = stable_hex(
                    f"xiaoo-otel-tool:{self.native_id}:{idx}:{tool.get('call_id') or t_idx}:{tool.get('name')}",
                    16,
                )
                args = tool.get("arguments")
                if isinstance(args, (dict, list)):
                    import json

                    args_text = json.dumps(args, ensure_ascii=False)
                else:
                    args_text = "" if args is None else str(args)
                out = tool.get("output")
                if isinstance(out, (dict, list)):
                    import json

                    out_text = json.dumps(out, ensure_ascii=False)
                else:
                    out_text = "" if out is None else str(out)
                tool_attrs = {
                    **self._base_session_attrs(),
                    "gen_ai.span.kind": "tool",
                    "tool.name": tool["name"],
                    "witty.tool.name": tool["name"],
                    "tool.arguments": truncate(args_text),
                    "input.value": truncate(args_text),
                    "witty.tool.input": truncate(args_text),
                }
                if out_text:
                    tool_attrs["output.value"] = truncate(out_text)
                    tool_attrs["tool.result"] = truncate(out_text)
                    tool_attrs["witty.tool.result"] = truncate(out_text)
                if tool.get("error"):
                    tool_attrs["tool.status"] = "error"
                    tool_attrs["witty.tool.error"] = True
                else:
                    tool_attrs["tool.status"] = "success"
                t_start = int(tool.get("started_ns") or turn_end)
                t_end = int(tool.get("ended_ns") or t_start)
                if t_end < t_start:
                    t_end = t_start
                spans.append(
                    self._span(
                        name=f"tool {tool['name']}",
                        span_id=tool_span_id,
                        parent_span_id=parent,
                        attributes=tool_attrs,
                        start_ns=t_start,
                        end_ns=t_end,
                    )
                )

        resource_attrs = {
            "service.name": self.service_name,
            "session.id": self.native_id,
            "witty.session.id": self.native_id,
        }
        return {
            "resourceSpans": [
                {
                    "resource": {"attributes": otel_attributes(resource_attrs)},
                    "scopeSpans": [
                        {
                            "scope": {"name": "agent-insight.xiaoo.otel", "version": "0.1"},
                            "spans": spans,
                        }
                    ],
                }
            ]
        }

    def has_content(self) -> bool:
        """True when buffer has anything worth keeping locally (incl. user-only)."""
        if self.user_text:
            return True
        return self.has_trace_spans()

    def has_trace_spans(self) -> bool:
        """True when flush would emit llm/tool (not only empty agent root)."""
        for turn in self.turns:
            if turn.get("assistant_text") or turn.get("reasoning_text") or turn.get("tools"):
                return True
        return False

    def to_dict(self) -> dict[str, Any]:
        return {
            "native_id": self.native_id,
            "service_name": self.service_name,
            "agent_name": self.agent_name,
            "trace_id": self.trace_id,
            "root_span_id": self.root_span_id,
            "started_ns": self.started_ns,
            "user_text": self.user_text,
            "turns": list(self.turns),
            "closed": self._closed,
            # Legacy keys kept empty for older readers.
            "assistant_text": "",
            "reasoning_text": "",
            "tools": [],
            "llm_span_id": self._llm_span_id(0) if self.turns else "",
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SessionSpanBuffer:
        buf = cls(
            str(data.get("native_id") or ""),
            service_name=str(data.get("service_name") or "xiaoo"),
            agent_name=str(data.get("agent_name") or "xiaoo"),
        )
        if data.get("trace_id"):
            buf.trace_id = str(data["trace_id"])
        if data.get("root_span_id"):
            buf.root_span_id = str(data["root_span_id"])
        if data.get("started_ns") is not None:
            buf.started_ns = int(data["started_ns"])
        buf.user_text = str(data.get("user_text") or "")
        turns = data.get("turns")
        if isinstance(turns, list) and turns:
            buf.turns = [t for t in turns if isinstance(t, dict)]
        else:
            # Migrate legacy flat buffer → single turn.
            assistant = str(data.get("assistant_text") or "")
            reasoning = str(data.get("reasoning_text") or "")
            tools = data.get("tools")
            tool_list = list(tools) if isinstance(tools, list) else []
            if assistant or reasoning or tool_list:
                migrated_tools = []
                for tool in tool_list:
                    if not isinstance(tool, dict):
                        continue
                    row = dict(tool)
                    row.setdefault("started_ns", buf.started_ns)
                    row.setdefault("ended_ns", buf.started_ns)
                    migrated_tools.append(row)
                buf.turns = [
                    {
                        "started_ns": buf.started_ns,
                        "ended_ns": None,
                        "assistant_text": assistant,
                        "reasoning_text": reasoning,
                        "tools": migrated_tools,
                        "closed": bool(migrated_tools),
                    }
                ]
        buf._closed = bool(data.get("closed"))
        return buf
