"""Fault catalog: models, registry, scenarios, capability API."""

from .definition import (
    FaultRegistry,
    add_fault,
    default_skills_root,
    get_fault_registry,
    invalidate_fault_registry,
    load_fault_definition,
)
from .models import FaultDefinition, InjectionStep
from .presentation import get_fault_ui_catalog, load_fault_ui_catalog

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
