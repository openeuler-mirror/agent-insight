# coding: utf-8
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
