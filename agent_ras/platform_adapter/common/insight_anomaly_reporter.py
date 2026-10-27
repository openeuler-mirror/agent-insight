# coding: utf-8
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

"""AnomalyReporter that forwards to Insight via insight_push (fail-open)."""
from __future__ import annotations

import logging
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


def default_insight_reporter_factory(
    session_id: str,
    *,
    platform: str = "openjiuwen",
) -> InsightAnomalyReporter:
    return InsightAnomalyReporter(session_id=session_id, platform=platform)
