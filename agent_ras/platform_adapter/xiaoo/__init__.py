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

"""xiaoO L3 adapter package."""
from platform_adapter.xiaoo.daemon_client import XiaooDaemonClient
from platform_adapter.xiaoo.daemon_session import (
    DaemonRasSession,
    build_daemon_ras_session,
    map_sse_event_to_observes,
)
from platform_adapter.xiaoo.hooks import (
    build_xiaoo_daemon_host_fns,
    build_xiaoo_ras_client,
)
from platform_adapter.xiaoo.stream_bridge import observe_text_delta, observe_tool_after

__all__ = [
    "XiaooDaemonClient",
    "DaemonRasSession",
    "build_daemon_ras_session",
    "map_sse_event_to_observes",
    "build_xiaoo_daemon_host_fns",
    "build_xiaoo_ras_client",
    "observe_text_delta",
    "observe_tool_after",
]
