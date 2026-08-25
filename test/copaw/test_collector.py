import json
import tempfile
import unittest
from pathlib import Path

from copaw.collector import Collector
from copaw.config import CollectorConfig


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

    def test_agent_llm_tool_flow(self):
        agent_span = self.collector.start_agent(
            session_id="session-a",
            root_session_id="session-a",
            agent_id="assistant",
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
        # AC5: agent trace carries the model used by the session.
        self.assertEqual(agents[0]["gen_ai.request.model"], "qwen3")
        self.assertEqual(len(llms), 1)
        self.assertEqual(llms[0]["llm.token_count.prompt"], 11)
        self.assertEqual(llms[0]["llm.model_name"], "qwen3")
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
        self.collector.finish_skill(skill_span, output="ok")
        mcp_span = self.collector.start_mcp(server_name="github", tool_name="get_issue", arguments={"issue": 1})
        self.collector.finish_mcp(mcp_span, result="issue found", status="error", error="rate limited")
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

        values = [self._values(attrs) for attrs in _spool_attributes(self.collector)]
        agents = [v for v in values if v.get("gen_ai.span.kind") == "AGENT"]
        subagent_agent = [v for v in agents if v.get("qwenpaw.session_id") == "sub-1234"]
        self.assertEqual(len(subagent_agent), 1)
        self.assertEqual(subagent_agent[0]["qwenpaw.parent_session_id"], "session-a")
        self.assertEqual(subagent_agent[0]["agent.subagent"], True)
        skills = [v for v in values if v.get("skill.name") == "docx"]
        self.assertEqual(len(skills), 1)
        self.assertEqual(skills[0]["skill.version"], "1.2")
        self.assertEqual(skills[0]["skill.trigger"], "slash")
        mcps = [v for v in values if v.get("mcp.server.name") == "github"]
        self.assertEqual(len(mcps), 1)
        self.assertEqual(mcps[0]["mcp.tool.name"], "get_issue")
        crons = [v for v in values if v.get("cron.job_id") == "job-1"]
        self.assertEqual(len(crons), 1)
        self.assertEqual(crons[0]["cron.status"], "success")

    def test_error_span_status(self):
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

    def test_placeholder_agent_turns_do_not_share_state(self):
        """Each QwenPaw request with placeholder session id gets a fresh root."""
        self.collector.start_agent(session_id="unknown", root_session_id="unknown", query="q1")
        llm1 = self.collector.start_llm(model="qwen3", input="q1")
        self.collector.finish_llm(
            llm1,
            output="a1",
            usage={"input_tokens": 1, "output_tokens": 2, "total_tokens": 3},
        )
        self.collector.finish_agent_for_session("unknown")
        self.collector.on_session_end("unknown")

        self.collector.start_agent(session_id="unknown", root_session_id="unknown", query="q2")
        llm2 = self.collector.start_llm(model="qwen3", input="q2")
        self.collector.finish_llm(
            llm2,
            output="a2",
            usage={"input_tokens": 2, "output_tokens": 2, "total_tokens": 4},
        )
        self.collector.finish_agent_for_session("unknown")
        self.collector.on_session_end("unknown")

        values = [self._values(attrs) for attrs in _spool_attributes(self.collector)]
        agents = [v for v in values if v.get("gen_ai.span.kind") == "AGENT"]
        markers = [v for v in values if v.get("qwenpaw.session.end") is True]

        self.assertEqual(len(agents), 2)
        self.assertEqual(len(markers), 2)
        self.assertNotEqual(agents[0]["qwenpaw.root_session_id"], agents[1]["qwenpaw.root_session_id"])
        self.assertEqual([int(v["llm.token_count.total"]) for v in agents], [3, 4])

    def test_llm_only_placeholder_session_rotates_after_reuse_window(self):
        """Fallback LLM-only capture must not pin all chats to one trace."""
        llm1 = self.collector.start_llm(model="qwen3", input="q1")
        self.collector.finish_llm(llm1, output="a1")
        first_root = self.collector.sessions["unknown"]["root_session_id"]
        self.collector._minted_roots["unknown"] = (first_root, self.collector._minted_roots["unknown"][1] - 31.0)

        llm2 = self.collector.start_llm(model="qwen3", input="q2")
        self.collector.finish_llm(llm2, output="a2")

        spans = _spool_spans(self.collector)
        llm_roots = [
            self._values(span["resource_attributes"])["session.id"]
            for span in spans
            if span["name"].startswith("llm.")
        ]
        trace_ids = [span["trace_id"] for span in spans if span["name"].startswith("llm.")]

        self.assertEqual(len(llm_roots), 2)
        self.assertNotEqual(llm_roots[0], llm_roots[1])
        self.assertNotEqual(trace_ids[0], trace_ids[1])

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
        self.assertEqual(len(llm["output.value"]), 2000)
        self.assertEqual(llm["agent.insight.content.truncated"], True)
        self.assertEqual(llm["qwenpaw.input_chars"], 5000)

    def test_sensitive_content_masked(self):
        """AC12: secrets in tool args / outputs are masked in spans."""
        self.collector.start_agent(
            session_id="session-a",
            root_session_id="session-a",
            agent_id="assistant",
            root_agent_id="assistant",
            query="deploy",
        )
        tool_span = self.collector.start_tool(
            tool_name="shell",
            tool_input={"command": "echo", "env": {"API_KEY": "sk-1234567890abcdef"}},
            kind="shell",
        )
        self.collector.finish_tool(tool_span, output="token=ghp_abcdefghijklmnop12345678")
        self.collector.finish_agent_for_session("session-a")

        values = [self._values(attrs) for attrs in _spool_attributes(self.collector)]
        tool = next(v for v in values if v.get("gen_ai.span.kind") == "TOOL")
        self.assertNotIn("sk-1234567890abcdef", tool["tool.input"])
        self.assertNotIn("ghp_abcdefghijklmnop12345678", tool["tool.output"])
        self.assertIn("***", tool["tool.input"])

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
