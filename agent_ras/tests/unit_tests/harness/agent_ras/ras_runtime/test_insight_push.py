import asyncio
import json
import threading
import time
import uuid
from urllib.error import HTTPError, URLError

from ras_runtime import insight_push


def test_push_anomaly_uses_stdlib_http_and_strips_platform_prefix(monkeypatch):
    captured = {}

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

    def fake_urlopen(req, timeout):
        captured["url"] = req.full_url
        captured["headers"] = dict(req.header_items())
        captured["body"] = json.loads(req.data.decode("utf-8"))
        captured["timeout"] = timeout
        return Response()

    monkeypatch.setattr(insight_push.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(insight_push, "_LOADED", True)
    monkeypatch.setattr(insight_push, "_LOADED_KEY", "wi_test")
    monkeypatch.setattr(insight_push, "_LOADED_URL", "http://localhost/events")

    asyncio.run(
        insight_push.push_anomaly(
            "opencode:ses_test",
            "opencode",
            {
                "kind": "llm_thinking_loop",
                "severity": "high",
                "summary": "loop",
                "evidence": {"mode": "suffix_cycle"},
                "trace_anchor": {
                    "message_id": "msg_1",
                    "part_id": "prt_reasoning",
                    "channel": "llm_reasoning",
                },
            },
            [
                {"type": "abort_stream"},
                {"type": "push_steering", "message": "请停止重复思考并重新规划。"},
            ],
        )
    )

    event = captured["body"]["events"][0]
    assert captured["url"] == "http://localhost/events"
    assert captured["headers"]["X-witty-api-key"] == "wi_test"
    assert captured["timeout"] == 5.0
    assert event["taskId"] == "ses_test"
    uuid.UUID(event["deliveryId"])
    assert "rasEventId" not in event
    assert event["anomalyKind"] == "llm_thinking_loop"
    assert event["actionTypes"] == "abort_stream,push_steering"
    assert event["payload"]["evidence"]["mode"] == "suffix_cycle"
    assert event["payload"]["actions"][1] == {
        "type": "push_steering",
        "message": "请停止重复思考并重新规划。",
    }
    assert event["payload"]["trace_anchor"]["part_id"] == "prt_reasoning"


def test_push_action_result_uses_existing_events_contract(monkeypatch):
    captured = {}

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

    def fake_urlopen(req, timeout):
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return Response()

    monkeypatch.setattr(insight_push.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(insight_push, "_LOADED", True)
    monkeypatch.setattr(insight_push, "_LOADED_KEY", "wi_test")
    monkeypatch.setattr(insight_push, "_LOADED_URL", "http://localhost/events")

    asyncio.run(
        insight_push.push_action_result(
            "opencode:ses_action",
            "opencode",
            {
                "action": "push_steering",
                "ok": True,
                "channel": "session.prompt",
                "message": "请改用另一种方案。",
                "trace_anchor": {
                    "message_id": "msg_1",
                    "part_id": "prt_reasoning",
                    "channel": "llm_reasoning",
                },
            },
        )
    )

    event = captured["body"]["events"][0]
    assert event["taskId"] == "ses_action"
    assert event["type"] == "action_result"
    assert event["actionTypes"] == "push_steering"
    assert event["payload"]["ok"] is True
    assert event["payload"]["message"] == "请改用另一种方案。"
    assert event["payload"]["trace_anchor"]["message_id"] == "msg_1"
    assert event["summary"] == "push_steering succeeded via session.prompt"


def test_push_action_result_preserves_delivery_anchor(monkeypatch):
    captured = {}

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

    def fake_urlopen(req, timeout):
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return Response()

    monkeypatch.setattr(insight_push.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(insight_push, "_LOADED", True)
    monkeypatch.setattr(insight_push, "_LOADED_KEY", "wi_test")
    monkeypatch.setattr(insight_push, "_LOADED_URL", "http://localhost/events")

    asyncio.run(
        insight_push.push_action_result(
            "opencode:ses_delivery",
            "opencode",
            {
                "action": "emit_notice",
                "ok": True,
                "channel": "session.prompt.noReply",
                "message": "notice body",
                "trace_anchor": {
                    "message_id": "msg_detect",
                    "part_id": "prt_reasoning",
                    "channel": "llm_reasoning",
                },
                "delivery_anchor": {
                    "message_id": "msg_notice",
                    "part_id": "prt_notice",
                    "channel": "ras_notice",
                },
            },
        )
    )

    event = captured["body"]["events"][0]
    assert event["payload"]["delivery_anchor"]["message_id"] == "msg_notice"
    assert event["payload"]["delivery_anchor"]["channel"] == "ras_notice"


def test_identical_events_receive_distinct_delivery_ids(monkeypatch):
    captured = []

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

    def fake_urlopen(req, timeout):
        captured.append(json.loads(req.data.decode("utf-8"))["events"][0])
        return Response()

    monkeypatch.setattr(insight_push.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(insight_push, "_LOADED", True)
    monkeypatch.setattr(insight_push, "_LOADED_KEY", "wi_test")
    monkeypatch.setattr(insight_push, "_LOADED_URL", "http://localhost/events")

    for _ in range(2):
        asyncio.run(
            insight_push.push_event(
                "opencode:ses_repeat",
                "opencode",
                "anomaly",
                {"kind": "llm_thinking_loop", "summary": "same occurrence"},
            )
        )

    assert captured[0]["deliveryId"] != captured[1]["deliveryId"]


def test_push_event_retries_transient_server_failure_with_same_delivery_id(monkeypatch):
    captured = []

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

    def fake_urlopen(req, timeout):
        captured.append(json.loads(req.data.decode("utf-8"))["events"][0])
        if len(captured) == 1:
            raise HTTPError(req.full_url, 500, "cold route", None, None)
        return Response()

    monkeypatch.setattr(insight_push.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(insight_push.time, "sleep", lambda _delay: None)
    monkeypatch.setattr(insight_push, "_LOADED", True)
    monkeypatch.setattr(insight_push, "_LOADED_KEY", "wi_test")
    monkeypatch.setattr(insight_push, "_LOADED_URL", "http://localhost/events")

    asyncio.run(
        insight_push.push_event(
            "opencode:ses_retry",
            "opencode",
            "anomaly",
            {"kind": "llm_thinking_loop"},
        )
    )

    assert len(captured) == 2
    assert captured[0]["deliveryId"] == captured[1]["deliveryId"]


def test_config_can_explicitly_disable_insight_push(tmp_path, monkeypatch):
    ras_home = tmp_path / "ras"
    ras_home.mkdir()
    (ras_home / "config.json").write_text(
        json.dumps(
            {
                "agent_ras": {
                    "insight": {
                        "enabled": False,
                        "events_url": "http://localhost/events",
                        "api_key": "wi_config",
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("AGENT_INSIGHT_RAS_HOME", str(ras_home))
    monkeypatch.setenv("AGENT_INSIGHT_RAS_INGEST_URL", "http://env/events")
    monkeypatch.setenv("AGENT_INSIGHT_API_KEY", "wi_env")

    key, url, source = insight_push._load_insight_config()
    assert key is None
    assert url is None
    assert source.startswith("disabled")


def test_fire_push_anomaly_runs_without_event_loop(monkeypatch):
    captured = {}
    done = threading.Event()

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

    def fake_urlopen(req, timeout):
        captured["body"] = json.loads(req.data.decode("utf-8"))
        done.set()
        return Response()

    monkeypatch.setattr(insight_push.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(insight_push, "_LOADED", True)
    monkeypatch.setattr(insight_push, "_LOADED_KEY", "wi_test")
    monkeypatch.setattr(insight_push, "_LOADED_URL", "http://localhost/events")
    insight_push.reset_push_stats()

    insight_push.fire_push_anomaly(
        "opencode:ses_thread",
        "opencode",
        {"kind": "llm_thinking_loop", "severity": "low", "summary": "loop"},
        [{"type": "abort_stream"}],
    )
    assert done.wait(5.0), "daemon push thread did not complete"
    # allow the success counter to update after urlopen returns
    for _ in range(50):
        if insight_push.get_push_stats()["successes"] >= 1:
            break
        time.sleep(0.05)
    assert captured["body"]["events"][0]["taskId"] == "ses_thread"
    assert insight_push.get_push_stats()["successes"] >= 1


def test_push_event_records_failure_as_warning_counter(monkeypatch, caplog):
    def fake_urlopen(req, timeout):
        raise URLError("down")

    monkeypatch.setattr(insight_push.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(insight_push.time, "sleep", lambda _delay: None)
    monkeypatch.setattr(insight_push, "_LOADED", True)
    monkeypatch.setattr(insight_push, "_LOADED_KEY", "wi_test")
    monkeypatch.setattr(insight_push, "_LOADED_URL", "http://localhost/events")
    insight_push.reset_push_stats()

    with caplog.at_level("WARNING", logger="ras_runtime.insight_push"):
        asyncio.run(
            insight_push.push_event(
                "opencode:ses_fail",
                "opencode",
                "anomaly",
                {"kind": "llm_thinking_loop"},
            )
        )

    assert insight_push.get_push_stats()["failures"] == 1
    assert any("insight push failed" in rec.message for rec in caplog.records)
