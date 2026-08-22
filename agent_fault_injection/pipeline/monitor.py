"""Async subprocess monitoring utilities."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from pathlib import Path

from .exceptions import ExperimentTimeoutError, PluginStartupError


class ProcessMonitor:
    async def wait_for_file(
        self,
        process: asyncio.subprocess.Process,
        path: Path,
        timeout_seconds: float,
    ) -> None:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_seconds

        while loop.time() < deadline:
            if path.is_file():
                return
            if process.returncode is not None:
                raise PluginStartupError(
                    f"Platform exited before plugin initialization "
                    f"(exit code {process.returncode})"
                )
            await asyncio.sleep(0.05)

        raise PluginStartupError(
            f"Platform plugin did not become ready within {timeout_seconds:g}s"
        )

    async def wait_for_exit(
        self,
        process: asyncio.subprocess.Process,
        timeout_seconds: float,
        *,
        health_check: Callable[[], None] | None = None,
        poll_interval_seconds: float = 0.25,
    ) -> int:
        if health_check is None:
            try:
                return await asyncio.wait_for(
                    process.wait(),
                    timeout=timeout_seconds,
                )
            except TimeoutError as exc:
                await self.stop(process)
                raise ExperimentTimeoutError(
                    f"Platform exceeded experiment timeout of {timeout_seconds:g}s"
                ) from exc

        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_seconds
        waiter = asyncio.create_task(process.wait())
        try:
            while True:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    await self.stop(process)
                    raise ExperimentTimeoutError(
                        f"Platform exceeded experiment timeout of "
                        f"{timeout_seconds:g}s"
                    )
                done, _ = await asyncio.wait(
                    {waiter},
                    timeout=min(poll_interval_seconds, remaining),
                )
                if done:
                    return waiter.result()
                health_check()
        finally:
            if not waiter.done():
                waiter.cancel()
                try:
                    await waiter
                except asyncio.CancelledError:
                    pass

    async def stop(self, process: asyncio.subprocess.Process) -> None:
        if process.returncode is not None:
            return

        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except TimeoutError:
            process.kill()
            await process.wait()

