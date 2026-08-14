from __future__ import annotations

from typing import Any

from .config import CollectorConfig
from .model import SpanRecord


def _any_value(value: Any) -> dict[str, Any]:
    if isinstance(value, bool):
        return {"boolValue": value}
    if isinstance(value, int):
        return {"intValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    return {"stringValue": str(value)}


def _attributes(values: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {"key": key, "value": _any_value(value)}
        for key, value in values.items()
        if value is not None
    ]


def encode_batch(records: list[SpanRecord], config: CollectorConfig) -> dict[str, Any]:
    spans: list[dict[str, Any]] = []
    for record in records:
        attributes = {
            "agent.insight.framework": "llamaindex",
            "agent.insight.span.kind": record.kind,
            "session.id": record.session_id,
            **record.attributes,
        }
        span = {
            "traceId": record.trace_id,
            "spanId": record.span_id,
            "name": record.name,
            "kind": 1,
            "startTimeUnixNano": str(record.start_time_ns),
            "endTimeUnixNano": str(max(record.start_time_ns, record.end_time_ns)),
            "attributes": _attributes(attributes),
            "status": {
                "code": 2 if record.status == "error" else 1,
                "message": record.status_message or "",
            },
        }
        if record.parent_span_id:
            span["parentSpanId"] = record.parent_span_id
        spans.append(span)
    return {
        "resourceSpans": [
            {
                "resource": {
                    "attributes": _attributes(
                        {
                            "service.name": config.service_name,
                            "agent.insight.framework": "llamaindex",
                            "user.id": config.user,
                            "telemetry.sdk.name": "agent-insight-llamaindex",
                            "telemetry.sdk.language": "python",
                            "telemetry.sdk.version": "0.2.0",
                        }
                    )
                },
                "scopeSpans": [
                    {
                        "scope": {"name": "agent-insight-llamaindex", "version": "0.2.0"},
                        "spans": spans,
                    }
                ],
            }
        ]
    }
