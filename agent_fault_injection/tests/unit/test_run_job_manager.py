"""Unit tests for bounded-parallel RunJobManager."""

from __future__ import annotations

import asyncio
import os
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import AsyncMock

from agent_fault_injection.web.app import RunJob, RunJobManager
from agent_fault_injection.workspace_alloc import (
    WorkspaceAllocationError,
    allocate_run_workspace,
    allocated_workspace_path,
    new_run_id,
    remove_allocated_workspace,
    sanitize_path_component,
)


class WorkspaceAllocTests(unittest.TestCase):
    def test_allocate_layout_and_seed_readme(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "README.md").write_text("seed\n", encoding="utf-8")
            run_id = "ras-20260101-000000-abcd1234"
            allocated = allocate_run_workspace(
                root, "single", "step-omission", run_id
            )
            self.assertEqual(
                allocated,
                root / ".ras-runs" / "single" / f"step-omission-{run_id}",
            )
            self.assertTrue(allocated.is_dir())
            self.assertEqual(
                (allocated / "README.md").read_text(encoding="utf-8"), "seed\n"
            )

    def test_allocate_rejects_package_root(self) -> None:
        from agent_fault_injection.workspace_alloc import package_root

        root = package_root()
        with self.assertRaises(WorkspaceAllocationError) as ctx:
            allocate_run_workspace(root, "single", "demo", "ras-x")
        self.assertIn("package root", str(ctx.exception))

    def test_suggested_default_avoids_package_root(self) -> None:
        from agent_fault_injection.workspace_alloc import (
            package_root,
            suggested_default_workspace,
        )

        root = package_root()
        previous = Path.cwd()
        try:
            os.chdir(root)
            suggested = suggested_default_workspace(ensure_exists=True)
            self.assertNotEqual(suggested, root)
            self.assertTrue(suggested.is_dir())
            self.assertEqual(suggested, Path("/tmp/ras-workspace").resolve())
        finally:
            os.chdir(previous)
    def test_sanitize_and_new_run_id(self) -> None:
        self.assertEqual(sanitize_path_component("a/b c"), "a-b-c")
        self.assertEqual(sanitize_path_component("   "), "item")
        run_id = new_run_id()
        self.assertTrue(run_id.startswith("ras-"))
        self.assertGreaterEqual(len(run_id), len("ras-YYYYMMDD-HHMMSS-") + 8)

    def test_remove_allocated_workspace_only_under_ras_runs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            allocated = allocate_run_workspace(root, "single", "demo", "ras-del")
            self.assertIsNotNone(allocated_workspace_path(allocated))
            self.assertTrue(remove_allocated_workspace(allocated))
            self.assertFalse(allocated.exists())
            self.assertTrue(root.is_dir())
            # Bare base is never removed.
            self.assertFalse(remove_allocated_workspace(root))
            self.assertTrue(root.is_dir())


