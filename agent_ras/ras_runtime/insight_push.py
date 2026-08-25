# coding: utf-8
"""Async push RAS anomaly events to AgentInsight ingest API.

Credentials are read from the RAS config file (agent_ras.insight section),
falling back to environment variables AGENT_INSIGHT_RAS_INGEST_URL /
AGENT_INSIGHT_API_KEY. If either is missing, pushes are silently skipped
(fail-open). Push failures stay fail-open for the Agent host, but are logged
at warning level and counted so operators can see Insight ingest gaps.
"""
from __future__ import annotations

import asyncio
from concurrent.futures import Future as ConcurrentFuture
import json
import logging
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.error import HTTPError, URLError
from urllib import request

logger = logging.getLogger(__name__)
_MAX_POST_ATTEMPTS = 3
_RETRY_DELAYS_S = (0.25, 0.75)
_MAX_RECEIPTS_PER_SESSION = 256

# Process-local counters for operators / tests (fail-open does not raise).
_PUSH_FAILURES = 0
_PUSH_SUCCESSES = 0
_PUSH_LOCK = threading.Lock()
_PENDING_PUSHES: dict[str, dict[str, asyncio.Future[bool] | ConcurrentFuture[bool]]] = {}
_PUSH_RECEIPTS: dict[str, dict[str, bool]] = {}


def get_push_stats() -> dict[str, int]:
    with _PUSH_LOCK:
        return {"successes": _PUSH_SUCCESSES, "failures": _PUSH_FAILURES}


def reset_push_stats() -> None:
    global _PUSH_SUCCESSES, _PUSH_FAILURES
    with _PUSH_LOCK:
        _PUSH_SUCCESSES = 0
        _PUSH_FAILURES = 0


def reset_pending_pushes_for_tests() -> None:
    with _PUSH_LOCK:
        _PENDING_PUSHES.clear()
        _PUSH_RECEIPTS.clear()


def _record_push_success() -> None:
    global _PUSH_SUCCESSES
    with _PUSH_LOCK:
        _PUSH_SUCCESSES += 1


def _record_push_failure() -> int:
    global _PUSH_FAILURES
    with _PUSH_LOCK:
        _PUSH_FAILURES += 1
        return _PUSH_FAILURES


def _load_insight_config() -> tuple[str | None, str | None, str]:
    """Return (api_key, events_url, config_source) for debug logging."""
    # 1. RAS config file (written by agent-insight install-ras)
    ras_home = os.environ.get(
        "AGENT_INSIGHT_RAS_HOME",
        os.environ.get("AGENT_INSIGHT_DATA_DIR", str(Path.home() / ".agent-insight")) + "/ras",
    )
    cfg_path = Path(ras_home) / "config.json"
    try:
        if cfg_path.is_file():
            data = json.loads(cfg_path.read_text(encoding="utf-8"))
            insight = (data.get("agent_ras") or {}).get("insight") or {}
            if insight.get("enabled") is False:
                return None, None, f"disabled in config.json ({cfg_path})"
            key = insight.get("api_key")
            url = insight.get("events_url")
            if key and url:
                return key, url, f"config.json ({cfg_path})"
    except Exception:
        logger.warning("failed to read RAS config", exc_info=True)

    # 2. Environment variables
    key = os.environ.get("AGENT_INSIGHT_API_KEY")
    url = os.environ.get("AGENT_INSIGHT_RAS_INGEST_URL")
    if key and url:
        return key, url, "environment"

    if not key:
        logger.debug("no insight API key configured, push skipped")
    elif not url:
        logger.debug("no insight events URL configured, push skipped")
    return None, None, "none"


_LOADED_KEY: str | None = None
_LOADED_URL: str | None = None
_LOADED = False


def _ensure_loaded() -> None:
    global _LOADED_KEY, _LOADED_URL, _LOADED
    if _LOADED:
        return
    _LOADED_KEY, _LOADED_URL, source = _load_insight_config()
    if _LOADED_KEY and _LOADED_URL:
        logger.debug("insight push configured via %s url=%s", source, _LOADED_URL)
    _LOADED = True


