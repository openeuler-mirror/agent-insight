# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""In-process RAS package embedded by supported agent hosts.

Public API (stable for FFI / tests):
  - call(op, session_id, payload_json) -> str
  - reset_runtime_for_tests()
"""
from __future__ import annotations

from .facade import call
from .runtime import reset_runtime_for_tests

__all__ = ["call", "reset_runtime_for_tests"]
