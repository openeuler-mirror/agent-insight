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
class PromptPresentation:
    key: str
    role: Literal["steering", "notice", "critical"]
    severity_band: str | None = None
    label: Mapping[str, str] | None = None
    template_zh: str | None = None
    template_en: str | None = None


@dataclass(frozen=True)
class SubmodePresentation:
    """UI row for one sub-mode; ``runtime_keys`` maps to anomaly.evidence."""

    id: str
    parent_id: str
    parent: Mapping[str, str]
    sub_mode: Mapping[str, str]
    anomaly_kind: str
    detection_level: Literal["L1", "L2", "L3"] | None
    severities: Sequence[str]
    detects: Mapping[str, str]
    recovery_summary: Mapping[str, str]
    recovery_actions: Sequence[str]
    runtime_keys: Mapping[str, str] = field(default_factory=dict)
    prompts: Sequence[PromptPresentation] = ()
    primary_faults: Sequence[str] = ()


@dataclass(frozen=True)
class DomainPresentation:
    """Optional Insight UI metadata attached to ``DetectorPlugin``."""

    order: int = 100
    label: Mapping[str, str] | None = None
    submodes: Sequence[SubmodePresentation] = ()


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
    presentation: DomainPresentation | None = None


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
    "DomainPresentation",
    "PromptPresentation",
    "RecoveryPlugin",
    "ReviewPlugin",
    "SubmodePresentation",
]
