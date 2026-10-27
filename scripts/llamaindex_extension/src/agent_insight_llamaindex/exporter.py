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

from __future__ import annotations

from collections.abc import Callable, Sequence

from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult
from opentelemetry.trace import StatusCode

from .model import SpanRecord


def readable_span_to_record(span: ReadableSpan) -> SpanRecord:
    context = span.context
    if context is None:
        raise ValueError("OpenTelemetry span has no context")
    attributes = dict(span.attributes or {})
    parent = span.parent
    start_time_ns = span.start_time or 0
    return SpanRecord(
        trace_id=f"{context.trace_id:032x}",
        span_id=f"{context.span_id:016x}",
        parent_span_id=f"{parent.span_id:016x}" if parent and parent.is_valid else None,
        session_id=str(attributes.get("session.id") or f"{context.trace_id:032x}"),
        name=span.name,
        kind=str(attributes.get("agent.insight.span.kind") or "span"),
        start_time_ns=start_time_ns,
        end_time_ns=span.end_time or start_time_ns,
        status="error" if span.status.status_code is StatusCode.ERROR else "success",
        status_message=span.status.description,
        attributes=attributes,
    )


class AgentInsightSpanExporter(SpanExporter):
    def __init__(self, submit: Callable[[SpanRecord], bool]) -> None:
        self._submit = submit

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        accepted = True
        for span in spans:
            try:
                accepted = self._submit(readable_span_to_record(span)) and accepted
            except Exception:
                accepted = False
        return SpanExportResult.SUCCESS if accepted else SpanExportResult.FAILURE

    def shutdown(self) -> None:
        return None

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        return True
