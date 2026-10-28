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
"""RASAgents facade — routes skill invocations to AgentAdapter."""
from __future__ import annotations

import asyncio
from typing import Any

from agents.base import (
    AgentAdapter,
    NoOpAgentAdapter,
)


class RASAgents:
    """Facade over ``AgentAdapter`` for detector skill members."""

    def __init__(self, adapter: AgentAdapter | None = None) -> None:
        self._adapter = adapter or NoOpAgentAdapter()

    async def invoke_skill(
        self,
        *,
        role: str,
        skill_name: str,
        payload: str,
        timeout: float,
    ) -> dict[str, Any]:
        try:
            result = await asyncio.wait_for(
                self._adapter.invoke_skill(
                    role=role,
                    skill_name=skill_name,
                    payload=payload,
                    timeout=timeout,
                ),
                timeout=timeout,
            )
        except Exception:
            return {}
        return result if isinstance(result, dict) else {}

    async def warmup_members(self, roles: tuple[str, ...]) -> None:
        warmup = getattr(self._adapter, "warmup_members", None)
        if callable(warmup):
            await warmup(roles)
