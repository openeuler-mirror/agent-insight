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

"""Agent runtime layer for Agent RAS semantic skills (platform-agnostic)."""
from agents.base import (
    AGENT_RAS_SKILL_ROLES,
    FAULT_DOMAIN_SKILLS,
    AgentAdapter,
    NoOpAgentAdapter,
    fault_domain_for_kind,
    load_skill_body,
    skill_for,
    skills_dir_for_role,
)
from agents.host_callback_adapter import HostCallbackAgentAdapter
from agents.ras_agents import RASAgents

__all__ = [
    "AGENT_RAS_SKILL_ROLES",
    "AgentAdapter",
    "FAULT_DOMAIN_SKILLS",
    "HostCallbackAgentAdapter",
    "NoOpAgentAdapter",
    "RASAgents",
    "fault_domain_for_kind",
    "load_skill_body",
    "skill_for",
    "skills_dir_for_role",
]
