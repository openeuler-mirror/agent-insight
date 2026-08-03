#!/usr/bin/env python3
# coding: utf-8
"""Synthetic E2E: L2 similar_clauses (逻辑死循环) → recovery actions → Insight.

Uses the same similar-clause shape as
``test_ac002_similar_clauses_medium``. Seeds Execution+Session so the
reliability list can show the task.

Usage:
  python scripts/e2e_l2_similar_clauses.py
"""
from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

USER = os.environ.get("E2E_INSIGHT_USER", "zhuangweizhuang@gmail.com")
DB_PATH = Path(
    os.environ.get(
        "AGENT_INSIGHT_DB",
        str(Path.home() / ".agent-insight" / "data" / "witty_insight.db"),
    )
).expanduser()


def _l2_text() -> str:
    core = (
        "明白，我先看看当前磁盘状况和之前的工作上下文，再开始测试。"
        "明白，我先看看当前磁盘状况和之前的工作进展，再开始测试。"
        "明白，我先看看当前磁盘状况和之前的上下文，再开始测试。"
    )
    return ("前缀填充。" * 10) + core


def seed_execution_session(task_id: str, final_result: str) -> str:
    if not DB_PATH.is_file():
        raise SystemExit(f"FAIL: db not found: {DB_PATH}")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    execution_id = f"e2e-l2-{uuid.uuid4().hex[:16]}"
    session_row_id = f"e2e-l2-sess-{uuid.uuid4().hex[:12]}"
    interactions = json.dumps(
        [
            {
                "role": "user",
                "content": "e2e L2 similar_clauses probe",
                "timestamp": now,
            },
            {
                "role": "assistant",
                "content": final_result,
                "timestamp": now,
                "messageID": "msg_llm_e2e_l2",
                "parts": [
                    {
                        "id": "prt_text_e2e_l2",
                        "type": "text",
                        "text": final_result[:500],
                    }
                ],
            },
            {
                "role": "user",
                "content": "检测到思考循环异常，已执行恢复操作",
                "timestamp": now,
                "messageID": "msg_notice_e2e_l2",
            },
        ],
        ensure_ascii=False,
    )
    conn = sqlite3.connect(str(DB_PATH))
    try:
        conn.execute(
            """
            INSERT INTO Execution (
              id, timestamp, latency, inputTokens, outputTokens,
              model, framework, agentName, query, finalResult,
              failures, user, taskId, isSubagent
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                execution_id,
                now,
                1200,
                10,
                20,
                "e2e-model",
                "opencode",
                "e2e-agent",
                "e2e L2 similar_clauses probe",
                final_result,
                "[]",
                USER,
                task_id,
                0,
            ),
        )
        conn.execute(
            """
            INSERT INTO Session (
              id, taskId, label, query, startTime, endTime, interactions, user, model
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_row_id,
                task_id,
                "e2e-l2-similar-clauses",
                "e2e L2 similar_clauses probe",
                now,
                now,
                interactions,
                USER,
                "e2e-model",
            ),
        )
        conn.commit()
    finally:
        conn.close()
    return execution_id


async def run() -> None:
    from ras_embed.insight_push import push_action_result, push_anomaly
    from ras_embed.session_hub import SessionHub

    text = _l2_text()
    hub = SessionHub()
    sid = f"opencode:e2e_l2_similar_{uuid.uuid4().hex[:10]}"
    task_id = sid.split(":", 1)[1]
    print(f"[e2e-l2] sid={sid} taskId={task_id} user={USER}")
    print(f"[e2e-l2] text_chars={len(text)}")

    hub.hello(
        sid,
        "opencode",
        {
            "detection_start_chars": 1,
            "window_max_chars": 100,
            "loop_repeat_threshold": 3,
            "similar_clause_sim_threshold": 0.9,
            "semantic_content_enabled": False,
        },
    )

    out = await hub.observe(
        sid,
        {
            "kind": "assistant_text",
            "channel": "llm_output",
            "mode": "snapshot",
            "text": text,
            "platform": "opencode",
            "trace_anchor": {
                "message_id": "msg_llm_e2e_l2",
                "part_id": "prt_text_e2e_l2",
                "channel": "llm_output",
            },
        },
    )
    anomaly = out.get("anomaly") or {}
    actions = out.get("actions") or []
    evidence = anomaly.get("evidence") or {}
    print(
        f"[e2e-l2] kind={anomaly.get('kind')} mode={evidence.get('mode')} "
        f"severity={anomaly.get('severity')} actions={[a.get('type') for a in actions]}"
    )
    if anomaly.get("kind") != "llm_thinking_loop":
        raise SystemExit(f"FAIL: expected llm_thinking_loop, got {anomaly!r}")
    if evidence.get("mode") != "similar_clauses":
        raise SystemExit(f"FAIL: expected similar_clauses, got {evidence!r}")
    if str(anomaly.get("severity") or "").lower() != "medium":
        raise SystemExit(f"FAIL: expected medium severity, got {anomaly.get('severity')!r}")
    types = [a.get("type") for a in actions]
    if "abort_stream" not in types:
        raise SystemExit(f"FAIL: expected abort_stream, got {types}")

    # Explicit await push (fire_and_forget may race before process exits).
    anomaly_payload = dict(anomaly)
    anomaly_payload["trace_anchor"] = {
        "message_id": "msg_llm_e2e_l2",
        "part_id": "prt_text_e2e_l2",
        "channel": "llm_output",
    }
    await push_anomaly(sid, "opencode", anomaly_payload, actions)

    notice_msg = next(
        (a.get("message") for a in actions if a.get("type") == "emit_notice"),
        None,
    )
    steer_msg = next(
        (a.get("message") for a in actions if a.get("type") == "push_steering"),
        None,
    )
    results = [
        {
            "action": "abort_stream",
            "ok": True,
            "channel": "session.abort",
            "trace_anchor": anomaly_payload["trace_anchor"],
        },
    ]
    if notice_msg is not None:
        results.append(
            {
                "action": "emit_notice",
                "ok": True,
                "channel": "session.prompt.noReply",
                "message": notice_msg,
                "trace_anchor": anomaly_payload["trace_anchor"],
                "delivery_anchor": {
                    "message_id": "msg_notice_e2e_l2",
                    "channel": "ras_notice",
                },
            }
        )
    if steer_msg is not None:
        results.append(
            {
                "action": "push_steering",
                "ok": True,
                "channel": "session.prompt",
                "message": steer_msg,
                "trace_anchor": anomaly_payload["trace_anchor"],
                "delivery_anchor": {
                    "message_id": "msg_steer_e2e_l2",
                    "channel": "ras_steering",
                },
            }
        )
    for result in results:
        await push_action_result(sid, "opencode", result)
        # brief yield for connection pool
        await asyncio.sleep(0.05)

    final_result = "e2e L2 recovered after similar_clauses"
    execution_id = seed_execution_session(task_id, final_result)
    print(f"[e2e-l2] seeded executionId={execution_id}")
    # Give ingest a moment if async paths still flush.
    time.sleep(0.3)
    print("E2E_L2_SIMILAR_CLAUSES_OK")
    print(f"TASK_ID={task_id}")


if __name__ == "__main__":
    asyncio.run(run())
