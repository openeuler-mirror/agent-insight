# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""Atomic recovery side effects — host-agnostic via HostControl.

Also owns protocol-path decision → wire actions (``build_recovery_actions``)
and in-proc wire → Host delivery (``apply_recovery_actions``).
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from core.host_control import HostControl, NoOpHostControl
from core.models import Anomaly, AnomalyKind
from core.recovery.robustness_prompt import (
    format_steering,
    interrupted_abnormal_degrade_user_notice,
    recovery_steering_on_abnormal,
    recovery_user_notice_for,
)
from core.recovery.state import (
    PendingRecovery,
    SuppressFlushState,
)

if TYPE_CHECKING:
    from core.recovery.engine import LocalAutoRecovery, RecoveryPolicy

logger = logging.getLogger(__name__)

LLM_STREAM_TYPES = frozenset({"llm_output", "llm_reasoning"})

_THINKING_LOOP_KINDS = frozenset(
    {
        AnomalyKind.LLM_THINKING_LOOP,
        AnomalyKind.LLM_THINKING_DEAD_LOOP,
    }
)


def truncate_chunk_payload(chunk: Any, content: str) -> None:
    """In-place truncate stream chunk payload content."""
    if isinstance(chunk, dict):
        payload = chunk.get("payload")
        if isinstance(payload, dict):
            payload["content"] = content
        return
    payload = getattr(chunk, "payload", None)
    if payload is None:
        return
    if isinstance(payload, dict):
        payload["content"] = content
    else:
        try:
            setattr(payload, "content", content)
        except Exception:
            logger.debug(
                "truncate_chunk_payload: could not set payload.content",
                exc_info=True,
            )


def truncate_chunk_on_hit(
    chunk: Any,
    chunk_text: str,
    *,
    keep_len: int | None = None,
) -> None:
    """Truncate hitting chunk: keep prefix before repeat or clear entirely."""
    if keep_len is not None and keep_len > 0:
        truncate_chunk_payload(chunk, chunk_text[:keep_len])
    else:
        truncate_chunk_payload(chunk, "")


def suppress_and_buffer(
    state: SuppressFlushState,
    chunk_type: str,
    text: str,
    chunk: Any,
) -> None:
    """Buffer suppressed text and truncate outgoing chunk payload."""
    state.record_suppressed(chunk_type, text)
    truncate_chunk_payload(chunk, "")


async def flush_suppressed_stream(
    host: HostControl,
    chunk_type: str,
    content: str,
) -> None:
    """Write buffered suppressed text back to the session stream."""
    if not content:
        return
    await host.write_stream_content(chunk_type, content)


async def inject_steering(host: HostControl, message: str) -> None:
    """Push a self-correction steering message onto the agent context."""
    try:
        text = format_steering(message or "")
        host.push_steering(text)
        logger.info(
            "inject_steering pushed chars=%s prefix=%r",
            len(text),
            text[:80],
        )
    except Exception:
        logger.error("inject_steering failed", exc_info=True)


async def emit_user_notice(host: HostControl, message: str) -> None:
    """Emit a user-visible recovery / warning notice on the session stream."""
    await host.emit_user_notice(message)


async def emit_stream_error(host: HostControl, message: str) -> None:
    """Write an error-typed stream event (critical terminate path)."""
    await host.emit_stream_error(message)


async def terminate(
    host: HostControl,
    message: str,
    *,
    write_error_stream: bool,
) -> None:
    """Force-finish the invoke; optionally emit an error stream event first."""
    if write_error_stream:
        await emit_stream_error(host, message)
    try:
        host.request_force_finish({"output": message, "result_type": "error"})
    except Exception:
        logger.error("terminate failed", exc_info=True)


def pending_from_anomaly(anomaly: Anomaly) -> PendingRecovery:
    """Alias for ``PendingRecovery.from_anomaly`` (executor / Monitor use)."""
    return PendingRecovery.from_anomaly(anomaly)


