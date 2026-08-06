"""Lookup of concrete platform adapters."""

from __future__ import annotations

import threading
from collections.abc import Callable

from ..pipeline.exceptions import PlatformNotFoundError
from .base import PlatformAdapter

AdapterFactory = Callable[[], PlatformAdapter]

_default_registry: PlatformAdapterRegistry | None = None
_default_lock = threading.Lock()


class PlatformAdapterRegistry:
    """Name → adapter registry with explicit ``register`` and builtin load."""

    def __init__(self, *, load_builtins: bool = True) -> None:
        self._factories: dict[str, AdapterFactory] = {}
        self._instances: dict[str, PlatformAdapter] = {}
        if load_builtins:
            self._load_builtins()

    def register(self, name: str, factory: AdapterFactory) -> None:
        normalized = name.strip().lower()
        if not normalized:
            raise ValueError("platform name must not be empty")
        self._factories[normalized] = factory
        self._instances.pop(normalized, None)

    def get(self, name: str) -> PlatformAdapter:
        normalized = name.strip().lower()
        cached = self._instances.get(normalized)
        if cached is not None:
            return cached
        try:
            factory = self._factories[normalized]
        except KeyError as exc:
            available = ", ".join(sorted(self._factories)) or "(none)"
            raise PlatformNotFoundError(
                f"Unknown platform {name!r}. Available platforms: {available}"
            ) from exc
        adapter = factory()
        self._instances[normalized] = adapter
        return adapter

    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self._factories))

    def _load_builtins(self) -> None:
        from .opencode.adapter import OpenCodeAdapter
        from .xiaoo.adapter import XiaoOAdapter

        self.register("opencode", OpenCodeAdapter)
        self.register("xiaoo", XiaoOAdapter)


def get_platform_adapter_registry(*, refresh: bool = False) -> PlatformAdapterRegistry:
    """Return the process-wide builtin platform registry."""

    global _default_registry
    with _default_lock:
        if refresh or _default_registry is None:
            _default_registry = PlatformAdapterRegistry()
        return _default_registry


def invalidate_platform_adapter_registry() -> None:
    """Drop the cached default platform registry."""

    global _default_registry
    with _default_lock:
        _default_registry = None
