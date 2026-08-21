#!/usr/bin/env python3
# coding: utf-8
"""E2E: Insight xiaoo-trace-collector → /otel/v1/traces → Session exists.

Requires running Insight + API key (AGENT_INSIGHT_API_KEY or FI/RAS config).
Optional: AGENT_INSIGHT_HOST / AGENT_INSIGHT_URL (default http://127.0.0.1:3000).

Usage: python3 scripts/xiaoo-trace-collector/e2e_upload.py
"""
from __future__ import annotations

import json
import os
import sys
import time
import uuid
from pathlib import Path
from urllib import request


def _collector_root() -> Path:
    override = (os.environ.get("AGENT_INSIGHT_XIAOO_TRACE_HOME") or "").strip()
    if override:
        return Path(override)
    here = Path(__file__).resolve().parent
    if (here / "otel_trace.py").is_file():
        return here
    data = (os.environ.get("AGENT_INSIGHT_DATA_DIR") or "").strip()
    home = Path(data) if data else Path.home() / ".agent-insight"
    return home / "xiaoo-trace-collector"


def _load_key_url() -> tuple[str, str]:
    sys.path.insert(0, str(_collector_root()))
    from otlp_http import load_otlp_config

    key, traces = load_otlp_config()
    if not key or not traces:
        raise SystemExit("FAIL: missing insight api_key / otel traces url")
    base = os.environ.get("AGENT_INSIGHT_URL", "").rstrip("/") or os.environ.get(
        "AGENT_INSIGHT_HOST", ""
    ).rstrip("/")
    if not base:
        if "/api/ingest/otel/" in traces:
            base = traces.split("/api/ingest/otel/", 1)[0]
        else:
            base = "http://127.0.0.1:3000"
    return key, base


def _get_json(url: str, key: str) -> dict:
    req = request.Request(url, headers={"x-witty-api-key": key}, method="GET")
    with request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8") or "{}")


def main() -> int:
    root = _collector_root()
    if not (root / "otel_trace.py").is_file():
        print(f"FAIL: collector missing at {root}", file=sys.stderr)
        return 1
    sys.path.insert(0, str(root))
    import otel_trace
    from otlp_http import get_otlp_stats, reset_otlp_stats

    key, base = _load_key_url()
    native = f"otel_e2e_{uuid.uuid4().hex[:10]}"
    sid = f"xiaoo:{native}"
    otel_trace.reset_buffers_for_tests()
    reset_otlp_stats()

    otel_trace.note_chat(sid, {"message": {"text": f"otel e2e {native}"}})
    otel_trace.note_stream(sid, "assistant says hi for otel e2e", channel="llm_output")
    otel_trace.note_tool(
        sid,
        {
            "call": {"tool_name": "bash", "input": {"cmd": "echo otel"}, "call_id": "t1"},
            "outcome": {"output": "otel\n", "status": "success"},
        },
    )
    ok = otel_trace.flush_session(sid)
    stats = get_otlp_stats()
    print("flush_ok", ok, "otlp_stats", stats)
    if not ok:
        print("FAIL: OTLP flush failed (is Insight up? api key ok?)", file=sys.stderr)
        return 2

    session = None
    for _ in range(30):
        time.sleep(1)
        try:
            data = _get_json(
                f"{base}/api/observe/session?taskId={native}&view=structure",
                key,
            )
        except Exception as exc:
            print("poll error", exc)
            continue
        if data.get("session") or data.get("interactions") or data.get("taskId"):
            session = data
            break
    if not session:
        print("FAIL: session not found after flush", file=sys.stderr)
        return 3
    print("PASS session visible for", native)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
