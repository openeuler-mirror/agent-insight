#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Spike step 2: run ONE single-agent execution, capture its OTEL spans via an
InMemorySpanExporter, transform the whole run -> agent-insight rich payload,
and POST it to /api/ingest/upload. End-to-end: jiuwen execution -> agent-insight trace."""
import os
import sys
import asyncio
import uuid
from pathlib import Path

from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")
sys.path.insert(0, str(HERE))

from openjiuwen.core.runner import Runner
from openjiuwen.core.single_agent import AgentCard, ReActAgent, ReActAgentConfig
from openjiuwen.agent_teams.observability.setup import init_observability, shutdown_observability
from openjiuwen.agent_teams.observability.config import ObservabilityConfig

from insight_bridge import make_exporter, transform_spans, post_to_insight


async def main() -> None:
    query = os.getenv("SPIKE_QUERY", "用一句话介绍杭州，并说明今天适不适合去西湖散步。")
    conversation_id = "jiuwen-spike-" + uuid.uuid4().hex[:8]

    exporter = make_exporter()
    init_observability(
        ObservabilityConfig(
            enabled=True,
            exporter="console",  # ignored: span_exporter_override wins
            service_name="jiuwenswarm",
            sample_rate=1.0,
        ),
        span_exporter_override=exporter,
    )

    agent = ReActAgent(card=AgentCard(name="spike_agent", description="spike single agent"))
    cfg = (
        ReActAgentConfig()
        .configure_model_client(
            provider=os.getenv("MODEL_PROVIDER", "OpenAI"),
            api_key=os.getenv("API_KEY", ""),
            api_base=os.getenv("API_BASE", ""),
            model_name=os.getenv("MODEL_NAME", ""),
            verify_ssl=os.getenv("LLM_SSL_VERIFY", "False"),
        )
        .configure_prompt_template(
            [{"role": "system", "content": "You are a helpful assistant. Answer briefly in Chinese."}]
        )
        .configure_max_iterations(3)
    )
    agent.configure(cfg)

    print(f"=== RUNNING (conversation_id={conversation_id}) ===", flush=True)
    res = await Runner.run_agent(agent=agent, inputs={"query": query, "conversation_id": conversation_id})
    answer = res.get("output", res) if isinstance(res, dict) else res
    print("=== AGENT OUTPUT ===", flush=True)
    print(answer, flush=True)

    spans = list(exporter.get_finished_spans())
    print(f"=== collected {len(spans)} spans: {[s.name for s in spans]} ===", flush=True)
    shutdown_observability()

    payload = transform_spans(
        spans,
        task_id=conversation_id,
        query=query,
        framework="jiuwenswarm",
        user=os.getenv("INSIGHT_USER") or None,
        agent_name="jiuwenswarm/spike_agent",
    )

    import json as _json
    (HERE / "last-payload.json").write_text(_json.dumps(payload, ensure_ascii=False, indent=2))
    print("=== PAYLOAD (saved to last-payload.json) ===", flush=True)
    print(_json.dumps({k: v for k, v in payload.items() if k != "interactions"}, ensure_ascii=False, indent=2), flush=True)
    print(f"interactions: {len(payload['interactions'])} turns", flush=True)

    base_url = os.getenv("INSIGHT_BASE_URL", "http://localhost:3000")
    api_key = os.getenv("INSIGHT_API_KEY")
    status, text = post_to_insight(payload, base_url=base_url, api_key=api_key)
    print(f"=== POST {base_url}/api/ingest/upload -> {status} ===", flush=True)
    print(text[:800], flush=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        import traceback
        print("=== ERROR ===", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)
