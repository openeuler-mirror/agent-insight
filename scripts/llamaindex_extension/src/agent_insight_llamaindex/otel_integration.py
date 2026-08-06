from __future__ import annotations

from llama_index.observability.otel import LlamaIndexOpenTelemetry
from llama_index_instrumentation import get_dispatcher
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from pydantic import PrivateAttr

from .config import CollectorConfig
from .event_handler import LlamaIndexEventHandler
from .exporter import AgentInsightSpanExporter
from .span_handler import LlamaIndexSpanHandler
from .uploader import CollectorRuntime


class AgentInsightOpenTelemetry(LlamaIndexOpenTelemetry):
    _config: CollectorConfig = PrivateAttr()
    _span_handler: LlamaIndexSpanHandler | None = PrivateAttr(default=None)
    _event_handler: LlamaIndexEventHandler | None = PrivateAttr(default=None)

    def __init__(self, config: CollectorConfig, runtime: CollectorRuntime) -> None:
        resource = Resource.create(
            {
                "service.name": config.service_name,
                "agent.insight.framework": "llamaindex",
                "user.id": config.user,
                "telemetry.sdk.name": "agent-insight-llamaindex",
                "telemetry.sdk.language": "python",
                "telemetry.sdk.version": "0.2.0",
            }
        )
        exporter = AgentInsightSpanExporter(runtime.submit)
        provider = TracerProvider(resource=resource)
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        super().__init__(
            span_exporter=exporter,
            span_processor="simple",
            tracer_provider=provider,
            service_name_or_resource=resource,
        )
        self._config = config

    @property
    def span_handler(self) -> LlamaIndexSpanHandler:
        if self._span_handler is None:
            raise RuntimeError("LlamaIndex OpenTelemetry is not registered")
        return self._span_handler

    @property
    def event_handler(self) -> LlamaIndexEventHandler:
        if self._event_handler is None:
            raise RuntimeError("LlamaIndex OpenTelemetry is not registered")
        return self._event_handler

    def start_registering(self) -> None:
        provider = self.tracer_provider
        if provider is None:
            raise RuntimeError("isolated TracerProvider is required")
        self._tracer_provider_instance = provider
        self._tracer = provider.get_tracer("llamaindex.opentelemetry.tracer")
        self._span_handler = LlamaIndexSpanHandler(
            config=self._config,
            tracer=self._tracer,
            tracer_provider=provider,
            debug=self.debug,
        )
        self._event_handler = LlamaIndexEventHandler(
            span_handler=self._span_handler,
            debug=self.debug,
        )
        dispatcher = get_dispatcher()
        dispatcher.add_span_handler(self._span_handler)
        dispatcher.add_event_handler(self._event_handler)

    def unregister(self) -> None:
        if self._span_handler is None or self._event_handler is None:
            return
        dispatcher = get_dispatcher()
        dispatcher.span_handlers = [
            item for item in dispatcher.span_handlers if item is not self._span_handler
        ]
        dispatcher.event_handlers = [
            item for item in dispatcher.event_handlers if item is not self._event_handler
        ]
        self._span_handler.close()
        self._span_handler = None
        self._event_handler = None

    def detach_after_fork(self) -> None:
        """Remove inherited handlers without flushing into dead parent threads."""
        if self._span_handler is None or self._event_handler is None:
            return
        dispatcher = get_dispatcher()
        dispatcher.span_handlers = [
            item for item in dispatcher.span_handlers if item is not self._span_handler
        ]
        dispatcher.event_handlers = [
            item for item in dispatcher.event_handlers if item is not self._event_handler
        ]
        self._span_handler = None
        self._event_handler = None

    def force_flush(self, timeout_millis: int = 10_000) -> bool:
        provider = self.tracer_provider
        if provider is None:
            return True
        return bool(provider.force_flush(timeout_millis))
