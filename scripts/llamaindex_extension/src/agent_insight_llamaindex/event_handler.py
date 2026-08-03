from __future__ import annotations

from typing import Any

from llama_index.observability.otel.base import OTelCompatibleEventHandler
from llama_index_instrumentation.base import BaseEvent
from llama_index_instrumentation.span import active_span_id

from .span_handler import LlamaIndexSpanHandler


class LlamaIndexEventHandler(OTelCompatibleEventHandler):
    span_handler: LlamaIndexSpanHandler

    def handle(self, event: BaseEvent, **kwargs: Any) -> None:
        self.span_handler.enrich(event.span_id or active_span_id.get(), event)
        super().handle(event, **kwargs)
