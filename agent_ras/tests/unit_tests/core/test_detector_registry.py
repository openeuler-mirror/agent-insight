# coding: utf-8
from __future__ import annotations

from core.config import AgentRASConfig
from detectors.loader import detector_config_models, detector_plugins
from detectors.registry import build_member_detectors
from detectors.types import DetectorPlugin
from ras_runtime.session_hub import SessionState


def _plugin_owns(plugin: DetectorPlugin, detector) -> bool:
    return detector.name in plugin.kinds or detector.name == plugin.id


def test_build_member_detectors_respects_enabled() -> None:
    config = AgentRASConfig()
    models = detector_config_models()
    assert models
    for domain_id in models:
        getattr(config.detectors, domain_id).enabled = False
    assert build_member_detectors(config) == []


def test_build_member_detectors_partial_enabled() -> None:
    config = AgentRASConfig()
    plugins = detector_plugins()
    assert plugins
    sample = next(iter(plugins.values()))
    for plugin in plugins.values():
        getattr(config.detectors, plugin.id).enabled = plugin.id == sample.id
    dets = build_member_detectors(config)
    assert dets
    for detector in dets:
        assert _plugin_owns(sample, detector)
    for plugin in plugins.values():
        if plugin.id == sample.id:
            continue
        assert not any(_plugin_owns(plugin, detector) for detector in dets)


def test_session_hub_gating_consistent_with_registry() -> None:
    """SessionHub 与 Monitor 同一注册入口：config 关停即不安装，无协议侧特权。"""
    plugins = detector_plugins()
    sample = next(iter(plugins.values()))
    state = SessionState.create(
        "s1",
        "unknown_platform",
        {sample.id: {"enabled": False}},
    )
    assert not any(_plugin_owns(sample, d) for d in state.detectors)

    state_on = SessionState.create(
        "s2",
        "unknown_platform",
        {sample.id: {"enabled": True}},
    )
    assert any(_plugin_owns(sample, d) for d in state_on.detectors)


def test_session_hub_nested_unique_field() -> None:
    """Domain-id hello writes only that domain; top-level field names are ignored."""
    models = detector_config_models()
    owners: dict[str, list[str]] = {}
    for name, model_cls in models.items():
        for fname in model_cls.model_fields:
            owners.setdefault(fname, []).append(name)

    domain_id: str | None = None
    field_name: str | None = None
    sample_value: int | None = None
    builtin: int | None = None
    for name, model_cls in models.items():
        current = model_cls()
        for fname in model_cls.model_fields:
            if fname == "enabled" or len(owners.get(fname, [])) != 1:
                continue
            val = getattr(current, fname)
            if isinstance(val, int) and not isinstance(val, bool):
                domain_id = name
                field_name = fname
                builtin = val
                sample_value = val + 2 if val else 7
                break
        if domain_id:
            break
    assert domain_id and field_name and sample_value is not None and builtin is not None

    nested = SessionState.create(
        "s3",
        "unknown_platform",
        {domain_id: {"enabled": True, field_name: sample_value}},
    )
    plugin = detector_plugins()[domain_id]
    owned = [d for d in nested.detectors if _plugin_owns(plugin, d)]
    assert owned
    assert getattr(owned[0]._config, field_name) == sample_value

    ignored = SessionState.create(
        "s4",
        "unknown_platform",
        {field_name: sample_value, "enabled": False},
    )
    owned_ignored = [d for d in ignored.detectors if _plugin_owns(plugin, d)]
    assert owned_ignored
    assert getattr(owned_ignored[0]._config, field_name) == builtin
