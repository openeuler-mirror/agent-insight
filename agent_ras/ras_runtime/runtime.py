# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""Background asyncio loop + SessionHub for in-process embed."""
from __future__ import annotations

import asyncio
import threading
from typing import Any

from .session_hub import SessionHub

_hub: SessionHub | None = None
_loop: asyncio.AbstractEventLoop | None = None
_thread: threading.Thread | None = None
_lock = threading.Lock()
_DEFAULT_TIMEOUT_S = 8.0


def reset_runtime_for_tests() -> None:
    """Tear down embed runtime (unit tests only)."""
    global _hub, _loop, _thread
    with _lock:
        if _loop is not None and _loop.is_running():
            async def _cancel_pending() -> None:
                current = asyncio.current_task()
                pending = [
                    task
                    for task in asyncio.all_tasks()
                    if task is not current and not task.done()
                ]
                for task in pending:
                    task.cancel()
                if pending:
                    await asyncio.gather(*pending, return_exceptions=True)

            try:
                asyncio.run_coroutine_threadsafe(
                    _cancel_pending(), _loop
                ).result(timeout=2.0)
            except Exception:
                pass
            _loop.call_soon_threadsafe(_loop.stop)
        if _thread is not None and _thread.is_alive():
            _thread.join(timeout=2.0)
        _hub = None
        _loop = None
        _thread = None


def ensure_runtime() -> tuple[SessionHub, asyncio.AbstractEventLoop]:
    global _hub, _loop, _thread
    with _lock:
        if _hub is not None and _loop is not None and _loop.is_running():
            return _hub, _loop

        hub = SessionHub()
        loop = asyncio.new_event_loop()

        def _run() -> None:
            asyncio.set_event_loop(loop)
            loop.run_forever()

        thread = threading.Thread(target=_run, name="ras_runtime_loop", daemon=True)
        thread.start()
        _hub = hub
        _loop = loop
        _thread = thread
        return hub, loop


def run_coro(coro: Any, timeout: float = _DEFAULT_TIMEOUT_S) -> Any:
    _, loop = ensure_runtime()
    fut = asyncio.run_coroutine_threadsafe(coro, loop)
    return fut.result(timeout=timeout)
