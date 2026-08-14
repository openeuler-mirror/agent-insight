from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

trace_metadata: ContextVar[dict[str, Any] | None] = ContextVar(
    "agent_insight_trace_metadata", default=None
)


@contextmanager
def trace_context(
    *, session_id: str | None = None, query: str | None = None, agent_name: str | None = None
) -> Iterator[None]:
    current = dict(trace_metadata.get() or {})
    if session_id:
        current["session_id"] = session_id
    if query:
        current["query"] = query
    if agent_name:
        current["agent_name"] = agent_name
    token = trace_metadata.set(current)
    try:
        yield
    finally:
        trace_metadata.reset(token)
