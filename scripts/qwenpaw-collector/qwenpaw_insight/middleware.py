"""AgentScope middleware that records tool executions as OTLP tool spans."""

from __future__ import annotations

import json
import re
from typing import Any, AsyncGenerator, Callable


try:
    from agentscope.middleware import MiddlewareBase as _MiddlewareBase
except ImportError:
    class _MiddlewareBase:
        """Fallback when agentscope is unavailable (unit tests)."""

        def is_implemented(self, hook_name: str) -> bool:
            return hook_name == "on_acting"


class AgentInsightToolMiddleware(_MiddlewareBase):
    """Wrap each tool execution with start/finish tool spans."""

    def __init__(self, collector: Any):
        self._collector = collector

    @staticmethod
    def _legacy_shell_exit_code(output: Any) -> int | None:
        """Read the exit code emitted by QwenPaw versions without metadata."""
        if output is None:
            return None
        match = re.search(r"\bexit\s+code\s+(-?\d+)\b", str(output), re.IGNORECASE)
        return int(match.group(1)) if match else None

    @staticmethod
    def _json_obj(value: Any) -> dict[str, Any]:
        if isinstance(value, dict):
            return value
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
                if isinstance(parsed, dict):
                    return parsed
            except (ValueError, TypeError):
                return {}
        return {}

    @classmethod
    def _delegation_description(cls, tool_name: str, tool_input: Any) -> str:
        payload = cls._json_obj(tool_input)
        if tool_name in ("chat_with_agent", "submit_to_agent"):
            return str(payload.get("text") or payload.get("prompt") or "").strip()
        return str(payload.get("task") or payload.get("description") or payload.get("prompt") or "").strip()

    @classmethod
    def _delegation_extra(cls, tool_name: str, tool_input: Any) -> dict[str, Any]:
        payload = cls._json_obj(tool_input)
        kind = {
            "spawn_subagent": "spawn",
            "spawn_batch": "batch",
            "chat_with_agent": "chat_with_agent",
            "submit_to_agent": "submit_to_agent",
        }.get(tool_name, "subagent")
        if tool_name == "spawn_subagent" and payload.get("batch"):
            kind = "batch"
        if tool_name == "spawn_subagent" and str(payload.get("fork")).lower() in ("true", "1", "yes"):
            kind = "fork"
        return {
            "qwenpaw.delegation.kind": kind,
            "qwenpaw.delegation.description": cls._delegation_description(tool_name, tool_input),
            "qwenpaw.delegation.target_agent": str(payload.get("to_agent") or payload.get("agent") or "").strip(),
        }

    @staticmethod
    def _sessions_from_text(text: Any) -> list[str]:
        if not text:
            return []
        seen: set[str] = set()
        sessions: list[str] = []
        for match in re.finditer(r"\[SESSION:\s*([^\]\s]+)\s*\]", str(text)):
            session_id = match.group(1).strip()
            if session_id and session_id not in seen:
                seen.add(session_id)
                sessions.append(session_id)
        return sessions

    async def on_acting(
        self,
        agent: Any,
        input_kwargs: dict[str, Any],
        next_handler: Callable[..., AsyncGenerator[Any, None]],
    ) -> AsyncGenerator[Any, None]:
        tool_call = input_kwargs.get("tool_call")
        tool_name = str(getattr(tool_call, "name", "unknown") or "unknown")
        tool_input = getattr(tool_call, "input", None)
        kind = "general"
        skill_name = ""
        if tool_name.lower() in ("skill", "skill_viewer"):
            kind = "skill"
            if isinstance(tool_input, dict):
                skill_name = str(tool_input.get("skill") or tool_input.get("name") or "")
            elif isinstance(tool_input, str):
                try:
                    parsed = json.loads(tool_input)
                    if isinstance(parsed, dict):
                        skill_name = str(parsed.get("skill") or parsed.get("name") or "")
                except (ValueError, TypeError):
                    skill_name = ""
        elif tool_name in ("spawn_subagent", "spawn_batch", "submit_to_agent", "chat_with_agent"):
            kind = "subagent"
        elif tool_name.startswith("mcp__"):
            kind = "mcp"
        elif tool_name.startswith(("shell", "bash", "cmd", "powershell")):
            kind = "shell"
        elif tool_name.startswith(("read_file", "write_file", "edit_file", "search_files", "file")):
            kind = "file"
        elif tool_name.startswith("browser"):
            kind = "browser"
        elif tool_name.startswith("screenshot") or "screenshot" in tool_name:
            kind = "screenshot"

        if kind == "skill":
            span_id = self._collector.start_skill(
                name=skill_name,
                trigger="tool",
                args=tool_input,
            )
        else:
            extra = self._delegation_extra(tool_name, tool_input) if kind == "subagent" else None
            span_id = self._collector.start_tool(
                tool_name=tool_name,
                tool_input=tool_input,
                kind=kind,
                extra=extra,
            )
        final_response = None
        error: BaseException | None = None
        try:
            async for event in next_handler():
                if type(event).__name__ == "ToolResponse":
                    final_response = event
                yield event
        except BaseException as exc:  # noqa: BLE001
            error = exc
            raise
        finally:
            output = None
            status = "success"
            exit_code = None
            if final_response is not None:
                content = getattr(final_response, "content", None)
                if isinstance(content, list):
                    output = "\n".join(
                        str(block.get("text") if isinstance(block, dict) else getattr(block, "text", str(block)))
                        for block in content
                    )
                else:
                    output = content
                state = getattr(final_response, "state", None)
                status = str(getattr(final_response, "status", None) or state or "success")
                exit_code = getattr(final_response, "exit_code", None)
                metadata = getattr(final_response, "metadata", None) or {}
                if exit_code is None and isinstance(metadata, dict):
                    exit_code = metadata.get("exit_code")
                if exit_code is None and kind == "shell":
                    exit_code = self._legacy_shell_exit_code(output)
                if getattr(final_response, "error", None):
                    error = error or str(getattr(final_response, "error"))
                if str(status).lower() in ("error", "failed", "denied", "interrupted") and error is None:
                    error = f"tool state: {status}"
            if kind == "skill":
                self._collector.finish_skill(
                    span_id,
                    output=output,
                    status=status,
                    error=error,
                )
            else:
                extra = None
                if kind == "subagent":
                    sessions = self._sessions_from_text(output)
                    if sessions:
                        extra = {"qwenpaw.delegation.children": sessions}
                self._collector.finish_tool(
                    span_id,
                    output=output,
                    status=status,
                    exit_code=exit_code,
                    error=error,
                    extra=extra,
                )