class RunJobManagerParallelTests(unittest.IsolatedAsyncioTestCase):
    async def test_peak_concurrency_respects_max_parallel_runs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            manager = RunJobManager(
                output_dir=Path(tmp),
                max_parallel_runs=2,
            )
            peak = 0
            current = 0
            gate = asyncio.Lock()
            started = asyncio.Event()
            hold = asyncio.Event()

            async def fake_execute(job_id: str) -> None:
                nonlocal peak, current
                async with gate:
                    current += 1
                    peak = max(peak, current)
                    if current >= 2:
                        started.set()
                # Stay busy until the test releases the hold so a third job cannot
                # sneak in before we observe the peak.
                await hold.wait()
                async with gate:
                    current -= 1
                job = manager._jobs[job_id]
                job.status = "completed"
                job.phase = "completed"
                job.updated_at = datetime.now(UTC).isoformat()

            manager._execute_job = AsyncMock(side_effect=fake_execute)  # type: ignore[method-assign]

            now = datetime.now(UTC).isoformat()
            job_ids: list[str] = []
            for index in range(5):
                job_id = f"pending-test-{index}"
                job_ids.append(job_id)
                manager._jobs[job_id] = RunJob(
                    run_id=job_id,
                    status="queued",
                    platform="opencode",
                    agent="build",
                    fault="demo",
                    prompt="prompt",
                    workspace=tmp,
                    created_at=now,
                    updated_at=now,
                    phase="queued",
                )
                await manager._queue.put(job_id)

            manager.start()
            self.assertEqual(len(manager._workers), 2)

            await asyncio.wait_for(started.wait(), timeout=2.0)
            # Allow a short window for a third worker to incorrectly start.
            await asyncio.sleep(0.05)
            self.assertLessEqual(peak, 2)
            self.assertEqual(peak, 2)

            hold.set()
            await asyncio.wait_for(manager._queue.join(), timeout=2.0)
            await manager.stop()

            self.assertEqual(peak, 2)
            self.assertTrue(
                all(manager._jobs[job_id].status == "completed" for job_id in job_ids)
            )

    def test_max_parallel_runs_clamped_to_at_least_one(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            manager = RunJobManager(output_dir=Path(tmp), max_parallel_runs=0)
            self.assertEqual(manager.max_parallel_runs, 1)

    async def test_enqueue_single_allocates_isolated_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "README.md").write_text("seed\n", encoding="utf-8")
            manager = RunJobManager(output_dir=root / "artifacts", max_parallel_runs=1)
            manager.start = lambda: None  # type: ignore[method-assign]

            from agent_fault_injection.web.app import RunCreateBody

            job = await manager.enqueue(
                RunCreateBody(
                    fault="step-omission",
                    prompt="test",
                    workspace=str(root),
                )
            )
            workspace = Path(job.workspace)
            self.assertTrue(workspace.is_dir())
            self.assertEqual(workspace.parent.name, "single")
            self.assertEqual(workspace.parent.parent.name, ".ras-runs")
            self.assertNotEqual(workspace.resolve(), root.resolve())
            self.assertEqual(job.base_workspace, str(root.resolve()))
            self.assertTrue(job.run_id.startswith("ras-"))
            self.assertIn(job.run_id, workspace.name)
            self.assertTrue((workspace / "README.md").is_file())

    async def test_enqueue_different_faults_get_distinct_workspaces(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manager = RunJobManager(output_dir=root / "artifacts", max_parallel_runs=1)
            manager.start = lambda: None  # type: ignore[method-assign]

            from agent_fault_injection.web.app import RunCreateBody

            first = await manager.enqueue(
                RunCreateBody(
                    fault="step-omission",
                    prompt="a",
                    workspace=str(root),
                )
            )
            second = await manager.enqueue(
                RunCreateBody(
                    fault="unverified-success",
                    prompt="b",
                    workspace=str(root),
                )
            )
            self.assertNotEqual(
                Path(first.workspace).resolve(), Path(second.workspace).resolve()
            )
            self.assertIn("step-omission", Path(first.workspace).name)
            self.assertIn("unverified-success", Path(second.workspace).name)

    async def test_enqueue_batch_allocates_isolated_workspaces(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "README.md").write_text("seed\n", encoding="utf-8")
            manager = RunJobManager(output_dir=root / "artifacts", max_parallel_runs=1)
            # Avoid starting real workers that would call OpenCode.
            manager.start = lambda: None  # type: ignore[method-assign]

            from agent_fault_injection.web.app import BatchCreateBody

            jobs = await manager.enqueue_batch(
                BatchCreateBody(
                    faults=["step-omission", "unverified-success"],
                    prompt="test",
                    workspace=str(root),
                )
            )
            self.assertEqual(len(jobs), 2)
            workspaces = [Path(job.workspace) for job in jobs]
            self.assertEqual(len({ws.resolve() for ws in workspaces}), 2)
            batch_ids = {job.batch_id for job in jobs}
            self.assertEqual(len(batch_ids), 1)
            batch_id = next(iter(batch_ids))
            self.assertTrue(batch_id)
            for workspace in workspaces:
                self.assertTrue(workspace.is_dir())
                self.assertEqual(workspace.parent.name, batch_id)
                self.assertEqual(workspace.parent.parent.name, ".ras-runs")
                self.assertTrue((workspace / "README.md").is_file())
                self.assertNotEqual(workspace.resolve(), root.resolve())

    async def test_same_allocated_workspace_runs_are_serialized(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            manager = RunJobManager(output_dir=Path(tmp), max_parallel_runs=2)
            peak = 0
            current = 0
            gate = asyncio.Lock()
            started = asyncio.Event()
            hold = asyncio.Event()
            workspace = str(Path(tmp) / "shared-ws")
            Path(workspace).mkdir()

            async def fake_execute(job_id: str) -> None:
                nonlocal peak, current
                job = manager._jobs[job_id]
                request_data = job.progress.get("request")
                assert isinstance(request_data, dict)
                from agent_fault_injection.web.app import RunCreateBody

                body = RunCreateBody.model_validate(request_data)
                ws_lock = await manager._workspace_lock_for(Path(body.workspace))
                async with ws_lock:
                    async with gate:
                        current += 1
                        peak = max(peak, current)
                        if current >= 1:
                            started.set()
                    await hold.wait()
                    async with gate:
                        current -= 1
                job.status = "completed"
                job.phase = "completed"
                job.updated_at = datetime.now(UTC).isoformat()

            manager._execute_job = AsyncMock(side_effect=fake_execute)  # type: ignore[method-assign]

            now = datetime.now(UTC).isoformat()
            for index in range(2):
                job_id = f"ras-shared-{index}"
                manager._jobs[job_id] = RunJob(
                    run_id=job_id,
                    status="queued",
                    platform="opencode",
                    agent="build",
                    fault="step-omission",
                    prompt=f"prompt-{index}",
                    workspace=workspace,
                    created_at=now,
                    updated_at=now,
                    phase="queued",
                    progress={
                        "request": {
                            "platform": "opencode",
                            "agent": "build",
                            "fault": "step-omission",
                            "prompt": f"prompt-{index}",
                            "workspace": workspace,
                            "output_dir": "artifacts",
                            "timeout_seconds": 600,
                            "plugin_startup_timeout": 120,
                            "judge_enabled": True,
                            "auto": True,
                        }
                    },
                )
                await manager._queue.put(job_id)

            manager.start()
            await asyncio.wait_for(started.wait(), timeout=2.0)
            await asyncio.sleep(0.05)
            # Same workspace must not overlap even with two workers.
            self.assertEqual(peak, 1)
            hold.set()
            await asyncio.wait_for(manager._queue.join(), timeout=2.0)
            await manager.stop()
            self.assertEqual(peak, 1)


class RunJobManagerDeleteTests(unittest.TestCase):
    def test_delete_completed_run_removes_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manager = RunJobManager(output_dir=root)
            run_id = "ras-delete-me"
            artifacts = root / run_id
            artifacts.mkdir()
            (artifacts / "manifest.json").write_text("{}", encoding="utf-8")
            now = datetime.now(UTC).isoformat()
            manager._jobs[run_id] = RunJob(
                run_id=run_id,
                status="completed",
                platform="opencode",
                agent="build",
                fault="demo",
                prompt="prompt",
                workspace=tmp,
                created_at=now,
                updated_at=now,
                phase="completed",
                artifacts_dir=str(artifacts),
            )

            result = manager.delete_run(run_id)
            self.assertTrue(result["deleted"])
            self.assertTrue(result["artifacts_deleted"])
            self.assertFalse(result["workspace_deleted"])
            self.assertNotIn(run_id, manager._jobs)
            self.assertFalse(artifacts.exists())

    def test_delete_run_removes_allocated_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            allocated = allocate_run_workspace(
                root, "single", "demo", "ras-ws-clean"
            )
            manager = RunJobManager(output_dir=root / "artifacts")
            run_id = "ras-ws-clean"
            artifacts = root / "artifacts" / run_id
            artifacts.mkdir(parents=True)
            (artifacts / "manifest.json").write_text("{}", encoding="utf-8")
            now = datetime.now(UTC).isoformat()
            manager._jobs[run_id] = RunJob(
                run_id=run_id,
                status="completed",
                platform="opencode",
                agent="build",
                fault="demo",
                prompt="prompt",
                workspace=str(allocated),
                created_at=now,
                updated_at=now,
                phase="completed",
                artifacts_dir=str(artifacts),
                base_workspace=str(root),
            )

            result = manager.delete_run(run_id)
            self.assertTrue(result["deleted"])
            self.assertTrue(result["workspace_deleted"])
            self.assertFalse(allocated.exists())
            self.assertTrue(root.is_dir())

    def test_delete_running_run_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            manager = RunJobManager(output_dir=Path(tmp))
            now = datetime.now(UTC).isoformat()
            run_id = "ras-running"
            manager._jobs[run_id] = RunJob(
                run_id=run_id,
                status="running",
                platform="opencode",
                agent="build",
                fault="demo",
                prompt="prompt",
                workspace=tmp,
                created_at=now,
                updated_at=now,
                phase="agent_running",
            )
            result = manager.delete_run(run_id)
            self.assertFalse(result["deleted"])
            self.assertEqual(result["reason"], "running")
            self.assertIn(run_id, manager._jobs)

    def test_delete_runs_batch_skips_missing_and_running(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manager = RunJobManager(output_dir=root)
            now = datetime.now(UTC).isoformat()
            done_id = "ras-done"
            running_id = "ras-busy"
            (root / done_id).mkdir()
            (root / done_id / "manifest.json").write_text("{}", encoding="utf-8")
            manager._jobs[done_id] = RunJob(
                run_id=done_id,
                status="failed",
                platform="opencode",
                agent="build",
                fault="demo",
                prompt="prompt",
                workspace=tmp,
                created_at=now,
                updated_at=now,
                phase="failed",
                artifacts_dir=str(root / done_id),
            )
            manager._jobs[running_id] = RunJob(
                run_id=running_id,
                status="running",
                platform="opencode",
                agent="build",
                fault="demo",
                prompt="prompt",
                workspace=tmp,
                created_at=now,
                updated_at=now,
                phase="running",
            )

            results = manager.delete_runs([done_id, running_id, "missing-id", done_id])
            by_id = {item["run_id"]: item for item in results}
            self.assertTrue(by_id[done_id]["deleted"])
            self.assertEqual(by_id[running_id]["reason"], "running")
            self.assertEqual(by_id["missing-id"]["reason"], "not_found")
            self.assertEqual(len(results), 3)


if __name__ == "__main__":
    unittest.main()
