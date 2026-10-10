# coding: utf-8
"""Scan detectors/ / review/ / recovery/ for *_PLUGIN and join by domain id."""
from __future__ import annotations

import importlib
import logging
import pkgutil
import threading
from pathlib import Path
from types import ModuleType
from typing import Any, Callable

from agents.base import NoOpAgentAdapter
from agents.ras_agents import RASAgents
from core.config import AgentRASConfig
from detectors.base import Detector
from detectors.types import DetectorPlugin, RecoveryPlugin, ReviewPlugin
from recovery.engine import RecoveryAction

logger = logging.getLogger(__name__)

_AGENT_RAS_ROOT = Path(__file__).resolve().parent.parent

_DETECTOR_SKIP = frozenset(
    {
        "base",
        "registry",
        "loader",
        "types",
        "catalog",
        "skill_verdicts",
        "__init__",
    }
)
_REVIEW_SKIP = frozenset({"__init__"})
_RECOVERY_SKIP = frozenset(
    {
        "engine",
        "operations",
        "state",
        "robustness_prompt",
        "__init__",
    }
)

_lock = threading.RLock()
_loaded = False

_detector_plugins: dict[str, DetectorPlugin] = {}
_review_plugins: dict[str, ReviewPlugin] = {}
_recovery_plugins: dict[str, RecoveryPlugin] = {}

# Joined runtime registries
KIND_TO_DOMAIN: dict[str, str] = {}
DOMAIN_SKILLS: dict[str, dict[str, str]] = {}
KIND_OVERRIDES: dict[str, list[RecoveryAction]] = {}
STREAM_KINDS: set[str] = set()
KIND_ANCHOR: dict[str, str] = {}
DOMAIN_MESSAGES: dict[str, dict[str, dict[str, str]]] = {}
TERMINATE_KINDS: set[str] = set()
MSG_KEY_TEMPLATES: dict[str, dict[str, str]] = {
    "steer": {},
    "notice": {},
    "critical": {},
}
KIND_LABELS: dict[str, dict[str, str]] = {}


def _import_package_modules(
    package_name: str,
    skip: frozenset[str],
) -> list[ModuleType]:
    try:
        package = importlib.import_module(package_name)
    except ImportError:
        return []
    pkg_path = getattr(package, "__path__", None)
    if pkg_path is None:
        return []
    modules: list[ModuleType] = []
    for info in pkgutil.iter_modules(pkg_path):
        if info.name in skip or info.name.startswith("_"):
            continue
        if info.ispkg:
            continue
        full = f"{package_name}.{info.name}"
        try:
            modules.append(importlib.import_module(full))
        except Exception:
            logger.exception("failed to import domain module %s", full)
    return modules


