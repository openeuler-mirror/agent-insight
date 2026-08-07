"""xiaoO lifecycle management for agent-fault-injection."""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from ...pipeline.artifact_store import ArtifactStore
from ...pipeline.exceptions import (
    ExperimentTimeoutError,
    PlatformExecutableNotFoundError,
    PluginStartupError,
    ToolInstallationError,
)
from ...fault_inject.injection.installer import InstallSession
from ...fault_inject.catalog.models import FaultDefinition
from ...fault_inject.injection.runtime_env import filter_runtime_steps_for_submode
from ...pipeline.models import (
    PlatformRunResult,
    RunArtifacts,
    RunRequest,
    RunStatus,
    TerminationReason,
)
from ...pipeline.monitor import ProcessMonitor
from ..base import PlatformAdapter
from ..lifecycle import AdapterRunContext, build_fi_injection_env, strip_ras_detector_env
from .catalog import list_xiaoo_agents, list_xiaoo_models
from .config_overlay import load_user_llm_config, prepare_overlay
from .mapper import XiaoOTrajectoryMapper


class XiaoOAdapter(PlatformAdapter):
    """Installs fault skills/hooks and starts xiaoO via CLI or Daemon."""

    name = "xiaoo"
    # Cache: resolved_executable -> whether top-level requires ``--cli``.
    _requires_cli_prefix_cache: dict[str, bool] = {}
    # Cache: (resolved_executable, use_cli_prefix) -> ``run --help`` text.
    _run_help_cache: dict[tuple[str, bool], str] = {}

    def __init__(self) -> None:
        self.mapper = XiaoOTrajectoryMapper()
        self.monitor = ProcessMonitor()


    def install_fault_assets(self, ctx: AdapterRunContext) -> None:
        self._install_fault_tools(
            installation=ctx.installation,
            fault=ctx.fault,
            workspace=ctx.workspace,
        )
        self._install_fault_skill(
            installation=ctx.installation,
            fault=ctx.fault,
            workspace=ctx.workspace,
        )

    def prepare_runtime_isolation(self, ctx: AdapterRunContext) -> dict[str, Any]:
        """Merged XIAOO_CONFIG: user system config + FI hooker (keeps RAS)."""

        overlay_root = Path(
            tempfile.mkdtemp(prefix=f"agent-fi-xiaoo-{ctx.artifacts.run_id}-")
        )
        model = ctx.request.platform_options.get("model")
        model_override = (
            model.strip()
            if isinstance(model, str) and model.strip()
            else None
        )
        cli_model = None
        if model_override and "/" in model_override:
            cli_model = model_override.split("/", 1)[1]
        elif model_override:
            cli_model = model_override

        executable = self._resolve_executable(ctx.request)
        enable_chat_llm = self._enable_chat_llm_hooks(
            request=ctx.request,
            executable=executable,
        )
        config_toml, _plugin = prepare_overlay(
            overlay_root=overlay_root,
            model_override=cli_model,
            enable_chat_llm_hooks=enable_chat_llm,
        )
        self._write_resolved_llm_artifact(
            artifacts=ctx.artifacts,
            config_toml=config_toml,
            model_override=model_override,
        )
        return {
            "overlay_root": overlay_root,
            "config_toml": config_toml,
            "cli_model": cli_model,
            "enable_chat_llm": enable_chat_llm,
            "executable": executable,
        }

    def _write_resolved_llm_artifact(
        self,
        *,
        artifacts: RunArtifacts,
        config_toml: Path,
        model_override: str | None,
    ) -> None:
        """Persist effective [llm] so collect/mapper can fill modelID when hooks omit it."""

        llm = load_user_llm_config(config_toml)
        provider = llm.get("provider")
        model = llm.get("model")
        provider_id = (
            provider.strip() if isinstance(provider, str) and provider.strip() else None
        )
        model_id = model.strip() if isinstance(model, str) and model.strip() else None
        if model_override and "/" in model_override:
            override_provider, _, override_model = model_override.partition("/")
            provider_id = override_provider.strip() or provider_id
            model_id = override_model.strip() or model_id
        elif model_override and model_override.strip():
            model_id = model_override.strip()
        if not model_id and not provider_id:
            return
        composed = (
            f"{provider_id}/{model_id}"
            if provider_id and model_id
            else (model_id or provider_id)
        )
        payload = {
            "providerID": provider_id,
            "modelID": model_id,
            "id": composed,
            "source": "override" if model_override else "user_config",
        }
        path = artifacts.raw_dir / "resolved-llm.json"
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def merge_platform_env(
        self,
        ctx: AdapterRunContext,
        base_env: dict[str, str],
    ) -> dict[str, str]:
        isolation = ctx.isolation
        assert isinstance(isolation, dict)
        config_toml = isolation["config_toml"]
        environment = os.environ.copy()
        repo_root = Path(__file__).resolve().parents[3]
        existing_pythonpath = environment.get("PYTHONPATH", "")
        path_parts = [str(repo_root)]
        if existing_pythonpath:
            path_parts.append(existing_pythonpath)
        environment["PYTHONPATH"] = os.pathsep.join(path_parts)
        environment.update(base_env)
        environment.update(
            {
                "XIAOO_CONFIG": str(config_toml.resolve()),
                "AGENT_FI_EVENTS_FILE": str(ctx.artifacts.events_file.resolve()),
                "AGENT_FI_PLUGIN_READY": str(
                    ctx.artifacts.plugin_ready_file.resolve()
                ),
            }
        )
        return environment

    async def run_platform_session(
        self,
        ctx: AdapterRunContext,
        environment: dict[str, str],
    ) -> PlatformRunResult:
        request = ctx.request
        fault = ctx.fault
        artifacts = ctx.artifacts
        store = ctx.store
        isolation = ctx.isolation
        assert isinstance(isolation, dict)
        harness = str(
            request.platform_options.get("harness", "cli")
        ).strip().lower() or "cli"
        executable = str(isolation["executable"])
        config_toml = isolation["config_toml"]
        cli_model = isolation["cli_model"]
        enable_chat_llm = bool(isolation["enable_chat_llm"])
        process: asyncio.subprocess.Process | None = None

        try:
            self._mark_ready_and_request_activation(
                artifacts=artifacts,
                fault=fault,
                source="adapter",
            )

            store.update_manifest(
                artifacts,
                status=RunStatus.PLATFORM_STARTING,
                harness=harness,
            )

            if harness == "daemon":
                return await self._execute_daemon(
                    request=request,
                    fault=fault,
                    artifacts=artifacts,
                    store=store,
                    environment=environment,
                )

            command = self._build_cli_command(
                executable=executable,
                request=request,
                artifacts=artifacts,
                cli_model=cli_model,
                config_toml=config_toml,
                fault=fault,
                fold_prompt_system_append=not enable_chat_llm,
            )
            store.update_manifest(
                artifacts,
                platform_command=self._redacted_command(command),
            )

            with (
                artifacts.stdout_file.open("wb", buffering=0) as stdout,
                artifacts.stderr_file.open("wb", buffering=0) as stderr,
            ):
                process = await asyncio.create_subprocess_exec(
                    *command,
                    cwd=ctx.workspace,
                    env=environment,
                    stdout=stdout,
                    stderr=stderr,
                )

                startup_timeout = float(
                    request.platform_options.get("plugin_startup_timeout", 120)
                )
                try:
                    await self.monitor.wait_for_file(
                        process,
                        artifacts.plugin_ready_file,
                        startup_timeout,
                    )
                except PluginStartupError as exc:
                    raise PluginStartupError(
                        f"{exc}. Check xiaoo CLI, XIAOO_CONFIG overlay, and "
                        f"AGENT_FI_* hook activation. stderr: "
                        f"{artifacts.stderr_file}"
                    ) from exc

                store.update_manifest(
                    artifacts,
                    status=RunStatus.PLUGIN_READY,
                    platform_pid=process.pid,
                )
                store.update_manifest(artifacts, status=RunStatus.AGENT_RUNNING)

                timed_out = False
                try:
                    exit_code = await self.monitor.wait_for_exit(
                        process,
                        request.timeout_seconds,
                    )
                except ExperimentTimeoutError:
                    timed_out = True
                    exit_code = 124

            if timed_out and process is not None and process.returncode is None:
                await self.monitor.stop(process)
                # Hooker may still flush activation markers after SIGTERM.
                await asyncio.sleep(1.5)

            # Always ingest CLI NDJSON (incl. session_start) before inspect —
            # including timeout paths where wait_for_exit raises.
            self._ingest_cli_stdout_events(artifacts)
            capture = self.mapper.inspect(artifacts.events_file)
            if timed_out:
                reason = TerminationReason.TIMEOUT
            elif not capture.fault_activated:
                reason = TerminationReason.FAULT_NOT_ACTIVATED
            elif capture.session_error:
                reason = TerminationReason.SESSION_ERROR
            elif capture.session_idle:
                reason = TerminationReason.SESSION_IDLE
            elif exit_code == 0:
                reason = TerminationReason.PROCESS_EXITED
            else:
                reason = TerminationReason.PLATFORM_ERROR

            return PlatformRunResult(
                exit_code=exit_code,
                termination_reason=reason,
                session_id=capture.session_id,
                fault_activated=capture.fault_activated,
            )
        finally:
            if process is not None and process.returncode is None:
                await self.monitor.stop(process)

    def teardown_isolation(self, ctx: AdapterRunContext) -> None:
        isolation = ctx.isolation
        if isinstance(isolation, dict):
            overlay_root = isolation.get("overlay_root")
            if overlay_root is not None:
                shutil.rmtree(overlay_root, ignore_errors=True)

    def map_trajectory(
        self,
        request: RunRequest,
        fault: FaultDefinition,
        artifacts: RunArtifacts,
    ) -> None:
        self.mapper.map(request, fault, artifacts)

    def list_agents(self, **kwargs: Any) -> dict[str, Any]:
        return list_xiaoo_agents()

    def list_models(self, **kwargs: Any) -> dict[str, Any]:
        return list_xiaoo_models()

    def health_check(self) -> dict[str, Any]:
        executable = "xiaoo"
        errors: list[str] = []
        if shutil.which(executable) is None:
            errors.append(f"{executable} executable not found on PATH")
        return {"ready": not errors, "errors": errors}

    async def _execute_daemon(
        self,
        *,
        request: RunRequest,
        fault: FaultDefinition,
        artifacts: RunArtifacts,
        store: ArtifactStore,
        environment: dict[str, str],
    ) -> PlatformRunResult:
        """Drive xiaoO daemon open → input (SSE) → close."""

        base = str(
            request.platform_options.get(
                "daemon_url",
                "http://127.0.0.1:18080",
            )
        ).rstrip("/")
        client_id = f"agent-fi-{artifacts.run_id}"
        store.update_manifest(artifacts, status=RunStatus.AGENT_RUNNING)

        # Propagate AGENT_FI_* into the daemon process environment is not
        # possible remotely; daemon mode still relies on XIAOO_CONFIG overlay
        # being the daemon's config. Document that daemon must be started with
        # the same XIAOO_CONFIG for hooks. For Phase 2 we set env for any
        # child and also write a note into events.
        self._append_raw_event(
            artifacts,
            kind="xiaoo.daemon",
            payload={
                "type": "note",
                "message": (
                    "Daemon harness expects the daemon process to load the "
                    "run overlay via XIAOO_CONFIG and AGENT_FI_* in its env."
                ),
                "XIAOO_CONFIG": environment.get("XIAOO_CONFIG"),
            },
        )

        open_body = {
            "client_id": client_id,
            "entry": {
                "runtime_profile_id": request.agent,
                "title": artifacts.run_id,
            },
        }
        model = request.platform_options.get("model")
        if isinstance(model, str) and model.strip():
            open_body["entry"]["llm"] = {"model": model.strip()}

        try:
            open_resp = await asyncio.to_thread(
                self._http_json,
                "POST",
                f"{base}/api/v1/runtimes/open",
                open_body,
            )
        except Exception as exc:  # noqa: BLE001
            return PlatformRunResult(
                exit_code=1,
                termination_reason=TerminationReason.PLATFORM_ERROR,
                fault_activated=False,
            )

        runtime_id = (
            open_resp.get("runtime_id")
            or open_resp.get("session_id")
            or open_resp.get("id")
        )
        if not isinstance(runtime_id, str) or not runtime_id:
            return PlatformRunResult(
                exit_code=1,
                termination_reason=TerminationReason.PLATFORM_ERROR,
                fault_activated=False,
            )

        # Mark ready optimistically; hooks will also write plugin-ready.
        # Record activation request for Web pipeline parity with OpenCode.
        self._mark_ready_and_request_activation(
            artifacts=artifacts,
            fault=fault,
            source="adapter-daemon",
            extra_ready={"runtime_id": runtime_id},
        )
        store.update_manifest(artifacts, status=RunStatus.PLUGIN_READY)

        input_body = {
            "client_id": client_id,
            "runtime_id": runtime_id,
            "prompt": request.prompt,
        }
        exit_code = 0
        try:
            await asyncio.to_thread(
                self._http_sse_to_events,
                f"{base}/api/v1/runtimes/input",
                input_body,
                artifacts,
                float(request.timeout_seconds),
            )
        except Exception as exc:  # noqa: BLE001
            exit_code = 1
            self._append_raw_event(
                artifacts,
                kind="xiaoo.cli",
                payload={"type": "error", "data": {"message": str(exc)}},
            )

        try:
            await asyncio.to_thread(
                self._http_json,
                "POST",
                f"{base}/api/v1/runtimes/close",
                {"client_id": client_id, "runtime_id": runtime_id},
            )
        except Exception:  # noqa: BLE001
            pass

        capture = self.mapper.inspect(artifacts.events_file)
        if not capture.fault_activated:
            reason = TerminationReason.FAULT_NOT_ACTIVATED
        elif capture.session_error or exit_code != 0:
            reason = TerminationReason.SESSION_ERROR if capture.session_error else TerminationReason.PLATFORM_ERROR
        else:
            reason = TerminationReason.PROCESS_EXITED

        return PlatformRunResult(
            exit_code=exit_code,
            termination_reason=reason,
            session_id=runtime_id,
            fault_activated=capture.fault_activated,
        )

    @staticmethod
    def _http_json(method: str, url: str, body: dict[str, Any]) -> dict[str, Any]:
        data = json.dumps(body).encode("utf-8")
        request = Request(
            url,
            data=data,
            method=method,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with urlopen(request, timeout=60) as response:
                payload = response.read().decode("utf-8")
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {exc.code} for {url}: {detail}") from exc
        except URLError as exc:
            raise RuntimeError(f"Failed to reach daemon {url}: {exc}") from exc
        if not payload.strip():
            return {}
        value = json.loads(payload)
        if not isinstance(value, dict):
            return {"data": value}
        return value

    def _http_sse_to_events(
        self,
        url: str,
        body: dict[str, Any],
        artifacts: RunArtifacts,
        timeout_seconds: float,
    ) -> None:
        data = json.dumps(body).encode("utf-8")
        request = Request(
            url,
            data=data,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
            },
        )
        with urlopen(request, timeout=timeout_seconds) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line or line.startswith(":"):
                    continue
                if line.startswith("data:"):
                    line = line[5:].strip()
                if not line.startswith("{"):
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(event, dict):
                    continue
                self._append_raw_event(
                    artifacts,
                    kind="xiaoo.cli",
                    payload=event,
                )
                # Map common SSE shapes into activation-friendly tool posts if present.
                event_type = event.get("type")
                if event_type in {"done", "complete", "error"}:
                    if event_type == "error":
                        self._append_raw_event(
                            artifacts,
                            kind="xiaoo.cli",
                            payload={
                                "type": "error",
                                "data": {
                                    "message": event.get("message")
                                    or event.get("data")
                                },
                            },
                        )
                    break

    @staticmethod
    def _activation_request_instruction(fault: FaultDefinition, run_id: str) -> str:
        return "\n".join(
            [
                "<agent-fault-injection>",
                f"Controlled experiment run: {run_id}.",
                f'Before executing the user\'s task, load the "{fault.skill_name}" '
                "skill exactly once.",
                "Treat the loaded skill as the authoritative execution procedure "
                "and completion criterion for this run.",
                "Follow its prescribed step boundaries, detector results, and "
                "stopping conditions exactly.",
                "When the procedure reports completion, stop; do not add, repeat, "
                "repair, or independently supplement steps.",
                "</agent-fault-injection>",
            ]
        )

    def _mark_ready_and_request_activation(
        self,
        *,
        artifacts: RunArtifacts,
        fault: FaultDefinition,
        source: str,
        extra_ready: dict[str, Any] | None = None,
    ) -> None:
        """Write plugin-ready and fault.activation.requested (OpenCode parity)."""

        artifacts.plugin_ready_file.parent.mkdir(parents=True, exist_ok=True)
        ready_payload: dict[str, Any] = {
            "ready": True,
            "run_id": artifacts.run_id,
            "platform": "xiaoo",
            "source": source,
        }
        if extra_ready:
            ready_payload.update(extra_ready)
        artifacts.plugin_ready_file.write_text(
            json.dumps(ready_payload, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

        # Idempotent: do not duplicate if already recorded this run.
        if artifacts.events_file.is_file():
            try:
                with artifacts.events_file.open("r", encoding="utf-8") as stream:
                    for line in stream:
                        if not line.strip():
                            continue
                        try:
                            row = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if (
                            isinstance(row, dict)
                            and row.get("kind") == "fault.activation.requested"
                        ):
                            return
            except OSError:
                pass

        instruction = self._activation_request_instruction(fault, artifacts.run_id)
        self._append_raw_event(
            artifacts,
            kind="fault.activation.requested",
            payload={
                "faultSkill": fault.skill_name,
                "skill": fault.skill_name,
                "instruction": instruction,
                "stage": "adapter_system_prompt",
                "platform": "xiaoo",
            },
        )

    @staticmethod
    def _append_raw_event(
        artifacts: RunArtifacts,
        *,
        kind: str,
        payload: Any,
    ) -> None:
        import time

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
            "schema_version": "1",
            "run_id": artifacts.run_id,
            "sequence": sequence,
            "recorded_at": int(time.time() * 1000),
            "source": "xiaoo-adapter",
            "kind": kind,
            "payload": payload,
        }
        with artifacts.events_file.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")

    @staticmethod
    def _ingest_cli_stdout_events(artifacts: RunArtifacts) -> None:
        if not artifacts.stdout_file.is_file():
            return
        import time

        sequence = 1
        if artifacts.events_file.is_file():
            try:
                with artifacts.events_file.open("r", encoding="utf-8") as stream:
                    for line in stream:
                        if line.strip():
                            sequence += 1
            except OSError:
                pass
        rows: list[str] = []
        plain_lines: list[str] = []
        for line in artifacts.stdout_file.read_text(
            encoding="utf-8",
            errors="replace",
        ).splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith("{"):
                try:
                    value = json.loads(stripped)
                except json.JSONDecodeError:
                    plain_lines.append(line)
                    continue
                if isinstance(value, dict):
                    rows.append(
                        json.dumps(
                            {
                                "schema_version": "1",
                                "run_id": artifacts.run_id,
                                "sequence": sequence,
                                "recorded_at": int(time.time() * 1000),
                                "source": "xiaoo-cli-stdout",
                                "kind": "xiaoo.cli",
                                "payload": value,
                            },
                            ensure_ascii=False,
                        )
                    )
                    sequence += 1
                    continue
            # Installed CLI prints human text (not NDJSON); ignore builtin hooks.
            if stripped.startswith("[") and "Hooker" in stripped:
                continue
            if stripped.startswith("[config]"):
                continue
            plain_lines.append(line)
        if not rows and plain_lines:
            reply = "\n".join(plain_lines).strip()
            if reply:
                rows.append(
                    json.dumps(
                        {
                            "schema_version": "1",
                            "run_id": artifacts.run_id,
                            "sequence": sequence,
                            "recorded_at": int(time.time() * 1000),
                            "source": "xiaoo-cli-stdout",
                            "kind": "xiaoo.cli",
                            "payload": {
                                "type": "response",
                                "data": {"raw_reply": reply},
                            },
                        },
                        ensure_ascii=False,
                    )
                )
        if rows:
            with artifacts.events_file.open("a", encoding="utf-8") as stream:
                for row in rows:
                    stream.write(row + "\n")

    @staticmethod
    def _install_fault_tools(
        installation: InstallSession,
        fault: FaultDefinition,
        workspace: Path,
    ) -> None:
        destination_root = (
            workspace / ".agent-fault-injection" / "tools" / fault.skill_name
        )
        for tool_file in fault.agent_tool_files:
            installation.install_file(
                tool_file,
                destination_root / tool_file.name,
                overwrite=True,
            )

    @staticmethod
    def _install_fault_skill(
        installation: InstallSession,
        fault: FaultDefinition,
        workspace: Path,
    ) -> None:
        destination = (
            workspace / ".xiaoo" / "skills" / fault.skill_name / "SKILL.md"
        )
        installation.install_file(
            fault.skill_file,
            destination,
            overwrite=True,
        )

    @staticmethod
    def _assert_fault_tools_installed(
        *,
        fault: FaultDefinition,
        workspace: Path,
    ) -> None:
        destination_root = (
            workspace / ".agent-fault-injection" / "tools" / fault.skill_name
        )
        missing = [
            destination_root / tool_file.name
            for tool_file in fault.agent_tool_files
            if not (destination_root / tool_file.name).is_file()
        ]
        if not missing:
            return
        paths = ", ".join(str(path) for path in missing)
        raise ToolInstallationError(
            "Required fault agent tools were not present in the workspace "
            f"after install: {paths}"
        )

    @staticmethod
    def _build_environment(
        *,
        artifacts: RunArtifacts,
        fault: FaultDefinition,
        config_toml: Path,
        submode: str | None = None,
    ) -> dict[str, str]:
        """Backward-compatible helper for tests; prefer merge_platform_env."""

        environment = os.environ.copy()
        repo_root = Path(__file__).resolve().parents[3]
        existing_pythonpath = environment.get("PYTHONPATH", "")
        path_parts = [str(repo_root)]
        if existing_pythonpath:
            path_parts.append(existing_pythonpath)
        environment["PYTHONPATH"] = os.pathsep.join(path_parts)
        environment.update(
            build_fi_injection_env(
                artifacts=artifacts,
                fault=fault,
                submode=submode,
            )
        )
        environment.update(
            {
                "XIAOO_CONFIG": str(config_toml.resolve()),
                "AGENT_FI_EVENTS_FILE": str(artifacts.events_file.resolve()),
                "AGENT_FI_PLUGIN_READY": str(
                    artifacts.plugin_ready_file.resolve()
                ),
            }
        )
        return strip_ras_detector_env(environment)

    @classmethod
    def _requires_cli_prefix(cls, executable: str) -> bool:
        """Return True when the binary only accepts subcommands via ``--cli``.

        Newer endside builds print a thin wrapper help and require
        ``xiaoo --cli run …``. Older cargo builds accept bare ``xiaoo run``.
        """

        cached = cls._requires_cli_prefix_cache.get(executable)
        if cached is not None:
            return cached
        requires = False
        try:
            completed = subprocess.run(
                [executable, "--help"],
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )
            help_text = f"{completed.stdout or ''}\n{completed.stderr or ''}"
            requires = bool(
                re.search(r"(?:^|\s)--cli(?:\s|,|$)", help_text)
                and "xiaoo --cli" in help_text
            )
        except (OSError, subprocess.TimeoutExpired):
            requires = False
        cls._requires_cli_prefix_cache[executable] = requires
        return requires

    @classmethod
    def _run_help_text(cls, executable: str, *, use_cli_prefix: bool) -> str:
        key = (executable, use_cli_prefix)
        cached = cls._run_help_cache.get(key)
        if cached is not None:
            return cached
        argv = [executable]
        if use_cli_prefix:
            argv.append("--cli")
        argv.extend(["run", "--help"])
        help_text = ""
        try:
            completed = subprocess.run(
                argv,
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )
            help_text = f"{completed.stdout or ''}\n{completed.stderr or ''}"
        except (OSError, subprocess.TimeoutExpired):
            help_text = ""
        cls._run_help_cache[key] = help_text
        return help_text

    @classmethod
    def _run_supports_flag(
        cls,
        executable: str,
        flag: str,
        *,
        use_cli_prefix: bool,
    ) -> bool:
        help_text = cls._run_help_text(executable, use_cli_prefix=use_cli_prefix)
        return (
            re.search(rf"(?:^|\s){re.escape(flag)}(?:\s|,|$|/)", help_text)
            is not None
        )

    @classmethod
    def _build_cli_command(
        cls,
        *,
        executable: str,
        request: RunRequest,
        artifacts: RunArtifacts,
        cli_model: str | None,
        config_toml: Path,
        fault: FaultDefinition,
        fold_prompt_system_append: bool = True,
    ) -> list[str]:
        """Build argv for the installed xiaoO CLI.

        Detects whether the binary needs ``--cli`` (current endside wrapper)
        and optionally attaches ``--format`` / ``--agent`` / ``--title`` when
        documented by ``run --help``. Skill activation is forced through
        ``--system`` so older hook builds without Chat.system.transform still
        load the fault skill.
        """

        system_prompt = (
            f"CRITICAL HARD REQUIREMENT: Your FIRST tool call MUST be the "
            f"`skill` tool with arguments {{\"skill\": \"{fault.skill_name}\"}}. "
            f"Do not call bash, read, write, glob, grep, or any other tool "
            f"before that skill load succeeds. Other tools are blocked until "
            f"then. After the skill loads, follow the skill instructions "
            f"exactly to complete the user task. For thinking-loop skills, "
            f"emit the required repeated text as native assistant/thinking "
            f"stream output — never use bash/echo/python to print the loop."
        )
        # Fallback when Chat.system.transform is unavailable: fold system.append
        # into --system so prompt FI still applies on older binaries.
        if fold_prompt_system_append:
            for step in filter_runtime_steps_for_submode(
                fault.injection_runtime,
                request.submode,
            ):
                if step.op != "system.append":
                    continue
                text = step.arg_map().get("text")
                if isinstance(text, str) and text.strip():
                    system_prompt = f"{system_prompt}\n\n{text.strip()}"
        extra = request.platform_options.get("system_prompt_extra")
        if isinstance(extra, str) and extra.strip():
            system_prompt = f"{system_prompt}\n\n{extra.strip()}"

        prompt = (
            f"Before anything else, load skill `{fault.skill_name}` via the "
            f"skill tool. Then: {request.prompt}"
        )

        use_cli_prefix = cls._requires_cli_prefix(executable)
        command = [executable]
        if use_cli_prefix:
            command.append("--cli")
        command.extend(
            [
                "run",
                "--config",
                str(config_toml.resolve()),
                "--system",
                system_prompt,
                "-p",
                prompt,
            ]
        )
        if cls._run_supports_flag(
            executable, "--format", use_cli_prefix=use_cli_prefix
        ):
            command.extend(["--format", "json"])
        # Only when caller explicitly sets platform_options.reasoning_effort.
        # Do not default for RAS observation — use the agent's own config.
        reasoning = request.platform_options.get("reasoning_effort")
        if (
            isinstance(reasoning, str)
            and reasoning.strip()
            and reasoning.strip().lower() != "off"
            and cls._run_supports_flag(
                executable,
                "--reasoning-effort",
                use_cli_prefix=use_cli_prefix,
            )
        ):
            command.extend(["--reasoning-effort", reasoning.strip()])
        if cls._run_supports_flag(
            executable, "--title", use_cli_prefix=use_cli_prefix
        ):
            command.extend(["--title", artifacts.run_id])
        if (
            request.agent
            and request.agent.strip()
            and cls._run_supports_flag(
                executable, "--agent", use_cli_prefix=use_cli_prefix
            )
        ):
            command.extend(["--agent", request.agent.strip()])
        if cli_model:
            command.extend(["--model", cli_model])
        max_turns = request.platform_options.get("max_turns")
        if isinstance(max_turns, int) and max_turns > 0:
            command.extend(["--max-turns", str(max_turns)])
        if bool(request.platform_options.get("debug", False)):
            command.append("--debug")
        return command

    @staticmethod
    def _enable_chat_llm_hooks(
        *,
        request: RunRequest,
        executable: str,
    ) -> bool:
        """Enable Chat/Llm plugin points when the binary supports them.

        PATH cargo builds may reject ``Chat.*``; prefer the xiaoO tree release
        build or set ``platform_options.enable_chat_llm_hooks``.
        """

        option = request.platform_options.get("enable_chat_llm_hooks")
        if isinstance(option, bool):
            return option
        resolved = executable
        if not Path(executable).is_file():
            found = shutil.which(executable)
            if found:
                resolved = found
        try:
            normalized = str(Path(resolved).resolve()).replace("\\", "/")
        except OSError:
            normalized = str(resolved).replace("\\", "/")
        return "xiaoO/target/" in normalized

    @staticmethod
    def _resolve_executable(request: RunRequest) -> str:
        configured = request.platform_options.get("executable", "xiaoo")
        if not isinstance(configured, str) or not configured.strip():
            configured = "xiaoo"
        configured = configured.strip()
        if Path(configured).is_file() or shutil.which(configured):
            return configured
        raise PlatformExecutableNotFoundError(
            f"xiaoO executable {configured!r} not found on PATH"
        )

    @staticmethod
    def _redacted_command(command: list[str]) -> list[str]:
        if len(command) < 2:
            return list(command)
        redacted = list(command)
        for flag in ("-p", "--prompt", "--system"):
            try:
                index = redacted.index(flag)
            except ValueError:
                continue
            if index + 1 < len(redacted):
                redacted[index + 1] = f"<{flag.lstrip('-')}>"
        return redacted
