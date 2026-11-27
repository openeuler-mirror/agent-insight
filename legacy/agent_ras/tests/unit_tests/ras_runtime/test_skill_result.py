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

"""TDD: ras_runtime skill_result op for inproc L3."""
from __future__ import annotations

import json

import pytest

from ras_runtime import call, reset_runtime_for_tests


@pytest.fixture(autouse=True)
def _clean():
    reset_runtime_for_tests()
    yield
    reset_runtime_for_tests()


def test_skill_result_roundtrip_via_embed_call():
    cfg = {
        "llm_thinking_loop": {
            "detection_start_chars": 20,
            "window_max_chars": 5000,
            "loop_repeat_threshold": 99,
            "semantic_eval_chars": 30,
            "semantic_content_enabled": True,
        },
    }
    sid = "opencode:embed_l3"
    call("hello", sid, json.dumps({"platform": "opencode", "config": cfg}))
    text = (
        "先分析需求背景与约束条件，再列出可选方案的优劣对比。"
        "然后评估风险与回滚策略，并给出推荐落地步骤说明。"
    )
    observed = json.loads(
        call(
            "observe",
            sid,
            json.dumps(
                {
                    "kind": "assistant_text",
                    "channel": "llm_output",
                    "mode": "snapshot",
                    "text": text,
                    "platform": "opencode",
                }
            ),
        )
    )
    reqs = observed.get("skill_requests") or []
    assert reqs, observed
    out = json.loads(
        call(
            "skill_result",
            sid,
            json.dumps(
                {
                    "request_id": reqs[0]["request_id"],
                    "result": {
                        "abnormal": True,
                        "primary_fault": "semantic_deadlock",
                    },
                    "timeout": 5,
                }
            ),
        )
    )
    assert out.get("ok") is True
    assert any(a.get("type") == "abort_stream" for a in (out.get("actions") or []))
