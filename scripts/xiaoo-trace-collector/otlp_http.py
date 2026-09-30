# coding: utf-8
"""Fail-open OTLP/HTTP JSON exporter for Agent Insight traces endpoint.

Owned by Insight xiaoo-trace-collector (not agent_ras).
"""
from __future__ import annotations

import json
import logging
import os

import threading
from pathlib import Path
from typing import Any
from urllib import request
from urllib.error import HTTPError, URLError

if os.environ.get("AGENT_INSIGHT_DATA_DIR"):
    raise RuntimeError("AGENT_INSIGHT_DATA_DIR is no longer supported; rename it to AGENT_INSIGHT_HOME and unset AGENT_INSIGHT_DATA_DIR.")

logger = logging.getLogger(__name__)

_LOCK = threading.Lock()
_STATS = {"successes": 0, "failures": 0, "skipped": 0}


def get_otlp_stats() -> dict[str, int]:
    with _LOCK:
        return dict(_STATS)


def reset_otlp_stats() -> None:
    with _LOCK:
        _STATS["successes"] = 0
        _STATS["failures"] = 0
        _STATS["skipped"] = 0


def _bump(key: str) -> None:
    with _LOCK:
        _STATS[key] = int(_STATS.get(key) or 0) + 1


def _insight_home() -> Path:
    data = os.path.expanduser(os.path.expandvars(os.environ.get("AGENT_INSIGHT_HOME") or "")).strip()
    if data:
        return Path(data)
    return Path.home() / ".agent-insight"


def load_otlp_config() -> tuple[str | None, str | None]:
    """Return (api_key, traces_url)."""
    key = (os.environ.get("AGENT_INSIGHT_API_KEY") or "").strip() or None
    explicit_env = (os.environ.get("AGENT_INSIGHT_OTLP_TRACES_URL") or "").strip()
    if key and explicit_env:
        return key, explicit_env

    host = (os.environ.get("AGENT_INSIGHT_HOST") or "").strip().rstrip("/")
    if key and host:
        return key, f"{host}/api/ingest/otel/v1/traces"
    if key or explicit_env or host:
        logger.warning("incomplete xiaoo OTLP environment configuration; upload skipped")
        return None, None

    # The installer refreshes RAS credentials; FI may still belong to an old installation.
    ras_home = os.environ.get(
        "AGENT_INSIGHT_RAS_HOME",
        str(_insight_home() / "ras"),
    )
    cfg_path = Path(ras_home) / "config.json"
    try:
        if cfg_path.is_file():
            data = json.loads(cfg_path.read_text(encoding="utf-8"))
            insight = (data.get("agent_ras") or {}).get("insight") or {}
            if insight.get("enabled") is False:
                return None, None
            key = str(insight.get("api_key") or "").strip() or None
            explicit = insight.get("otel_traces_url") or insight.get("traces_url")
            if key and explicit:
                return str(key), str(explicit)
            events_url = insight.get("events_url")
            if key and events_url:
                base = str(events_url).rstrip("/")
                if base.endswith("/api/ingest/ras-events"):
                    traces = (
                        base[: -len("/api/ingest/ras-events")]
                        + "/api/ingest/otel/v1/traces"
                    )
                elif "/api/ingest/" in base:
                    traces = (
                        base.rsplit("/api/ingest/", 1)[0]
                        + "/api/ingest/otel/v1/traces"
                    )
                else:
                    traces = base + "/api/ingest/otel/v1/traces"
                return str(key), traces
            logger.warning("incomplete xiaoo OTLP RAS configuration; upload skipped")
            return None, None
    except Exception:
        logger.warning("failed to read xiaoo OTLP RAS configuration; upload skipped")
        return None, None

    fi_cfg = _insight_home() / "fault-injection" / "config.json"
    try:
        if fi_cfg.is_file():
            data = json.loads(fi_cfg.read_text(encoding="utf-8"))
            key = str(data.get("apiKey") or "").strip() or None
            base = str(data.get("insightBaseUrl") or "").strip().rstrip("/")
            if key and base:
                return key, f"{base}/api/ingest/otel/v1/traces"
    except Exception:
        logger.warning("failed to read legacy xiaoo OTLP configuration; upload skipped")
    return None, None


def post_otlp_traces(payload: dict[str, Any], *, timeout: float = 8.0) -> bool:
    """POST OTLP/HTTP JSON. Fail-open: returns False on skip/error, never raises."""
    try:
        key, url = load_otlp_config()
        if not key or not url:
            _bump("skipped")
            return False
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = request.Request(
            url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "x-witty-api-key": key,
            },
            method="POST",
        )
        with request.urlopen(req, timeout=timeout) as resp:
            code = getattr(resp, "status", None) or resp.getcode()
            if int(code) >= 200 and int(code) < 300:
                _bump("successes")
                return True
            _bump("failures")
            logger.warning("OTLP traces HTTP %s", code)
            return False
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        _bump("failures")
        logger.warning("OTLP traces failed: %s", exc)
        return False
    except Exception as exc:
        _bump("failures")
        logger.warning("OTLP traces unexpected error: %s", exc)
        return False
