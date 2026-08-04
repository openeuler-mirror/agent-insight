"""Shared L2: RasClient, protocol factory, Insight reporter."""

from platform_adapter.common.observe import observe_assistant_text, observe_tool_after
from platform_adapter.common.protocol_client import (
    CallableHostControl,
    apply_wire_actions,
    build_protocol_ras_client,
)
from platform_adapter.common.ras_client import RasClient

__all__ = [
    "RasClient",
    "CallableHostControl",
    "apply_wire_actions",
    "build_protocol_ras_client",
    "observe_assistant_text",
    "observe_tool_after",
]