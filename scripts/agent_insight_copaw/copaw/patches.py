"""Runtime monkey-patches for QwenPaw modules.

The patches are small, reversible wrappers installed by the plugin backend or
by ``copaw.setup()``.  They cover LLM calls, MCP driver calls,
subagent session correlation, skill slash invocations and cron executions.
Every patch is optional: if the referenced QwenPaw module is not importable,
the patch is skipped without breaking QwenPaw.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_ORIGINALS: list[tuple[Any, str, Any]] = []


def _restore_all() -> None:
    while _ORIGINALS:
        owner, name, original = _ORIGINALS.pop()
        try:
            setattr(owner, name, original)
        except Exception:  # noqa: BLE001
            pass


def _message_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
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
        return str(value.get("content") or value)
    return str(value)


def _provider_id(model_obj: Any) -> str | None:
    provider = getattr(model_obj, "provider_id", None) or getattr(model_obj, "_provider_id", None)
    if provider:
        return str(provider)
    try:
        key = model_obj.model_key
    except Exception:  # noqa: BLE001
        return None
    if isinstance(key, str) and ":" in key:
        return key.split(":", 1)[0]
    return None


def _prompt_input(args: tuple, kwargs: dict) -> Any:
    return kwargs.get("messages") or kwargs.get("prompt") or (args[0] if args else None)


def install_llm_compat_patch(collector: Any) -> bool:
    """Fallback: wrap the OpenAI-compatible model call directly.

    Returns True when the patch was installed.
    """
    try:
        from qwenpaw.providers import openai_chat_model_compat as mod  # type: ignore[import-not-found]
    except Exception as exc:  # noqa: BLE001
        logger.debug("llm patch skipped: %s", exc)
        return False

    original = mod.OpenAIChatModelCompat.__call__

    async def traced_call(self: Any, *args: Any, **kwargs: Any) -> Any:
        model = getattr(self, "model", None) or kwargs.get("model")
        span_id = collector.start_llm(
            model=str(model) if model else None,
            provider=_provider_id(self),
            input=_prompt_input(args, kwargs),
        )
        try:
            result = await original(self, *args, **kwargs)
        except BaseException as exc:  # noqa: BLE001
            collector.finish_llm(span_id, error=exc)
            raise

        # 流式响应：真正的结果与 usage 在最后一个 chunk（is_last=True）上。
        # 把流包一层，等调用方迭代结束后再落盘 span，避免记到 generator 本身。
        if hasattr(result, "__aiter__"):
            async def traced_stream() -> Any:
                final: Any = None
                try:
                    async for chunk in result:
                        if getattr(chunk, "is_last", False):
                            final = chunk
                        yield chunk
                except BaseException as exc:  # noqa: BLE001
                    collector.finish_llm(span_id, error=exc)
                    raise
                if final is not None:
                    collector.finish_llm(
                        span_id,
                        output=_message_text(final),
                        usage=getattr(final, "usage", None),
                    )
                else:
                    collector.finish_llm(
                        span_id,
                        error=RuntimeError("LLM stream ended without a final response"),
                    )

            return traced_stream()

        collector.finish_llm(
            span_id,
            output=_message_text(result),
            usage=getattr(result, "usage", None),
        )
        return result

    mod.OpenAIChatModelCompat.__call__ = traced_call
    _ORIGINALS.append((mod.OpenAIChatModelCompat, "__call__", original))
    return True


def install_llm_patch(collector: Any) -> bool:
    """Wrap the shared RetryChatModel used by cloud and local providers.

    Patching the outer wrapper covers every provider QwenPaw builds through
    ``create_model_and_formatter`` (OpenAI-compatible, Anthropic, Gemini,
    DashScope, OpenAI Responses and local runtimes) and records one span per
    logical LLM call including retries. Falls back to the OpenAI-compatible
    class when the wrapper is unavailable.
    """
    try:
        from qwenpaw.providers.retry_chat_model import RetryChatModel  # type: ignore[import-not-found]
    except Exception as exc:  # noqa: BLE001
        logger.debug("llm retry patch skipped, using compat fallback: %s", exc)
        return install_llm_compat_patch(collector)

    original_call = RetryChatModel.__call__
    original_structured = RetryChatModel.generate_structured_output

    async def traced_call(self: Any, *args: Any, **kwargs: Any) -> Any:
        span_id = collector.start_llm(
            model=str(getattr(self, "model", None) or kwargs.get("model") or ""),
            provider=_provider_id(self),
            input=_prompt_input(args, kwargs),
        )
        try:
            result = await original_call(self, *args, **kwargs)
        except BaseException as exc:  # noqa: BLE001
            collector.finish_llm(span_id, error=exc)
            raise

        if hasattr(result, "__aiter__"):
            async def traced_stream() -> Any:
                final: Any = None
                try:
                    async for chunk in result:
                        if getattr(chunk, "is_last", False):
                            final = chunk
                        yield chunk
                except BaseException as exc:  # noqa: BLE001
                    collector.finish_llm(span_id, error=exc)
                    raise
                if final is not None:
                    collector.finish_llm(
                        span_id,
                        output=_message_text(final),
                        usage=getattr(final, "usage", None),
                    )
                else:
                    collector.finish_llm(
                        span_id,
                        error=RuntimeError("LLM stream ended without a final response"),
                    )

            return traced_stream()

        collector.finish_llm(
            span_id,
            output=_message_text(result),
            usage=getattr(result, "usage", None),
        )
        return result

    async def traced_structured(self: Any, *args: Any, **kwargs: Any) -> Any:
        span_id = collector.start_llm(
            model=str(getattr(self, "model", None) or kwargs.get("model") or ""),
            provider=_provider_id(self),
            input=_prompt_input(args, kwargs),
        )
        try:
            result = await original_structured(self, *args, **kwargs)
        except BaseException as exc:  # noqa: BLE001
            collector.finish_llm(span_id, error=exc)
            raise
        collector.finish_llm(
            span_id,
            output=_message_text(result),
            usage=getattr(result, "usage", None),
        )
        return result

    RetryChatModel.__call__ = traced_call
    RetryChatModel.generate_structured_output = traced_structured
    _ORIGINALS.append((RetryChatModel, "__call__", original_call))
    _ORIGINALS.append((RetryChatModel, "generate_structured_output", original_structured))
    return True


def install_mcp_patch(collector: Any) -> bool:
    """Wrap MCP driver execution to capture server/tool/args/result/latency."""
    try:
        from qwenpaw.drivers.handlers import mcp as mod  # type: ignore[import-not-found]
    except Exception as exc:  # noqa: BLE001
        logger.debug("mcp patch skipped: %s", exc)
        return False

    original = mod.MCPDriverHandler._execute

    async def traced_execute(self: Any, credential: Any, context: Any, **kwargs: Any) -> Any:
        tool_name = str(kwargs.get("tool_name") or "unknown")
        arguments = kwargs.get("arguments") or {}
        span_id = collector.start_mcp(
            server_name=getattr(self, "name", "mcp"),
            tool_name=tool_name,
            arguments=arguments,
        )
        try:
            result = await original(self, credential, context, **kwargs)
            collector.finish_mcp(span_id, result=result)
            return result
        except BaseException as exc:  # noqa: BLE001
            collector.finish_mcp(span_id, error=exc, status="error")
            raise

    mod.MCPDriverHandler._execute = traced_execute
    _ORIGINALS.append((mod.MCPDriverHandler, "_execute", original))
    return True


def install_subagent_patch(collector: Any) -> bool:
    """Correlate generated subagent session ids with their parent session."""
    try:
        from qwenpaw.agents.tools import agent_management as mod  # type: ignore[import-not-found]
    except Exception as exc:  # noqa: BLE001
        logger.debug("subagent patch skipped: %s", exc)
        return False

    original = mod._generate_subagent_session_id

    def traced_generate() -> str:
        session_id = original()
        parent = None
        try:
            from qwenpaw.app.agent_context import get_current_session_id  # type: ignore[import-not-found]

            parent = get_current_session_id()
        except Exception:  # noqa: BLE001
            parent = None
        collector.register_subagent_relation(session_id, parent)
        return session_id

    mod._generate_subagent_session_id = traced_generate
    _ORIGINALS.append((mod, "_generate_subagent_session_id", original))
    return True


def _skill_version(workspace_dir: Any, skill_name: str) -> Any:
    try:
        import frontmatter  # type: ignore[import-not-found]

        path = Path(str(workspace_dir)) / "skills" / skill_name / "SKILL.md"
        if path.exists():
            return frontmatter.loads(path.read_text(encoding="utf-8")).get("version")
    except Exception:  # noqa: BLE001
        pass
    return None


def install_skill_patch(collector: Any) -> bool:
    """Wrap the /<skill_name> fallback handler to emit skill spans."""
    try:
        from qwenpaw.runtime import builtin_commands as mod  # type: ignore[import-not-found]
    except Exception as exc:  # noqa: BLE001
        logger.debug("skill patch skipped: %s", exc)
        return False

    original = mod._skill_fallback_handler

    async def traced_handler(raw_text: str, ctx: Any) -> Any:
        parsed = None
        try:
            parsed = mod._parse_skill_query(raw_text)
        except Exception:  # noqa: BLE001
            parsed = None
        span_id = None
        if parsed:
            session_id = getattr(ctx, "session_id", None)
            workspace_dir = getattr(getattr(ctx, "workspace", None), "workspace_dir", None)
            span_id = collector.start_skill(
                session_id=session_id,
                name=parsed[0],
                version=_skill_version(workspace_dir, parsed[0]),
                trigger="slash",
                args=parsed[1],
            )
        try:
            result = await original(raw_text, ctx)
            if span_id:
                collector.finish_skill(span_id, output=_message_text(result))
            return result
        except BaseException as exc:  # noqa: BLE001
            if span_id:
                collector.finish_skill(span_id, status="error", error=exc)
            raise

    mod._skill_fallback_handler = traced_handler
    _ORIGINALS.append((mod, "_skill_fallback_handler", original))
    return True


def install_cron_patch(collector: Any) -> bool:
    """Wrap cron execution and skipped-run recording with cron spans."""
    try:
        from qwenpaw.app.crons import manager as mod  # type: ignore[import-not-found]
    except Exception as exc:  # noqa: BLE001
        logger.debug("cron patch skipped: %s", exc)
        return False

    original = mod.CronManager._execute_once

    async def traced_execute_once(self: Any, job: Any, trigger: str = "scheduled") -> dict[str, Any]:
        span_id = collector.start_cron(
            job_id=getattr(job, "id", ""),
            job_name=getattr(job, "name", ""),
            task_type=getattr(job, "task_type", ""),
            trigger=trigger,
            channel=getattr(getattr(job, "dispatch", None), "channel", ""),
        )
        try:
            result = await original(self, job, trigger=trigger)
            collector.finish_cron(span_id, status="success", output=result)
            return result
        except asyncio.CancelledError:
            collector.finish_cron(span_id, status="cancelled")
            raise
        except BaseException as exc:  # noqa: BLE001
            collector.finish_cron(span_id, status="error", error=exc)
            raise

    mod.CronManager._execute_once = traced_execute_once
    _ORIGINALS.append((mod.CronManager, "_execute_once", original))

    original_skip = mod.CronManager._record_skipped

    async def traced_record_skipped(self: Any, job: Any, error_msg: str) -> None:
        span_id = collector.start_cron(
            job_id=getattr(job, "id", ""),
            job_name=getattr(job, "name", ""),
            task_type=getattr(job, "task_type", ""),
            trigger="scheduled",
            channel=getattr(getattr(job, "dispatch", None), "channel", ""),
        )
        collector.finish_cron(span_id, status="skipped", error=error_msg)
        return await original_skip(self, job, error_msg)

    mod.CronManager._record_skipped = traced_record_skipped
    _ORIGINALS.append((mod.CronManager, "_record_skipped", original_skip))
    return True


_INSTALLERS = (
    install_llm_patch,
    install_mcp_patch,
    install_subagent_patch,
    install_skill_patch,
    install_cron_patch,
)


def install_all(collector: Any) -> None:
    """Install every patch; each failure is isolated and only logged."""
    installed: list[str] = []
    for installer in _INSTALLERS:
        try:
            if installer(collector):
                installed.append(installer.__name__)
        except Exception as exc:  # noqa: BLE001
            logger.debug("patch %s failed: %s", installer.__name__, exc)
    if installed:
        logger.info("agent-insight-copaw patches installed: %s", ", ".join(installed))


def uninstall_all() -> None:
    _restore_all()
