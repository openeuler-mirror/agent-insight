#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Spike step 5a: run a DeepAgent that FANS OUT to isolated Task sub-agents
(hub-and-spoke; sub-agents do NOT talk to each other) and dump the span shape,
to contrast with the team (message-bus, peer-comms) run."""
import os
import sys
import asyncio
import uuid
import tempfile
from pathlib import Path
from collections import Counter

from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")
sys.path.insert(0, str(HERE))

from openjiuwen.core.foundation.llm import Model, ModelClientConfig, ModelRequestConfig
from openjiuwen.core.single_agent import AgentCard
from openjiuwen.harness.factory import create_deep_agent
from openjiuwen.core.runner import Runner
from openjiuwen.agent_teams.observability import (
    ObservabilityConfig,
    init_observability,
    shutdown_observability,
)

from insight_bridge import make_exporter


def build_model() -> Model:
    return Model(
        model_client_config=ModelClientConfig(
            client_provider=os.getenv("MODEL_PROVIDER", "OpenAI"),
            api_key=os.getenv("API_KEY", ""),
            api_base=os.getenv("API_BASE", ""),
            timeout=120,
            verify_ssl=False,
        ),
        model_config=ModelRequestConfig(
            model=os.getenv("MODEL_NAME", ""), temperature=0.2, top_p=0.9,
        ),
    )


def dump(spans):
    print(f"\n=== {len(spans)} spans ===", flush=True)
    for s in sorted(spans, key=lambda x: x.start_time or 0):
        a = dict(s.attributes or {})
        tid = format(s.context.trace_id, "032x")[:8]
        sid = format(s.context.span_id, "016x")[:8]
        pid = format(s.parent.span_id, "016x")[:8] if s.parent else "----"
        print(f"[{tid}/{sid} ^{pid}] {s.name}", flush=True)
        for k in a:
            if k.startswith(("agentteam.", "gen_ai.tool", "gen_ai.usage.total", "gen_ai.request.model")) \
               and "prompt." not in k and "completion." not in k:
                print(f"    {k} = {str(a[k])[:70]}", flush=True)


async def main() -> None:
    ws = tempfile.mkdtemp(prefix="task-ws-", dir=str(HERE))
    exporter = make_exporter()
    init_observability(
        ObservabilityConfig(enabled=True, exporter="console", service_name="jiuwenswarm", sample_rate=1.0),
        span_exporter_override=exporter,
    )
    agent = create_deep_agent(
        model=build_model(),
        card=AgentCard(name="coordinator", description="task fan-out coordinator"),
        workspace=ws,
        language="cn",
        max_iterations=12,
        add_general_purpose_agent=True,
        enable_async_subagent=False,
        system_prompt=(
            "你是协调者。当任务可拆分时，必须用 task 工具把每个子任务分派给一个独立的 "
            "general-purpose 子 agent 去完成：一个子任务派一个子 agent，等它们各自返回结果后，"
            "你再把结果汇总成最终答复。不要自己直接回答可拆分的子任务。"
        ),
    )

    await Runner.start()
    task_id = "jiuwen-task-" + uuid.uuid4().hex[:8]
    query = (
        "请完成两件相互独立的小调研，并分别交给两个独立子 agent 去做："
        "(1) 用一句话说明杭州西湖最佳游览季节；(2) 用一句话推荐一道杭州本地必吃菜。"
        "最后把两个子 agent 的结果合并成一段话给我。"
    )
    print(f"=== TASK FAN-OUT RUN task_id={task_id} ===", flush=True)
    try:
        res = await Runner.run_agent(agent=agent, inputs={"query": query, "conversation_id": task_id})
    finally:
        try:
            await Runner.stop()
        except Exception:
            pass
    out = res.get("output", res) if isinstance(res, dict) else res
    print("=== OUTPUT ===", flush=True)
    print(str(out)[:500], flush=True)

    spans = list(exporter.get_finished_spans())
    print("=== span name breakdown:", dict(Counter(s.name.split('.')[0] for s in spans)), "===", flush=True)
    dump(spans)
    shutdown_observability()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        import traceback
        print("=== ERROR ===", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)
