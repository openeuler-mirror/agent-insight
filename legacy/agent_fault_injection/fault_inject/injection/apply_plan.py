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

"""Apply a FaultDefinition.injection_plan using injection capabilities.

Reads an already-loaded catalog definition; does not define plans.
"""

from __future__ import annotations

from .context import InjectionContext
from . import file_ops as _file_ops  # noqa: F401
from .op_registry import get_op
from ..catalog.models import FaultDefinition
from ..catalog.scenarios import normalize_submode


def _step_matches(when_submode: str | None, current: str | None) -> bool:
    if when_submode is None:
        return True
    wanted = normalize_submode(when_submode)
    actual = normalize_submode(current) or "1"
    return wanted == actual


def apply_injection_plan(
    fault: FaultDefinition,
    ctx: InjectionContext,
) -> list[dict]:
    """Run ``fault.injection_plan`` via registered file ops; no-op when empty."""

    if not fault.injection_plan:
        return []

    if ctx.assets_root is None and fault.assets_dir is not None:
        ctx.assets_root = fault.assets_dir

    results: list[dict] = []
    for step in fault.injection_plan:
        if not _step_matches(step.when_submode, ctx.submode):
            continue
        op = get_op(step.op)
        result = op(ctx, step.arg_map())
        ctx.last_ops.append(result)
        results.append(result)
    return results
