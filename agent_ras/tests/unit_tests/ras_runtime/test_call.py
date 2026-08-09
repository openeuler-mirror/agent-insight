# coding: utf-8
"""TDD: ras_runtime.call JSON facade (in-process, no HTTP)."""
from __future__ import annotations

import json

import pytest

from ras_runtime import call, reset_runtime_for_tests


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
