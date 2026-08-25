"""CoPaw (QwenPaw) plugin backend entry point."""

from __future__ import annotations

import atexit
import shutil
from pathlib import Path
from typing import Any

from copaw import patches
from copaw.collector import Collector
from copaw.config import ensure_spool_dir, load_config
from copaw.hooks import AgentInsightCleanupHook, AgentInsightRootHook
from copaw.middleware import AgentInsightToolMiddleware

_collector: Collector | None = None


def register(api: Any) -> None:
    """QwenPaw plugin protocol: called by the plugin loader with a PluginApi."""

    global _collector
    config = load_config(getattr(api, "config", None) or {})
    if not config.enabled:
        return

    ensure_spool_dir(config)
    _collector = Collector(config)

    api.register_startup_hook("copaw_start", _collector.start, priority=10)
    api.register_runtime_hook(AgentInsightRootHook(_collector))
    api.register_runtime_hook(AgentInsightCleanupHook(_collector))
    api.register_middleware(
        lambda ctx, agent_config: AgentInsightToolMiddleware(_collector),
        priority=90,
    )
    api.register_shutdown_hook("copaw_flush", _collector.flush, priority=90)
    api.register_uninstall_hook(
        "copaw_uninstall",
        _uninstall,
        priority=10,
    )
    patches.install_all(_collector)
    # AC21: process-exit flush even when QwenPaw's own shutdown hook is missed.
    atexit.register(_collector.flush)


def _uninstall(plugin_id: str | None = None, delete_files: bool = False) -> None:
    global _collector
    config = _collector.config if _collector is not None else None
    patches.uninstall_all()
    if _collector is not None:
        _collector.close()
        _collector = None
    # The QwenPaw plugin loader calls this only for an explicit removal when
    # delete_files is true. Do not erase telemetry on a temporary reload.
    if delete_files and config is not None:
        try:
            shutil.rmtree(Path(config.spool_dir).expanduser())
        except FileNotFoundError:
            pass
        except OSError:
            pass


def get_collector() -> Collector | None:
    return _collector


class CopawPlugin:
    """New-style QwenPaw plugin entry (exports a ``plugin`` object)."""

    def register(self, api: Any) -> None:
        register(api)


plugin = CopawPlugin()
