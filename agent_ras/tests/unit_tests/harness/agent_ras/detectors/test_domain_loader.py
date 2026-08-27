# coding: utf-8
"""Unit tests for detectors.loader domain join."""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from agents.ras_agents import RASAgents
from core.config import AgentRASConfig
from detectors.loader import (
    DOMAIN_SKILLS,
    KIND_OVERRIDES,
    KIND_TO_DOMAIN,
    STREAM_KINDS,
    anchor_for_kind,
    build_member_detectors,
    detector_plugins,
    ensure_domains_loaded,
    reset_domains_for_tests,
    skill_for,
)
from detectors.types import DetectorPlugin, RecoveryPlugin, ReviewPlugin
from recovery.engine import RecoveryAction


def test_builtin_domains_join() -> None:
    reset_domains_for_tests()
    ensure_domains_loaded(force=True)
    plugins = detector_plugins()
    assert plugins
    for plugin in plugins.values():
        for kind, domain in plugin.kind_to_domain.items():
            assert KIND_TO_DOMAIN[kind] == domain
            if plugin.anchor:
                assert anchor_for_kind(kind) == plugin.anchor
        skills = DOMAIN_SKILLS.get(plugin.id, {})
        if plugin.detection_skill:
            assert skills.get("detection") == plugin.detection_skill
            assert skill_for(plugin.id, "detection") == plugin.detection_skill


def test_build_member_detectors_order() -> None:
    reset_domains_for_tests()
    ensure_domains_loaded(force=True)
    cfg = AgentRASConfig()
    dets = build_member_detectors(cfg)
    plugins = detector_plugins()

    def _plugin_for(detector) -> DetectorPlugin | None:
        for plugin in plugins.values():
            if detector.name in plugin.kinds or detector.name == plugin.id:
                return plugin
        return None

    prios = []
    for detector in dets:
        plugin = _plugin_for(detector)
        assert plugin is not None
        prios.append((plugin.priority, plugin.id))
    assert prios == sorted(prios)


def test_partial_plugins_join(monkeypatch) -> None:
    """Synthetic only-detect / only-review / only-recovery still join cleanly."""
    reset_domains_for_tests()

    class _Cfg(BaseModel):
        model_config = ConfigDict(extra="forbid")
        enabled: bool = True

    def _factory(cfg: BaseModel, agents: RASAgents):
        del cfg, agents
        return None

    from detectors import loader as ldr

    def _fake_load(*, force: bool = False) -> None:
        del force
        ldr._detector_plugins.clear()
        ldr._review_plugins.clear()
        ldr._recovery_plugins.clear()
        ldr._detector_plugins["only_detect"] = DetectorPlugin(
            id="only_detect",
            kinds=("only_detect_kind",),
            kind_to_domain={"only_detect_kind": "only_detect"},
            config_model=_Cfg,
            factory=_factory,
        )
        ldr._review_plugins["only_review"] = ReviewPlugin(
            id="only_review",
            review_skill="only-review-skill",
        )
        ldr._recovery_plugins["only_recover"] = RecoveryPlugin(
            id="only_recover",
            kind_overrides={
                "only_recover_kind": [RecoveryAction.OBSERVE_ONLY],
            },
            stream_kinds=("only_recover_kind",),
            anchor="llm",
        )
        ldr._rebuild_joined()
        ldr._loaded = True

    monkeypatch.setattr(ldr, "ensure_domains_loaded", _fake_load)
    _fake_load()
    assert "only_detect_kind" in KIND_TO_DOMAIN
    assert DOMAIN_SKILLS["only_review"]["review"] == "only-review-skill"
    assert "only_recover_kind" in STREAM_KINDS
    assert KIND_OVERRIDES["only_recover_kind"] == [RecoveryAction.OBSERVE_ONLY]
    reset_domains_for_tests()
    ensure_domains_loaded(force=True)
