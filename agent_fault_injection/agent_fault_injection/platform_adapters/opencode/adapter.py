"""OpenCode lifecycle management for agent-fault-injection."""

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

from ...artifact_store import ArtifactStore
from ...exceptions import (
    PlatformConnectionError,
    PlatformExecutableNotFoundError,
    PluginStartupError,
    ToolInstallationError,
)
from ...fault_inject.installer import InstallSession
from ...fault_inject.injection_tools import InjectionContext, apply_injection_plan
from ...fault_inject.injection_tools.runtime_plan import (
    filter_runtime_steps_for_submode,
    runtime_plan_to_json,
)
from ...fault_inject.models import FaultDefinition
from ...models import (
    PlatformRunResult,
    RunArtifacts,
    RunRequest,
    RunStatus,
    TerminationReason,
)
from ...monitor import ProcessMonitor
from ..base import PlatformAdapter
from .mapper import OpenCodeTrajectoryMapper


class OpenCodeAdapter(PlatformAdapter):
    """Installs the experiment extension and starts OpenCode internally."""

    name = "opencode"
    # Cache: (resolved_executable, flag) -> documented by `opencode run --help`.
    _run_flag_support_cache: dict[tuple[str, str], bool] = {}

    def __init__(self) -> None:
        self.mapper = OpenCodeTrajectoryMapper()
        self.monitor = ProcessMonitor()

    async def execute(
        self,
        request: RunRequest,
        fault: FaultDefinition,
        artifacts: RunArtifacts,
        store: ArtifactStore,
    ) -> PlatformRunResult:
        workspace = request.workspace.resolve()
        if not workspace.is_dir():
            raise ValueError(f"Workspace does not exist or is not a directory: {workspace}")

        executable = self._resolve_executable(request)
        plugin_version = self._resolve_plugin_version(executable)
        plugin_source = (
            Path(__file__).resolve().parent / "plugin" / "agent-fault-injection.ts"
        )
        if not plugin_source.is_file():
            raise PluginStartupError(f"Bundled OpenCode plugin is missing: {plugin_source}")

        installation = InstallSession()
        process: asyncio.subprocess.Process | None = None
        isolated_root: Path | None = None

        try:
            store.update_manifest(artifacts, status=RunStatus.PREPARING)
            self._install_fault_tools(
                installation=installation,
                fault=fault,
                workspace=workspace,
            )
            self._assert_fault_tools_installed(fault=fault, workspace=workspace)
            shutil.copy2(
                fault.skill_file,
                artifacts.resolved_fault_dir / "SKILL.md",
            )
            apply_injection_plan(
                fault,
                InjectionContext(
                    workspace=workspace,
                    artifacts_dir=artifacts.resolved_fault_dir,
                    events_file=artifacts.events_file,
                    installation=installation,
                    submode=request.submode,
                    assets_root=fault.assets_dir,
                ),
            )

            isolated_root = self._prepare_isolated_environment(
                request=request,
                artifacts=artifacts,
                fault=fault,
                plugin_source=plugin_source,
                plugin_version=plugin_version,
            )

            environment = self._build_environment(
                artifacts=artifacts,
                fault=fault,
                isolated_root=isolated_root,
                submode=request.submode,
            )

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

            with (
                artifacts.stdout_file.open("wb", buffering=0) as stdout,
                artifacts.stderr_file.open("wb", buffering=0) as stderr,
            ):
                process = await asyncio.create_subprocess_exec(
                    *command,
                    cwd=workspace,
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
                        self._startup_failure_message(
                            exc=exc,
                            artifacts=artifacts,
                            startup_timeout=startup_timeout,
                        )
                    ) from exc

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

                exit_code = await self.monitor.wait_for_exit(
                    process,
                    request.timeout_seconds,
                    health_check=(
                        provider_health_check
                        if retry_limit > 0
                        else None
                    ),
                )

            capture = self.mapper.inspect(artifacts.events_file)
            if not capture.fault_activated:
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
            installation.cleanup()
            if isolated_root is not None:
                shutil.rmtree(isolated_root, ignore_errors=True)

    def map_trajectory(
        self,
        request: RunRequest,
        fault: FaultDefinition,
        artifacts: RunArtifacts,
    ) -> None:
        self.mapper.map(request, fault, artifacts)

    @staticmethod
    def build_runtime_env(*, agent_ras: dict[str, str] | None = None) -> dict[str, str]:
        """Real system environment, optionally overlaying AGENT_RAS_* keys."""

        environment = os.environ.copy()
        if agent_ras:
            environment.update(agent_ras)
        return environment

    @staticmethod
    def strip_agent_ras_env(environment: dict[str, str]) -> dict[str, str]:
        """Copy env without AGENT_RAS_* so the eval plugin is not activated."""

        return {
            key: value
            for key, value in environment.items()
            if not key.startswith("AGENT_RAS_")
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

    @staticmethod
    def _build_environment(
        *,
        artifacts: RunArtifacts,
        fault: FaultDefinition,
        isolated_root: Path,
        submode: str | None = None,
    ) -> dict[str, str]:
        environment = os.environ.copy()
        # Isolate config and plugins while preserving authentication/model data.
        for key in list(environment):
            if key.startswith("OPENCODE_") or key in {
                "XDG_CONFIG_HOME",
                "XDG_STATE_HOME",
            }:
                environment.pop(key, None)
        runtime_steps = filter_runtime_steps_for_submode(
            fault.injection_runtime,
            submode,
        )
        environment.update(
            {
                "AGENT_RAS_RUN_ID": artifacts.run_id,
                "AGENT_RAS_FAULT_SKILL": fault.skill_name,
                "AGENT_RAS_RAW_DIR": str(artifacts.raw_dir.resolve()),
                "AGENT_RAS_SCHEMA_VERSION": "1",
                "AGENT_RAS_INJECTION_RUNTIME": runtime_plan_to_json(
                    runtime_steps
                ),
                "AGENT_RAS_INJECTION_ARTIFACTS": str(
                    (artifacts.resolved_fault_dir / "injection").resolve()
                ),
                "XDG_CONFIG_HOME": str(isolated_root / "xdg-config"),
                "OPENCODE_CONFIG_DIR": str(isolated_root / "config"),
                "OPENCODE_DISABLE_DEFAULT_PLUGINS": "1",
                "OPENCODE_DISABLE_MODELS_FETCH": "1",
            }
        )
        return environment

    @staticmethod
    def _assert_fault_tools_installed(
        *,
        fault: FaultDefinition,
        workspace: Path,
    ) -> None:
        """Fail fast when required agent tools are missing after install."""

        destination_root = (
            workspace
            / ".agent-fault-injection"
            / "tools"
            / fault.skill_name
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

    @classmethod
    def _prepare_isolated_environment(
        cls,
        *,
        request: RunRequest,
        artifacts: RunArtifacts,
        fault: FaultDefinition,
        plugin_source: Path,
        plugin_version: str,
    ) -> Path:
        """Create a disposable config containing the eval plugin and Skill."""

        root = Path(
            tempfile.mkdtemp(prefix=f"agent-ras-oc-env-{artifacts.run_id}-")
        )
        xdg_config = root / "xdg-config"
        config_dir = root / "config"
        plugin_path = config_dir / "plugins" / "agent-fault-injection.ts"
        skill_path = config_dir / "skills" / fault.skill_name / "SKILL.md"
        for path in (xdg_config, plugin_path.parent, skill_path.parent):
            path.mkdir(parents=True, exist_ok=True)
        shutil.copy2(plugin_source, plugin_path)
        shutil.copy2(fault.skill_file, skill_path)

        package = {
            "private": True,
            "dependencies": {"@opencode-ai/plugin": plugin_version},
        }
        (config_dir / "package.json").write_text(
            json.dumps(package, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

        config: dict[str, Any] = {
            "$schema": "https://opencode.ai/config.json",
            # Explicit loading and default-plugin isolation guarantee one eval
            # plugin instance even though the file lives in the config tree.
            "plugin": [str(plugin_path.resolve())],
        }
        user_config = cls._load_user_opencode_config() or {}
        model = request.platform_options.get("model")
        if isinstance(model, str) and model.strip():
            config["model"] = model.strip()
        else:
            model = user_config.get("model")
            if isinstance(model, str) and model.strip():
                config["model"] = model.strip()

        small_model = user_config.get("small_model")
        if isinstance(small_model, str) and small_model.strip():
            config["small_model"] = small_model.strip()

        provider = user_config.get("provider")
        if isinstance(provider, dict) and provider:
            config["provider"] = provider

        payload = json.dumps(config, ensure_ascii=False, indent=2) + "\n"
        (config_dir / "opencode.json").write_text(payload, encoding="utf-8")
        return root

    @staticmethod
    def _resolve_plugin_version(executable: str) -> str:
        """Match the plugin SDK dependency to the user's OpenCode release."""

        try:
            completed = subprocess.run(
                [executable, "--version"],
                capture_output=True,
                text=True,
                check=False,
                timeout=10,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise PluginStartupError(
                f"Could not determine OpenCode version from {executable!r}: {exc}"
            ) from exc

        output = f"{completed.stdout}\n{completed.stderr}"
        match = re.search(
            r"(?<![0-9])([0-9]+\.[0-9]+\.[0-9]+)(?![0-9])",
            output,
        )
        if completed.returncode != 0 or match is None:
            raise PluginStartupError(
                f"Could not determine a semantic OpenCode version from "
                f"{executable!r} (exit code {completed.returncode})."
            )
        return match.group(1)

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

    @classmethod
    def _copy_user_providers(cls) -> dict[str, Any] | None:
        """Return provider map from user OpenCode config, if present."""

        data = cls._load_user_opencode_config()
        if data is None:
            return None
        provider = data.get("provider")
        if isinstance(provider, dict):
            return provider
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
    ) -> str:
        extras: list[str] = []
        for label, path in (
            ("stderr", artifacts.stderr_file),
            ("opencode.log", artifacts.raw_dir / "opencode.log"),
        ):
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            lines = [line for line in text.splitlines() if line.strip()]
            if not lines:
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
                    )
                )
            ] or lines[-5:]
            extras.append(f"{label}: " + " · ".join(interesting[-6:]))

        detail = (" | " + " | ".join(extras)) if extras else ""
        hints = (
            "检查：1) `opencode run` 是否可用且 provider token 有效；"
            "2) 系统 OpenCode 配置（~/.config/opencode，含 jsonc）是否正确；"
            "3) artifacts/<run>/raw/stderr.log；"
            f"4) 可调大 plugin_startup_timeout（当前 {startup_timeout:g}s）。"
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
