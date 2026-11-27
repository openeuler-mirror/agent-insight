# Copyright (c) 2026 Huawei Technologies Co., Ltd.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""OTLP JSON span builders used by the QwenPaw collector."""

from __future__ import annotations

import hashlib
import json
import time
from typing import Any, Iterable

TRUNCATION_MARKER_TEMPLATE = "…[TRUNCATED original_chars={}]"


def now_ns() -> int:
    return time.time_ns()


def seconds_to_ns(value: Any) -> int | None:
    try:
        return int(float(value) * 1_000_000_000)
    except (TypeError, ValueError):
        return None


def stable_hex(value: str, length: int) -> str:
    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()[:length]


def json_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    try:
        return json.dumps(value, ensure_ascii=False, default=str, separators=(",", ":"))
    except Exception:
        return str(value)


def limited_text(value: Any, max_chars: int) -> tuple[str, bool, int]:
    text = json_text(value)
    chars = list(text)
    original_chars = len(chars)
    if max_chars > 0 and original_chars > max_chars:
        marker = TRUNCATION_MARKER_TEMPLATE.format(original_chars)
        marker_chars = list(marker)
        if max_chars <= len(marker_chars):
            return "".join(marker_chars[:max_chars]), True, original_chars
        return "".join(chars[: max_chars - len(marker_chars)]) + marker, True, original_chars
    return text, False, original_chars


def otel_value(value: Any) -> dict[str, Any]:
    if isinstance(value, bool):
        return {"boolValue": value}
    if isinstance(value, int):
        return {"intValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    return {"stringValue": json_text(value)}


def attributes(values: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {"key": key, "value": otel_value(value)}
        for key, value in values.items()
        if value is not None and value != ""
    ]


def build_resource(
    service_name: str,
    root_session_id: str,
    user_id: str = "",
    version: str = "",
) -> dict[str, Any]:
    resource_attrs: dict[str, Any] = {
        "service.name": service_name,
        "agent.insight.framework": "qwenpaw",
        "session.id": root_session_id,
        "service.instance.id": root_session_id,
    }
    if user_id:
        resource_attrs["user.id"] = user_id
    if version:
        resource_attrs["qwenpaw.version"] = version
    return {"attributes": attributes(resource_attrs)}


def new_span(
    *,
    name: str,
    span_id: str,
    trace_id: str,
    parent_span_id: str | None,
    span_attributes: dict[str, Any],
    start_ns: int | None = None,
) -> dict[str, Any]:
    start = start_ns or now_ns()
    return {
        "traceId": trace_id,
        "spanId": span_id,
        "parentSpanId": parent_span_id or "",
        "name": name,
        "kind": 1,
        "startTimeUnixNano": str(start),
        "endTimeUnixNano": str(start),
        "attributes": attributes(span_attributes),
        "status": {"code": 1},
    }


def decode_attributes(items: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Decode OTLP attribute entries back to native Python values.

    ``intValue``/``doubleValue``/``boolValue`` are stored with their real
    types so that merging a finished span's attributes does not downgrade
    numeric attributes (e.g. ``qwenpaw.input_chars``) to strings.
    """
    decoded: dict[str, Any] = {}
    for item in items:
        key = item.get("key")
        value = item.get("value", {})
        if not key:
            continue
        if "intValue" in value:
            try:
                decoded[key] = int(value["intValue"])
            except (TypeError, ValueError):
                decoded[key] = value["intValue"]
        elif "boolValue" in value:
            decoded[key] = value["boolValue"]
        elif "doubleValue" in value:
            decoded[key] = value["doubleValue"]
        else:
            decoded[key] = value.get("stringValue", "")
    return decoded


def finish_span(
    span: dict[str, Any],
    span_attributes: dict[str, Any],
    end_ns: int | None = None,
) -> None:
    merged = decode_attributes(span.get("attributes", []))
    merged.update(span_attributes)
    span["attributes"] = attributes(merged)
    span["endTimeUnixNano"] = str(end_ns or now_ns())


def otlp_payload(
    service_name: str,
    root_session_id: str,
    user_id: str,
    version: str,
    spans: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    ordered = sorted(spans, key=lambda item: int(item["startTimeUnixNano"]))
    return {
        "resourceSpans": [
            {
                "resource": build_resource(service_name, root_session_id, user_id, version),
                "scopeSpans": [
                    {
                        "scope": {"name": "agent-insight-qwenpaw", "version": version or "0.1.0"},
                        "spans": ordered,
                    }
                ],
            }
        ]
    }
