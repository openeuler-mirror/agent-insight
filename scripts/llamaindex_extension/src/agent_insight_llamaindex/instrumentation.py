from __future__ import annotations

import atexit
import threading
from dataclasses import dataclass
from typing import Any

from llama_index_instrumentation import get_dispatcher

from .config import CollectorConfig
from .event_handler import LlamaIndexEventHandler
from .span_handler import LlamaIndexSpanHandler
from .uploader import CollectorRuntime


@dataclass(slots=True)
class InstrumentationState:
    config: CollectorConfig
    runtime: CollectorRuntime
    dispatcher: Any
    span_handler: LlamaIndexSpanHandler
    event_handler: LlamaIndexEventHandler


_lock = threading.RLock()
_state: InstrumentationState | None = None
_atexit_registered = False


def instrument(
    config: CollectorConfig | None = None, **overrides: Any
) -> InstrumentationState | None:
    global _state, _atexit_registered
    with _lock:
        if _state is not None:
            return _state
        resolved = config or CollectorConfig.load(**overrides)
        if not resolved.ready:
            return None
        runtime = CollectorRuntime(resolved)
        span_handler = LlamaIndexSpanHandler(config=resolved, emit=runtime.submit)
        event_handler = LlamaIndexEventHandler(span_handler=span_handler)
        dispatcher = get_dispatcher()
        dispatcher.add_span_handler(span_handler)
        dispatcher.add_event_handler(event_handler)
        runtime.start()
        _state = InstrumentationState(
            config=resolved,
            runtime=runtime,
            dispatcher=dispatcher,
            span_handler=span_handler,
            event_handler=event_handler,
        )
        if not _atexit_registered:
            atexit.register(shutdown)
            _atexit_registered = True
        return _state


def flush(timeout: float = 10.0) -> bool:
    with _lock:
        state = _state
    return True if state is None else state.runtime.flush(timeout)


def uninstrument(*, flush_timeout: float = 10.0) -> None:
    global _state
    with _lock:
        state = _state
        if state is None:
            return
        _state = None
        state.dispatcher.span_handlers = [
            handler
            for handler in state.dispatcher.span_handlers
            if handler is not state.span_handler
        ]
        state.dispatcher.event_handlers = [
            handler
            for handler in state.dispatcher.event_handlers
            if handler is not state.event_handler
        ]
        state.span_handler.close()
    state.runtime.flush(flush_timeout)
    state.runtime.close(flush_timeout)


def shutdown(timeout: float = 5.0) -> None:
    uninstrument(flush_timeout=timeout)


def current_state() -> InstrumentationState | None:
    with _lock:
        return _state
