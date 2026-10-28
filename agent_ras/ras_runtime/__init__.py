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
"""In-process RAS package: SessionHub facade (platform-agnostic runtime).

Public API (stable for FFI / tests):
  - call(op, session_id, payload_json) -> str
  - ensure_runtime()
  - reset_runtime_for_tests()

Subprocess-hook transport (xiaoo-style) lives under
``platform_adapter.common.transport.subprocess_ipc``.
"""
from __future__ import annotations

from .facade import call
from .runtime import ensure_runtime, reset_runtime_for_tests

__all__ = [
    "call",
    "ensure_runtime",
    "reset_runtime_for_tests",
]
