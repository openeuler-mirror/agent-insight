from .config import CollectorConfig
from .context import trace_context
from .instrumentation import flush, instrument, shutdown, uninstrument

setup = instrument

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
