"""Lookup of concrete platform adapters."""

from __future__ import annotations

from collections.abc import Callable

from ..pipeline.exceptions import PlatformNotFoundError
from .base import PlatformAdapter

AdapterFactory = Callable[[], PlatformAdapter]


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
