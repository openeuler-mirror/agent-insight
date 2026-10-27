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
"""HostControl protocol tests (no openjiuwen dependency)."""
from __future__ import annotations

import pytest

from core.host_control import HostControl, NoOpHostControl


@pytest.mark.asyncio
async def test_noop_host_control_methods_do_not_raise() -> None:
    host: HostControl = NoOpHostControl()
    host.request_abort_stream()
    host.push_steering("steer")
    host.request_force_finish({"output": "x", "result_type": "error"})
    await host.emit_user_notice("notice")
    await host.emit_stream_error("err")
    await host.write_stream_content("llm_output", "buffered")


def test_noop_is_runtime_checkable() -> None:
    assert isinstance(NoOpHostControl(), HostControl)
