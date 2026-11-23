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
"""Recovery: policy mapping + atomic operations + robustness prompts."""

from recovery.engine import (
    DEFAULT_SEVERITY_ACTIONS,
    LocalAutoRecovery,
    RecoveryAction,
    RecoveryExecutor,
    RecoveryPlan,
    RecoveryPolicy,
    needs_immediate_apply,
    plan_recovery,
    should_emit_user_notice,
)
from recovery.operations import (
    apply_recovery_actions,
    build_recovery_actions,
)
from recovery.robustness_prompt import load_message
from recovery.state import (
    PendingRecovery,
    SuppressFlushState,
)

__all__ = [
    "DEFAULT_SEVERITY_ACTIONS",
    "LocalAutoRecovery",
    "PendingRecovery",
    "RecoveryPlan",
    "RecoveryAction",
    "RecoveryExecutor",
    "RecoveryPolicy",
    "SuppressFlushState",
    "apply_recovery_actions",
    "build_recovery_actions",
    "load_message",
    "needs_immediate_apply",
    "plan_recovery",
    "should_emit_user_notice",
]
