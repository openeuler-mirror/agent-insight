#!/usr/bin/env python3
# coding: utf-8
"""RAS-owned xiaoo Daemon control-plane harness.

Modes:
  1) Default (no live daemon): inject SSE-shaped events into SessionHub via
     ``map_sse_event_to_observes`` and verify Host cancel/input callables fire
     for unknown_tool_repeat + thinking loop (submode gates).
  2) Live: set ``XIAOO_DAEMON_URL`` (and ensure stock ``xiaoo-daemon`` is up).
     Opens a lease, runs a prompt turn, maps real SSE, exercises cancel.

Does **not** modify FI. FI remains a separate black-box regression.
"""
from __future__ import annotations

import json
import os
import sys
import uuid
from typing import Any

from platform_adapter.xiaoo.daemon_session import (
    DaemonRasSession,
    map_sse_event_to_observes,
)
from platform_adapter.xiaoo.hooks import build_xiaoo_ras_client
from ras_runtime import reset_runtime_for_tests


def _hello_cfg() -> dict[str, Any]:
    return {
        "detection_start_chars": 1,
        "window_max_chars": 200,
        "loop_repeat_threshold": 3,
        "semantic_content_enabled": False,
    }


def run_synthetic_tool_repeat() -> int:
    reset_runtime_for_tests()
    aborts: list[dict[str, Any]] = []
    notices: list[str] = []
    steers: list[str] = []

    def abort_fn() -> dict[str, Any]:
        aborts.append({"ok": True})
        return {"ok": True}

    client, _host = build_xiaoo_ras_client(
        abort_fn=abort_fn,
        notice_fn=notices.append,
        steer_fn=steers.append,
    )
    sid = f"xiaoo:e2e_tool_{uuid.uuid4().hex[:8]}"
    assert client.ensure()
    client.hello(sid, "xiaoo", _hello_cfg())
    mids: dict[str, str] = {}
    for i in range(12):
        map_sse_event_to_observes(
            {
                "type": "tool_result",
                "tool_name": "bash",
                "call_id": f"c{i}",
                "output_preview": "bash: nonexistent_command_abc123: command not found",
                "is_error": True,
                "args_preview": json.dumps(
                    {"command": "nonexistent_command_abc123"}
                ),
            },
            session_id=sid,
            client=client,
            message_ids=mids,
        )
    print("tool_repeat aborts", len(aborts), "notices", len(notices), "steers", len(steers))
    if not aborts:
        print("FAIL: unknown_tool_repeat did not abort", file=sys.stderr)
        return 1
    if not (notices or steers):
        print("WARN: abort without notice/steer", file=sys.stderr)
    print("OK: synthetic tool_repeat_dead_loop submode=2 (unknown)")
    return 0


def run_synthetic_thinking() -> int:
    reset_runtime_for_tests()
    aborts: list[dict[str, Any]] = []
    notices: list[str] = []
    steers: list[str] = []

    client, _host = build_xiaoo_ras_client(
        abort_fn=lambda: aborts.append({"ok": True}) or {"ok": True},
        notice_fn=notices.append,
        steer_fn=steers.append,
    )
    sid = f"xiaoo:e2e_think_{uuid.uuid4().hex[:8]}"
    assert client.ensure()
    client.hello(sid, "xiaoo", _hello_cfg())
    mids: dict[str, str] = {}
    chunk = ("计划下一步。确认目标。准备执行。" * 4) + "\n"
    snap = ""
    for _ in range(24):
        snap += chunk
        map_sse_event_to_observes(
            {"type": "thinking_delta", "delta": chunk, "snapshot": snap},
            session_id=sid,
            client=client,
            message_ids=mids,
        )
    print("thinking aborts", len(aborts), "notices", len(notices), "steers", len(steers))
    if not aborts:
        print("FAIL: thinking loop did not abort", file=sys.stderr)
        return 1
    print("OK: synthetic thinking-dead-loop via thinking_delta SSE map")
    return 0


def run_live_daemon() -> int:
    base = (os.environ.get("XIAOO_DAEMON_URL") or "").strip()
    if not base:
        print("SKIP live daemon: set XIAOO_DAEMON_URL to exercise open/input/cancel")
        return 0
    reset_runtime_for_tests()
    session = DaemonRasSession(
        base_url=base,
        hello_config=_hello_cfg(),
        timeout_seconds=float(os.environ.get("XIAOO_DAEMON_TIMEOUT", "30")),
    )
    try:
        session.open(title="ras-e2e-daemon")
        cancel = session.daemon.cancel()
        print("live open runtime_id", session.daemon.runtime_id, "cancel", cancel)
        if not cancel.get("ok"):
            print(f"FAIL: cancel not ok: {cancel}", file=sys.stderr)
            return 1
        # Optional full turn (may hang on LLM); opt-in only.
        if (os.environ.get("XIAOO_RAS_E2E_LIVE_TURN") or "").strip() in {"1", "true", "yes"}:
            prompt = os.environ.get(
                "XIAOO_RAS_E2E_PROMPT",
                "Reply with one short sentence and stop. Do not call tools.",
            )
            result = session.run_turn(prompt)
            print(
                "live events",
                len(result.get("events") or []),
                "stopped",
                result.get("stopped"),
            )
            if not result.get("events"):
                print("FAIL: live daemon returned no SSE events", file=sys.stderr)
                return 1
        print("OK: live daemon open+cancel (lease control plane)")
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL live daemon: {exc}", file=sys.stderr)
        return 1
    finally:
        try:
            session.close()
        except Exception:  # noqa: BLE001
            pass


def main() -> int:
    rc = 0
    rc |= run_synthetic_tool_repeat()
    rc |= run_synthetic_thinking()
    rc |= run_live_daemon()
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
