#!/usr/bin/env python3
# coding: utf-8
"""E2E: xiaoo OTel buffer → Insight /otel/v1/traces → Session exists.

Requires running Insight with RAS config api_key (same as insight_push).
Optional: AGENT_INSIGHT_URL (default http://127.0.0.1:3000).
"""
from __future__ import annotations

import json
import os
import sys
import time
import uuid
from pathlib import Path
from urllib import request
from urllib.error import HTTPError, URLError


def _load_key_url() -> tuple[str, str]:
    from platform_adapter.common.otlp_http import load_otlp_config

    key, traces = load_otlp_config()
    if not key or not traces:
        raise SystemExit("FAIL: missing insight api_key / otel traces url in RAS config")
    base = os.environ.get("AGENT_INSIGHT_URL", "").rstrip("/")
    if not base:
        # derive from traces url
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
    # Ensure imports from agent_ras root
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root))

    from platform_adapter.xiaoo import otel_trace
    from platform_adapter.common.otlp_http import reset_otlp_stats, get_otlp_stats

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

    # Wait for spool consumer
    session = None
    for _ in range(30):
        time.sleep(1)
        try:
            data = _get_json(
                f"{base}/api/observe/session?taskId={native}&view=structure",
                key,
            )
        except HTTPError as exc:
            if exc.code == 404:
                continue
            print(f"FAIL: observe HTTP {exc.code}", file=sys.stderr)
            return 3
        except URLError as exc:
            print(f"FAIL: observe unreachable: {exc}", file=sys.stderr)
            return 3
        if data.get("interactions") or data.get("session"):
            session = data
            break

    if not session:
        print("FAIL: Session not found after OTLP (consumer timeout)", file=sys.stderr)
        return 4

    interactions = session.get("interactions") or []
    print("OK: session found taskId=", native, "interactions=", len(interactions))
    if not interactions:
        print("WARN: session exists but interactions empty", file=sys.stderr)
        return 5
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
