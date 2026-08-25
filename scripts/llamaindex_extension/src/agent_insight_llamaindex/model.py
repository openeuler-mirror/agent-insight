from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class SpanRecord:
    trace_id: str
    span_id: str
    parent_span_id: str | None
    session_id: str
    name: str
    kind: str
    start_time_ns: int
    end_time_ns: int
    status: str = "success"
    status_message: str | None = None
    attributes: dict[str, Any] = field(default_factory=dict)
