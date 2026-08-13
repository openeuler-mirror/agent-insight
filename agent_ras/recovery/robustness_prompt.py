# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""Generic robustness prompt rendering. Domain copy lives in recovery/<domain>.py."""
from __future__ import annotations

from typing import Any

from core.models import Anomaly
from recovery.state import PendingRecovery

robustness_prompts_cn: dict[str, str] = {
    "generic_recovery_user_notice": (
        "检测到 {kind_label} 异常，已执行恢复操作"
    ),
    "interrupted_abnormal_degrade_user_notice": (
        "异常恢复中断且无法完成收尾，已按正常路径降级处理"
    ),
    "platform_abort_unconfirmed_user_notice": (
        "无法确认已截断当前生成流，请手动停止（Esc / Abort）。"
        "停止后将尝试纠偏续作。"
    ),
    "generic_steer": (
        "检测到 {kind} 异常（{summary}），"
        "请尝试调整参数、更换工具/策略，"
        "或在已有证据充分时结束任务。"
    ),
}

robustness_prompts_en: dict[str, str] = {
    "generic_recovery_user_notice": (
        "Detected a {kind_label} anomaly; recovery has been applied"
    ),
    "interrupted_abnormal_degrade_user_notice": (
        "Abnormal recovery was interrupted and could not be completed; "
        "degraded to the normal path"
    ),
    "platform_abort_unconfirmed_user_notice": (
        "Could not confirm the generation stream was stopped. "
        "Please stop it manually (Esc / Abort); steering will retry after idle."
    ),
    "generic_steer": (
        "Detected {kind} anomaly ({summary}). "
        "Please adjust parameters, switch tools/strategy, "
        "or finish the task if enough evidence has been gathered."
    ),
}

cn_messages = robustness_prompts_cn
en_messages = robustness_prompts_en

_LOCALES: dict[str, dict[str, str]] = {
    "cn": robustness_prompts_cn,
    "zh": robustness_prompts_cn,
    "en": robustness_prompts_en,
}
_DEFAULT_LOCALE = "cn"

_STEERING_OPEN = "<system-reminder>"
_STEERING_CLOSE = "</system-reminder>"


def _table(locale: str) -> dict[str, str]:
    loc = (locale or "cn").strip().lower()
    if loc == "zh":
        loc = "cn"
    return _LOCALES.get(loc) or _LOCALES[_DEFAULT_LOCALE]


def load_message(locale: str, key: str, **kwargs: Any) -> str:
    """Render a robustness prompt template (public API)."""
    table = _table(locale)
    template = table.get(key)
    if template is None:
        template = _LOCALES[_DEFAULT_LOCALE].get(key)
    if template is None:
        raise KeyError(
            f"prompt key {key!r} not found in locale {locale!r} "
            f"or fallback {_DEFAULT_LOCALE!r}"
        )
    try:
        return template.format(**kwargs)
    except (KeyError, IndexError):
        return template


def render(template_key: str, locale: str = "cn", **kwargs: Any) -> str:
    template = _table(locale).get(template_key) or template_key
    try:
        return template.format(**kwargs)
    except (KeyError, IndexError):
        return template


def format_steering(body: str) -> str:
    """Wrap steering body in the standard ``<system-reminder>`` envelope."""
    text = (body or "").strip()
    if not text:
        return text
    if text.startswith(_STEERING_OPEN) and text.endswith(_STEERING_CLOSE):
        return text
    inner = text
    if inner.startswith(_STEERING_OPEN):
        inner = inner[len(_STEERING_OPEN):].lstrip("\n")
    if inner.endswith(_STEERING_CLOSE):
        inner = inner[: -len(_STEERING_CLOSE)].rstrip()
    return f"{_STEERING_OPEN}\n{inner}\n{_STEERING_CLOSE}"


