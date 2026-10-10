# coding: utf-8
"""``python -m platform_adapter.common.transport.subprocess_ipc`` entry."""
from __future__ import annotations

from platform_adapter.common.transport.subprocess_ipc.worker import main

if __name__ == "__main__":
    raise SystemExit(main())
