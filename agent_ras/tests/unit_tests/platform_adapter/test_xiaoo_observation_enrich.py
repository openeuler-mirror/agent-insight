# coding: utf-8
from __future__ import annotations

import json
from pathlib import Path

from platform_adapter.xiaoo.observation_enrich import (
    compose_assistant_observation,
    enrich_interactions_from_observation_events,
    extract_observation_text,
    rewrite_collect_after_observation_enrich,
)


def _write_events(path: Path, rows: list[dict]) -> None:
    path.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
        encoding="utf-8",
    )


def test_enrich_fills_empty_assistant_without_ras_anomaly_in_assistant(
    tmp_path: Path,
) -> None:
    events = tmp_path / "events.jsonl"
    _write_events(
        events,
        [
            {
                "kind": "xiaoo.cli",
                "payload": {
                    "type": "thinking_delta",
                    "snapshot": "明白，磁盘安全第一。我先看看上下文。",
                },
            },
            {
                "kind": "xiaoo.daemon",
                "payload": {
                    "type": "turn_done",
                    "stopped": True,
                    "last_observe": {"anomaly": {"summary": "should-not-appear"}},
                    "drained": [
                        "[RAS] 检测到思考循环异常，已执行恢复操作",
                        "<system-reminder>\n[思考循环锁定]\n</system-reminder>",
                    ],
                },
            },
        ],
    )
    interactions = [
        {"role": "user", "content": "执行场景2"},
        {"role": "assistant", "content": ""},
    ]
    out = enrich_interactions_from_observation_events(events, interactions)
    assert out[1]["content"].startswith("明白，磁盘安全第一")
    assert "should-not-appear" not in out[1]["content"]
    assert out[2]["role"] == "user"
    assert "检测到思考循环异常" in out[2]["content"]
    assert out[3]["role"] == "user"
    assert "思考循环锁定" in out[3]["content"]
    blob = json.dumps(out, ensure_ascii=False)
    assert "should-not-appear" not in blob


def test_extract_observation_prefers_longest_snapshot(tmp_path: Path) -> None:
    events = tmp_path / "events.jsonl"
    _write_events(
        events,
        [
            {
                "kind": "xiaoo.cli",
                "payload": {
                    "type": "thinking_delta",
                    "delta": "短",
                    "snapshot": "明白，我先看看上下文。" * 3,
                },
            },
            {
                "kind": "xiaoo.cli",
                "payload": {
                    "type": "thinking_delta",
                    "snapshot": "明白，我先看看上下文。" * 5,
                },
            },
            {
                "kind": "xiaoo.daemon",
                "payload": {
                    "type": "turn_done",
                    "stopped": True,
                    "last_observe": {
                        "anomaly": {"summary": "llm_thinking_loop (similar_clauses)"}
                    },
                    "drained": ["[RAS] 检测到思考循环异常"],
                },
            },
        ],
    )
    obs = extract_observation_text(events)
    assert obs["thinking"] == "明白，我先看看上下文。" * 5
    assert "llm_thinking_loop" not in obs["thinking"]
    assert "[RAS]" not in obs["thinking"]


def test_enrich_noop_without_stream_observation(tmp_path: Path) -> None:
    events = tmp_path / "events.jsonl"
    _write_events(
        events,
        [
            {
                "kind": "fault.activation.completed",
                "payload": {"skill": "thinking-dead-loop"},
            }
        ],
    )
    interactions = [
        {"role": "user", "content": "go"},
        {"role": "assistant", "content": ""},
    ]
    out = enrich_interactions_from_observation_events(events, interactions)
    assert out[1]["content"] == ""


def test_enrich_appends_assistant_when_missing(tmp_path: Path) -> None:
    events = tmp_path / "events.jsonl"
    _write_events(
        events,
        [
            {
                "kind": "xiaoo.cli",
                "payload": {"type": "text_delta", "snapshot": "hello out"},
            }
        ],
    )
    out = enrich_interactions_from_observation_events(
        events, [{"role": "user", "content": "hi"}]
    )
    assert out[-1]["role"] == "assistant"
    assert out[-1]["content"] == "hello out"


def test_rewrite_collect_updates_interactions_and_collect(tmp_path: Path) -> None:
    from agent_fault_injection.pipeline.models import RunArtifacts

    root = tmp_path / "run"
    raw = root / "raw"
    raw.mkdir(parents=True)
    events = raw / "events.jsonl"
    _write_events(
        events,
        [
            {
                "kind": "fault.activation.completed",
                "payload": {"skill": "thinking-dead-loop"},
            },
            {
                "kind": "xiaoo.cli",
                "payload": {
                    "type": "thinking_delta",
                    "snapshot": "明白，我先看看之前的上下文。",
                },
            },
        ],
    )
    interactions_path = root / "interactions.json"
    interactions_path.write_text(
        json.dumps(
            {
                "taskId": "sess-1",
                "framework": "xiaoo",
                "runId": "run-1",
                "interactions": [
                    {"role": "user", "content": "执行场景2"},
                    {"role": "assistant", "content": ""},
                ],
                "markers": [],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    artifacts = RunArtifacts(
        run_id="run-1",
        root=root,
        raw_dir=raw,
        resolved_fault_dir=root / "resolved_fault",
        events_file=events,
        session_file=raw / "session.json",
        stdout_file=raw / "stdout.log",
        stderr_file=raw / "stderr.log",
        trajectory_file=root / "trajectory.jsonl",
        interactions_file=interactions_path,
        execution_file=root / "execution.jsonl",
        manifest_file=root / "manifest.json",
        request_file=root / "request.json",
        plugin_ready_file=raw / "plugin-ready.json",
    )
    path = rewrite_collect_after_observation_enrich(
        artifacts,
        framework="xiaoo",
        fault="thinking-dead-loop",
        fault_activated=True,
        session_id="sess-1",
    )
    assert path is not None and path.is_file()
    doc = json.loads(interactions_path.read_text(encoding="utf-8"))
    assert "明白" in doc["interactions"][1]["content"]
    collect = json.loads(path.read_text(encoding="utf-8"))
    assert collect["faultActivated"] is True
    assert "明白" in collect["interactions"][1]["content"]
    # No synthetic response event written
    cli_types = []
    for line in events.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("kind") == "xiaoo.cli":
            cli_types.append((row.get("payload") or {}).get("type"))
    assert "response" not in cli_types


def test_compose_joins_thinking_and_output() -> None:
    text = compose_assistant_observation(
        thinking="think",
        output="say",
    )
    assert text == "say\n\nthink"


def test_compose_surfaces_repetitive_clauses_first() -> None:
    preamble = "我已加载技能。现在执行场景2。" + ("x" * 100)
    loop = ("明白，我先看看上下文，磁盘安全第一。") * 4
    text = compose_assistant_observation(thinking=preamble, output=loop + "\n" + preamble)
    assert text.startswith("明白")
    assert "我已加载技能" in text
    assert text.count("明白") >= 4
