"""CLI for installing/uninstalling the collector into CoPaw (QwenPaw)."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from dataclasses import fields
from pathlib import Path
from typing import Sequence

from .config import CollectorConfig, ensure_spool_dir, load_config, save_config

PLUGIN_DIR_NAME = "agent-insight-copaw"


def _plugin_root() -> Path:
    # Package lives at <plugin_root>/copaw/cli.py
    return Path(__file__).resolve().parent.parent


def _qwenpaw_plugins_dir() -> Path:
    try:
        from qwenpaw.config.utils import get_plugins_dir  # type: ignore[import-not-found]

        return Path(get_plugins_dir())
    except Exception:  # noqa: BLE001
        working = (
            os.getenv("QWENPAW_WORKING_DIR")
            or os.getenv("COPAW_WORKING_DIR")
            or str(Path.home() / ".qwenpaw")
        )
        return Path(working) / "plugins"


def _target_dir(plugins_dir: Path) -> Path:
    return plugins_dir / PLUGIN_DIR_NAME


def _copy_plugin(target: Path) -> None:
    ignore = shutil.ignore_patterns(
        "__pycache__",
        "*.pyc",
        ".pytest_cache",
        "tests",
        "benchmarks",
        ".git",
    )
    if target.exists():
        shutil.rmtree(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    pkg_dir = Path(__file__).resolve().parent
    shutil.copytree(pkg_dir, target / "copaw", ignore=ignore)
    assets_dir = pkg_dir / "_plugin_assets"
    if (assets_dir / "plugin.json").exists() and (assets_dir / "backend.py").exists():
        shutil.copy2(assets_dir / "plugin.json", target / "plugin.json")
        shutil.copy2(assets_dir / "backend.py", target / "backend.py")
    else:
        # Source checkout fallback keeps the CLI usable before packaging.
        root = pkg_dir.parent
        shutil.copy2(root / "plugin.json", target / "plugin.json")
        shutil.copy2(root / "backend.py", target / "backend.py")


def _config_from_plugin_dir(target: Path) -> CollectorConfig | None:
    """Read the installed plugin's config.json, or None when not installed."""
    config_path = target / "config.json"
    if not config_path.exists():
        return None
    try:
        raw = json.loads(config_path.read_text(encoding="utf-8-sig"))
        if isinstance(raw, dict):
            valid = {field.name for field in fields(CollectorConfig)}
            kwargs = {key: value for key, value in raw.items() if key in valid}
            if kwargs:
                return CollectorConfig(**kwargs)
    except (OSError, ValueError, TypeError):
        pass
    return CollectorConfig()


def cmd_install(args: argparse.Namespace) -> int:
    plugins_dir = Path(args.plugins_dir) if args.plugins_dir else _qwenpaw_plugins_dir()
    target = _target_dir(plugins_dir)
    _copy_plugin(target)

    config = load_config()
    if args.host:
        host = str(args.host).rstrip("/")
        config.endpoint = f"{host}/api/ingest/otel/v1/traces"
    if args.api_key:
        config.api_key = args.api_key
    if args.endpoint:
        config.endpoint = args.endpoint
    save_config(config, target / "config.json")
    # AC3: the spool directory exists immediately after installation.
    ensure_spool_dir(config)

    print(f"Installed CoPaw AgentInsight collector to: {target}")
    print(f"OTLP endpoint: {config.endpoint or '(not configured)'}")
    print(f"Spool directory: {config.spool_dir}")
    print("Restart QwenPaw, or register in-process with:")
    print("  import copaw; copaw.setup()")
    return 0


def cmd_uninstall(args: argparse.Namespace) -> int:
    plugins_dir = Path(args.plugins_dir) if args.plugins_dir else _qwenpaw_plugins_dir()
    target = _target_dir(plugins_dir)
    config = _config_from_plugin_dir(target)
    cleanup_config = config or load_config()
    removed = False
    if target.exists():
        try:
            shutil.rmtree(target)
            removed = True
        except OSError as exc:
            print(f"Warning: could not remove plugin directory {target}: {exc}")
    if config is not None and not args.keep_spool:
        spool = Path(config.spool_dir).expanduser()
        if spool.exists():
            try:
                shutil.rmtree(spool)
                removed = True
            except OSError as exc:
                print(f"Warning: could not remove spool directory {spool}: {exc}")
    if args.remove_log:
        log = Path(cleanup_config.log_file).expanduser()
        if log.exists():
            log.unlink(missing_ok=True)
            removed = True
    print(f"Uninstalled collector from: {target}")
    if not removed:
        print("Nothing to remove; plugin was not installed.")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    config = load_config()
    print(json.dumps(config.to_dict(), ensure_ascii=False, indent=2))
    return 0


def cmd_flush(args: argparse.Namespace) -> int:
    config = load_config()
    print(f"Spool directory: {config.spool_dir}")
    print("Flush is performed automatically on session end and process exit.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agent-insight-copaw")
    sub = parser.add_subparsers(dest="command", required=True)

    install = sub.add_parser("install", help="Install the collector into QwenPaw/CoPaw")
    install.add_argument("--host", help="AgentInsight server host, e.g. http://localhost:3000")
    install.add_argument("--endpoint", help="Full OTLP traces endpoint")
    install.add_argument("--api-key", help="AgentInsight API key")
    install.add_argument("--plugins-dir", help="QwenPaw plugins directory override")
    install.set_defaults(func=cmd_install)

    uninstall = sub.add_parser("uninstall", help="Remove the collector from QwenPaw/CoPaw")
    uninstall.add_argument("--plugins-dir", help="QwenPaw plugins directory override")
    uninstall.add_argument("--keep-spool", action="store_true", help="Keep the spool directory")
    uninstall.add_argument("--remove-log", action="store_true", help="Also remove the plugin log file")
    uninstall.set_defaults(func=cmd_uninstall)

    sub.add_parser("status", help="Show collector configuration").set_defaults(func=cmd_status)
    sub.add_parser("flush", help="Show spool/flush information").set_defaults(func=cmd_flush)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
