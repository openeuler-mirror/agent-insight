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

"""Subprocess-hook embedding transport (Unix socket SessionHub).

For hosts that spawn a short-lived hook process per event (e.g. xiaoo).
Not SessionHub itself — that stays in ``ras_runtime``. This package only wires
hooks to a shared worker over ``ras_embed.sock``.
"""
from __future__ import annotations

from platform_adapter.common.transport.subprocess_ipc.client import (
    call_ipc,
    default_sock_path,
    ensure_worker,
    ipc_available,
)

__all__ = [
    "call_ipc",
    "default_sock_path",
    "ensure_worker",
    "ipc_available",
]
