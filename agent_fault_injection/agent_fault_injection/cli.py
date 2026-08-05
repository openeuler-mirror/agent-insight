"""Command-line interface for starting controlled platform experiments."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import textwrap
from pathlib import Path
from typing import Any, Sequence

from .exceptions import AgentRasEvalError, ConfigurationError
from .fault_inject.catalog import add_fault
from .fault_inject.registry import FaultRegistry
from .models import (
    FaultContainmentStatus,
    FaultOutcome,
    RunRequest,
    RunResult,
    RunStatus,
    TerminationReason,
)
from .runner import ExperimentRunner
from .workspace_alloc import (
    WorkspaceAllocationError,
    allocate_run_workspace,
    new_run_id,
)

_REPORT_WIDTH = 64
_LABEL_WIDTH = 18


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="agent-fault-injection",
        description=(
            "Run controlled fault-injection experiments, collect execution "
            "trajectories, and optionally judge whether a fault manifested."
        ),
        epilog=(
            "Use 'agent-fault-injection run --help' for experiment options or "
            "'agent-fault-injection fault --help' to manage fault skills."
        ),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    run = subparsers.add_parser(
        "run",
        help="Start a fault-injection experiment on the selected platform",
        description=(
            "Run one agent with an injected fault skill and capture its "
            "trajectory. Fault outcome judging runs in Insight (server-side)."
        ),
        epilog="""examples:
  # Capture injection + trajectory (judge off by default; Insight judges)
  agent-fault-injection run --platform opencode --agent build \\
    --fault thinking-dead-loop --prompt "execute case2" \\
    --workspace /tmp/ras-workspace --output-dir /tmp/ras-artifacts

  # Opt-in local OpenCode judge (legacy; prefer Insight server judge)
  agent-fault-injection run --platform opencode --agent build \\
    --fault thinking-dead-loop --prompt "execute case2" \\
    --workspace /tmp/ras-workspace --judge

  # Load experiment values from YAML or JSON
  agent-fault-injection run --config configs/experiment.yaml

defaults:
  --auto is enabled by default. Use --no-auto to disable.
  Prefer a dedicated base workspace directory, not the repository root.
  Each run allocates a fresh subdirectory under ``.ras-runs/single/``.

