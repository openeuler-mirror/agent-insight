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
"""Stable public API for in-process Agent RAS core."""

import importlib
from typing import Any

from core.host_control import HostControl, NoOpHostControl
from core.config import AgentRASConfig
from core.models import Anomaly, Severity, Signal, SignalKind

# Capability packages (agents/ recovery/) import core.models; eager re-export
# here would cycle core/__init__ <-> agents.base. Resolve lazily (PEP 562).
_LAZY_REEXPORTS = {
    "AgentAdapter": "agents.base",
    "NoOpAgentAdapter": "agents.base",
    "RecoveryAction": "recovery.engine",
}

__all__ = [
    "AgentAdapter",
    "AgentRASConfig",
    "Anomaly",
    "HostControl",
    "NoOpAgentAdapter",
    "NoOpHostControl",
    "RecoveryAction",
    "Severity",
    "Signal",
    "SignalKind",
]


def __getattr__(name: str) -> Any:
    module = _LAZY_REEXPORTS.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(importlib.import_module(module), name)
    globals()[name] = value
    return value
