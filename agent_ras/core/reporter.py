# coding: utf-8
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

# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""Optional anomaly sink protocol between Monitor and external reporters.

This module defines only the typing contract. A single-Agent Monitor may pass
``reporter=None`` and skip external reporting.
"""
from __future__ import annotations

from typing import Protocol, runtime_checkable

from core.models import Anomaly


@runtime_checkable
class AnomalyReporter(Protocol):
    """Structural protocol: ``async report(anomaly)`` for optional sinks.

    Implementations may also expose ``bind_ctx`` and ``handles_all_anomalies``.
    """

    async def report(self, anomaly: Anomaly) -> None:
        """Forward one detected anomaly to the configured sink."""
        ...
