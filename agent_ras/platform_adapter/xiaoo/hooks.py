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

"""xiaoO protocol inproc hooks — thin L3 over shared factory + Host callables.

Host delivery: pass abort/notice/steer callables (Daemon path uses
``DaemonRasSession`` / ``build_xiaoo_daemon_host_fns`` → ``runtimes/cancel``
and ``runtimes/input`` under the same lease). Plugin hooker leaves Host
unwired and maps wire actions to stdout HookAction.
"""
from __future__ import annotations

import logging
from typing import Any, Callable

from platform_adapter.common.protocol_client import (
    CallableHostControl,
    build_protocol_ras_client,
)
from platform_adapter.common.ras_client import RasClient

logger = logging.getLogger(__name__)


def build_xiaoo_daemon_host_fns(
    *,
    cancel_fn: Callable[[], dict[str, Any]],
    input_fn: Callable[[str], dict[str, Any]],
    notice_as_steer: bool = True,
) -> tuple[Callable[[], Any], Callable[[str], Any], Callable[[str], Any]]:
    """Host callables backed by Daemon ``cancel`` + ``input`` (same lease)."""

    def abort_fn() -> dict[str, Any]:
        return cancel_fn()

    def steer_fn(message: str) -> dict[str, Any]:
        return input_fn(message)

    def notice_fn(message: str) -> dict[str, Any]:
        text = f"[RAS] {message}" if notice_as_steer else message
        return input_fn(text)

    return abort_fn, notice_fn, steer_fn


def build_xiaoo_ras_client(
    *,
    abort_fn: Callable[[], Any] | None = None,
    notice_fn: Callable[[str], Any] | None = None,
    steer_fn: Callable[[str], Any] | None = None,
) -> tuple[RasClient, CallableHostControl]:
    """Create RasClient for xiaoO (protocol inproc).

    Unwired Host when no callables are passed (plugin hooker stdout path).
    """
    unwired = abort_fn is None and notice_fn is None and steer_fn is None
    if unwired:
        logger.debug("xiaoo Host fns unwired: pass abort/notice/steer for Daemon delivery")

    return build_protocol_ras_client(
        platform="xiaoo",
        abort_fn=abort_fn,
        notice_fn=notice_fn,
        steer_fn=steer_fn,
        report_results=not unwired,
    )


__all__ = [
    "build_xiaoo_ras_client",
    "build_xiaoo_daemon_host_fns",
]
