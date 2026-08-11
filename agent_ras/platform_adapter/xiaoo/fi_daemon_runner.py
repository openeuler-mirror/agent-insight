# coding: utf-8
"""RAS-owned xiaoo Daemon FI collector (Insight fi-worker entry).

Holds the Daemon lease so abort → ``runtimes/cancel`` actually stops the stream.
Imports FI libraries only — does **not** edit ``agent_fault_injection/**``.

CLI (compatible with fi-worker argv shape)::

  python -m platform_adapter.xiaoo.fi_daemon_runner run \\
    --platform xiaoo --agent <agent> --fault <fault> --prompt <text> \\
    --workspace <dir> --output-dir <dir> --run-id <id> \\
    [--model ...] [--submode ...] [--timeout-seconds ...]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from agent_fault_injection.fault_inject.catalog.models import FaultDefinition
from agent_fault_injection.pipeline.models import (
    PlatformRunResult,
    RunArtifacts,
    RunRequest,
    RunStatus,
    TerminationReason,
)
from agent_fault_injection.pipeline.runner import ExperimentRunner
from agent_fault_injection.platform_adapters.registry import PlatformAdapterRegistry
from agent_fault_injection.platform_adapters.xiaoo.adapter import XiaoOAdapter
from agent_fault_injection.pipeline.workspace_alloc import (
    WorkspaceAllocationError,
    allocate_run_workspace,
    new_run_id,
)

from platform_adapter.xiaoo.config_sync import load_hello_config_from_ras_config
from platform_adapter.xiaoo.daemon_session import DaemonRasSession
from platform_adapter.xiaoo.observation_enrich import (
    rewrite_collect_after_observation_enrich,
)

logger = logging.getLogger(__name__)


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _wait_http(url: str, *, timeout_seconds: float = 30.0) -> None:
    from platform_adapter.xiaoo.daemon_client import urlopen_noproxy

    deadline = time.time() + timeout_seconds
    last: Exception | None = None
    while time.time() < deadline:
        try:
            with urlopen_noproxy(url, timeout=2.0) as resp:
                if 200 <= int(resp.status) < 500:
                    return
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(0.25)
    raise RuntimeError(f"daemon not ready at {url}: {last}")


def _compose_daemon_prompt(fault: FaultDefinition, user_prompt: str) -> str:
    return (
        f"CRITICAL HARD REQUIREMENT: Your FIRST tool call MUST be the "
        f"`skill` tool with arguments {{\"skill\": \"{fault.skill_name}\"}}. "
        f"Do not call bash, read, write, glob, grep, or any other tool "
        f"before that skill load succeeds. Other tools are blocked until "
        f"then. After the skill loads, follow the skill instructions "
        f"exactly to complete the user task. For thinking-loop skills, "
        f"emit the required repeated text as native assistant/thinking "
        f"stream output — never use bash/echo/python to print the loop.\n\n"
        f"Before anything else, load skill `{fault.skill_name}` via the "
        f"skill tool. Then: {user_prompt}"
    )


def build_daemon_open_kwargs(
    *,
    title: str,
    workspace: str,
    model: Any = None,
) -> dict[str, Any]:
    """Daemon open args for FI runs — never bind Insight/CLI agent to role preset."""

    open_kwargs: dict[str, Any] = {
        "title": title,
        "workspace": workspace,
    }
    if isinstance(model, str) and model.strip():
        open_kwargs["model"] = model.strip()
    return open_kwargs


def _append_event(artifacts: RunArtifacts, *, kind: str, payload: Any) -> None:
    import time as _time

    sequence = 1
    if artifacts.events_file.is_file():
        try:
            with artifacts.events_file.open("r", encoding="utf-8") as stream:
                for line in stream:
                    if line.strip():
                        sequence += 1
        except OSError:
            pass
    row = {
        "kind": kind,
        "ts": int(_time.time() * 1000),
        "sequence": sequence,
        "payload": payload,
    }
    artifacts.events_file.parent.mkdir(parents=True, exist_ok=True)
    with artifacts.events_file.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(row, ensure_ascii=False) + "\n")


class RasOwnedXiaooDaemonAdapter(XiaoOAdapter):
    """FI prepare/overlay + RAS-owned Daemon lease for observe/cancel."""

    async def run_platform_session(
        self,
        ctx,
        environment: dict[str, str],
    ) -> PlatformRunResult:
        request = ctx.request
        fault = ctx.fault
        artifacts = ctx.artifacts
        store = ctx.store

        port = int(request.platform_options.get("daemon_port") or _free_port())
        host = str(request.platform_options.get("daemon_host") or "127.0.0.1")
        base_url = f"http://{host}:{port}"
        external = bool(request.platform_options.get("external_daemon"))
        daemon_bin = (
            str(request.platform_options.get("daemon_executable") or "").strip()
            or shutil.which("xiaoo-daemon")
            or "xiaoo-daemon"
        )

        store.update_manifest(
            artifacts,
            status=RunStatus.PLATFORM_STARTING,
            harness="ras-daemon",
            daemon_url=base_url,
        )

        env = dict(environment)
        # Host HTTPS_PROXY (e.g. 127.0.0.1:10090) often breaks outbound LLM from
        # the daemon child while loopback health must stay direct. Prefer direct
        # egress for the daemon process; local daemon HTTP already uses noproxy.
        for key in (
            "http_proxy",
            "https_proxy",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "all_proxy",
            "ALL_PROXY",
        ):
            env.pop(key, None)
        # Dashboard auto-increments; pin API port explicitly.
        cmd = [
            daemon_bin,
            "--host",
            host,
            "--port",
            str(port),
            "--dashboard-host",
            "127.0.0.1",
            "--dashboard-port",
            str(_free_port()),
        ]
        artifacts.stdout_file.parent.mkdir(parents=True, exist_ok=True)
        proc: subprocess.Popen[bytes] | None = None
        stdout_fh = None
        stderr_fh = None
        session: DaemonRasSession | None = None
        try:
            if not external:
                stdout_fh = artifacts.stdout_file.open("ab", buffering=0)
                stderr_fh = artifacts.stderr_file.open("ab", buffering=0)
                proc = subprocess.Popen(
                    cmd,
                    cwd=str(ctx.workspace),
                    env=env,
                    stdout=stdout_fh,
                    stderr=stderr_fh,
                )
                store.update_manifest(artifacts, platform_pid=proc.pid)
                await asyncio.to_thread(
                    _wait_http,
                    f"{base_url}/api/v1/health",
                    timeout_seconds=float(
                        request.platform_options.get("daemon_startup_timeout", 45)
                    ),
                )
            else:
                await asyncio.to_thread(
                    _wait_http,
                    f"{base_url}/api/v1/health",
                    timeout_seconds=float(
                        request.platform_options.get("daemon_startup_timeout", 45)
                    ),
                )

            hello = load_hello_config_from_ras_config()
            session = DaemonRasSession(
                base_url=base_url,
                client_id=f"agent-ras-fi-{artifacts.run_id}",
                hello_config=hello,
                timeout_seconds=float(request.timeout_seconds),
            )
            open_kwargs = build_daemon_open_kwargs(
                title=artifacts.run_id,
                workspace=str(ctx.workspace),
                model=request.platform_options.get("model"),
            )
            open_resp = await asyncio.to_thread(session.open, **open_kwargs)
            _append_event(
                artifacts,
                kind="xiaoo.daemon",
                payload={"type": "open", "response": open_resp},
            )

            self._mark_ready_and_request_activation(
                artifacts=artifacts,
                fault=fault,
                source="ras-daemon",
                extra_ready={
                    "runtime_id": session.daemon.runtime_id,
                    "daemon_url": base_url,
                },
            )
            store.update_manifest(artifacts, status=RunStatus.PLUGIN_READY)
            store.update_manifest(artifacts, status=RunStatus.AGENT_RUNNING)

            prompt = _compose_daemon_prompt(fault, request.prompt)
            result = await asyncio.to_thread(
                session.run_turn,
                prompt,
                timeout_seconds=float(request.timeout_seconds),
            )
            for event in result.get("events") or []:
                if isinstance(event, dict):
                    _append_event(artifacts, kind="xiaoo.cli", payload=event)
            _append_event(
                artifacts,
                kind="xiaoo.daemon",
                payload={
                    "type": "turn_done",
                    "stopped": bool(result.get("stopped")),
                    "drained": result.get("drained") or [],
                    "error": result.get("error"),
                    "last_observe": result.get("last_observe"),
                },
            )
        except Exception as exc:  # noqa: BLE001
            _append_event(
                artifacts,
                kind="xiaoo.cli",
                payload={"type": "error", "data": {"message": str(exc)}},
            )
            capture = self.mapper.inspect(artifacts.events_file)
            return PlatformRunResult(
                exit_code=1,
                termination_reason=TerminationReason.PLATFORM_ERROR,
                session_id=capture.session_id
                or (session.daemon.runtime_id if session else None),
                fault_activated=capture.fault_activated,
            )
        finally:
            if session is not None:
                try:
                    await asyncio.to_thread(session.close)
                except Exception:  # noqa: BLE001
                    pass
            if proc is not None and proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    proc.kill()
            for fh in (stdout_fh, stderr_fh):
                if fh is not None:
                    try:
                        fh.close()
                    except Exception:  # noqa: BLE001
                        pass

        capture = self.mapper.inspect(artifacts.events_file)
        runtime_id = (
            session.daemon.runtime_id if session is not None else capture.session_id
        )
        if not capture.fault_activated:
            reason = TerminationReason.FAULT_NOT_ACTIVATED
            exit_code = 1
        else:
            reason = TerminationReason.PROCESS_EXITED
            exit_code = 0
        return PlatformRunResult(
            exit_code=exit_code,
            termination_reason=reason,
            session_id=runtime_id,
            fault_activated=capture.fault_activated,
        )


def build_runner() -> ExperimentRunner:
    registry = PlatformAdapterRegistry(load_builtins=True)
    registry.register("xiaoo", RasOwnedXiaooDaemonAdapter)
    return ExperimentRunner(platform_registry=registry)


def _session_id_from_artifacts(artifacts: RunArtifacts) -> str | None:
    """Trace ID written by ExperimentRunner (manifest / interactions)."""

    for path in (artifacts.manifest_file, artifacts.interactions_file):
        if not path.is_file():
            continue
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(doc, dict):
            continue
        for key in ("session_id", "taskId", "task_id"):
            value = doc.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


def _build_request(args: argparse.Namespace) -> RunRequest:
    workspace_base = Path(args.workspace).expanduser().resolve()
    if not workspace_base.is_dir():
        raise SystemExit(f"workspace missing: {workspace_base}")
    run_id = str(args.run_id or "").strip() or new_run_id()
    try:
        workspace = allocate_run_workspace(
            workspace_base,
            "single",
            str(args.fault),
            run_id,
        )
    except WorkspaceAllocationError as exc:
        raise SystemExit(str(exc)) from exc

    platform_options: dict[str, Any] = {"harness": "ras-daemon"}
    if args.model:
        platform_options["model"] = args.model
    if args.daemon_url:
        # External daemon (tests); skip spawn when host/port parsed.
        from urllib.parse import urlparse

        parsed = urlparse(args.daemon_url)
        if parsed.hostname:
            platform_options["daemon_host"] = parsed.hostname
        if parsed.port:
            platform_options["daemon_port"] = parsed.port
        platform_options["external_daemon"] = True

    submode = str(args.submode).strip() if args.submode else None
    return RunRequest(
        platform="xiaoo",
        agent=str(args.agent),
        fault=str(args.fault),
        prompt=str(args.prompt),
        workspace=workspace,
        output_dir=Path(args.output_dir).expanduser().resolve(),
        timeout_seconds=int(args.timeout_seconds or 600),
        platform_options=platform_options,
        submode=submode,
        run_id=run_id,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="fi_daemon_runner")
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="Run one xiaoo FI experiment via RAS Daemon lease")
    run.add_argument("--platform", required=True, choices=["xiaoo"])
    run.add_argument("--agent", required=True)
    run.add_argument("--fault", required=True)
    run.add_argument("--prompt", required=True)
    run.add_argument("--workspace", required=True)
    run.add_argument("--output-dir", required=True)
    run.add_argument("--run-id", default=None)
    run.add_argument("--model", default=None)
    run.add_argument("--submode", default=None)
    run.add_argument("--timeout-seconds", type=int, default=600)
    run.add_argument(
        "--daemon-url",
        default=None,
        help="Optional external daemon base URL (still RAS-owned lease).",
    )
    return parser


async def _async_main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command != "run":
        parser.error(f"unsupported command {args.command}")
    request = _build_request(args)
    runner = build_runner()
    result = await runner.run(request)

    # FI mapper only maps CLI final ``response``; Daemon observation is stream
    # deltas. Enrich interactions from truthful SSE, then rebuild collect-result.
    # Do not fabricate platform events; do not inject RAS anomaly into Judge.
    try:
        from agent_fault_injection.fault_inject.catalog.definition import FaultRegistry

        fault_def = FaultRegistry().get(request.fault)
        injection_method = (
            getattr(fault_def, "injection_method", None) or "skill_inject"
        )
        session_id = _session_id_from_artifacts(result.artifacts)
        # Prefer activation from rewritten collect / events after enrich.
        rewrite_collect_after_observation_enrich(
            result.artifacts,
            framework=request.platform,
            fault=request.fault,
            injection_method=injection_method,
            # Let build_collect_payload derive activation from events.jsonl.
            fault_activated=False,
            session_id=session_id,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("observation enrich / collect rewrite failed: %s", exc)

    collect = result.artifacts.root / "collect-result.json"
    print(
        json.dumps(
            {
                "runId": result.run_id,
                "status": str(result.status),
                "exitCode": result.exit_code,
                "terminationReason": str(result.termination_reason),
                "collectResult": str(collect) if collect.is_file() else None,
            },
            ensure_ascii=False,
        )
    )
    return 0 if result.status.value == "completed" or collect.is_file() else 1


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=os.environ.get("RAS_FI_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    return asyncio.run(_async_main(argv))


if __name__ == "__main__":
    raise SystemExit(main())
