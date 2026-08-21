# coding: utf-8
"""Assemble capability catalog from DETECTOR/REVIEW/RECOVERY plugins."""
from __future__ import annotations

from typing import Any, Mapping

from detectors.types import (
    DetectorPlugin,
    DomainPresentation,
    PromptPresentation,
    RecoveryPlugin,
    SubmodePresentation,
)


def _action_value(action: Any) -> str:
    return str(getattr(action, "value", action))


def _lookup_message(
    key: str,
    *,
    locale: str,
    recovery: RecoveryPlugin | None,
) -> str | None:
    """Resolve prompt template from recovery.messages, then robustness_prompt."""
    if recovery and recovery.messages:
        if locale == "zh":
            for loc in ("zh", "cn"):
                table = recovery.messages.get(loc)
                if isinstance(table, Mapping) and key in table:
                    return str(table[key])
        else:
            table = recovery.messages.get("en")
            if isinstance(table, Mapping) and key in table:
                return str(table[key])
    try:
        from recovery import robustness_prompt as rp

        loc_key = "cn" if locale == "zh" else "en"
        table = rp._LOCALES.get(loc_key) or {}
        if key in table:
            return str(table[key])
    except Exception:
        pass
    return None


def _fill_prompt(
    prompt: PromptPresentation,
    recovery: RecoveryPlugin | None,
) -> dict[str, Any]:
    template_zh = prompt.template_zh
    template_en = prompt.template_en
    if template_zh is None:
        template_zh = _lookup_message(prompt.key, locale="zh", recovery=recovery)
    if template_en is None:
        template_en = _lookup_message(prompt.key, locale="en", recovery=recovery)
    out: dict[str, Any] = {
        "key": prompt.key,
        "role": prompt.role,
        "templateZh": template_zh,
        "templateEn": template_en,
    }
    if prompt.severity_band is not None:
        out["severityBand"] = prompt.severity_band
    if prompt.label is not None:
        out["label"] = dict(prompt.label)
    return out


def _submode_dict(
    submode: SubmodePresentation,
    *,
    recovery: RecoveryPlugin | None,
    domain_id: str | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": submode.id,
        "parentId": submode.parent_id,
        "parent": dict(submode.parent),
        "subMode": dict(submode.sub_mode),
        "anomalyKind": submode.anomaly_kind,
        "severities": list(submode.severities),
        "detects": dict(submode.detects),
        "recoverySummary": dict(submode.recovery_summary),
        "recoveryActions": list(submode.recovery_actions),
        "runtimeKeys": dict(submode.runtime_keys),
        "prompts": [
            _fill_prompt(p, recovery) for p in submode.prompts
        ],
    }
    if submode.primary_faults:
        out["primaryFaults"] = list(submode.primary_faults)
    if domain_id is not None:
        out["domainId"] = domain_id
    return out


def _sort_key(plugin: DetectorPlugin) -> tuple[int, str]:
    presentation = plugin.presentation
    order = (
        presentation.order
        if presentation is not None
        else plugin.priority
    )
    return (order, plugin.id)


def _kind_labels(plugin: DetectorPlugin) -> dict[str, Any]:
    presentation = plugin.presentation
    label = dict(presentation.label) if presentation and presentation.label else None
    out: dict[str, Any] = {}
    for kind in plugin.kinds:
        out[str(kind)] = label if label is not None else str(kind)
    return out


def _domain_entry(
    plugin: DetectorPlugin,
    *,
    review_skill: str | None,
    recovery: RecoveryPlugin | None,
) -> dict[str, Any]:
    presentation: DomainPresentation | None = plugin.presentation
    config_schema = plugin.config_model.model_json_schema()
    config_defaults = plugin.config_model().model_dump()

    stream_kinds: list[str] = []
    kind_overrides: dict[str, list[str]] = {}
    if recovery is not None:
        stream_kinds = [str(k) for k in recovery.stream_kinds]
        kind_overrides = {
            str(kind): [_action_value(a) for a in actions]
            for kind, actions in recovery.kind_overrides.items()
        }

    submodes: list[dict[str, Any]] = []
    if presentation is not None:
        for sm in presentation.submodes:
            submodes.append(_submode_dict(sm, recovery=recovery))

    entry: dict[str, Any] = {
        "id": plugin.id,
        "order": presentation.order if presentation is not None else plugin.priority,
        "label": dict(presentation.label) if presentation and presentation.label else None,
        "kinds": [str(k) for k in plugin.kinds],
        "kindLabels": _kind_labels(plugin),
        "configSchema": config_schema,
        "configDefaults": config_defaults,
        "detection_skill": plugin.detection_skill,
        "review_skill": review_skill,
        "stream_kinds": stream_kinds,
        "kind_overrides": kind_overrides,
        "anchor": plugin.anchor,
        "priority": plugin.priority,
        "enabledByDefault": plugin.enabled_by_default,
        "version": plugin.version,
        "submodes": submodes,
    }
    return entry


def build_capability_catalog() -> dict:
    """Scan loaded domain plugins and return Insight capability catalog."""
    from detectors import loader as ldr
    from detectors.loader import detector_plugins, ensure_domains_loaded

    ensure_domains_loaded()
    plugins = detector_plugins()
    review_plugins = dict(ldr._review_plugins)
    recovery_plugins = dict(ldr._recovery_plugins)

    domains: list[dict[str, Any]] = []
    flat_submodes: list[dict[str, Any]] = []

    for plugin in sorted(plugins.values(), key=_sort_key):
        review = review_plugins.get(plugin.id)
        recovery = recovery_plugins.get(plugin.id)
        review_skill = review.review_skill if review is not None else None
        entry = _domain_entry(
            plugin,
            review_skill=review_skill,
            recovery=recovery,
        )
        domains.append(entry)
        for sm in entry["submodes"]:
            flat = dict(sm)
            flat["domainId"] = plugin.id
            flat_submodes.append(flat)

    return {
        "version": 1,
        "domains": domains,
        "submodes": flat_submodes,
        "recovery": {
            "global": {
                "notify_user_on_warning": True,
            },
        },
    }


__all__ = ["build_capability_catalog"]
