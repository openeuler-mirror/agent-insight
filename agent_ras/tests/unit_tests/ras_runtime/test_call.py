# coding: utf-8
# Copyright (c) 2026 Huawei Technologies Co., Ltd.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""TDD: ras_runtime.call JSON facade (in-process, no HTTP)."""
from __future__ import annotations

import json
import threading
import time

import pytest

from ras_runtime import call, reset_runtime_for_tests
from ras_runtime import insight_push


@pytest.fixture(autouse=True)
def _clean_embed(monkeypatch):
    monkeypatch.setenv("RAS_EMBED_USE_IPC", "0")
    monkeypatch.setenv("RAS_EMBED_IPC_FORCE_LOCAL", "1")
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
                        "llm_thinking_loop": {
                            "detection_start_chars": 10,
                            "window_max_chars": 200,
                            "loop_repeat_threshold": 99,
                            "semantic_content_enabled": False,
                        },
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


@pytest.mark.parametrize("timeout_ms", [0, 2000])
def test_pre_abort_receipt_flush_respects_remaining_deadline(monkeypatch, timeout_ms):
    """A stalled delivery must not extend the pre-abort wait or cancel the push."""
    arrived = threading.Event()
    release = threading.Event()

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

    def stalled_urlopen(req, timeout):
        arrived.set()
        assert release.wait(5)
        return Response()

    monkeypatch.setattr(insight_push.request, "urlopen", stalled_urlopen)
    monkeypatch.setattr(insight_push, "_LOADED", True)
    monkeypatch.setattr(insight_push, "_LOADED_KEY", "wi_test")
    monkeypatch.setattr(insight_push, "_LOADED_URL", "http://localhost/events")
    insight_push.reset_pending_pushes_for_tests()
    try:
        call("hello", "opencode:ses_deadline", json.dumps({"platform": "opencode", "config": {}}))
        call("action_result", "opencode:ses_deadline", json.dumps({"action": "abort_stream", "ok": True}))
        assert arrived.wait(1)
        started = time.monotonic()
        flushed = json.loads(call("flush", "opencode:ses_deadline", json.dumps({"timeout_ms": timeout_ms})))
        elapsed = time.monotonic() - started
        if timeout_ms:
            assert 1.8 <= elapsed < 2.7
        else:
            assert elapsed < 0.5
        assert flushed["pending"] == 1
        assert flushed["timed_out"] is True
    finally:
        release.set()
        call("flush", "opencode:ses_deadline", json.dumps({"timeout_ms": 2000}))


@pytest.mark.parametrize("phase, ok", [("terminating", True), ("failed", False)])
def test_abort_signal_phase_survives_runtime_and_http_delivery(monkeypatch, phase, ok):
    """Preserve the stage used by frontend labels instead of inferring it from ok."""
    captured = []

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

    def capture_request(req, timeout):
        captured.extend(json.loads(req.data.decode("utf-8"))["events"])
        return Response()

    monkeypatch.setattr(insight_push.request, "urlopen", capture_request)
    monkeypatch.setattr(insight_push, "_LOADED", True)
    monkeypatch.setattr(insight_push, "_LOADED_KEY", "wi_test")
    monkeypatch.setattr(insight_push, "_LOADED_URL", "http://localhost/events")
    insight_push.reset_pending_pushes_for_tests()
    call("hello", "opencode:ses_phase", json.dumps({"platform": "opencode", "config": {}}))
    result = json.loads(call("action_result", "opencode:ses_phase", json.dumps({
        "action": "abort_stream", "phase": phase, "ok": ok, "channel": "session.abort",
    })))
    flushed = json.loads(call("flush", "opencode:ses_phase", json.dumps({"timeout_ms": 2000})))
    assert result["phase"] == phase
    assert flushed["acked"] == 1
    assert len(captured) == 1
    assert captured[0]["payload"]["phase"] == phase
    assert captured[0]["payload"]["ok"] is ok
    assert captured[0]["summary"] == f"abort_stream {phase} via session.abort"
