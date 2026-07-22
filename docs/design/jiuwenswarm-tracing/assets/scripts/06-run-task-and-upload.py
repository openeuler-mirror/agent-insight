#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Spike step 5b: run a DeepAgent Task fan-out (isolated sub-agents), transform
-> agent-insight, POST. Contrast trace vs the team (peer-comms) run."""
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

from insight_bridge import make_exporter, transform_task_spans, post_to_insight


def build_model() -> Model:
    return Model(
        model_client_config=ModelClientConfig(
            client_provider=os.getenv("MODEL_PROVIDER", "OpenAI"),
            api_key=os.getenv("API_KEY", ""),
            api_base=os.getenv("API_BASE", ""),
            timeout=120,
            verify_ssl=False,
        ),
        model_config=ModelRequestConfig(model=os.getenv("MODEL_NAME", ""), temperature=0.2, top_p=0.9),
    )


async def main() -> None:
    ws = tempfile.mkdtemp(prefix="task-ws-", dir=str(HERE))
    task_id = "jiuwen-task-" + uuid.uuid4().hex[:8]
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
    query = (
        "请完成两件相互独立的小调研，并分别交给两个独立子 agent 去做："
        "(1) 用一句话说明杭州西湖最佳游览季节；(2) 用一句话推荐一道杭州本地必吃菜。"
        "最后把两个子 agent 的结果合并成一段话给我。"
    )
    print(f"=== TASK FAN-OUT RUN task_id={task_id} ===", flush=True)
    try:
        await Runner.run_agent(agent=agent, inputs={"query": query, "conversation_id": task_id})
    finally:
        try:
            await Runner.stop()
        except Exception:
            pass

    spans = list(exporter.get_finished_spans())
    print(f"=== collected {len(spans)} spans: {dict(Counter(s.name.split('.')[0] for s in spans))} ===", flush=True)
    shutdown_observability()

    payload = transform_task_spans(
        spans, task_id=task_id, query=query, coordinator="coordinator",
        framework="jiuwenswarm", user=os.getenv("INSIGHT_USER") or None,
    )
    import json as _json
    (HERE / "last-task-payload.json").write_text(_json.dumps(payload, ensure_ascii=False, indent=2))
    print("=== PAYLOAD summary ===", flush=True)
    print(_json.dumps({k: v for k, v in payload.items() if k != "interactions"}, ensure_ascii=False, indent=2), flush=True)
    print("interactions:", [(i.get("role"), i.get("agent"), len(i.get("tool_calls", []))) for i in payload["interactions"]], flush=True)

    base_url = os.getenv("INSIGHT_BASE_URL", "http://localhost:3010")
    status, text = post_to_insight(payload, base_url=base_url, api_key=os.getenv("INSIGHT_API_KEY"))
    print(f"=== POST {base_url}/api/ingest/upload -> {status} ===", flush=True)
    print(text[:400], flush=True)
    print(f"VIEW: {base_url}/trace?ownership=all&scope=all&time=all&taskId={task_id}", flush=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        import traceback
        print("=== ERROR ===", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)
