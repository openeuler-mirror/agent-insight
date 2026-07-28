from __future__ import annotations

from typing import Any

from llama_index_instrumentation.base import BaseEvent
from llama_index_instrumentation.event_handlers import BaseEventHandler

from .span_handler import LlamaIndexSpanHandler


class LlamaIndexEventHandler(BaseEventHandler):
    span_handler: LlamaIndexSpanHandler

    def handle(self, event: BaseEvent, **kwargs: Any) -> None:
        self.span_handler.enrich(event.span_id, event)
