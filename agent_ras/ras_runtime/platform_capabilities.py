# coding: utf-8
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
    "xiaoo": {
        "supports_host_skill_judge": True,
    },
}


def platform_capabilities(platform: str) -> dict[str, Any]:
    return dict(_PLATFORM_CAPABILITIES.get(str(platform or "").strip(), {}))


def supports_host_skill_judge(platform: str) -> bool:
    return bool(platform_capabilities(platform).get("supports_host_skill_judge"))
