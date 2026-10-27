"""????????: ????????? Trace ?????? AgentInsight ???

??:
    $env:PYTHONPATH = "D:\\openeuler\\agent-insight\\scripts\\qwenpaw"
    $env:AGENT_INSIGHT_API_KEY = "<?? API Key>"
    python demo_push.py

?????? AGENT_INSIGHT_API_KEY ?????(sam)?
"""
from __future__ import annotations

import os
import time
from datetime import datetime

from qwenpaw_insight.collector import Collector
from qwenpaw_insight.config import CollectorConfig

API_KEY = os.environ.get("AGENT_INSIGHT_API_KEY", "")
ENDPOINT = os.environ.get("AGENT_INSIGHT_HOST", "http://localhost:3000").rstrip("/") + "/api/ingest/otel/v1/traces"
USER_ID = os.environ.get("AGENT_INSIGHT_USER", "sam")

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
ROOT_SESSION = f"demo-{USER_ID}-{stamp}"
SUB_SESSION = f"demo-sub-{USER_ID}-{stamp}"
CRON_JOB = f"demo-cron-{USER_ID}-{stamp}"


def main() -> None:
    if not API_KEY:
        raise SystemExit("???? AGENT_INSIGHT_API_KEY ????(?? -> ?? -> API Key)")

    config = CollectorConfig(
        endpoint=ENDPOINT,
        api_key=API_KEY,
        service_name="qwenpaw",
    )
    collector = Collector(config)
    collector.start()

    # 1) ? Agent(Channel ??: ??)
    collector.start_agent(
        session_id=ROOT_SESSION,
        root_session_id=ROOT_SESSION,
        agent_id="assistant",
        root_agent_id="assistant",
        user_id=USER_ID,
        channel="dingtalk",
        source="chat",
        query="????? GitHub issue #1 ?????",
    )
    # 2) LLM ?? 1
    llm1 = collector.start_llm(model="qwen3", provider="dashscope", input="???????????")
    collector.finish_llm(llm1, output="??? issue??????????", usage={"input_tokens": 120, "output_tokens": 60, "total_tokens": 180})
    # 3) Tool: Shell
    tool = collector.start_tool(tool_name="shell", tool_input="ls -la", kind="shell")
    collector.finish_tool(tool, output="ok", status="success", exit_code=0)
    # 4) Skill ??
    skill = collector.start_skill(name="docx", version="1.2", trigger="slash", args="??????")
    collector.finish_skill(skill, output="?????")
    # 5) MCP ??
    mcp = collector.start_mcp(server_name="github", tool_name="get_issue", arguments={"issue": 1})
    collector.finish_mcp(mcp, result="issue #1: demo title")
    # 6) ? Agent(?????? Agent)
    collector.register_subagent_relation(SUB_SESSION, ROOT_SESSION)
    collector.start_agent(
        session_id=SUB_SESSION,
        root_session_id=ROOT_SESSION,
        agent_id="worker",
        root_agent_id="assistant",
        user_id=USER_ID,
        channel="dingtalk",
        source="chat",
        query="?? issue ??",
        is_subagent=True,
    )
    # 7) LLM ?? 2(? Agent ?)
    llm2 = collector.start_llm(model="qwen3", provider="dashscope", input="?? issue")
    collector.finish_llm(llm2, output="???", usage={"input_tokens": 40, "output_tokens": 20, "total_tokens": 60})
    collector.finish_agent_for_session(SUB_SESSION)
    # 8) Cron ????
    cron = collector.start_cron(job_id=CRON_JOB, job_name="????", task_type="agent", channel="dingtalk")
    collector.finish_cron(cron, status="success", output="?????")
    # ? Agent ??
    collector.finish_agent_for_session(ROOT_SESSION, output="????")
    collector.on_session_end(ROOT_SESSION)

    print(f"[demo] ??? Trace: ?Agent={ROOT_SESSION} ?Agent={SUB_SESSION} Cron={CRON_JOB}")
    print(f"[demo] ??? {ENDPOINT} ...")
    collector.flush(8)
    collector.close()
    print("[demo] ?????? 30-40 ?????? /trace ?????????")


if __name__ == "__main__":
    main()
