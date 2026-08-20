# coding: utf-8
"""TDD: ras_runtime.call JSON facade (in-process, no HTTP)."""
from __future__ import annotations

import json
import threading

import pytest

from ras_runtime import call, reset_runtime_for_tests
from ras_runtime import insight_push


@pytest.fixture(autouse=True)
def _clean_embed():
    reset_runtime_for_tests()
    yield
    reset_runtime_for_tests()


def test_health_returns_ok():
    out = json.loads(call("health", "", "{}"))
    assert out["status"] == "ok"
    assert out["transport"] == "inproc"


def test_hello_and_observe_roundtrip():
    welcome = json.loads(
        call(
            "hello",
            "opencode:ses_test",
            json.dumps(
                {
                    "platform": "opencode",
                    "config": {
                        "detection_start_chars": 10,
                        "window_max_chars": 200,
                        "loop_repeat_threshold": 99,
                        "semantic_content_enabled": False,
                    },
                }
            ),
        )
    )
    assert welcome["session_id"] == "opencode:ses_test"
    assert "host_messages" in welcome or "protocol_version" in welcome or welcome.get("ok") is not False

    result = json.loads(
        call(
            "observe",
            "opencode:ses_test",
            json.dumps(
                {
                    "kind": "assistant_text",
                    "channel": "llm_reasoning",
                    "mode": "snapshot",
                    "text": "short",
                    "platform": "opencode",
                }
            ),
        )
    )
    assert result["session_id"] == "opencode:ses_test"
    assert "actions" in result
    assert result.get("anomaly") is None or isinstance(result.get("anomaly"), dict)


def test_reset_and_bye():
    call(
        "hello",
        "opencode:ses_bye",
        json.dumps({"platform": "opencode", "config": {}}),
    )
    reset_out = json.loads(call("reset", "opencode:ses_bye", "{}"))
    assert reset_out.get("ok") is True
    bye_out = json.loads(call("bye", "opencode:ses_bye", "{}"))
    assert bye_out.get("ok") is True


def test_unknown_op_returns_error_json():
    out = json.loads(call("nope", "s", "{}"))
    assert "error" in out


def test_action_result_can_be_flushed_before_short_lived_host_exits(monkeypatch):
    received = threading.Event()

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

    def fake_urlopen(req, timeout):
        json.loads(req.data.decode("utf-8"))
        received.set()
        return Response()

    monkeypatch.setattr(insight_push.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(insight_push, "_LOADED", True)
    monkeypatch.setattr(insight_push, "_LOADED_KEY", "wi_test")
    monkeypatch.setattr(insight_push, "_LOADED_URL", "http://localhost/events")
    insight_push.reset_pending_pushes_for_tests()

    call(
        "hello",
        "opencode:ses_flush",
        json.dumps({"platform": "opencode", "config": {}}),
    )
    action = json.loads(
        call(
            "action_result",
            "opencode:ses_flush",
            json.dumps({"action": "abort_stream", "ok": True}),
        )
    )
    flushed = json.loads(
        call("flush", "opencode:ses_flush", json.dumps({"timeout_ms": 2000}))
    )

    assert action["ok"] is True
    assert received.is_set()
    assert flushed["acked"] == 1
    assert flushed["pending"] == 0
    assert flushed["timed_out"] is False
