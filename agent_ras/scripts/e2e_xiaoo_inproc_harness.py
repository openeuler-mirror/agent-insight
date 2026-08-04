#!/usr/bin/env python3
# coding: utf-8
"""In-process E2E harness for xiaoo: inject repeat-tool + text loop signals.

Does not require a live xiaoO binary. Validates SessionHub observe → wire actions
→ CallableHostControl (no HTTP/SSE).
"""
from __future__ import annotations

import json
import sys
import uuid

from platform_adapter.xiaoo.hooks import build_xiaoo_ras_client
from platform_adapter.xiaoo.stream_bridge import observe_text_delta, observe_tool_after


def main() -> int:
    aborts: list[str] = []
    notices: list[str] = []
    steers: list[str] = []

    client, _host = build_xiaoo_ras_client(
        abort_fn=lambda: aborts.append("abort"),
        notice_fn=notices.append,
        steer_fn=steers.append,
    )
    sid = f"xiaoo:e2e_{uuid.uuid4().hex[:8]}"
    assert client.ensure(), "ras_embed health failed"
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
    print("hello", json.dumps(hello, ensure_ascii=False))

    # Repeat tool fault
    for _ in range(12):
        observe_tool_after(client, sid, name="bash", args={"cmd": "echo hi"})

    # Thinking / text repetition (short windows for harness)
    chunk = ("计划下一步。确认目标。准备执行。" * 4) + "\n"
    for _ in range(20):
        observe_text_delta(client, sid, chunk, channel="llm_reasoning")

    print("aborts", aborts)
    print("notices", len(notices), notices[:1])
    print("steers", len(steers), steers[:1])
    if not aborts:
        print("WARN: no abort yet — thresholds may need more signal", file=sys.stderr)
        return 2
    print("OK: xiaoo inproc harness delivered recovery wire")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
