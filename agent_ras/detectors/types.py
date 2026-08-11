# coding: utf-8
"""Plugin contracts for detectors / review / recovery domain modules."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Literal, Mapping, Sequence

from pydantic import BaseModel

from agents.ras_agents import RASAgents
from detectors.base import Detector
from recovery.engine import RecoveryAction

Anchor = Literal["llm", "tool"]


@dataclass(frozen=True)
class DetectorPlugin:
    """Detection-side domain registration (lives under ``detectors/``)."""

    id: str
    kinds: Sequence[str]
    kind_to_domain: Mapping[str, str]
    config_model: type[BaseModel]
    factory: Callable[[BaseModel, RASAgents], Detector | None]
    detection_skill: str | None = None
    enabled_by_default: bool = True
    version: int = 1
    anchor: Anchor | None = None
    # Lower runs first in the member detector list (first-hit dispatch).
    priority: int = 100


@dataclass(frozen=True)
class ReviewPlugin:
    """Semantic review / judge skill binding (lives under ``review/``)."""

    id: str
    review_skill: str
    version: int = 1


@dataclass(frozen=True)
class RecoveryPlugin:
    """Recovery policy + user-facing copy (same module under ``recovery/``)."""

    id: str
    kind_overrides: Mapping[str, Sequence[RecoveryAction]] = field(default_factory=dict)
    stream_kinds: Sequence[str] = ()
    anchor: Anchor = "llm"
    messages: Mapping[str, Mapping[str, str]] = field(default_factory=dict)
    version: int = 1


__all__ = [
    "Anchor",
    "DetectorPlugin",
    "RecoveryPlugin",
    "ReviewPlugin",
]