def _scalar_fields(mapping: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in mapping.items():
        if isinstance(value, (dict, list, tuple)):
            continue
        out[key] = value
    return out


def _anomaly_fields(anomaly: Anomaly) -> dict[str, Any]:
    evidence = dict(anomaly.evidence or {})
    kind = str(getattr(anomaly.kind, "value", anomaly.kind))
    fields = _scalar_fields(evidence)
    fields.update(
        {
            "tool_name": anomaly.member_name,
            "member_name": anomaly.member_name,
            "summary": anomaly.summary,
            "kind": kind,
            "count": int(evidence.get("count") or 0),
            "tool_arguments": str(evidence.get("tool_arguments") or ""),
            "mode": str(evidence.get("mode") or ""),
            "repeats": evidence.get("repeats") or evidence.get("count") or 0,
        }
    )
    return fields


def _pending_fields(pending: PendingRecovery) -> dict[str, Any]:
    fields = _scalar_fields(dict(pending.extra or {}))
    fields.update(
        {
            "mode": pending.mode,
            "count": pending.count,
            "summary": str(fields.get("summary") or ""),
        }
    )
    return fields


def _ensure_messages_loaded() -> None:
    from detectors.loader import ensure_domains_loaded

    ensure_domains_loaded()


def _resolve_template_key(
    evidence: dict[str, Any],
    role: str,
    *,
    domain: str | None,
) -> str | None:
    _ensure_messages_loaded()
    from detectors.loader import DOMAIN_MESSAGES, msg_template_for

    explicit = {
        "steer": "steer_key",
        "notice": "notice_key",
        "critical": "critical_key",
    }.get(role)
    if explicit:
        raw = evidence.get(explicit)
        if raw:
            return str(raw)
    msg_key = str(evidence.get("msg_key") or "").strip()
    if msg_key:
        aliased = msg_template_for(role, msg_key)
        if aliased:
            return aliased
        if _table("cn").get(msg_key) or _table("en").get(msg_key):
            return msg_key
    default_key = {
        "steer": "steer_default",
        "notice": "notice_default",
        "critical": "critical_default",
    }.get(role)
    if default_key and domain:
        table = (DOMAIN_MESSAGES.get(domain) or {}).get("cn") or {}
        if default_key in table:
            return default_key
    return None


def _fault_domain(anomaly: Anomaly | None, extra: dict[str, Any] | None) -> str | None:
    if extra:
        domain = str(extra.get("fault_domain") or "").strip()
        if domain:
            return domain
    if anomaly is None:
        return None
    evidence = anomaly.evidence or {}
    domain = str(evidence.get("fault_domain") or "").strip()
    if domain:
        return domain
    from detectors.loader import fault_domain_for_kind

    return fault_domain_for_kind(anomaly.kind)


def steer_text_for(anomaly: Anomaly, locale: str = "cn") -> str | None:
    evidence = dict(anomaly.evidence or {})
    domain = _fault_domain(anomaly, evidence)
    key = _resolve_template_key(evidence, "steer", domain=domain)
    if not key:
        return None
    return format_steering(render(key, locale, **_anomaly_fields(anomaly)))


def user_warning_text_for(anomaly: Anomaly, locale: str = "cn") -> str | None:
    evidence = dict(anomaly.evidence or {})
    domain = _fault_domain(anomaly, evidence)
    key = _resolve_template_key(evidence, "notice", domain=domain)
    if not key:
        return None
    fields = _anomaly_fields(anomaly)
    fields.pop("tool_arguments", None)
    return render(key, locale, **fields)


def user_notice_text_for(anomaly: Anomaly, locale: str = "cn") -> str | None:
    """Short user-facing notice for any anomaly (detector-specific when available)."""
    return user_warning_text_for(anomaly, locale=locale)


def _kind_label_for(anomaly: Anomaly, locale: str) -> str:
    from detectors.loader import kind_label

    return kind_label(anomaly.kind, locale)


def interrupted_abnormal_degrade_user_notice(locale: str = "cn") -> str:
    """ZZP-004 last-resort notice when abort ran but pending was lost before commit."""
    return render("interrupted_abnormal_degrade_user_notice", locale)


def platform_abort_unconfirmed_user_notice(locale: str = "cn") -> str:
    """Host-side notice when abort/interrupt cannot be confirmed mid-stream."""
    return render("platform_abort_unconfirmed_user_notice", locale)


def host_messages_for_locale(locale: str = "cn") -> dict[str, str]:
    """Small message bag for L3 hosts (platform delivery only; text from core)."""
    loc = (locale or "cn").strip().lower()
    if loc == "zh":
        loc = "cn"
    return {
        "platform_abort_unconfirmed_user_notice": platform_abort_unconfirmed_user_notice(
            loc
        ),
    }


def recovery_user_notice_for(pending: PendingRecovery, locale: str = "cn") -> str:
    """User-facing notice after automatic recovery is applied."""
    extra = dict(pending.extra or {})
    domain = _fault_domain(None, extra)
    key = _resolve_template_key(extra, "notice", domain=domain)
    if key:
        return render(key, locale, **_pending_fields(pending))
    return render("generic_recovery_user_notice", locale, kind_label=pending.source)


def recovery_user_notice_for_anomaly(anomaly: Anomaly, locale: str = "cn") -> str:
    """Recovery notice from an anomaly (immediate apply path)."""
    pending = PendingRecovery.from_anomaly(anomaly)
    extra = dict(pending.extra or {})
    domain = _fault_domain(anomaly, extra)
    key = _resolve_template_key(extra, "notice", domain=domain)
    if key:
        return recovery_user_notice_for(pending, locale=locale)
    return render(
        "generic_recovery_user_notice",
        locale,
        kind_label=_kind_label_for(anomaly, locale),
    )


def critical_text_for(anomaly: Anomaly, locale: str = "cn") -> str:
    evidence = dict(anomaly.evidence or {})
    domain = _fault_domain(anomaly, evidence)
    key = _resolve_template_key(evidence, "critical", domain=domain)
    if not key:
        key = str(evidence.get("msg_key") or "") or "critical_default"
    return render(key, locale, **_anomaly_fields(anomaly))


def generic_steer_text_for(anomaly: Anomaly, locale: str = "cn") -> str:
    return format_steering(
        render(
            "generic_steer",
            locale,
            kind=str(getattr(anomaly.kind, "value", anomaly.kind)),
            summary=anomaly.summary,
        )
    )


def recovery_steering_on_abnormal(pending: PendingRecovery, locale: str = "cn") -> str:
    """Steering injected after automatic recovery confirms an abnormal stream kind."""
    extra = dict(pending.extra or {})
    domain = _fault_domain(None, extra)
    key = _resolve_template_key(extra, "steer", domain=domain)
    if not key:
        return format_steering(render("generic_steer", locale, kind=pending.source, summary=""))
    return format_steering(render(key, locale, **_pending_fields(pending)))


def format_repeat_display(scanned_text: str, start_pos: int, max_len: int = 1200) -> str:
    if not scanned_text:
        return ""
    text = scanned_text[start_pos:] if start_pos > 0 else scanned_text
    if len(text) > max_len:
        return text[:max_len] + "…"
    return text


def extract_repeat_unit(scanned_text: str, start_pos: int, max_unit: int = 200) -> str:
    unit = format_repeat_display(scanned_text, start_pos, max_len=max_unit)
    return unit or "(无法提取重复片段)"
