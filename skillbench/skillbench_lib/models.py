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

"""Data models shared by SkillBench analysis scripts."""

from __future__ import annotations

from dataclasses import dataclass

from .config import Status


@dataclass(frozen=True)
class Trial:
    group: str
    task_name: str
    total_tokens: int
    input_tokens: int
    success: bool
    cost_usd: float | None
    duration_sec: float | None
    exception_type: str | None
    cache_tokens: int = 0
    output_tokens: int = 0
    reward: float | None = None
    trial_name: str = ""
    run_datetime: str = ""
    session_id: str | None = None
    result_path: str = ""


# Back-compat aliases for existing callers.
TrialRecord = Trial
TrialArtifact = Trial


@dataclass(frozen=True)
class CellState:
    status: Status
    success_rate: float | None
    mean_tokens: float | None
    mean_duration: float | None
    mean_cost: float | None
    mean_cost_per_1M: float | None
    n_trials: int
