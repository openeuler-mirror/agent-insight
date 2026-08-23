"""Acceptance-level tests mapping to AC31-AC34.

These tests drive the Collector directly (no QwenPaw process needed) with a
fake exporter so the full eight-trace-type flow, parent/child correlation,
token accounting and structural stability can be verified deterministically.
"""

import tempfile
import unittest
from pathlib import Path

from agent_insight_copaw.collector import Collector
from agent_insight_copaw.config import CollectorConfig


class FakeExporter:
    def __init__(self):
        self.payloads: list[tuple[str, dict]] = []
        self.flush_count = 0

    def submit(self, item_id: str, payload: dict) -> None:
        self.payloads.append((item_id, payload))

    def flush(self, timeout: float = 3.0) -> None:
        self.flush_count += 1

    def close(self) -> None:
        pass


def _unwrap(value: dict) -> object:
    if "intValue" in value:
        return int(value["intValue"])
    if "doubleValue" in value:
        return value["doubleValue"]
    if "boolValue" in value:
        return value["boolValue"]
    return value.get("stringValue", "")


def _span_attributes(collector: Collector) -> list[dict]:
    attrs_list: list[dict] = []
    for _item_id, payload in collector.exporter.payloads:
        for span in payload["resourceSpans"][0]["scopeSpans"][0]["spans"]:
            attrs = {}
            for item in span.get("attributes", []):
                attrs[item["key"]] = _unwrap(item.get("value", {}))
            attrs["_span_id"] = span["spanId"]
            attrs["_parent_span_id"] = span.get("parentSpanId") or ""
            attrs["_span_name"] = span["name"]
            attrs_list.append(attrs)
    return attrs_list


def run_standard_scenario(collector: Collector) -> None:
    """AC31: one standardized run producing all eight trace types."""
    # Root agent (Channel trace).
    root_span = collector.start_agent(
        session_id="root-1",
        root_session_id="root-1",
        agent_id="assistant",
        root_agent_id="assistant",
        user_id="alice",
        channel="dingtalk",
        source="chat",
        query="standard task",
    )
    # LLM step 1.
    llm1 = collector.start_llm(model="qwen3", provider="dashscope", input="plan")
    collector.finish_llm(llm1, output="use shell", usage={"input_tokens": 10, "output_tokens": 5, "total_tokens": 15})
    # Tool call.
    tool = collector.start_tool(tool_name="shell", tool_input="ls", kind="shell")
    collector.finish_tool(tool, output="ok", status="success", exit_code=0)
    # Skill call.
    skill = collector.start_skill(name="docx", version="1.2", trigger="slash", args="make doc")
    collector.finish_skill(skill, output="doc ok")
    # MCP call.
    mcp = collector.start_mcp(server_name="github", tool_name="get_issue", arguments={"issue": 1})
    collector.finish_mcp(mcp, result="issue #1")
    # Sub-agent (nested under root).
    collector.register_subagent_relation("sub-1", "root-1")
    collector.start_agent(
        session_id="sub-1",
        root_session_id="root-1",
        agent_id="worker",
        root_agent_id="assistant",
        user_id="alice",
        channel="dingtalk",
        source="chat",
        query="sub task",
        is_subagent=True,
    )
    llm2 = collector.start_llm(model="qwen3", provider="dashscope", input="sub plan")
    collector.finish_llm(llm2, output="sub done", usage={"input_tokens": 4, "output_tokens": 2, "total_tokens": 6})
    collector.finish_agent_for_session("sub-1")
    # Cron job.
    cron = collector.start_cron(job_id="job-1", job_name="daily report", task_type="agent", channel="dingtalk")
    collector.finish_cron(cron, status="success", output="report sent")
    # Root agent finalization (Agent trace).
    collector.finish_agent_for_session("root-1", output="all done")
    collector.on_session_end("root-1")