async def apply_recovery_normal(
    host: HostControl,
    suppress: SuppressFlushState,
    pending: PendingRecovery,
    *,
    locale: str = "cn",
) -> None:
    """Normal / fail-open: flush suppressed buffers and stop suppressing."""
    _ = locale
    chunk_type = pending.chunk_type
    suppress.mark_resolved_normal()
    flushed = suppress.flush_suppressed(chunk_type)
    if flushed:
        await flush_suppressed_stream(host, chunk_type, flushed)


def interrupted_abnormal_degrade_notice(locale: str = "cn") -> str:
    """ZZP-004 degrade copy when finalize cannot re-enter abnormal recovery."""
    return interrupted_abnormal_degrade_user_notice(locale)


async def apply_recovery_abnormal(
    host: HostControl,
    pending: PendingRecovery,
    *,
    locale: str = "cn",
) -> str:
    """Abnormal path: inject recovery steering and return notice text."""
    steering = recovery_steering_on_abnormal(pending, locale=locale)
    logger.info(
        "apply_recovery_abnormal source=%s profile=%s primary_fault=%s "
        "steering_chars=%s",
        pending.source,
        pending.recovery_profile,
        pending.extra.get("primary_fault") or "",
        len(steering),
    )
    await inject_steering(host, steering)
    return recovery_user_notice_for(pending, locale=locale)


def build_recovery_actions(
    anomaly: Anomaly,
    *,
    locale: str = "cn",
    policy: RecoveryPolicy,
    auto: LocalAutoRecovery,
    notify_user_on_warning: bool = True,
) -> list[dict[str, Any]]:
    """Decide wire actions for the protocol path (abort / notice / steer).

    Wire types mirror HostControl: ``abort_stream``, ``emit_notice``,
    ``push_steering``. Platforms deliver; they must not re-decide.
    """
    # Lazy import: engine imports operations at module load.
    from core.recovery.engine import plan_recovery

    actions: list[dict[str, Any]] = [{"type": "abort_stream"}]

    if anomaly.kind in _THINKING_LOOP_KINDS:
        pending = PendingRecovery.from_anomaly(anomaly)
        notice = recovery_user_notice_for(pending, locale=locale)
        steer = recovery_steering_on_abnormal(pending, locale=locale)
        if notice:
            actions.append({"type": "emit_notice", "message": notice})
        if steer:
            actions.append({"type": "push_steering", "message": steer})
        return actions

    plan = plan_recovery(
        anomaly,
        policy,
        auto,
        locale=locale,
        notify_user_on_warning=notify_user_on_warning,
    )
    notice = plan.user_notice or plan.recovery_notice
    if notice:
        actions.append({"type": "emit_notice", "message": notice})
    if plan.steering_text:
        actions.append({"type": "push_steering", "message": plan.steering_text})
    return actions


async def apply_recovery_actions(
    host: HostControl,
    actions: list[dict[str, Any]],
) -> None:
    """In-proc deliver: wire action list → HostControl (mirrors JS applyActions)."""
    for action in actions or []:
        if not isinstance(action, dict):
            logger.warning("apply_recovery_actions: skip non-dict action %r", action)
            continue
        atype = action.get("type")
        if atype == "abort_stream":
            try:
                host.request_abort_stream()
            except Exception:
                logger.error("apply_recovery_actions abort_stream failed", exc_info=True)
        elif atype == "emit_notice":
            message = str(action.get("message") or "")
            if message:
                await emit_user_notice(host, message)
        elif atype == "push_steering":
            message = str(action.get("message") or "")
            if message:
                # Idempotent envelope via inject_steering / format_steering.
                await inject_steering(host, message)
        else:
            logger.warning("apply_recovery_actions: unknown type %r", atype)


# Back-compat alias for callers still typing host loosely
def ensure_host(host: HostControl | None) -> HostControl:
    return host if host is not None else NoOpHostControl()
