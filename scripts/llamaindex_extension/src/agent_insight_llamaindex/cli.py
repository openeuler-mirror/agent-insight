from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

from .config import CollectorConfig, _default_spool_root
from .spool import Spool

_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _load_model_environment(environment: dict[str, str]) -> None:
    path = Path(
        environment.get("AGENT_INSIGHT_LLAMA_MODEL_ENV")
        or (Path.home() / ".agent-insight" / "llamaindex.env")
    ).expanduser()
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for line in lines:
        candidate = line.strip()
        if not candidate or candidate.startswith("#") or "=" not in candidate:
            continue
        name, value = candidate.split("=", 1)
        name = name.strip()
        if not _ENV_NAME.fullmatch(name):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        environment.setdefault(name, value)


def _configure(args: argparse.Namespace) -> int:
    config = CollectorConfig.load(
        endpoint=args.endpoint,
        api_key=args.api_key,
        user=args.user,
        capture_content=not args.no_content,
        max_content_chars=args.max_content_chars,
    )
    if not config.endpoint or not config.api_key:
        print("endpoint and api key are required", file=sys.stderr)
        return 2
    config.write()
    Spool(config)
    print(f"configuration written: {config.config_path}")
    print(f"endpoint: {config.endpoint}")
    print(f"api key: ***{config.api_key[-4:]}")
    return 0


def _status(_: argparse.Namespace) -> int:
    config = CollectorConfig.load()
    pending = len(Spool(config).pending())
    payload = {**config.redacted(), "ready": config.ready, "pending_batches": pending}
    print(json.dumps(payload, ensure_ascii=False, indent=2, default=str))
    return 0 if config.ready else 1


def _run(args: argparse.Namespace) -> int:
    command = list(args.command)
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        print("a command is required after --", file=sys.stderr)
        return 2
    environment = os.environ.copy()
    _load_model_environment(environment)
    # Keep the opt-in sitecustomize next to the downloaded collector so the
    # ``run`` command works from the Agent Insight-managed runtime directory. It is added
    # only to this child process and cannot affect other Python collectors.
    bootstrap = Path(__file__).resolve().parent / "_bootstrap"
    python_path = environment.get("PYTHONPATH")
    environment["PYTHONPATH"] = os.pathsep.join(
        [str(bootstrap), *([python_path] if python_path else [])]
    )
    environment["AGENT_INSIGHT_LLAMAINDEX_AUTOSTART"] = "1"
    return subprocess.call(command, env=environment)


def _safe_runtime_path(path: Path) -> bool:
    resolved = path.expanduser().resolve()
    home = Path.home().resolve()
    return (
        resolved != home
        and resolved != Path(resolved.anchor)
        and any("llamaindex" in part.lower() for part in resolved.parts)
    )


def _purge(args: argparse.Namespace) -> int:
    if not args.yes:
        print("refusing to delete runtime data without --yes", file=sys.stderr)
        return 2
    config = CollectorConfig.load()
    removed = 0
    spool_targets = {config.spool_dir}
    managed_root = _default_spool_root()
    if managed_root.is_dir():
        spool_targets.update(managed_root.glob("account-*/spool"))
    for spool_dir in spool_targets:
        if not _safe_runtime_path(spool_dir) or not spool_dir.exists():
            continue
        target_config = CollectorConfig.load(spool_dir=spool_dir)
        removed += Spool(target_config).purge()
        try:
            spool_dir.rmdir()
        except OSError:
            pass
        account_dir = spool_dir.parent
        if account_dir.name.startswith("account-"):
            try:
                account_dir.rmdir()
            except OSError:
                pass
    try:
        managed_root.rmdir()
    except OSError:
        pass
    if config.config_path.is_file() and config.config_path.name == "llamaindex.json":
        config.config_path.unlink()
        removed += 1
    model_env = Path(
        os.environ.get("AGENT_INSIGHT_LLAMA_MODEL_ENV")
        or (Path.home() / ".agent-insight" / "llamaindex.env")
    ).expanduser()
    if (
        model_env.is_file()
        and model_env.name == "llamaindex.env"
        and _safe_runtime_path(model_env)
    ):
        model_env.unlink()
        removed += 1
    print(f"removed {removed} runtime files")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agent-insight-llamaindex")
    subparsers = parser.add_subparsers(dest="subcommand", required=True)
    configure = subparsers.add_parser("configure")
    configure.add_argument("--endpoint")
    configure.add_argument("--api-key")
    configure.add_argument("--user")
    configure.add_argument("--no-content", action="store_true")
    configure.add_argument("--max-content-chars", type=int, default=2_000)
    configure.set_defaults(handler=_configure)
    status = subparsers.add_parser("status")
    status.set_defaults(handler=_status)
    run = subparsers.add_parser("run")
    run.add_argument("command", nargs=argparse.REMAINDER)
    run.set_defaults(handler=_run)
    purge = subparsers.add_parser("uninstall")
    purge.add_argument("--purge", action="store_true", required=True)
    purge.add_argument("--yes", action="store_true")
    purge.set_defaults(handler=_purge)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.handler(args))


if __name__ == "__main__":
    raise SystemExit(main())
