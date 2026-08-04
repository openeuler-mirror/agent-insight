# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""In-process RAS package embedded by supported agent hosts.

Public API (stable for FFI / tests):
  - call(op, session_id, payload_json) -> str
  - ensure_runtime()
  - reset_runtime_for_tests()
  - ensure_worker() / ipc helpers for subprocess-hook hosts
"""
from __future__ import annotations

from .facade import call
from .ipc import (
    default_control_path,
    default_sock_path,
    ensure_worker,
    ipc_available,
    publish_host_control,
)
from .runtime import ensure_runtime, reset_runtime_for_tests

__all__ = [
    "call",
    "default_control_path",
    "default_sock_path",
    "ensure_runtime",
    "ensure_worker",
    "ipc_available",
    "publish_host_control",
    "reset_runtime_for_tests",
]
