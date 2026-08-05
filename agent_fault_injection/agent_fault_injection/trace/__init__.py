"""Insight-compatible trace mapping."""

from .interactions_mapper import (
    InsightInteractionsMapper,
    TraceDocument,
    enrich_trace_document_model,
    write_interactions_artifact,
)

__all__ = [
    "InsightInteractionsMapper",
    "TraceDocument",
    "enrich_trace_document_model",
    "write_interactions_artifact",
]
