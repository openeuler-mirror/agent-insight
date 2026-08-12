# coding: utf-8
"""AnomalyReporter that forwards to Insight via insight_push (fail-open)."""
from __future__ import annotations

import logging
import uuid
from typing import Any

from core.models import Anomaly
from ras_runtime.insight_push import fire_push_action_result, fire_push_anomaly

logger = logging.getLogger(__name__)


class InsightAnomalyReporter:
    """Push anomalies (and optional action results) to Agent Insight RAS ingest."""

    handles_all_anomalies = True

    def __init__(self, session_id: str, platform: str = "openjiuwen") -> None:
        self._session_id = session_id
        self._platform = platform

    async def report(self, anomaly: Anomaly) -> None:
        evidence = anomaly.evidence if isinstance(anomaly.evidence, dict) else {}
        kind = anomaly.kind.value if hasattr(anomaly.kind, "value") else str(anomaly.kind)
        severity = anomaly.severity.value if hasattr(anomaly.severity, "value") else str(anomaly.severity)
        anomaly_dict: dict[str, Any] = {
            "kind": kind,
            "severity": severity,
            "summary": anomaly.summary,
            "evidence": evidence,
        }
        fire_push_anomaly(self._session_id, self._platform, anomaly_dict)

    def push_action_result(self, result: dict[str, Any]) -> None:
        fire_push_action_result(self._session_id, self._platform, result)


def allocate_delivery_message_id() -> str:
    return f"msg_{uuid.uuid4().hex[:26]}"


def default_insight_reporter_factory(
    session_id: str,
    *,
    platform: str = "openjiuwen",
) -> InsightAnomalyReporter:
    return InsightAnomalyReporter(session_id=session_id, platform=platform)