async def push_anomaly(
    session_id: str,
    platform: str,
    anomaly_dict: dict[str, Any],
    actions: list[dict[str, Any]] | None = None,
) -> bool:
    """Non-blocking: POST anomaly event to Insight API."""
    action_types = (
        ",".join(a.get("type", "") for a in actions) if actions else None
    )
    payload = dict(anomaly_dict)
    payload["actions"] = [dict(action) for action in actions or []]
    return await push_event(
        session_id,
        platform,
        "anomaly",
        payload,
        anomaly_kind=anomaly_dict.get("kind"),
        severity=anomaly_dict.get("severity"),
        summary=anomaly_dict.get("summary"),
        action_types=action_types,
    )


async def push_event(
    session_id: str,
    platform: str,
    event_type: str,
    event_payload: dict[str, Any],
    *,
    anomaly_kind: str | None = None,
    severity: str | None = None,
    summary: str | None = None,
    action_types: str | None = None,
    delivery_id: str | None = None,
) -> bool:
    """POST one structured RAS event to the existing Insight ingest route."""
    _ensure_loaded()
    if not _LOADED_KEY or not _LOADED_URL:
        return True

    task_id = session_id
    # Strip "{platform}:" prefix (e.g. "opencode:ses_xxx" → "ses_xxx")
    # to align with OTEL telemetry taskId format used in Execution/Session tables.
    if ":" in task_id:
        task_id = task_id.split(":", 1)[1]
    payload: dict[str, Any] = {
        "taskId": task_id,
        "type": event_type,
        "deliveryId": delivery_id or str(uuid.uuid4()),
        "framework": platform,
        "anomalyKind": anomaly_kind,
        "severity": severity,
        "summary": summary,
        "actionTypes": action_types,
        "payload": event_payload,
    }

    def _post() -> int:
        body = json.dumps({"events": [payload]}, ensure_ascii=False).encode("utf-8")
        for attempt in range(_MAX_POST_ATTEMPTS):
            req = request.Request(
                _LOADED_URL,
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "x-witty-api-key": _LOADED_KEY,
                },
                method="POST",
            )
            try:
                with request.urlopen(req, timeout=5.0) as resp:
                    return int(resp.status)
            except HTTPError as exc:
                if exc.code < 500 or attempt == _MAX_POST_ATTEMPTS - 1:
                    raise
            except (URLError, TimeoutError, OSError):
                if attempt == _MAX_POST_ATTEMPTS - 1:
                    raise
            time.sleep(_RETRY_DELAYS_S[attempt])
        raise RuntimeError("insight push retry loop exhausted")

    try:
        status = await asyncio.to_thread(_post)
        if status >= 400:
            failures = _record_push_failure()
            logger.warning(
                "insight push HTTP %d session=%s type=%s failures=%d",
                status,
                session_id,
                event_type,
                failures,
            )
            return False
        else:
            _record_push_success()
            logger.debug(
                "insight push ok session=%s type=%s", session_id, event_type
            )
            return True
    except Exception as exc:
        failures = _record_push_failure()
        logger.warning(
            "insight push failed session=%s type=%s failures=%d err=%s",
            session_id,
            event_type,
            failures,
            exc,
            exc_info=True,
        )
        return False


def _register_push(
    session_id: str,
    token: str,
    handle: asyncio.Future[bool] | ConcurrentFuture[bool],
) -> None:
    with _PUSH_LOCK:
        _PENDING_PUSHES.setdefault(session_id, {})[token] = handle

    def _settled(done: asyncio.Future[bool] | ConcurrentFuture[bool]) -> None:
        try:
            acked = bool(done.result())
        except BaseException:
            acked = False
            logger.warning(
                "insight push background task failed session=%s", session_id,
                exc_info=True,
            )
        with _PUSH_LOCK:
            pending = _PENDING_PUSHES.get(session_id)
            if pending is not None:
                pending.pop(token, None)
                if not pending:
                    _PENDING_PUSHES.pop(session_id, None)
            receipts = _PUSH_RECEIPTS.setdefault(session_id, {})
            receipts[token] = acked
            while len(receipts) > _MAX_RECEIPTS_PER_SESSION:
                receipts.pop(next(iter(receipts)))

    handle.add_done_callback(_settled)