def _rebuild_joined() -> None:
    KIND_TO_DOMAIN.clear()
    DOMAIN_SKILLS.clear()
    KIND_OVERRIDES.clear()
    STREAM_KINDS.clear()
    KIND_ANCHOR.clear()
    DOMAIN_MESSAGES.clear()
    TERMINATE_KINDS.clear()
    for role in MSG_KEY_TEMPLATES:
        MSG_KEY_TEMPLATES[role].clear()
    KIND_LABELS.clear()

    from detectors.skill_verdicts import clear_skill_parsers, register_skill_parser

    clear_skill_parsers()

    for plugin in _detector_plugins.values():
        for kind, domain in plugin.kind_to_domain.items():
            KIND_TO_DOMAIN[str(kind)] = str(domain)
        skills = DOMAIN_SKILLS.setdefault(plugin.id, {})
        if plugin.detection_skill:
            skills["detection"] = plugin.detection_skill
            if plugin.verdict_parser is not None:
                register_skill_parser(plugin.detection_skill, plugin.verdict_parser)
        if plugin.anchor:
            for kind in plugin.kinds:
                KIND_ANCHOR[str(kind)] = plugin.anchor
        presentation = plugin.presentation
        if presentation is not None:
            loc_label = dict(presentation.label) if presentation.label else {}
            zh = str(loc_label.get("zh") or loc_label.get("cn") or "")
            en = str(loc_label.get("en") or "")
            for kind in plugin.kinds:
                KIND_LABELS.setdefault(str(kind), {})
                if zh:
                    KIND_LABELS[str(kind)].setdefault("cn", zh)
                if en:
                    KIND_LABELS[str(kind)].setdefault("en", en)
            for sm in presentation.submodes:
                kind = str(sm.anomaly_kind)
                parent = dict(sm.parent or {})
                KIND_LABELS.setdefault(kind, {})
                if parent.get("zh"):
                    KIND_LABELS[kind]["cn"] = str(parent["zh"])
                if parent.get("en"):
                    KIND_LABELS[kind]["en"] = str(parent["en"])

    for plugin in _review_plugins.values():
        skills = DOMAIN_SKILLS.setdefault(plugin.id, {})
        skills["review"] = plugin.review_skill
        if plugin.verdict_parser is not None:
            register_skill_parser(plugin.review_skill, plugin.verdict_parser)

    for plugin in _recovery_plugins.values():
        for kind, actions in plugin.kind_overrides.items():
            KIND_OVERRIDES[str(kind)] = list(actions)
        for kind in plugin.stream_kinds:
            STREAM_KINDS.add(str(kind))
            KIND_ANCHOR.setdefault(str(kind), plugin.anchor)
        if plugin.messages:
            DOMAIN_MESSAGES[plugin.id] = {
                loc: dict(table) for loc, table in plugin.messages.items()
            }
        for kind in plugin.terminate_kinds:
            TERMINATE_KINDS.add(str(kind))
        for role, table in plugin.msg_key_templates.items():
            target = MSG_KEY_TEMPLATES.setdefault(str(role), {})
            for msg_key, template_key in table.items():
                target[str(msg_key)] = str(template_key)
        # Recovery anchor fills kinds that only appear in overrides/stream
        for kind in plugin.kind_overrides:
            KIND_ANCHOR.setdefault(str(kind), plugin.anchor)


def reset_domains_for_tests() -> None:
    """Clear loader state (unit tests)."""
    global _loaded
    with _lock:
        _loaded = False
        _detector_plugins.clear()
        _review_plugins.clear()
        _recovery_plugins.clear()
        _rebuild_joined()


def ensure_domains_loaded(*, force: bool = False) -> None:
    """Import domain modules once and rebuild joined registries."""
    global _loaded
    with _lock:
        if _loaded and not force:
            return
        _detector_plugins.clear()
        _review_plugins.clear()
        _recovery_plugins.clear()

        for mod in _import_package_modules("detectors", _DETECTOR_SKIP):
            plugin = getattr(mod, "DETECTOR_PLUGIN", None)
            if isinstance(plugin, DetectorPlugin):
                if plugin.id in _detector_plugins:
                    logger.error(
                        "duplicate DETECTOR_PLUGIN id=%s in %s; keeping first",
                        plugin.id,
                        mod.__name__,
                    )
                    continue
                _detector_plugins[plugin.id] = plugin

        for mod in _import_package_modules("review", _REVIEW_SKIP):
            plugin = getattr(mod, "REVIEW_PLUGIN", None)
            if isinstance(plugin, ReviewPlugin):
                if plugin.id in _review_plugins:
                    logger.error(
                        "duplicate REVIEW_PLUGIN id=%s in %s; keeping first",
                        plugin.id,
                        mod.__name__,
                    )
                    continue
                _review_plugins[plugin.id] = plugin

        for mod in _import_package_modules("recovery", _RECOVERY_SKIP):
            plugin = getattr(mod, "RECOVERY_PLUGIN", None)
            if isinstance(plugin, RecoveryPlugin):
                if plugin.id in _recovery_plugins:
                    logger.error(
                        "duplicate RECOVERY_PLUGIN id=%s in %s; keeping first",
                        plugin.id,
                        mod.__name__,
                    )
                    continue
                _recovery_plugins[plugin.id] = plugin

        _rebuild_joined()
        _sync_agents_skill_tables()
        _merge_recovery_messages()
        _loaded = True


def _sync_agents_skill_tables() -> None:
    """Push joined skill / kind maps into agents.base mutable registries."""
    from agents import base as agents_base

    agents_base.FAULT_DOMAIN_SKILLS.clear()
    agents_base.FAULT_DOMAIN_SKILLS.update(
        {domain: dict(skills) for domain, skills in DOMAIN_SKILLS.items()}
    )
    agents_base._KIND_TO_FAULT_DOMAIN.clear()
    agents_base._KIND_TO_FAULT_DOMAIN.update(dict(KIND_TO_DOMAIN))


