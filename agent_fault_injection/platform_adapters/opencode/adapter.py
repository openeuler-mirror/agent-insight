"""OpenCode lifecycle management for agent-fault-injection."""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

from ...pipeline.exceptions import (
    ExperimentTimeoutError,
    PlatformConnectionError,
    PlatformExecutableNotFoundError,
    PluginStartupError,
)
from ...fault_inject.injection.installer import InstallSession
from ...fault_inject.catalog.models import FaultDefinition
from ...pipeline.models import (
    PlatformRunResult,
    RunArtifacts,
    RunRequest,
    RunStatus,
    TerminationReason,
)
from ...pipeline.monitor import ProcessMonitor
from ..base import PlatformAdapter
from ..lifecycle import AdapterRunContext, strip_ras_detector_env
from .mapper import OpenCodeTrajectoryMapper


class OpenCodeAdapter(PlatformAdapter):
    """Installs the experiment extension and starts OpenCode internally."""

    name = "opencode"
    # Cache: (resolved_executable, flag) -> documented by `opencode run --help`.
    _run_flag_support_cache: dict[tuple[str, str], bool] = {}

    def __init__(self) -> None:
        self.mapper = OpenCodeTrajectoryMapper()
        self.monitor = ProcessMonitor()

    def install_fault_assets(self, ctx: AdapterRunContext) -> None:
        plugin_source = (
            Path(__file__).resolve().parent / "plugin" / "agent-fault-injection.ts"
        )
        if not plugin_source.is_file():
            raise PluginStartupError(
                f"Bundled OpenCode plugin is missing: {plugin_source}"
            )
        executable = self._resolve_executable(ctx.request)
        ctx.request.platform_options["_resolved_executable"] = executable
        self._install_workspace_plugin_and_skill(
            installation=ctx.installation,
            workspace=ctx.workspace,
            fault=ctx.fault,
            plugin_source=plugin_source,
        )
        self._install_fault_tools(
            installation=ctx.installation,
            fault=ctx.fault,
            workspace=ctx.workspace,
        )

    def merge_platform_env(
        self,
        ctx: AdapterRunContext,
        base_env: dict[str, str],
    ) -> dict[str, str]:
        # Real system env (HOME/config/user plugins including RAS).
        # Only overlay AGENT_FI_* from base_env.
        return self.build_runtime_env(fi_injection=base_env)

    async def run_platform_session(
        self,
        ctx: AdapterRunContext,
        environment: dict[str, str],
    ) -> PlatformRunResult:
        request = ctx.request
        artifacts = ctx.artifacts
        store = ctx.store
        workspace = ctx.workspace
        executable = str(
            request.platform_options.get("_resolved_executable")
            or self._resolve_executable(request)
        )
        process: asyncio.subprocess.Process | None = None
        try:
            command = self._build_command(
                executable=executable,
                request=request,
                artifacts=artifacts,
            )
            store.update_manifest(
                artifacts,
                status=RunStatus.PLATFORM_STARTING,
                platform_command=self._redacted_command(command),
            )

            startup_timeout = float(
                request.platform_options.get("plugin_startup_timeout", 120)
            )
            lock_retries = max(
                0, int(request.platform_options.get("database_lock_retries", 3))
            )
            attempt = 0
            exit_code = 1
            timed_out = False
            while True:
                attempt += 1
                with (
                    artifacts.stdout_file.open(
                        "wb" if attempt == 1 else "ab", buffering=0
                    ) as stdout,
                    artifacts.stderr_file.open(
                        "wb" if attempt == 1 else "ab", buffering=0
                    ) as stderr,
                ):
                    if attempt > 1:
                        stderr.write(
                            f"\n--- retry {attempt} after database is locked ---\n".encode()
                        )
                    process = await asyncio.create_subprocess_exec(
                        *command,
                        cwd=workspace,
                        env=environment,
                        stdout=stdout,
                        stderr=stderr,
                    )

                    try:
                        await self.monitor.wait_for_file(
                            process,
                            artifacts.plugin_ready_file,
                            startup_timeout,
                        )
                    except PluginStartupError as exc:
                        exit_before_stop = process.returncode
                        plugin_path = (
                            workspace
                            / ".opencode"
                            / "plugins"
                            / "agent-fault-injection.ts"
                        )
                        plugin_installed = plugin_path.is_file()
                        await self.monitor.stop(process)
                        stopped_code = process.returncode
                        process = None
                        message = self._startup_failure_message(
                            exc=exc,
                            artifacts=artifacts,
                            startup_timeout=startup_timeout,
                            process_exit_code=exit_before_stop
                            if exit_before_stop is not None
                            else stopped_code,
                            plugin_installed=plugin_installed,
                            agent_fi_raw_dir=environment.get("AGENT_FI_RAW_DIR"),
                            agent_fi_run_id=environment.get("AGENT_FI_RUN_ID"),
                        )
                        if (
                            attempt <= lock_retries
                            and self._is_database_locked_failure(message, artifacts)
                        ):
                            await asyncio.sleep(min(2.0, 0.4 * attempt))
                            continue
                        raise PluginStartupError(message) from exc

                    store.update_manifest(
                        artifacts,
                        status=RunStatus.PLUGIN_READY,
                        platform_pid=process.pid,
                    )
                    store.update_manifest(artifacts, status=RunStatus.AGENT_RUNNING)

                    retry_limit = int(
                        request.platform_options.get("provider_retry_limit", 1)
                    )

                    def provider_health_check() -> None:
                        failure = self._provider_retry_failure(
                            artifacts.events_file,
                            retry_limit=retry_limit,
                        )
                        if failure is not None:
                            raise PlatformConnectionError(failure)

                    try:
                        exit_code = await self.monitor.wait_for_exit(
                            process,
                            request.timeout_seconds,
                            health_check=(
                                provider_health_check
                                if retry_limit > 0
                                else None
                            ),
                        )
                    except ExperimentTimeoutError:
                        exit_code = 124
                        timed_out = True
                    break

            if timed_out and process is not None and process.returncode is None:
                await self.monitor.stop(process)
                await asyncio.sleep(1.5)

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

    @staticmethod
    def _is_database_locked_failure(
        message: str,
        artifacts: RunArtifacts,
    ) -> bool:
        haystacks = [message.lower()]
        for path in (artifacts.stderr_file, artifacts.raw_dir / "opencode.log"):
            try:
                haystacks.append(
                    path.read_text(encoding="utf-8", errors="replace").lower()
                )
            except OSError:
                continue
        return any("database is locked" in text for text in haystacks)

    def map_trajectory(
        self,
        request: RunRequest,
        fault: FaultDefinition,
        artifacts: RunArtifacts,
    ) -> None:
        self.mapper.map(request, fault, artifacts)

    @staticmethod
    def build_runtime_env(*, fi_injection: dict[str, str] | None = None) -> dict[str, str]:
        """Real system environment, optionally overlaying AGENT_FI_* keys."""

        environment = os.environ.copy()
        if fi_injection:
            environment.update(fi_injection)
        return strip_ras_detector_env(environment)

    @staticmethod
    def strip_fi_injection_env(environment: dict[str, str]) -> dict[str, str]:
        """Copy env without AGENT_FI_* so the eval plugin is not activated."""

        return {
            key: value
            for key, value in environment.items()
            if not key.startswith("AGENT_FI_")
        }

    @staticmethod
    def _install_fault_tools(
        installation: InstallSession,
        fault: FaultDefinition,
        workspace: Path,
    ) -> None:
        destination_root = (
            workspace
            / ".agent-fault-injection"
            / "tools"
            / fault.skill_name
        )
        for tool_file in fault.agent_tool_files:
            installation.install_file(
                tool_file,
                destination_root / tool_file.name,
                overwrite=True,
            )

    @classmethod
    def _install_workspace_plugin_and_skill(
        cls,
        *,
        installation: InstallSession,
        workspace: Path,
        fault: FaultDefinition,
        plugin_source: Path,
    ) -> None:
        """Install FI plugin + Skill under workspace `.opencode/` (system OpenCode)."""

        plugin_dest = workspace / ".opencode" / "plugins" / "agent-fault-injection.ts"
        skill_dest = (
            workspace / ".opencode" / "skills" / fault.skill_name / "SKILL.md"
        )
        lib_dest = workspace / ".opencode" / "lib" / "rewrite-runtime.ts"
        installation.install_file(plugin_source, plugin_dest, overwrite=True)
        installation.install_file(fault.skill_file, skill_dest, overwrite=True)

        rewrite_runtime = (
            Path(__file__).resolve().parent / "lib" / "rewrite-runtime.ts"
        )
        if not rewrite_runtime.is_file():
            candidate = plugin_source.parent / "rewrite-runtime.ts"
            if candidate.is_file():
                rewrite_runtime = candidate
            else:
                sibling_lib = plugin_source.parent.parent / "lib" / "rewrite-runtime.ts"
                if sibling_lib.is_file():
                    rewrite_runtime = sibling_lib
        if rewrite_runtime.is_file():
            installation.install_file(rewrite_runtime, lib_dest, overwrite=True)

    @staticmethod
    def _provider_retry_failure(
        events_file: Path,
        *,
        retry_limit: int,
    ) -> str | None:
        if retry_limit <= 0 or not events_file.is_file():
            return None

        highest_attempt = 0
        latest_message = ""
        try:
            lines = events_file.read_text(
                encoding="utf-8",
                errors="replace",
            ).splitlines()
        except OSError:
            return None

        for line in lines:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("kind") != "opencode.event":
                continue
            payload = event.get("payload")
            if not isinstance(payload, dict) or payload.get("type") != "session.status":
                continue
            properties = payload.get("properties")
            if not isinstance(properties, dict):
                continue
            status = properties.get("status")
            if not isinstance(status, dict) or status.get("type") != "retry":
                continue
            attempt = status.get("attempt")
            if not isinstance(attempt, int) or attempt < highest_attempt:
                continue
            highest_attempt = attempt
            message = status.get("message")
            latest_message = str(message) if message is not None else ""

        if highest_attempt < retry_limit:
            return None
        detail = f": {latest_message}" if latest_message else ""
        return (
            f"OpenCode model provider remained unavailable after retry "
            f"attempt {highest_attempt}{detail}"
        )

    @classmethod
    def _load_user_opencode_config(cls) -> dict[str, Any] | None:
        """Load ~/.config/opencode config (jsonc preferred over json)."""

        config_home = Path.home() / ".config" / "opencode"
        candidates = (
            config_home / "opencode.jsonc",
            config_home / "opencode.json",
            config_home / "config.json",
        )
        for path in candidates:
            if not path.is_file():
                continue
            try:
                text = path.read_text(encoding="utf-8")
                data = cls._parse_jsonc(text)
            except (OSError, UnicodeError, json.JSONDecodeError, ValueError):
                continue
            if isinstance(data, dict):
                return data
        return None

    @staticmethod
    def _parse_jsonc(text: str) -> Any:
        """Parse JSON with // and /* */ comments and trailing commas."""

        stripped = OpenCodeAdapter._strip_jsonc_comments(text)
        stripped = re.sub(r",\s*([}\]])", r"\1", stripped)
        return json.loads(stripped)

    @staticmethod
    def _strip_jsonc_comments(text: str) -> str:
        result: list[str] = []
        i = 0
        n = len(text)
        in_string = False
        escape = False
        while i < n:
            ch = text[i]
            if in_string:
                result.append(ch)
                if escape:
                    escape = False
                elif ch == "\\":
                    escape = True
                elif ch == '"':
                    in_string = False
                i += 1
                continue
            if ch == '"':
                in_string = True
                result.append(ch)
                i += 1
                continue
            if ch == "/" and i + 1 < n:
                nxt = text[i + 1]
                if nxt == "/":
                    i += 2
                    while i < n and text[i] not in "\r\n":
                        i += 1
                    continue
                if nxt == "*":
                    i += 2
                    while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                        i += 1
                    i = min(i + 2, n)
                    continue
            result.append(ch)
            i += 1
        return "".join(result)

    @staticmethod
    def _startup_failure_message(
        *,
        exc: PluginStartupError,
        artifacts: RunArtifacts,
        startup_timeout: float,
        process_exit_code: int | None = None,
        plugin_installed: bool | None = None,
        agent_fi_raw_dir: str | None = None,
        agent_fi_run_id: str | None = None,
    ) -> str:
        extras: list[str] = []
        ready = artifacts.plugin_ready_file
        extras.append(
            "plugin-ready="
            + ("present" if ready.is_file() else f"missing({ready})")
        )
        if plugin_installed is not None:
            extras.append(
                "workspace-plugin="
                + ("installed" if plugin_installed else "missing")
            )
        if agent_fi_run_id is not None or agent_fi_raw_dir is not None:
            extras.append(
                "AGENT_FI="
                + (
                    "set"
                    if agent_fi_run_id and agent_fi_raw_dir
                    else "incomplete"
                )
            )
        if process_exit_code is not None:
            extras.append(f"process-exit={process_exit_code}")
        else:
            extras.append("process-exit=still-running-at-timeout")

        for label, path in (
            ("stderr", artifacts.stderr_file),
            ("stdout", artifacts.stdout_file),
            ("opencode.log", artifacts.raw_dir / "opencode.log"),
        ):
            try:
                size = path.stat().st_size if path.is_file() else 0
            except OSError:
                extras.append(f"{label}: unreadable")
                continue
            if size <= 0:
                extras.append(f"{label}: empty(0B)")
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                extras.append(f"{label}: unreadable({size}B)")
                continue
            lines = [line for line in text.splitlines() if line.strip()]
            if not lines:
                extras.append(f"{label}: blank({size}B)")
                continue
            interesting = [
                line
                for line in lines[-20:]
                if any(
                    token in line.lower()
                    for token in (
                        "error",
                        "warn",
                        "fail",
                        "plugin",
                        "timeout",
                        "auth",
                        "token",
                        "401",
                        "database is locked",
                        "locked",
                    )
                )
            ] or lines[-5:]
            extras.append(f"{label}: " + " · ".join(interesting[-6:]))

        detail = (" | " + " | ".join(extras)) if extras else ""
        hints = (
            "检查：1) `opencode run` 是否可用且 provider token 有效；"
            "2) 系统 OpenCode 配置（~/.config/opencode，含 jsonc）是否正确；"
            "3) workspace `.opencode/plugins/agent-fault-injection.ts` 与 AGENT_FI_*；"
            "4) artifacts/<run>/raw/stderr.log（空日志多为进程挂起未加载插件）；"
            f"5) 可调大 plugin_startup_timeout（当前 {startup_timeout:g}s）。"
        )
        return f"{exc}{detail} — {hints}"

    @staticmethod
    def _resolve_executable(request: RunRequest) -> str:
        configured = str(
            request.platform_options.get("executable", "opencode")
        ).strip()
        if not configured:
            configured = "opencode"

        has_separator = os.sep in configured or (
            os.altsep is not None and os.altsep in configured
        )
        if has_separator:
            path = Path(configured).expanduser().resolve()
            if path.is_file():
                return str(path)
        else:
            resolved = shutil.which(configured)
            if resolved:
                return resolved

        raise PlatformExecutableNotFoundError(
            f"OpenCode executable {configured!r} was not found. "
            "Install OpenCode in the environment running agent-fault-injection, "
            "or set platform_options.executable."
        )

    @classmethod
    def _supports_run_flag(cls, executable: str, flag: str) -> bool:
        """Return whether ``opencode run --help`` documents ``flag`` (e.g. --auto)."""

        key = (executable, flag)
        cached = cls._run_flag_support_cache.get(key)
        if cached is not None:
            return cached
        supported = False
        try:
            completed = subprocess.run(
                [executable, "run", "--help"],
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )
            help_text = f"{completed.stdout or ''}\n{completed.stderr or ''}"
            # Match flag as its own token (avoid substring false positives).
            supported = re.search(
                rf"(?:^|\s){re.escape(flag)}(?:\s|,|$)",
                help_text,
            ) is not None
        except (OSError, subprocess.TimeoutExpired):
            supported = False
        cls._run_flag_support_cache[key] = supported
        return supported

    @classmethod
    def _build_command(
        cls,
        executable: str,
        request: RunRequest,
        artifacts: RunArtifacts,
        *,
        supports_auto: bool | None = None,
    ) -> list[str]:
        command = [
            executable,
            "run",
            "--agent",
            request.agent,
            "--dir",
            str(request.workspace.resolve()),
            "--title",
            artifacts.run_id,
            "--format",
            "json",
            "--print-logs",
            "--log-level",
            "WARN",
        ]
        want_auto = bool(request.platform_options.get("auto", True))
        if want_auto:
            if supports_auto is None:
                supports_auto = cls._supports_run_flag(executable, "--auto")
            if supports_auto:
                command.append("--auto")
        model = request.platform_options.get("model")
        if isinstance(model, str) and model.strip():
            command.extend(["--model", model.strip()])
        command.append(request.prompt)
        return command

    def list_agents(self, **kwargs: Any) -> dict[str, Any]:
        """Enumerate agents via ``opencode agent list`` (builtins + user config)."""
        from .catalog import list_opencode_agents

        executable = kwargs.get("executable")
        if executable is not None and not isinstance(executable, str):
            executable = None
        config = self._load_user_opencode_config()
        return list_opencode_agents(executable=executable, config=config)

    def list_models(self, **kwargs: Any) -> dict[str, Any]:
        """Enumerate models: config provider.*.models first, else credentialed CLI."""
        from .catalog import list_opencode_models

        executable = kwargs.get("executable")
        if executable is not None and not isinstance(executable, str):
            executable = None
        config = self._load_user_opencode_config()
        return list_opencode_models(executable=executable, config=config)

    def health_check(self) -> dict[str, Any]:
        executable = "opencode"
        errors: list[str] = []
        if shutil.which(executable) is None:
            errors.append(f"{executable} executable not found on PATH")
        return {"ready": not errors, "errors": errors}

    @staticmethod
    def _redacted_command(command: list[str]) -> list[str]:
        # The prompt may contain private source or task details. It is already
        # stored in request.json, so the manifest records only its placeholder.
        if not command:
            return []
        return [*command[:-1], "<prompt>"]
