# coding: utf-8
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
