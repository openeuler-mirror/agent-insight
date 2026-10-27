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

"""Registry of structural injection ops (Command + Registry pattern)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .context import InjectionContext

InjectionOp = Callable[[InjectionContext, dict[str, Any]], dict[str, Any]]

_REGISTRY: dict[str, InjectionOp] = {}


def register(op_name: str, func: InjectionOp) -> InjectionOp:
    """Register a structural op implementation under its fault.json op id."""

    _REGISTRY[op_name] = func
    return func


def get_op(op_name: str) -> InjectionOp:
    try:
        return _REGISTRY[op_name]
    except KeyError as exc:
        raise KeyError(f"Unknown injection op: {op_name}") from exc
