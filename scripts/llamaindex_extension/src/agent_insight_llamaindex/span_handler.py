from __future__ import annotations

import inspect
import re
import secrets
import time
from collections.abc import Callable
from typing import Any

from llama_index_instrumentation.span import BaseSpan
from llama_index_instrumentation.span_handlers import BaseSpanHandler
from pydantic import Field

from .config import CollectorConfig
from .context import trace_metadata
from .model import SpanRecord
from .serialization import add_content_attribute, extract_nodes


class CollectorSpan(BaseSpan):
    trace_id: str
    otel_span_id: str
    otel_parent_span_id: str | None = None
    session_id: str
    name: str
    kind: str = "span"
    start_time_ns: int = Field(default_factory=time.time_ns)
    attributes: dict[str, Any] = Field(default_factory=dict)


def _span_name(identifier: str) -> str:
    uuid_suffix = re.search(
        r"-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        identifier,
        re.IGNORECASE,
    )
    if uuid_suffix:
        return identifier[: uuid_suffix.start()]
    head, separator, tail = identifier.rpartition("-")
    return head if separator and len(tail) >= 8 else identifier


def _method(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower()


def _workflow_context_identity(context: Any) -> int:
    face = getattr(context, "_face", context)
    adapter = getattr(face, "_internal_adapter", None)
    run_state = getattr(adapter, "_queues", adapter)
    return id(run_state if run_state is not None else face)


def _kind(name: str, instance: Any, arguments: dict[str, Any]) -> str:
    method = _method(name)
    class_name = type(instance).__name__.lower() if instance is not None else name.lower()
    event = arguments.get("ev") or arguments.get("event")
    event_name = type(event).__name__.lower() if event is not None else ""
    if method in {"chat", "achat", "stream_chat", "astream_chat", "complete", "acomplete"}:
        return "llm"
    if "retriev" in method or "retriever" in class_name:
        return "retriever"
    if method in {"synthesize", "asynthesize", "get_response", "aget_response"}:
        return "synthesizer"
    if method == "call_tool" or event_name == "toolcall":
        return "tool"
    if method == "run" and "agent" in class_name:
        return "agent"
    if method == "run" and "workflow" in class_name:
        return "workflow"
    if event_name or method in {
        "init_run",
        "setup_agent",
        "run_agent_step",
        "parse_agent_output",
        "aggregate_tool_results",
    }:
        return "workflow_step"
    if method in {"query", "aquery"}:
        return "chain"
    return "span"


class LlamaIndexSpanHandler(BaseSpanHandler[CollectorSpan]):
    config: CollectorConfig = Field(default=None)  # type: ignore[assignment]
    emit: Callable[[SpanRecord], bool] = Field(default=None)  # type: ignore[assignment]
    identities: dict[str, tuple[str, str, str]] = Field(default_factory=dict)
    dropped_open_spans: int = 0

    def __init__(
        self,
        config: CollectorConfig,
        emit: Callable[[SpanRecord], bool],
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self.config = config
        self.emit = emit

    def close(self) -> None:
        """Release unfinished spans when instrumentation is removed.

        LlamaIndex normally balances every span_enter with span_exit/span_drop. A
        cancelled task or third-party instrumentation bug can leave an open span,
        however. Clearing these references prevents repeated setup/unsetup cycles
        and long-lived worker processes from retaining arbitrary prompt/tool data.
        """
        with self.lock:
            self.open_spans.clear()
            self.identities.clear()
            self.current_span_ids.clear()

    def new_span(
        self,
        id_: str,
        bound_args: inspect.BoundArguments,
        instance: Any = None,
        parent_span_id: str | None = None,
        tags: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> CollectorSpan:
        self._bound_open_spans()
        name = _span_name(id_)
        parent = self.identities.get(parent_span_id or "")
        metadata = trace_metadata.get() or {}
        trace_id = parent[0] if parent else secrets.token_hex(16)
        otel_parent = parent[1] if parent else None
        session_id = str(metadata.get("session_id") or (parent[2] if parent else trace_id))
        span = CollectorSpan(
            id_=id_,
            parent_id=parent_span_id,
            trace_id=trace_id,
            otel_span_id=secrets.token_hex(8),
            otel_parent_span_id=otel_parent,
            session_id=session_id,
            name=name,
            kind=_kind(name, instance, bound_args.arguments),
            tags=tags or {},
        )
        self.identities[id_] = (trace_id, span.otel_span_id, session_id)
        self._capture_input(span, bound_args.arguments, instance)
        return span

    def _bound_open_spans(self) -> None:
        if len(self.open_spans) < self.config.max_open_spans:
            return
        with self.lock:
            if len(self.open_spans) < self.config.max_open_spans:
                return
            oldest_id = min(
                self.open_spans,
                key=lambda item: self.open_spans[item].start_time_ns,
            )
            self.open_spans.pop(oldest_id, None)
            self.identities.pop(oldest_id, None)
            self.dropped_open_spans += 1

    def _capture_input(
        self, span: CollectorSpan, arguments: dict[str, Any], instance: Any
    ) -> None:
        metadata = trace_metadata.get() or {}
        if metadata.get("query"):
            add_content_attribute(span.attributes, "agent.query", metadata["query"], self.config)
        if metadata.get("agent_name"):
            span.attributes["agent.name"] = metadata["agent_name"]
        span.attributes["code.namespace"] = type(instance).__module__ if instance else ""
        span.attributes["code.function"] = _method(span.name)
        event = arguments.get("ev") or arguments.get("event") or arguments.get("start_event")
        current_agent = getattr(event, "current_agent_name", None)
        if current_agent:
            span.attributes["agent.name"] = current_agent
            context = arguments.get("ctx")
            context_identity = (
                _workflow_context_identity(context)
                if context is not None
                else span.otel_span_id
            )
            span.attributes["agent.instance.id"] = (
                f"{span.trace_id}:{context_identity}:{current_agent}"
            )
        user_msg = getattr(event, "user_msg", None)
        if user_msg is None and event is not None and hasattr(event, "get"):
            try:
                user_msg = event.get("user_msg")
            except Exception:
                pass
        if user_msg:
            add_content_attribute(span.attributes, "input.value", user_msg, self.config)
            add_content_attribute(span.attributes, "agent.query", user_msg, self.config)
            if current_agent:
                add_content_attribute(span.attributes, "agent.task", user_msg, self.config)
        elif current_agent:
            task_input = getattr(event, "input", None)
            if task_input:
                add_content_attribute(span.attributes, "agent.task", task_input, self.config)
        if span.kind == "tool" and event is not None:
            span.attributes["tool.name"] = getattr(event, "tool_name", None) or "tool"
            add_content_attribute(
                span.attributes,
                "tool.arguments",
                getattr(event, "tool_kwargs", arguments),
                self.config,
            )
        elif span.kind == "workflow_step":
            span.attributes["workflow.step.name"] = _method(span.name)
            if event is not None:
                span.attributes["workflow.step.input_event"] = type(event).__name__
                add_content_attribute(span.attributes, "input.value", event, self.config)
        elif span.kind in {"retriever", "synthesizer", "chain"}:
            candidate = next(
                (value for key, value in arguments.items() if key not in {"self", "ctx"}), None
            )
            if candidate is not None:
                add_content_attribute(span.attributes, "input.value", candidate, self.config)

    def enrich(self, span_id: str | None, event: Any) -> None:
        if not span_id:
            return
        with self.lock:
            span = self.open_spans.get(span_id)
            if span is None:
                return
            class_name = (
                event.class_name() if hasattr(event, "class_name") else type(event).__name__
            )
            span.attributes["llamaindex.event"] = class_name
            if class_name.startswith("LLM"):
                span.kind = "llm"
                model, provider = self._model_from_event(event)
                if model:
                    span.attributes["gen_ai.request.model"] = model
                if provider:
                    span.attributes["gen_ai.provider.name"] = provider
                prompt = getattr(event, "prompt", None) or getattr(event, "messages", None)
                if prompt is not None:
                    add_content_attribute(span.attributes, "input.value", prompt, self.config)
                response = getattr(event, "response", None)
                if response is not None:
                    add_content_attribute(span.attributes, "output.value", response, self.config)
                    self._set_usage(span, response)
            elif class_name == "RetrievalStartEvent":
                span.kind = "retriever"
                add_content_attribute(
                    span.attributes,
                    "retrieval.query",
                    getattr(event, "str_or_query_bundle", ""),
                    self.config,
                )
            elif class_name == "RetrievalEndEvent":
                span.kind = "retriever"
                add_content_attribute(
                    span.attributes,
                    "retrieval.nodes",
                    extract_nodes(getattr(event, "nodes", []), self.config),
                    self.config,
                )
            elif class_name.startswith("Synthesize"):
                span.kind = "synthesizer"
                query = getattr(event, "query", None)
                response = getattr(event, "response", None)
                if query is not None:
                    add_content_attribute(span.attributes, "input.value", query, self.config)
                if response is not None:
                    add_content_attribute(span.attributes, "output.value", response, self.config)
            elif class_name.startswith("Agent"):
                if span.kind == "span":
                    span.kind = "agent"
                for key in ("input", "user_msg", "arguments"):
                    value = getattr(event, key, None)
                    if value is not None:
                        add_content_attribute(span.attributes, "input.value", value, self.config)
                        break

    @staticmethod
    def _model_from_event(event: Any) -> tuple[str | None, str | None]:
        value = getattr(event, "model_dict", None)
        if not isinstance(value, dict):
            return None, None
        model = value.get("model") or value.get("model_name")
        provider = value.get("provider") or value.get("class_name")
        return str(model) if model else None, str(provider) if provider else None

    @staticmethod
    def _set_usage(span: CollectorSpan, response: Any) -> None:
        from .serialization import extract_usage

        usage = extract_usage(response)
        span.attributes["gen_ai.usage.input_tokens"] = usage["input_tokens"]
        span.attributes["gen_ai.usage.output_tokens"] = usage["output_tokens"]
        span.attributes["gen_ai.usage.total_tokens"] = usage["total_tokens"]

    def prepare_to_exit_span(
        self,
        id_: str,
        bound_args: inspect.BoundArguments,
        instance: Any = None,
        result: Any = None,
        **kwargs: Any,
    ) -> CollectorSpan | None:
        span = self.open_spans.get(id_)
        if span is None:
            return None
        self._capture_result(span, result)
        self._emit(span, "success", None)
        self.identities.pop(id_, None)
        return span

    def prepare_to_drop_span(
        self,
        id_: str,
        bound_args: inspect.BoundArguments,
        instance: Any = None,
        err: BaseException | None = None,
        **kwargs: Any,
    ) -> CollectorSpan | None:
        span = self.open_spans.get(id_)
        if span is None:
            return None
        if err is not None:
            span.attributes["error.type"] = type(err).__name__
            add_content_attribute(span.attributes, "error.message", str(err), self.config)
        self._emit(span, "error", str(err) if err else "span dropped")
        self.identities.pop(id_, None)
        return span

    def _capture_result(self, span: CollectorSpan, result: Any) -> None:
        if result is None:
            return
        if span.kind == "tool":
            tool_output = getattr(result, "tool_output", result)
            span.attributes["tool.status"] = (
                "error" if getattr(tool_output, "is_error", False) else "success"
            )
            add_content_attribute(span.attributes, "tool.output", tool_output, self.config)
        else:
            add_content_attribute(span.attributes, "output.value", result, self.config)
        if span.kind == "retriever":
            nodes = getattr(result, "nodes", result if isinstance(result, list) else None)
            if nodes is not None:
                add_content_attribute(
                    span.attributes,
                    "retrieval.nodes",
                    extract_nodes(nodes, self.config),
                    self.config,
                )

    def _emit(self, span: CollectorSpan, status: str, message: str | None) -> None:
        self.emit(
            SpanRecord(
                trace_id=span.trace_id,
                span_id=span.otel_span_id,
                parent_span_id=span.otel_parent_span_id,
                session_id=span.session_id,
                name=span.name,
                kind=span.kind,
                start_time_ns=span.start_time_ns,
                end_time_ns=time.time_ns(),
                status=status,
                status_message=message,
                attributes=dict(span.attributes),
            )
        )
