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

import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path

from qwenpaw_insight import __version__ as qwenpaw_version
from qwenpaw_insight.collector import COLLECTOR_VERSION, Collector
from qwenpaw_insight.config import CollectorConfig


class _RecordingExporter:
    def __init__(self) -> None:
        self.payloads: list[tuple[str, dict]] = []
        self.flush_calls: list[float] = []
        self.closed = False

    def submit(self, item_id: str, payload: dict) -> None:
        self.payloads.append((item_id, payload))

    def flush(self, timeout: float = 3.0) -> None:
        self.flush_calls.append(timeout)

    def close(self) -> None:
        self.closed = True


class _SlowFlushExporter(_RecordingExporter):
    def flush(self, timeout: float = 3.0) -> None:
        self.flush_calls.append(timeout)
        time.sleep(0.2)


def _spool_attributes(collector: Collector) -> list[dict]:
    return [span["attributes"] for span in _spool_spans(collector)]


def _spool_spans(collector: Collector) -> list[dict]:
    spool_dir = Path(collector.config.spool_dir)
    spans: list[dict] = []
    for path in spool_dir.rglob("*.json"):
        payload = json.loads(path.read_text(encoding="utf-8"))
        resource_attrs = {
            item["key"]: item["value"]
            for item in payload["resourceSpans"][0]["resource"].get("attributes", [])
        }
        for span in payload["resourceSpans"][0]["scopeSpans"][0]["spans"]:
            spans.append(
                {
                    "trace_id": span["traceId"],
                    "name": span["name"],
                    "start_ns": int(span["startTimeUnixNano"]),
                    "attributes": {item["key"]: item["value"] for item in span["attributes"]},
                    "resource_attributes": resource_attrs,
                }
            )
    return sorted(spans, key=lambda span: span["start_ns"])


class CollectorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.config = CollectorConfig(
            endpoint="",
            spool_dir=str(Path(self.tmp.name) / "spool"),
            log_file=str(Path(self.tmp.name) / "plugin.log"),
        )
        self.collector = Collector(self.config)

    def tearDown(self):
        self.collector.close()
        self.tmp.cleanup()

    @staticmethod
    def _unwrap(value: dict) -> object:
        if "intValue" in value:
            return int(value["intValue"])
        if "doubleValue" in value:
            return value["doubleValue"]
        if "boolValue" in value:
            return value["boolValue"]
        return value.get("stringValue", "")

    def _values(self, attrs: dict) -> dict:
        return {key: self._unwrap(value) for key, value in attrs.items()}

    def _agent_span_from(self, exporter: _RecordingExporter) -> tuple[dict, dict]:
        for _, payload in exporter.payloads:
            for span in payload["resourceSpans"][0]["scopeSpans"][0]["spans"]:
                attrs = self._values({item["key"]: item["value"] for item in span["attributes"]})
                if attrs.get("gen_ai.span.kind") == "AGENT":
                    return span, attrs
        self.fail("collector did not submit an agent span")

    def test_agent_llm_tool_flow(self):
        agent_span = self.collector.start_agent(
            session_id="session-a",
            root_session_id="session-a",
            agent_id="assistant",
            agent_name="Default",
            root_agent_id="assistant",
            user_id="alice",
            channel="console",
            source="chat",
            query="hello",
        )
        llm_span = self.collector.start_llm(model="qwen3", provider="dashscope", input="hello")
        self.collector.finish_llm(
            llm_span,
            output="done",
            usage={"input_tokens": 11, "output_tokens": 7, "total_tokens": 18},
        )
        tool_span = self.collector.start_tool(tool_name="shell", tool_input="ls", kind="shell")
        self.collector.finish_tool(tool_span, output="README.md", status="success", exit_code=0)
        self.collector.finish_agent_for_session("session-a")

        values = [self._values(attrs) for attrs in _spool_attributes(self.collector)]
        agents = [v for v in values if v.get("gen_ai.span.kind") == "AGENT"]
        llms = [v for v in values if v.get("gen_ai.span.kind") == "LLM"]
        tools = [v for v in values if v.get("gen_ai.span.kind") == "TOOL"]
        self.assertEqual(len(agents), 1)
        self.assertEqual(agents[0]["output.value"], "done")
        self.assertEqual(agents[0]["llm.token_count.total"], 18)
        self.assertEqual(agents[0]["qwenpaw.channel"], "console")
        self.assertEqual(agents[0]["qwenpaw.user_id"], "alice")
        self.assertEqual(agents[0]["qwenpaw.agent_id"], "assistant")
        self.assertEqual(agents[0]["qwenpaw.agent.name"], "Default")
        self.assertEqual(agents[0]["qwenpaw.user_input"], "hello")
        # AC5: agent trace carries the model used by the session.
        self.assertEqual(agents[0]["gen_ai.request.model"], "qwen3")
        self.assertEqual(len(llms), 1)
        self.assertEqual(llms[0]["llm.token_count.prompt"], 11)
        self.assertEqual(llms[0]["llm.model_name"], "qwen3")
        self.assertEqual(llms[0]["qwenpaw.user_input"], "hello")
        self.assertEqual(len(tools), 1)
        self.assertEqual(tools[0]["tool.name"], "shell")
        self.assertEqual(tools[0]["tool.exit_code"], 0)

    def test_subagent_skill_mcp_cron(self):
        self.collector.start_agent(
            session_id="session-a",
            root_session_id="session-a",
            agent_id="assistant",
            root_agent_id="assistant",
            user_id="alice",
            channel="dingtalk",
            source="chat",
            query="run task",
        )
        self.collector.register_subagent_relation("sub-1234", "session-a")
        self.assertTrue(self.collector.is_subagent_session("sub-1234"))
        self.collector.start_agent(
            session_id="sub-1234",
            root_session_id="session-a",
            agent_id="worker",
            root_agent_id="assistant",
            user_id="alice",
            channel="dingtalk",
            source="chat",
            query="write report",
            is_subagent=True,
        )
        skill_span = self.collector.start_skill(name="docx", version="1.2", trigger="slash", args="make doc")
        long_skill_output = "k" * 5000
        self.collector.finish_skill(skill_span, output=long_skill_output)
        mcp_span = self.collector.start_mcp(server_name="github", tool_name="get_issue", arguments={"issue": 1})
        long_mcp_result = "m" * 5000
        self.collector.finish_mcp(mcp_span, result=long_mcp_result, status="error", error="rate limited")
        cron_span = self.collector.start_cron(
            job_id="job-1",
            job_name="daily report",
            task_type="agent",
            trigger="scheduled",
            channel="dingtalk",
        )
        self.collector.finish_cron(cron_span, status="success", output="report sent")
        # Destroy the sub-agent so its agent trace is emitted (AC6).
        self.collector.finish_agent_for_session("sub-1234")
        self.collector.finish_agent_for_session("session-a")

        values = [self._values(attrs) for attrs in _spool_attributes(self.collector)]
        agents = [v for v in values if v.get("gen_ai.span.kind") == "AGENT"]
        subagent_agent = [v for v in agents if v.get("qwenpaw.session_id") == "sub-1234"]
        root_agent = next(v for v in agents if v.get("qwenpaw.session_id") == "session-a")
        self.assertEqual(len(subagent_agent), 1)
        self.assertEqual(subagent_agent[0]["qwenpaw.parent_session_id"], "session-a")
        self.assertEqual(subagent_agent[0]["agent.subagent"], True)
        self.assertEqual(root_agent["qwenpaw.turn_id"], subagent_agent[0]["qwenpaw.turn_id"])
        self.assertEqual(root_agent["qwenpaw.trace_key"], subagent_agent[0]["qwenpaw.trace_key"])
        skills = [v for v in values if v.get("skill.name") == "docx"]
        self.assertEqual(len(skills), 1)
        self.assertEqual(skills[0]["skill.version"], "1.2")
        self.assertEqual(skills[0]["skill.trigger"], "slash")
        self.assertEqual(skills[0]["tool.output"], skills[0]["skill.output"])
        self.assertEqual(len(skills[0]["tool.output"]), 2000)
        self.assertTrue(skills[0]["tool.output"].endswith("…[TRUNCATED original_chars=5000]"))
        mcps = [v for v in values if v.get("mcp.server.name") == "github"]
        self.assertEqual(len(mcps), 1)
        self.assertEqual(mcps[0]["mcp.tool.name"], "get_issue")
        self.assertEqual(mcps[0]["tool.output"], mcps[0]["mcp.result"])
        self.assertEqual(len(mcps[0]["tool.output"]), 2000)
        self.assertTrue(mcps[0]["tool.output"].endswith("…[TRUNCATED original_chars=5000]"))
        crons = [v for v in values if v.get("cron.job_id") == "job-1"]
        self.assertEqual(len(crons), 1)
        self.assertEqual(crons[0]["cron.status"], "success")

    def test_nested_subagent_restores_parent_context(self):
        """After a child session finishes, later spans attach to the parent."""
        self.collector.start_agent(
            session_id="session-a",
            root_session_id="session-a",
            agent_id="default",
            agent_name="Default",
            query="root task",
        )
        self.collector.register_subagent_relation("sub-1", "session-a", root_session_id="session-a")
        self.collector.start_agent(
            session_id="sub-1",
            root_session_id="session-a",
            agent_id="default",
            agent_name="Default · Subagent",
            query="child task",
            is_subagent=True,
        )
        child_llm = self.collector.start_llm(model="qwen3", input="child")
        self.collector.finish_llm(child_llm, output="child done")
        self.collector.finish_agent_for_session("sub-1")

        parent_llm = self.collector.start_llm(model="qwen3", input="parent follow-up")
        self.collector.finish_llm(parent_llm, output="parent done")
        self.collector.finish_agent_for_session("session-a")

        values = [self._values(attrs) for attrs in _spool_attributes(self.collector)]
        llms = [v for v in values if v.get("gen_ai.span.kind") == "LLM"]
        self.assertEqual(len(llms), 2)
        self.assertEqual(llms[0]["qwenpaw.session_id"], "sub-1")
        self.assertEqual(llms[1]["qwenpaw.session_id"], "session-a")

    def test_error_span_status(self):
        self.collector.start_agent(
            session_id="session-a",
            root_session_id="session-a",
            agent_id="assistant",
            query="run bad tool",
        )
        tool_span = self.collector.start_tool(tool_name="shell", tool_input="bad", kind="shell")
        self.collector.finish_tool(tool_span, status="error", error="boom")
        payload = json.loads(
            list(Path(self.config.spool_dir).rglob("*.json"))[0].read_text(encoding="utf-8")
        )
        span = payload["resourceSpans"][0]["scopeSpans"][0]["spans"][0]
        self.assertEqual(span["status"]["code"], 2)

    def test_react_step_numbering(self):
        """AC7: each ReAct step (LLM + following tool) carries a step index."""
        self.collector.start_agent(
            session_id="session-a",
            root_session_id="session-a",
            agent_id="assistant",
            root_agent_id="assistant",
            query="multi step",
        )
        llm1 = self.collector.start_llm(model="qwen3", input="think 1")
        self.collector.finish_llm(llm1, output="use shell")
        tool1 = self.collector.start_tool(tool_name="shell", tool_input="ls", kind="shell")
        self.collector.finish_tool(tool1, output="ok")
        llm2 = self.collector.start_llm(model="qwen3", input="think 2")
        self.collector.finish_llm(llm2, output="done")

        values = [self._values(attrs) for attrs in _spool_attributes(self.collector)]
        llms = sorted(
            [v for v in values if v.get("gen_ai.span.kind") == "LLM"],
            key=lambda v: int(v.get("qwenpaw.react.step", 0)),
        )
        tools = [v for v in values if v.get("gen_ai.span.kind") == "TOOL"]
        self.assertEqual([int(v["qwenpaw.react.step"]) for v in llms], [1, 2])
        self.assertEqual(int(tools[0]["qwenpaw.react.step"]), 1)

    def test_real_session_turns_create_distinct_traces(self):
        """Each QwenPaw question gets its own trace, even in one conversation."""
        self.collector.start_agent(session_id="session-a", root_session_id="session-a", query="q1")
        llm1 = self.collector.start_llm(model="qwen3", input="q1")
        self.collector.finish_llm(
            llm1,
            output="a1",
            usage={"input_tokens": 1, "output_tokens": 2, "total_tokens": 3},
        )
        self.collector.finish_agent_for_session("session-a")
        self.collector.on_session_end("session-a")

        self.collector.start_agent(session_id="session-a", root_session_id="session-a", query="q2")
        llm2 = self.collector.start_llm(model="qwen3", input="q2")
        self.collector.finish_llm(
            llm2,
            output="a2",
            usage={"input_tokens": 2, "output_tokens": 2, "total_tokens": 4},
        )
        self.collector.finish_agent_for_session("session-a")
        self.collector.on_session_end("session-a")

        spans = _spool_spans(self.collector)
        values = [self._values(span["attributes"]) for span in spans]
        agents = [v for v in values if v.get("gen_ai.span.kind") == "AGENT"]
        markers = [v for v in values if v.get("qwenpaw.session.end") is True]
        trace_ids = [span["trace_id"] for span in spans if span["name"] == "agent"]

        self.assertEqual(len(agents), 2)
        self.assertEqual(len(markers), 2)
        self.assertEqual(agents[0]["qwenpaw.root_session_id"], "session-a")
        self.assertEqual(agents[1]["qwenpaw.root_session_id"], "session-a")
        self.assertEqual(len(set(trace_ids)), 2)
        self.assertNotEqual(agents[0]["qwenpaw.turn_id"], agents[1]["qwenpaw.turn_id"])
        self.assertNotEqual(agents[0]["qwenpaw.trace_key"], agents[1]["qwenpaw.trace_key"])
        self.assertEqual([int(v["llm.token_count.total"]) for v in agents], [3, 4])

    def test_turn_identity_is_unique_after_collector_restart_and_inherited_by_subagent(self):
        first_exporter = _RecordingExporter()
        first = Collector(self.config, exporter=first_exporter)
        first.start_agent(session_id="persistent-chat", root_session_id="persistent-chat", query="before restart")
        first.register_subagent_relation("child-session", "persistent-chat")
        first.start_agent(
            session_id="child-session",
            root_session_id="persistent-chat",
            query="sub task",
            is_subagent=True,
        )
        first.finish_agent_for_session("child-session")
        first.finish_agent_for_session("persistent-chat", output="before restart answer")
        first.on_session_end("persistent-chat")

        first_agent_span, first_agent = self._agent_span_from(first_exporter)
        first_child_span = next(
            span
            for _, payload in first_exporter.payloads
            for span in payload["resourceSpans"][0]["scopeSpans"][0]["spans"]
            if self._values({item["key"]: item["value"] for item in span["attributes"]}).get("qwenpaw.session_id") == "child-session"
        )
        first_child = self._values({item["key"]: item["value"] for item in first_child_span["attributes"]})

        second_exporter = _RecordingExporter()
        second = Collector(self.config, exporter=second_exporter)
        second.start_agent(session_id="persistent-chat", root_session_id="persistent-chat", query="after restart")
        second.finish_agent_for_session("persistent-chat", output="after restart answer")
        second.on_session_end("persistent-chat")
        second_agent_span, second_agent = self._agent_span_from(second_exporter)

        self.assertEqual(first_agent["qwenpaw.turn_id"], first_child["qwenpaw.turn_id"])
        self.assertEqual(first_agent["qwenpaw.trace_key"], first_child["qwenpaw.trace_key"])
        self.assertNotEqual(first_agent["qwenpaw.turn_id"], second_agent["qwenpaw.turn_id"])
        self.assertNotEqual(first_agent["qwenpaw.trace_key"], second_agent["qwenpaw.trace_key"])
        self.assertNotEqual(first_agent_span["traceId"], second_agent_span["traceId"])

    def test_session_end_does_not_wait_for_exporter_flush(self):
        exporter = _SlowFlushExporter()
        collector = Collector(self.config, exporter=exporter)
        collector.start_agent(session_id="session-a", root_session_id="session-a", query="hello")
        collector.finish_agent_for_session("session-a", output="done")

        async def finish_request() -> float:
            started = time.monotonic()
            collector.on_session_end("session-a")
            return time.monotonic() - started

        elapsed = asyncio.run(finish_request())
        self.assertLess(elapsed, 0.1)
        self.assertEqual(exporter.flush_calls, [])

    def test_close_keeps_bounded_flush_for_process_shutdown(self):
        exporter = _RecordingExporter()
        collector = Collector(self.config, exporter=exporter)
        collector.close()
        self.assertEqual(exporter.flush_calls, [5.0])
        self.assertTrue(exporter.closed)

    def test_error_never_emits_successful_tool_status(self):
        self.collector.start_agent(session_id="session-a", root_session_id="session-a", query="hello")
        span_id = self.collector.start_tool(tool_name="read_file", tool_input="missing.txt")
        self.collector.finish_tool(span_id, status="success", error="file missing")

        values = [self._values(attrs) for attrs in _spool_attributes(self.collector)]
        tool = next(value for value in values if value.get("tool.name") == "read_file")
        self.assertEqual(tool["tool.status"], "error")
        self.assertEqual(tool["error.message"], "file missing")

    def test_llm_only_placeholder_session_is_orphaned(self):
        """Fallback LLM-only capture must not create guessed QwenPaw traces."""
        llm1 = self.collector.start_llm(model="qwen3", input="q1")
        self.collector.finish_llm(llm1, output="a1")

        llm2 = self.collector.start_llm(model="qwen3", input="q2")
        self.collector.finish_llm(llm2, output="a2")

        spans = _spool_spans(self.collector)
        self.assertEqual(llm1, "")
        self.assertEqual(llm2, "")
        self.assertEqual(spans, [])

    def test_content_truncated_at_2000_chars(self):
        """AC16: prompt/response over 2000 chars is truncated."""
        self.collector.start_agent(
            session_id="session-a",
            root_session_id="session-a",
            agent_id="assistant",
            root_agent_id="assistant",
            query="x" * 5000,
        )
        llm_span = self.collector.start_llm(model="qwen3", input="y" * 5000)
        self.collector.finish_llm(llm_span, output="z" * 5000)

        values = [self._values(attrs) for attrs in _spool_attributes(self.collector)]
        llm = next(v for v in values if v.get("gen_ai.span.kind") == "LLM")
        self.assertEqual(len(llm["input.value"]), 2000)
        self.assertEqual(len(llm["qwenpaw.user_input"]), 2000)
        self.assertEqual(len(llm["output.value"]), 2000)
        self.assertTrue(llm["output.value"].endswith("…[TRUNCATED original_chars=5000]"))
        self.assertEqual(llm["agent.insight.content.truncated"], True)
        self.assertEqual(llm["qwenpaw.input_chars"], 5000)
        self.assertEqual(llm["qwenpaw.user_input_truncated"], True)
        self.assertEqual(llm["qwenpaw.user_input_chars"], 5000)

    def test_version_is_unified_to_1_0_0(self):
        self.assertEqual(COLLECTOR_VERSION, "1.0.0")
        self.assertEqual(qwenpaw_version, "1.0.0")

    def test_sensitive_content_masked(self):
        """AC12: secrets in tool args / outputs are masked in spans."""
        self.collector.start_agent(
            session_id="session-a",
            root_session_id="session-a",
            agent_id="assistant",
            root_agent_id="assistant",
            query="deploy",
        )
        llm_span = self.collector.start_llm(model="qwen3", input="api_key=sk-1234567890abcdef")
        self.collector.finish_llm(llm_span, output="ok")
        tool_span = self.collector.start_tool(
            tool_name="shell",
            tool_input={"command": "echo", "env": {"API_KEY": "sk-1234567890abcdef"}},
            kind="shell",
        )
        self.collector.finish_tool(tool_span, output="token=ghp_abcdefghijklmnop12345678")
        self.collector.finish_agent_for_session("session-a")

        values = [self._values(attrs) for attrs in _spool_attributes(self.collector)]
        tool = next(v for v in values if v.get("gen_ai.span.kind") == "TOOL")
        agent = next(v for v in values if v.get("gen_ai.span.kind") == "AGENT")
        llm = next(v for v in values if v.get("gen_ai.span.kind") == "LLM")
        self.assertNotIn("sk-1234567890abcdef", tool["tool.input"])
        self.assertNotIn("ghp_abcdefghijklmnop12345678", tool["tool.output"])
        self.assertIn("***", tool["tool.input"])
        self.assertEqual(agent["qwenpaw.user_input"], "deploy")
        self.assertNotIn("sk-1234567890abcdef", llm["qwenpaw.user_input"])
        self.assertIn("***", llm["qwenpaw.user_input"])

    def test_message_text_includes_reasoning_and_action(self):
        """AC7: reasoning and action declarations are traceable."""
        class _FakeContent:
            def __init__(self, content):
                self.content = content

        text = Collector._message_text(
            _FakeContent(
                [
                {"type": "thinking", "thinking": "I should list files"},
                {"type": "tool_use", "name": "shell", "input": '{"command":"ls"}'},
                {"type": "text", "text": "Listing files"},
                ],
            ),
        )
        self.assertIn("I should list files", text)
        self.assertIn("Action: shell", text)
        self.assertIn('{"command":"ls"}', text)

    def test_cron_output_sanitized(self):
        """AC12: cron results are sanitized before spooling."""
        cron_span = self.collector.start_cron(
            job_id="job-secret",
            job_name="report",
            task_type="agent",
            channel="console",
        )
        self.collector.finish_cron(cron_span, status="success", output="token=sk-1234567890abcdef")
        values = [self._values(attrs) for attrs in _spool_attributes(self.collector)]
        cron = next(v for v in values if v.get("cron.job_id") == "job-secret")
        self.assertNotIn("sk-1234567890abcdef", cron["cron.output"])
        self.assertIn("***", cron["cron.output"])


    def test_close_finalizes_open_spans(self):
        """AC21: open spans are spooled (not lost) when the collector closes."""
        self.collector.start_agent(
            session_id="session-a",
            root_session_id="session-a",
            agent_id="assistant",
            root_agent_id="assistant",
            query="task",
        )
        self.collector.close()
        values = [self._values(attrs) for attrs in _spool_attributes(self.collector)]
        agents = [v for v in values if v.get("gen_ai.span.kind") == "AGENT"]
        self.assertEqual(len(agents), 1)
        self.assertEqual(agents[0]["agent.insight.status"], "interrupted")


if __name__ == "__main__":
    unittest.main()
