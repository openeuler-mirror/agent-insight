"""Behavioral fault definitions and installation helpers."""

from .catalog.models import FaultDefinition
from .catalog.registry import FaultRegistry

__all__ = ["FaultDefinition", "FaultRegistry"]