def _merge_recovery_messages() -> None:
    """Merge domain message tables into robustness_prompt locale catalogs."""
    try:
        from recovery import robustness_prompt as rp
    except ImportError:
        return
    for _domain, by_locale in DOMAIN_MESSAGES.items():
        for loc, table in by_locale.items():
            loc_key = "cn" if loc in ("cn", "zh") else loc
            target = rp._LOCALES.get(loc_key)
            if target is None:
                continue
            target.update(table)


def fault_domain_for_kind(kind: Any) -> str | None:
    ensure_domains_loaded()
    key = getattr(kind, "value", kind)
    return KIND_TO_DOMAIN.get(str(key or "").strip())


def skill_for(fault_domain: str, role: str) -> str:
    ensure_domains_loaded()
    domain = str(fault_domain or "").strip()
    role_key = str(role or "").strip()
    skills = DOMAIN_SKILLS.get(domain)
    if not skills or role_key not in skills:
        raise ValueError(
            f"unknown skill role {role!r} for fault domain {fault_domain!r}; "
            f"known={sorted((skills or {}).keys())}"
        )
    return skills[role_key]


def is_stream_kind(kind: Any) -> bool:
    ensure_domains_loaded()
    key = getattr(kind, "value", kind)
    return str(key or "").strip() in STREAM_KINDS


def anchor_for_kind(kind: Any) -> str | None:
    ensure_domains_loaded()
    key = getattr(kind, "value", kind)
    return KIND_ANCHOR.get(str(key or "").strip())


def detector_plugins() -> dict[str, DetectorPlugin]:
    ensure_domains_loaded()
    return dict(_detector_plugins)


def recovery_kind_overrides() -> dict[str, list[RecoveryAction]]:
    ensure_domains_loaded()
    return {k: list(v) for k, v in KIND_OVERRIDES.items()}


def recovery_terminate_kinds() -> set[str]:
    ensure_domains_loaded()
    return set(TERMINATE_KINDS)


def msg_template_for(role: str, msg_key: str) -> str | None:
    ensure_domains_loaded()
    key = str(msg_key or "").strip()
    if not key:
        return None
    return MSG_KEY_TEMPLATES.get(str(role), {}).get(key)


def kind_label(kind: Any, locale: str = "cn") -> str:
    ensure_domains_loaded()
    key = str(getattr(kind, "value", kind) or "").strip()
    loc = "en" if str(locale or "").strip().lower() == "en" else "cn"
    labels = KIND_LABELS.get(key) or {}
    return labels.get(loc) or key


def detector_config_models() -> dict[str, type]:
    """Map domain id → config model class from DETECTOR_PLUGIN."""
    ensure_domains_loaded()
    return {pid: p.config_model for pid, p in _detector_plugins.items()}


def build_member_detectors(
    config: AgentRASConfig,
    agents: RASAgents | None = None,
) -> list[Detector]:
    """Build detectors from DETECTOR_PLUGIN factories."""
    ensure_domains_loaded()
    agents = agents or RASAgents(NoOpAgentAdapter())
    out: list[Detector] = []
    for plugin in sorted(
        _detector_plugins.values(),
        key=lambda p: (p.priority, p.id),
    ):
        cfg_obj = getattr(config.detectors, plugin.id, None)
        if cfg_obj is None:
            cfg_obj = plugin.config_model()
        elif not isinstance(cfg_obj, plugin.config_model):
            if isinstance(cfg_obj, dict):
                cfg_obj = plugin.config_model(**cfg_obj)
            else:
                cfg_obj = plugin.config_model(**cfg_obj.model_dump())
        detector = plugin.factory(cfg_obj, agents)
        if detector is not None:
            out.append(detector)
    return out


__all__ = [
    "KIND_LABELS",
    "KIND_OVERRIDES",
    "KIND_TO_DOMAIN",
    "MSG_KEY_TEMPLATES",
    "STREAM_KINDS",
    "TERMINATE_KINDS",
    "anchor_for_kind",
    "build_member_detectors",
    "detector_config_models",
    "detector_plugins",
    "ensure_domains_loaded",
    "fault_domain_for_kind",
    "is_stream_kind",
    "kind_label",
    "msg_template_for",
    "recovery_kind_overrides",
    "recovery_terminate_kinds",
    "reset_domains_for_tests",
    "skill_for",
]
