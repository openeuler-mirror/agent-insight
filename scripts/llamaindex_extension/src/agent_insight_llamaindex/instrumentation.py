from __future__ import annotations

import atexit
import threading
from dataclasses import dataclass
from typing import Any

from .config import CollectorConfig
from .event_handler import LlamaIndexEventHandler
from .otel_integration import AgentInsightOpenTelemetry
from .span_handler import LlamaIndexSpanHandler
from .uploader import CollectorRuntime


@dataclass(slots=True)
class InstrumentationState:
    config: CollectorConfig
    runtime: CollectorRuntime
    instrumentor: AgentInsightOpenTelemetry
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
        runtime.start()
        instrumentor: AgentInsightOpenTelemetry | None = None
        try:
            instrumentor = AgentInsightOpenTelemetry(resolved, runtime)
            instrumentor.start_registering()
        except BaseException:
            if instrumentor is not None:
                instrumentor.unregister()
            runtime.close(1.0)
            raise
        _state = InstrumentationState(
            config=resolved,
            runtime=runtime,
            instrumentor=instrumentor,
            span_handler=instrumentor.span_handler,
            event_handler=instrumentor.event_handler,
        )
        if not _atexit_registered:
            atexit.register(shutdown)
            _atexit_registered = True
        return _state


def flush(timeout: float = 10.0) -> bool:
    with _lock:
        state = _state
    if state is None:
        return True
    state.instrumentor.force_flush(max(1, int(timeout * 1000)))
    return state.runtime.flush(timeout)


def uninstrument(*, flush_timeout: float = 10.0) -> None:
    global _state
    with _lock:
        state = _state
        if state is None:
            return
        _state = None
        state.instrumentor.unregister()
    state.runtime.flush(flush_timeout)
    state.runtime.close(flush_timeout)


def shutdown(timeout: float = 5.0) -> None:
    uninstrument(flush_timeout=timeout)


def current_state() -> InstrumentationState | None:
    with _lock:
        return _state