judge behavior:
  Local --judge is OFF by default. Insight BFF /api/fault-injection runs
  the server-side judge after collect. --judge opts into legacy local judge.""",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    run.add_argument(
        "--config",
        type=Path,
        help=(
            "YAML or JSON experiment configuration. Explicit CLI values "
            "override matching configuration values."
        ),
    )
    run.add_argument(
        "--platform",
        help="Agent platform adapter, for example 'opencode' (required unless configured).",
    )
    run.add_argument(
        "--agent",
        help="Platform agent name, for example 'build' (required unless configured).",
    )
    run.add_argument(
        "--fault",
        help=(
            "Fault skill name to inject. Run 'agent-fault-injection fault list' "
            "to show available names."
        ),
    )
    run.add_argument(
        "--submode",
        help=(
            "Optional fault submode / scenario id (for example '1' or '2'). "
            "Also settable via YAML/JSON field 'submode'."
        ),
    )
    prompt = run.add_mutually_exclusive_group()
    prompt.add_argument(
        "--prompt",
        help="Task text sent to the evaluated agent (required unless configured).",
    )
    prompt.add_argument(
        "--prompt-file",
        type=Path,
        help="UTF-8 file containing the evaluated agent task.",
    )
    run.add_argument(
        "--workspace",
        type=Path,
        help=(
            "Existing base directory for the evaluated agent. Each run "
            "allocates a fresh subdirectory under .ras-runs/single/."
        ),
    )
    run.add_argument(
        "--output-dir",
        type=Path,
        help="Artifact root directory (default: ./artifacts).",
    )
    run.add_argument(
        "--run-id",
        help=(
            "Stable run id for artifacts and collect-result "
            "(default: auto-generated ras-<stamp>-<hex>)."
        ),
    )
    run.add_argument(
        "--timeout-seconds",
        type=int,
        help="Maximum evaluated-agent runtime in seconds (default: 600).",
    )
    run.add_argument(
        "--platform-executable",
        help="Platform executable path or command name (default: opencode).",
    )
    run.add_argument(
        "--model",
        help="Model override for the evaluated agent.",
    )
    run.add_argument(
        "--auto",
        action=argparse.BooleanOptionalAction,
        default=None,
        help=(
            "Enable or disable the platform's automatic tool execution mode "
            "(default: enabled; matches the Web UI)."
        ),
    )
    run.add_argument(
        "--plugin-startup-timeout",
        type=float,
        help=(
            "Seconds to wait for the eval plugin ready signal "
            "(default: 120; also settable via platform_options)."
        ),
    )
    run.add_argument(
        "--judge",
        action=argparse.BooleanOptionalAction,
        default=None,
        help=(
            "Enable or disable legacy local fault-outcome classification "
            "(default: disabled; prefer Insight server judge)."
        ),
    )
    run.add_argument(
        "--judge-agent",
        help=(
            "Agent used by the judge "
            "(default: ras-judge, a no-tool primary agent)."
        ),
    )
    run.add_argument(
        "--judge-model",
        help="Model used by the judge (default: --model or platform default).",
    )
    run.add_argument(
        "--judge-timeout-seconds",
        type=float,
        help="Maximum judge runtime in seconds (default: 120).",
    )
    run.add_argument(
        "--judge-pure",
        action=argparse.BooleanOptionalAction,
        default=None,
        help=(
            "Run the judge with OpenCode --pure "
            "(no external plugins; default: enabled)."
        ),
    )

    fault = subparsers.add_parser(
        "fault",
        help="Manage reusable fault skills",
        description="List or install reusable fault-injection skills.",
        epilog=(
            "Use 'agent-fault-injection fault list' to discover fault names or "
            "'agent-fault-injection fault add --help' for installation options."
        ),
    )
    fault_commands = fault.add_subparsers(dest="fault_command", required=True)

    serve = subparsers.add_parser(
        "serve",
        help="(Removed) Use Insight /agent-ras/fault-injection instead",
        description=(
            "Legacy FastAPI/Vite UI was removed. Open Insight at "
            "/agent-ras/fault-injection and use /api/fault-injection."
        ),
    )
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8787)
    serve.add_argument(
        "--output-dir",
        type=Path,
        default=Path("artifacts"),
        help="Unused (legacy).",
    )
    serve.add_argument(
        "--static-dir",
        type=Path,
        default=None,
        help="Directory containing webui build output (index.html).",
    )
    serve.add_argument(
        "--max-parallel-runs",
        type=int,
        default=5,
        help="Max concurrent experiment runs; excess jobs stay queued (default: 5).",
    )

    fault_add = fault_commands.add_parser(
        "add",
        help="Validate and add a fault skill to the built-in catalog",
        description=(
            "Validate a SKILL.md file and install it as a built-in fault skill."
        ),
        epilog="""example:
  agent-fault-injection fault add --name tool-timeout \\
    --skill-file /tmp/tool-timeout/SKILL.md \\
    --description "Repeated tool timeout fault" """,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    fault_add.add_argument(
        "--name",
        required=True,
        help="Unique lowercase fault name used by 'run --fault'.",
    )
    fault_add.add_argument(
        "--skill-file",
        required=True,
        type=Path,
        help="Path to the source SKILL.md file.",
    )
    fault_add.add_argument(
        "--description",
        help="Optional fault description; defaults to the skill metadata.",
    )

    fault_commands.add_parser(
        "list",
        help="List automatically discovered fault skills",
        description=(
            "Print available fault name and injected skill name."
        ),
    )
    return parser


def _load_config(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {}
    if not path.is_file():
        raise ConfigurationError(f"Configuration file does not exist: {path}")

    suffix = path.suffix.lower()
    content = path.read_text(encoding="utf-8")
    if suffix == ".json":
        value = json.loads(content)
    elif suffix in {".yaml", ".yml"}:
        try:
            import yaml
        except ImportError as exc:
            raise ConfigurationError(
                "PyYAML is required to read YAML configuration files"
            ) from exc
        value = yaml.safe_load(content)
    else:
        raise ConfigurationError(
            f"Unsupported configuration format {suffix!r}; use YAML or JSON"
        )

    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ConfigurationError("Configuration root must be an object")
    return value


def _value(
    cli_value: Any,
    config: dict[str, Any],
    key: str,
    default: Any = None,
) -> Any:
    return cli_value if cli_value is not None else config.get(key, default)


def build_request(namespace: argparse.Namespace) -> RunRequest:
    config = _load_config(namespace.config)

    prompt = _value(namespace.prompt, config, "prompt")
    prompt_file = _value(namespace.prompt_file, config, "prompt_file")
    if prompt is None and prompt_file is not None:
        prompt_path = Path(prompt_file).expanduser()
        if not prompt_path.is_file():
            raise ConfigurationError(f"Prompt file does not exist: {prompt_path}")
        prompt = prompt_path.read_text(encoding="utf-8")

    required = {
        "platform": _value(namespace.platform, config, "platform"),
        "agent": _value(namespace.agent, config, "agent"),
        "fault": _value(namespace.fault, config, "fault"),
        "prompt": prompt,
        "workspace": _value(namespace.workspace, config, "workspace"),
    }
    missing = [name for name, value in required.items() if value in (None, "")]
    if missing:
        raise ConfigurationError(
            "Missing required experiment fields: " + ", ".join(missing)
        )

    workspace_base = Path(required["workspace"]).expanduser().resolve()
    if not workspace_base.is_dir():
        raise ConfigurationError(
            f"Workspace does not exist or is not a directory: {workspace_base}"
        )
    cli_run_id = _value(getattr(namespace, "run_id", None), config, "run_id")
    run_id = str(cli_run_id).strip() if cli_run_id not in (None, "") else new_run_id()
    if not run_id:
        raise ConfigurationError("run_id must not be empty when provided")
    try:
        workspace = allocate_run_workspace(
            workspace_base,
            "single",
            str(required["fault"]),
            run_id,
        )
    except WorkspaceAllocationError as exc:
        raise ConfigurationError(str(exc)) from exc
    output_value = _value(namespace.output_dir, config, "output_dir", "artifacts")
    output_dir = Path(output_value).expanduser().resolve()
    timeout_seconds = int(
        _value(namespace.timeout_seconds, config, "timeout_seconds", 600)
    )

    platform_options = dict(config.get("platform_options") or {})
    executable = _value(
        namespace.platform_executable,
        platform_options,
        "executable",
    )
    model = _value(namespace.model, platform_options, "model")
    auto = _value(namespace.auto, platform_options, "auto")
    plugin_startup_timeout = _value(
        getattr(namespace, "plugin_startup_timeout", None),
        platform_options,
        "plugin_startup_timeout",
    )
    judge_enabled = _value(namespace.judge, platform_options, "judge_enabled")
    judge_agent = _value(namespace.judge_agent, platform_options, "judge_agent")
    judge_model = _value(namespace.judge_model, platform_options, "judge_model")
    judge_timeout_seconds = _value(
        namespace.judge_timeout_seconds,
        platform_options,
        "judge_timeout_seconds",
    )
    judge_pure = _value(namespace.judge_pure, platform_options, "judge_pure")
    if executable is not None:
        platform_options["executable"] = executable
    if model is not None:
        platform_options["model"] = model
    # Default True to match the Web UI when neither CLI nor YAML sets auto.
    platform_options["auto"] = True if auto is None else bool(auto)
    if plugin_startup_timeout is not None:
        platform_options["plugin_startup_timeout"] = float(
            plugin_startup_timeout
        )
    if judge_enabled is not None:
        platform_options["judge_enabled"] = bool(judge_enabled)
    else:
        platform_options.setdefault("judge_enabled", False)
    if judge_agent is not None:
        platform_options["judge_agent"] = str(judge_agent)
    if judge_model is not None:
        platform_options["judge_model"] = str(judge_model)
    if judge_timeout_seconds is not None:
        platform_options["judge_timeout_seconds"] = float(
            judge_timeout_seconds
        )
    if judge_pure is not None:
        platform_options["judge_pure"] = bool(judge_pure)

    raw_submode = _value(
        getattr(namespace, "submode", None),
        config,
        "submode",
    )
    submode: str | None = None
    if raw_submode is not None and str(raw_submode).strip():
        submode = str(raw_submode).strip()

    try:
        return RunRequest(
            platform=str(required["platform"]),
            agent=str(required["agent"]),
            fault=str(required["fault"]),
            prompt=str(required["prompt"]),
            workspace=workspace,
            output_dir=output_dir,
            timeout_seconds=timeout_seconds,
            platform_options=platform_options,
            submode=submode,
            run_id=run_id,
        )
    except (TypeError, ValueError) as exc:
        raise ConfigurationError(str(exc)) from exc


def _value_text(value: object) -> str:
    enum_value = getattr(value, "value", None)
    return str(enum_value if enum_value is not None else value)


def _print_section(title: str) -> None:
    print()
    print(f" {title} ".center(_REPORT_WIDTH, "="))
    print()


def _print_field(label: str, value: object) -> None:
    print(f"  {label:<{_LABEL_WIDTH}}{_value_text(value)}")


def _print_reason(reason: str) -> None:
    print()
    print("  Reason")
    for line in textwrap.wrap(
        reason,
        width=_REPORT_WIDTH - 4,
        break_long_words=False,
        break_on_hyphens=False,
    ) or [""]:
        print(f"  {line}")


def _print_footer() -> None:
    print()
    print("=" * _REPORT_WIDTH)


def _fault_outcome_label(outcome: FaultOutcome) -> str:
    if outcome == FaultOutcome.OCCURRED:
        return "FAULT OCCURRED"
    return "FAULT NOT OCCURRED"


def _containment_label(status: FaultContainmentStatus) -> str:
    labels = {
        FaultContainmentStatus.UNRESOLVED: "UNRESOLVED",
        FaultContainmentStatus.RECOVERED: "RECOVERED",
        FaultContainmentStatus.PREVENTED: "PREVENTED",
        FaultContainmentStatus.NO_TRACE: "NO EXECUTION TRACE",
    }
    return labels[status]


def _print_agent_execution(details: dict[str, object]) -> None:
    _print_section("Agent Execution")
    _print_field("Run ID", details["run_id"])
    _print_field("Platform", details["platform"])
    _print_field("Agent", details["agent"])
    _print_field("Fault", details["fault"])
    _print_field("Workspace", details["workspace"])
    print()
    _print_field(
        "Execution Status",
        details.get("execution_status", "finished"),
    )
    _print_field("Termination", details["termination_reason"])
    _print_field("Exit Code", details["exit_code"])
    _print_field(
        "Fault Activated",
        "yes" if details.get("fault_activated") else "no",
    )
    _print_field("Trajectory", details["trajectory"])
    _print_field("Artifacts", details["artifacts"])
    _print_footer()


def _print_run_progress(
    event: str,
    details: dict[str, object],
) -> None:
    if event == "agent_execution_finished":
        _print_agent_execution(details)
        sys.stdout.flush()
    elif event == "fault_verification_started":
        print(
            "\nJudge is evaluating the collected execution data...\n",
            flush=True,
        )


def _print_artifacts(result: RunResult) -> None:
    artifacts = result.artifacts
    print()
    print("  Artifacts")
    _print_field("Directory", artifacts.root)
    for label, path in (
        ("Manifest", artifacts.manifest_file),
        ("Trajectory", artifacts.trajectory_file),
        ("Judge Request", artifacts.root / "judge-request.json"),
        ("Judge Result", artifacts.root / "judge-result.json"),
        ("Judge Stdout", artifacts.raw_dir / "judge-stdout.log"),
        ("Judge Stderr", artifacts.raw_dir / "judge-stderr.log"),
    ):
        if path.is_file():
            _print_field(label, path)


def _print_judge_result(
    request: RunRequest,
    result: RunResult,
) -> None:
    pre_judge_failure = (
        result.status == RunStatus.FAILED
        and result.evaluation_error is None
        and result.termination_reason
        not in {TerminationReason.FAULT_NOT_ACTIVATED}
    )
    _print_section(
        "Experiment Result" if pre_judge_failure else "Judge Result"
    )

    if result.fault_outcome is not None:
        _print_field("Evaluation", "completed")
        _print_field(
            "Injection Outcome",
            _fault_outcome_label(result.fault_outcome),
        )
        if result.fault_containment_status is not None:
            _print_field(
                "Recovery / Handling",
                _containment_label(result.fault_containment_status),
            )
            _print_field(
                "Classification",
                f"{result.fault_outcome.value} + "
                f"{result.fault_containment_status.value}",
            )
        if result.fault_reason:
            _print_reason(result.fault_reason)
    elif result.evaluation_error:
        _print_field("Evaluation", "failed")
        _print_field("Overall Status", result.status)
        _print_reason(result.evaluation_error)
        print()
        print("  Collected agent execution data has been preserved.")
    elif pre_judge_failure:
        _print_field("Overall Status", result.status)
        _print_field("Termination", result.termination_reason)
        if result.error:
            _print_reason(result.error)
    else:
        _print_field("Evaluation", "skipped")
        skip_reason = (
            "judge disabled"
            if not bool(
                request.platform_options.get("judge_enabled", False)
            )
            else "fault was not activated"
        )
        _print_field("Reason", skip_reason)

    _print_artifacts(result)
    _print_footer()


async def _run(namespace: argparse.Namespace) -> int:
    request = build_request(namespace)
    result = await ExperimentRunner(
        progress_callback=_print_run_progress
    ).run(request)
    _print_judge_result(request, result)

    return 0 if result.status == RunStatus.COMPLETED else result.exit_code or 1


def _add_fault(namespace: argparse.Namespace) -> int:
    fault = add_fault(
        name=namespace.name,
        skill_file=namespace.skill_file,
        description=namespace.description,
    )
    print(f"fault: {fault.name}")
    print(f"skill: {fault.skill_name}")
    print(f"installed: {fault.skill_file}")
    return 0


def _list_faults() -> int:
    registry = FaultRegistry()
    for name in registry.names():
        fault = registry.get(name)
        print(f"{fault.name}\t{fault.skill_name}")
    return 0


def cli(argv: Sequence[str] | None = None) -> int:
    parser = _parser()
    namespace = parser.parse_args(argv)

    try:
        if namespace.command == "run":
            return asyncio.run(_run(namespace))
        if namespace.command == "serve":
            print(
                "agent-fault-injection: 'serve' was removed. "
                "Use Insight UI /agent-ras/fault-injection and "
                "BFF /api/fault-injection instead.",
                file=sys.stderr,
            )
            return 2
        if namespace.command == "fault" and namespace.fault_command == "add":
            return _add_fault(namespace)
        if namespace.command == "fault" and namespace.fault_command == "list":
            return _list_faults()
    except (AgentRasEvalError, OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"agent-fault-injection: {exc}", file=sys.stderr)
        return 2

    parser.error(f"Unsupported command: {namespace.command}")
    return 2


def main() -> None:
    raise SystemExit(cli())


if __name__ == "__main__":
    main()
