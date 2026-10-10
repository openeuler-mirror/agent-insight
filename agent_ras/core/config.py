# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""Per-agent Agent RAS configuration (single-Agent)."""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from core.models import Severity
from recovery.engine import (
    DEFAULT_SEVERITY_ACTIONS,
    RecoveryAction,
)


class DetectorsConfig(BaseModel):
    """Toggle + thresholds for every detector.

    Domain configs live on each ``DETECTOR_PLUGIN.config_model`` and are
    coerced here via ``extra="allow"``.
    """

    model_config = ConfigDict(extra="allow")

    @model_validator(mode="before")
    @classmethod
    def _coerce_plugin_domains(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        try:
            from detectors.loader import detector_plugins

            plugins = detector_plugins()
        except Exception:
            return data
        out = dict(data)
        for domain_id, plugin in plugins.items():
            raw = out.get(domain_id)
            if raw is None:
                continue
            if isinstance(raw, plugin.config_model):
                continue
            if isinstance(raw, BaseModel):
                out[domain_id] = plugin.config_model(**raw.model_dump())
            elif isinstance(raw, dict):
                out[domain_id] = plugin.config_model(**raw)
        return out

    @model_validator(mode="after")
    def _fill_plugin_defaults(self) -> "DetectorsConfig":
        try:
            from detectors.loader import detector_plugins

            plugins = detector_plugins()
        except Exception:
            return self
        extras = self.__pydantic_extra__
        if extras is None:
            extras = {}
            object.__setattr__(self, "__pydantic_extra__", extras)
        for domain_id, plugin in plugins.items():
            current = extras.get(domain_id, getattr(self, domain_id, None))
            if current is None:
                extras[domain_id] = plugin.config_model()
            elif isinstance(current, dict):
                extras[domain_id] = plugin.config_model(**current)
            elif not isinstance(current, plugin.config_model):
                if isinstance(current, BaseModel):
                    extras[domain_id] = plugin.config_model(**current.model_dump())
        return self


class RecoveryConfig(BaseModel):
    """Recovery-side knobs (parallel to ``detectors``)."""

    model_config = ConfigDict(extra="forbid")

    # LOW 警告时是否向用户推送可见 notice（steering 始终按 policy 执行）
    notify_user_on_warning: bool = True


class RecoveryPolicyConfig(BaseModel):
    """Severity-to-action mapping; optional per-kind overrides."""

    model_config = ConfigDict(extra="forbid")

    severity_actions: dict[Severity, list[RecoveryAction]] = Field(
        default_factory=lambda: dict(DEFAULT_SEVERITY_ACTIONS),
    )
    kind_overrides: dict[str, list[RecoveryAction]] = Field(
        default_factory=dict,
        description="Optional per-kind action overrides (empty = use severity only)",
    )


def coerce_message_locale(language: str | None) -> str:
    """Map DeepAgent / prompt language to Agent RAS message locale (cn/en).

    Not a config field — mirrors how SecurityRail / SkillUseRail read
    ``system_prompt_builder.language`` at runtime.
    """
    loc = (language or "cn").strip().lower()
    if loc in ("en", "english"):
        return "en"
    if loc in ("zh", "zh-cn", "zhcn", "chinese", "cn"):
        return "cn"
    return "cn"


class AgentRASConfig(BaseModel):
    """Per-agent Agent RAS framework configuration."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    detectors: DetectorsConfig = Field(default_factory=DetectorsConfig)
    recovery: RecoveryConfig = Field(default_factory=RecoveryConfig)
    policy: RecoveryPolicyConfig = Field(default_factory=RecoveryPolicyConfig)
