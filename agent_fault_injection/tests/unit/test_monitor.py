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

import asyncio
from unittest import IsolatedAsyncioTestCase

from agent_fault_injection.pipeline.exceptions import PlatformConnectionError
from agent_fault_injection.pipeline.monitor import ProcessMonitor


class _HangingProcess:
    def __init__(self) -> None:
        self.returncode: int | None = None
        self._finished = asyncio.Event()

    async def wait(self) -> int:
        await self._finished.wait()
        return self.returncode or 0

    def terminate(self) -> None:
        self.returncode = -15
        self._finished.set()

    def kill(self) -> None:
        self.returncode = -9
        self._finished.set()


class ProcessMonitorTests(IsolatedAsyncioTestCase):
    async def test_health_check_aborts_before_timeout(self) -> None:
        monitor = ProcessMonitor()
        process = _HangingProcess()

        def health_check() -> None:
            raise PlatformConnectionError("provider unavailable")

        with self.assertRaisesRegex(
            PlatformConnectionError,
            "provider unavailable",
        ):
            await monitor.wait_for_exit(
                process, 10,  # type: ignore[arg-type]
                health_check=health_check,
                poll_interval_seconds=0.001,
            )

        await monitor.stop(process)  # type: ignore[arg-type]
        self.assertEqual(process.returncode, -15)


if __name__ == "__main__":
    import unittest

    unittest.main()
