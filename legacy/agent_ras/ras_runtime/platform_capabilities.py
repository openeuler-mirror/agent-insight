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

"""Platform capability flags for ras_runtime (avoid platform-name string branches)."""
from __future__ import annotations

from typing import Any

# OpenCode / xiaoO: HostCallback + skill_result. openjiuwen deep-mount uses DeepAgentAdapter.
_PLATFORM_CAPABILITIES: dict[str, dict[str, Any]] = {
    "opencode": {
        "supports_host_skill_judge": True,
    },
    "openjiuwen": {
        "supports_host_skill_judge": False,
    },
    "pi": {
        "supports_host_skill_judge": False,
    },
    "xiaoo": {
        "supports_host_skill_judge": True,
    },
}


def platform_capabilities(platform: str) -> dict[str, Any]:
    return dict(_PLATFORM_CAPABILITIES.get(str(platform or "").strip(), {}))


def supports_host_skill_judge(platform: str) -> bool:
    return bool(platform_capabilities(platform).get("supports_host_skill_judge"))
