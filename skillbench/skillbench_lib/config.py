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

"""Shared constants for SkillBench analysis."""

from __future__ import annotations

from enum import StrEnum

REQUIRED_GROUPS = ("static", "init", "dynamic", "hybrid")
MODES = ("init", "static", "dynamic", "hybrid", "feedback")
COMPARISON_GROUPS = ("static", "dynamic", "hybrid", "feedback")
BASELINE_GROUP = "init"

AGENT_TIMEOUT_SECONDS = 900.0
TIMEOUT_LOW = 899.7
TIMEOUT_HIGH = 900.3


class Status(StrEnum):
    MISSING = "missing"
    AGENT_TIMEOUT = "agent_timeout"
    SETUP_TIMEOUT = "setup_timeout"
    ENV_TIMEOUT = "env_timeout"
    FAIL = "fail"
    PARTIAL = "partial"
    SUCCESS = "success"


# Back-compat string aliases — equal-by-value to the enum members.
STATUS_MISSING = Status.MISSING
STATUS_AGENT_TIMEOUT = Status.AGENT_TIMEOUT
STATUS_SETUP_TIMEOUT = Status.SETUP_TIMEOUT
STATUS_ENV_TIMEOUT = Status.ENV_TIMEOUT
STATUS_FAIL = Status.FAIL
STATUS_PARTIAL = Status.PARTIAL
STATUS_SUCCESS = Status.SUCCESS

SETUP_TIMEOUT_EXCEPTIONS = frozenset({"AgentSetupTimeoutError"})
ENV_TIMEOUT_EXCEPTIONS = frozenset(
    {
        "EnvironmentStartTimeoutError",
        "EnvironmentBuildTimeoutError",
    }
)
