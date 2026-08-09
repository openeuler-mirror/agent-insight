# coding: utf-8
"""Subprocess-hook embedding transport (Unix socket SessionHub + host control).

For hosts that spawn a short-lived hook process per event (e.g. xiaoo).
Not SessionHub itself — that stays in ``ras_runtime``. This package only wires
hooks to a shared worker and to ``ras_control.sock``.
"""
from __future__ import annotations

from platform_adapter.common.transport.subprocess_ipc.client import (
    call_ipc,
    default_control_path,
    default_sock_path,
    ensure_worker,
    ipc_available,
    publish_host_control,
    send_host_control,
)

__all__ = [
    "call_ipc",
    "default_control_path",
    "default_sock_path",
    "ensure_worker",
    "ipc_available",
    "publish_host_control",
    "send_host_control",
]