def _schedule_coro(
    session_id: str,
    factory: Callable[[], Awaitable[bool]],
    *,
    thread_name: str,
) -> None:
    """Run and retain a push until a later bounded flush observes its receipt."""
    token = str(uuid.uuid4())
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        handle: ConcurrentFuture[bool] = ConcurrentFuture()
        _register_push(session_id, token, handle)

        def _run() -> None:
            try:
                handle.set_result(asyncio.run(factory()))
            except Exception as exc:
                handle.set_exception(exc)

        threading.Thread(
            target=_run,
            name=thread_name,
            daemon=True,
        ).start()
        return
    task = loop.create_task(factory())
    _register_push(session_id, token, task)


async def flush_pending_pushes(
    session_id: str,
    timeout_ms: int = 2500,
) -> dict[str, int | bool]:
    """Wait for the session's current push snapshot without cancelling on timeout."""
    with _PUSH_LOCK:
        pending = dict(_PENDING_PUSHES.get(session_id, {}))
        receipts = dict(_PUSH_RECEIPTS.get(session_id, {}))
        snapshot_tokens = set(pending) | set(receipts)

    timeout_s = max(0.0, min(float(timeout_ms) / 1000.0, 30.0))
    deadline = asyncio.get_running_loop().time() + timeout_s
    while any(not handle.done() for handle in pending.values()):
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            break
        await asyncio.sleep(min(0.01, remaining))
    await asyncio.sleep(0)

    with _PUSH_LOCK:
        current_receipts = _PUSH_RECEIPTS.get(session_id, {})
        acked = 0
        failed = 0
        still_pending = 0
        for token in snapshot_tokens:
            if token in receipts:
                result = receipts[token]
            else:
                handle = pending[token]
                if not handle.done():
                    still_pending += 1
                    continue
                try:
                    result = bool(handle.result())
                except BaseException:
                    result = False
            if result:
                acked += 1
            else:
                failed += 1
        for token in snapshot_tokens:
            current_receipts.pop(token, None)
        if not current_receipts:
            _PUSH_RECEIPTS.pop(session_id, None)

    return {
        "attempted": len(snapshot_tokens),
        "acked": acked,
        "failed": failed,
        "pending": still_pending,
        "timed_out": still_pending > 0,
    }


def fire_push_anomaly(
    session_id: str,
    platform: str,
    anomaly_dict: dict[str, Any],
    actions: list[dict[str, Any]] | None = None,
) -> None:
    """Schedule push as background task; skip only when Insight is not configured."""
    _ensure_loaded()
    if not _LOADED_KEY or not _LOADED_URL:
        return
    _schedule_coro(
        session_id,
        lambda: push_anomaly(session_id, platform, anomaly_dict, actions),
        thread_name="ras-insight-anomaly-push",
    )


async def push_action_result(
    session_id: str,
    platform: str,
    result: dict[str, Any],
) -> bool:
    action = str(result.get("action") or "")
    ok = bool(result.get("ok"))
    channel = str(result.get("channel") or "")
    summary = f"{action or 'action'} {'succeeded' if ok else 'failed'}"
    if channel:
        summary += f" via {channel}"
    return await push_event(
        session_id,
        platform,
        "action_result",
        result,
        summary=summary,
        action_types=action or None,
    )


def fire_push_action_result(
    session_id: str,
    platform: str,
    result: dict[str, Any],
) -> None:
    """Schedule an action acknowledgement from sync or async facade contexts."""
    _ensure_loaded()
    if not _LOADED_KEY or not _LOADED_URL:
        return
    _schedule_coro(
        session_id,
        lambda: push_action_result(session_id, platform, result),
        thread_name="ras-insight-action-push",
    )