class AcceptanceTest(unittest.TestCase):
    def _collector(self) -> Collector:
        self.tmp = tempfile.TemporaryDirectory()
        config = CollectorConfig(
            endpoint="",
            spool_dir=str(Path(self.tmp.name) / "spool"),
            log_file=str(Path(self.tmp.name) / "plugin.log"),
        )
        return Collector(config, exporter=FakeExporter())

    def tearDown(self):
        if hasattr(self, "tmp"):
            self.tmp.cleanup()

    def test_all_eight_trace_types_produced(self):
        """AC31: agent/subagent/skill/tool/llm/mcp/channel/cron all present."""
        collector = self._collector()
        run_standard_scenario(collector)
        spans = _span_attributes(collector)

        agents = [s for s in spans if s.get("gen_ai.span.kind") == "AGENT" and s.get("agent.subagent") is not True and "cron.job_id" not in s]
        subagents = [s for s in spans if s.get("agent.subagent") is True]
        llms = [s for s in spans if s.get("gen_ai.span.kind") == "LLM"]
        tools = [s for s in spans if s.get("gen_ai.span.kind") == "TOOL" and "skill.name" not in s and "mcp.server.name" not in s]
        skills = [s for s in spans if s.get("skill.name")]
        mcps = [s for s in spans if s.get("mcp.server.name")]
        crons = [s for s in spans if s.get("cron.job_id")]
        channels = [s for s in spans if s.get("qwenpaw.channel")]

        self.assertEqual(len(agents), 1)
        self.assertEqual(len(subagents), 1)
        self.assertGreaterEqual(len(llms), 2)
        self.assertEqual(len(tools), 1)
        self.assertEqual(len(skills), 1)
        self.assertEqual(len(mcps), 1)
        self.assertEqual(len(crons), 1)
        self.assertTrue(any(c["qwenpaw.channel"] == "dingtalk" for c in channels))

    def test_session_end_marker_emitted_once_for_root(self):
        """Explicit session-end marker is submitted once for the root trace."""
        collector = self._collector()
        collector.start_agent(
            session_id="root-1",
            root_session_id="root-1",
            agent_id="assistant",
            root_agent_id="assistant",
            user_id="alice",
            query="hello",
        )
        collector.finish_agent_for_session("root-1", output="done")
        collector.on_session_end("root-1")
        collector.on_session_end("root-1")

        spans = _span_attributes(collector)
        markers = [s for s in spans if s.get("qwenpaw.session.end") is True]
        self.assertEqual(len(markers), 1)
        self.assertEqual(markers[0]["_span_name"], "qwenpaw.session.end")
        self.assertEqual(markers[0]["qwenpaw.session_id"], "root-1")
        self.assertTrue(markers[0]["qwenpaw.completed_at"])

    def test_session_end_marker_skipped_for_subagent(self):
        """Sub-agent session end must not complete the parent trace early."""
        collector = self._collector()
        collector.start_agent(
            session_id="root-1",
            root_session_id="root-1",
            agent_id="assistant",
            root_agent_id="assistant",
            query="task",
        )
        collector.register_subagent_relation("sub-1", "root-1")
        collector.start_agent(
            session_id="sub-1",
            root_session_id="root-1",
            agent_id="worker",
            root_agent_id="assistant",
            query="sub task",
            is_subagent=True,
        )
        collector.finish_agent_for_session("sub-1")
        collector.on_session_end("sub-1")

        spans = _span_attributes(collector)
        markers = [s for s in spans if s.get("qwenpaw.session.end") is True]
        self.assertEqual(len(markers), 0)

    def test_parent_child_correlation(self):
        """AC32: sub-agent spans link to the parent agent span (incl. nesting)."""
        collector = self._collector()
        root_span = collector.start_agent(
            session_id="root-1",
            root_session_id="root-1",
            agent_id="assistant",
            root_agent_id="assistant",
            query="task",
        )
        # Level-1 sub-agent.
        collector.register_subagent_relation("sub-1", "root-1")
        collector.start_agent(
            session_id="sub-1",
            root_session_id="root-1",
            agent_id="worker",
            root_agent_id="assistant",
            query="sub task",
            is_subagent=True,
        )
        # Level-2 sub-agent (multi-level nesting).
        collector.register_subagent_relation("sub-1-1", "sub-1")
        collector.start_agent(
            session_id="sub-1-1",
            root_session_id="root-1",
            agent_id="worker2",
            root_agent_id="assistant",
            query="sub sub task",
            is_subagent=True,
        )
        # Concurrent sibling.
        collector.register_subagent_relation("sub-2", "root-1")
        collector.start_agent(
            session_id="sub-2",
            root_session_id="root-1",
            agent_id="worker3",
            root_agent_id="assistant",
            query="sibling task",
            is_subagent=True,
        )
        # Destroy the sub-agents (AC6: create + destroy emit sub-agent traces).
        collector.finish_agent_for_session("sub-1-1")
        collector.finish_agent_for_session("sub-2")
        collector.finish_agent_for_session("sub-1")
        collector.finish_agent_for_session("root-1")

        spans = _span_attributes(collector)
        by_session = {s["qwenpaw.session_id"]: s for s in spans if s.get("gen_ai.span.kind") == "AGENT"}
        root = by_session["root-1"]
        sub1 = by_session["sub-1"]
        sub11 = by_session["sub-1-1"]
        sub2 = by_session["sub-2"]

        self.assertEqual(sub1["_parent_span_id"], root["_span_id"])
        self.assertEqual(sub11["_parent_span_id"], sub1["_span_id"])
        self.assertEqual(sub2["_parent_span_id"], root["_span_id"])
        self.assertEqual(sub1["qwenpaw.parent_session_id"], "root-1")
        self.assertEqual(sub11["qwenpaw.parent_session_id"], "sub-1")
        self.assertEqual(sub2["qwenpaw.parent_session_id"], "root-1")

    def test_token_totals_match_llm_usage(self):
        """AC33: agent trace total tokens equal the sum of LLM spans."""
        collector = self._collector()
        run_standard_scenario(collector)
        spans = _span_attributes(collector)
        agent = next(s for s in spans if s.get("gen_ai.span.kind") == "AGENT" and s.get("agent.subagent") is not True and "cron.job_id" not in s)
        llm_total = sum(int(s["llm.token_count.total"]) for s in spans if s.get("gen_ai.span.kind") == "LLM")
        self.assertEqual(int(agent["llm.token_count.total"]), llm_total)
        self.assertEqual(llm_total, 21)  # 15 + 6

    def test_repeated_runs_have_identical_structure(self):
        """AC34: three identical runs produce the same trace structure."""
        fingerprints: list[list[tuple]] = []
        for _ in range(3):
            collector = self._collector()
            run_standard_scenario(collector)
            spans = _span_attributes(collector)
            fingerprint = sorted(
                (
                    s["_span_name"],
                    s.get("gen_ai.span.kind", ""),
                    tuple(
                        sorted(
                            key
                            for key in s
                            if key not in ("_span_id", "_parent_span_id", "_span_name")
                        )
                    ),
                )
                for s in spans
            )
            fingerprints.append(fingerprint)
            collector.close()
        self.assertEqual(fingerprints[0], fingerprints[1])
        self.assertEqual(fingerprints[1], fingerprints[2])


if __name__ == "__main__":
    unittest.main()



