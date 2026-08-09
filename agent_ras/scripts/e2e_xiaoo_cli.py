#!/usr/bin/env python3
# coding: utf-8
"""CLI-oriented E2E without daemon HTTP/SSE.

Validates protocol inproc: SessionHub observe → wire → Host callables.
Optionally checks Insight ingest when AGENT_INSIGHT_URL is set.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
import uuid

from platform_adapter.xiaoo.hooks import build_xiaoo_ras_client
from platform_adapter.xiaoo.stream_bridge import observe_text_delta, observe_tool_after


def _insight_ok(platform: str = "xiaoo") -> bool:
    base = (os.environ.get("AGENT_INSIGHT_URL") or "").rstrip("/")
    if not base:
        return True
    url = f"{base}/api/ingest/ras-events?platform={platform}&limit=5"
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            body = json.loads(resp.read().decode("utf-8") or "[]")
        return isinstance(body, list)
    except Exception as exc:
        print(f"insight check skipped/failed: {exc}", file=sys.stderr)
        return False


def main() -> int:
    aborts: list[str] = []
    notices: list[str] = []
    steers: list[str] = []

    client, _host = build_xiaoo_ras_client(
        abort_fn=lambda: aborts.append("abort"),
        notice_fn=notices.append,
        steer_fn=steers.append,
    )
    sid = f"xiaoo:cli_e2e_{uuid.uuid4().hex[:8]}"
    assert client.ensure(), "ras_runtime health failed"
    hello = client.hello(
        sid,
        "xiaoo",
        {
            "detection_start_chars": 1,
            "window_max_chars": 200,
            "loop_repeat_threshold": 3,
            "semantic_content_enabled": False,
        },
    )
    if not hello:
        print("FAIL: hello returned null", file=sys.stderr)
        return 1

    for _ in range(12):
        observe_tool_after(client, sid, name="bash", args={"cmd": "echo hi"})

    chunk = ("计划下一步。确认目标。准备执行。" * 4) + "\n"
    for _ in range(20):
        observe_text_delta(client, sid, chunk, channel="llm_reasoning")

    print("aborts", aborts)
    print("notices", len(notices))
    print("steers", len(steers))
    if not aborts:
        print("FAIL: expected abort_stream wire", file=sys.stderr)
        return 2
    if not _insight_ok():
        print("WARN: insight check failed", file=sys.stderr)
    print("OK: xiaoo CLI inproc E2E (no HTTP/SSE)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
