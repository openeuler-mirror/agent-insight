"""Fault catalog: models, registry, scenarios, capability API."""

from .catalog import add_fault, default_skills_root, load_fault_definition
from .models import FaultDefinition, InjectionStep
from .registry import FaultRegistry, get_fault_registry, invalidate_fault_registry
from .ui_catalog import get_fault_ui_catalog, load_fault_ui_catalog

__all__ = [
    "FaultDefinition",
    "FaultRegistry",
    "InjectionStep",
    "add_fault",
    "default_skills_root",
    "get_fault_registry",
    "get_fault_ui_catalog",
    "invalidate_fault_registry",
    "load_fault_definition",
    "load_fault_ui_catalog",
]
