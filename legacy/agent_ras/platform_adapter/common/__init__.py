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

"""Shared L2: RasClient, protocol factory, Insight ras-events reporter."""

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