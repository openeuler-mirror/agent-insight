"""agent-insight-copaw: CoPaw (QwenPaw) trace collector for AgentInsight.

One-line registration (AC2)::

    import copaw
    copaw.setup(host="http://localhost:3000", api_key="wi_xxx")

The collector is also loadable as a QwenPaw plugin (plugin.json + backend.py).
"""

from __future__ import annotations

import atexit
import logging
from typing import Any

from . import patches
from .collector import Collector
from .config import CollectorConfig, ensure_spool_dir, load_config

__version__ = "0.2.0"

__all__ = [
    "Collector",
    "CollectorConfig",
    "PLUGIN_ID",
    "load_config",
    "setup",
    "teardown",
    "__version__",
]

PLUGIN_ID = "agent-insight-copaw"
_logger = logging.getLogger(__name__)

_GLOBAL: Collector | None = None


def setup(
    host: str | None = None,
    *,
    endpoint: str | None = None,
    api_key: str | None = None,
    enabled: bool | None = None,
    register_in_qwenpaw: bool = True,
    **overrides: Any,
) -> Collector | None:
    """Register the collector in the current process (AC2).

    Args:
        host: AgentInsight server host, e.g. ``http://localhost:3000``.
        endpoint: Full OTLP traces endpoint; takes precedence over host.
        api_key: AgentInsight API key (``wi_...``).
        enabled: Set False to disable collection.
        register_in_qwenpaw: Also register runtime hooks/middleware into a
            running QwenPaw process (best effort).
        **overrides: Any :class:`CollectorConfig` field.

    The function is idempotent: repeated calls return the existing collector.
    """
    global _GLOBAL
    if _GLOBAL is not None:
        return _GLOBAL

    config = load_config()
    values = config.to_dict()
    if host:
        values["endpoint"] = f"{str(host).rstrip('/')}/api/ingest/otel/v1/traces"
    if endpoint:
        values["endpoint"] = str(endpoint)
    if api_key:
        values["api_key"] = str(api_key)
    if enabled is not None:
        values["enabled"] = bool(enabled)
    values.update({key: value for key, value in overrides.items() if value is not None})
    config = CollectorConfig(**values)

    if not config.enabled:
        _logger.info("agent-insight-copaw is disabled; setup() skipped")
        return None

    # AC3: a one-line registration always initializes the configured spool.
    ensure_spool_dir(config)
    collector = Collector(config)
    collector.start()
    patches.install_all(collector)
    if register_in_qwenpaw:
        _register_into_running_qwenpaw(collector)

    # AC21: flush all un-uploaded data on process exit.
    atexit.register(collector.flush)

    _GLOBAL = collector
    _logger.info(
        "agent-insight-copaw setup complete (spool=%s, endpoint=%s)",
        collector.exporter.account_dir,
        collector.exporter.endpoint or "(not configured)",
    )
    return collector


def teardown() -> None:
    """Stop the collector and restore all monkey-patches."""
    global _GLOBAL
    if _GLOBAL is None:
        return
    try:
        patches.uninstall_all()
        _GLOBAL.close()
    finally:
        _GLOBAL = None


def _register_into_running_qwenpaw(collector: Collector) -> None:
    """Best-effort in-process registration into a running QwenPaw app."""
    try:
        from qwenpaw.plugins.registry import PluginRegistry  # type: ignore[import-not-found]
    except Exception:  # noqa: BLE001
        _logger.debug("qwenpaw is not importable; setup() collects via patches only")
        return

    try:
        from .hooks import AgentInsightCleanupHook, AgentInsightRootHook
        from .middleware import AgentInsightToolMiddleware

        registry = PluginRegistry()
        manager = registry.get_workspace_manager()

        def _register_hooks_to_workspace(ws: Any) -> int:
            hook_registry = getattr(getattr(ws, "plugins", None), "hook_registry", None)
            if hook_registry is None:
                return 0
            count = 0
            for hook in (AgentInsightRootHook(collector), AgentInsightCleanupHook(collector)):
                try:
                    hook_registry.register(hook)
                    count += 1
                except (TypeError, ValueError):
                    _logger.debug("hook already registered", exc_info=True)
            return count

        registered = 0
        if manager is not None:
            for ws in manager.agents.values():
                registered += _register_hooks_to_workspace(ws)

        def _on_startup() -> None:
            current = registry.get_workspace_manager()
            if current is None:
                return
            for ws in current.agents.values():
                _register_hooks_to_workspace(ws)

        def _on_workspace_created(workspace_info: dict[str, Any]) -> None:
            agent_id = (workspace_info or {}).get("agent_id")
            current = registry.get_workspace_manager()
            if not agent_id or current is None:
                return
            ws = current.agents.get(agent_id)
            if ws is not None:
                _register_hooks_to_workspace(ws)

        # AC2: one-line setup must also cover workspaces created after setup().
        registry.register_startup_hook(
            plugin_id=PLUGIN_ID,
            hook_name="copaw_runtime_hooks",
            callback=_on_startup,
            priority=65,
        )
        registry.register_workspace_created_hook(
            plugin_id=PLUGIN_ID,
            hook_name="copaw_runtime_hooks_ws",
            callback=_on_workspace_created,
            priority=65,
        )
        registry.register_middleware(
            plugin_id=PLUGIN_ID,
            factory=lambda ctx, agent_config: AgentInsightToolMiddleware(collector),
            priority=90,
        )
        _logger.info("agent-insight-copaw registered %d runtime hooks in QwenPaw", registered)
    except Exception:  # noqa: BLE001
        _logger.debug("in-process QwenPaw registration failed; patches still active", exc_info=True)
