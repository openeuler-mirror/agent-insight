#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Prototype: jiuwen single agent reporting via agent-core's BUILT-IN OTLP http
exporter (no InMemory override, no upload script) -> agent-insight OTEL endpoint.
This is the "one-line auto-integrate" path: just point observability at us."""
import os
import sys
import asyncio
from pathlib import Path

from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")

from openjiuwen.core.runner import Runner
from openjiuwen.core.single_agent import AgentCard, ReActAgent, ReActAgentConfig
from openjiuwen.agent_teams.observability.setup import init_observability, shutdown_observability
from openjiuwen.agent_teams.observability.config import ObservabilityConfig

INSIGHT_OTLP = os.getenv("INSIGHT_OTLP", "http://localhost:3011/api/ingest/otel/v1/traces")


async def main() -> None:
    # THE WHOLE INTEGRATION: point agent-core's OTLP exporter at agent-insight.
    init_observability(ObservabilityConfig(
        enabled=True, exporter="otlp_http", endpoint=INSIGHT_OTLP,
        service_name="jiuwenswarm", sample_rate=1.0))

    agent = ReActAgent(card=AgentCard(name="spike_agent", description="otlp single agent"))
    cfg = (ReActAgentConfig()
           .configure_model_client(
               provider=os.getenv("MODEL_PROVIDER", "OpenAI"), api_key=os.getenv("API_KEY", ""),
               api_base=os.getenv("API_BASE", ""), model_name=os.getenv("MODEL_NAME", ""),
               verify_ssl=os.getenv("LLM_SSL_VERIFY", "False"))
           .configure_prompt_template([{"role": "system", "content": "You are a helpful assistant. Answer briefly in Chinese."}])
           .configure_max_iterations(3))
    agent.configure(cfg)

    print(f"=== RUN (OTLP push -> {INSIGHT_OTLP}) ===", flush=True)
    res = await Runner.run_agent(agent=agent, inputs={"query": "用一句话介绍杭州。", "conversation_id": "jiuwen-otlp-single"})
    print("OUTPUT:", (res.get("output", res) if isinstance(res, dict) else res), flush=True)
    shutdown_observability()  # force-flush remaining spans to the OTLP endpoint
    print("=== done (spans flushed) ===", flush=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        import traceback
        traceback.print_exc()
        sys.exit(1)
