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
