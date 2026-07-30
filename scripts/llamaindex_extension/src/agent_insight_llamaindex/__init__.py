from importlib import import_module
from typing import Any

from .config import CollectorConfig
from .context import trace_context

__all__ = [
    "CollectorConfig",
    "flush",
    "instrument",
    "shutdown",
    "setup",
    "trace_context",
    "uninstrument",
]

__version__ = "0.1.0"


def __getattr__(name: str) -> Any:
    """Load LlamaIndex-dependent instrumentation only when it is requested.

    Keeping the package initializer dependency-light lets the installer run the
    configuration CLI with a bootstrap Python that does not own the observed
    project's LlamaIndex environment.
    """

    if name not in {"flush", "instrument", "setup", "shutdown", "uninstrument"}:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    instrumentation = import_module(".instrumentation", __name__)
    value = instrumentation.instrument if name == "setup" else getattr(instrumentation, name)
    globals()[name] = value
    return value


def __dir__() -> list[str]:
    return sorted(set(globals()) | set(__all__))
