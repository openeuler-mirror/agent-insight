#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Spike step 1: run ONE single-agent execution through agent-core (the jiuwen engine),
with observability turned on (console exporter) so we can SEE what it natively emits.
No agent-insight wiring yet — this is the "run bare and observe" step."""
import os
import sys
import asyncio
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent / ".env")

from openjiuwen.core.runner import Runner
from openjiuwen.core.single_agent import AgentCard, ReActAgent, ReActAgentConfig
from openjiuwen.agent_teams.observability.setup import (
    init_observability,
    shutdown_observability,
)
from openjiuwen.agent_teams.observability.config import ObservabilityConfig


async def main() -> None:
    # Console exporter => spans print to stdout. This is the whole point of step 1.
    init_observability(
        ObservabilityConfig(
            enabled=True,
            exporter="console",
            service_name="jiuwenswarm-spike",
            sample_rate=1.0,
        )
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

    print("=== RUNNING SINGLE AGENT ===", flush=True)
    res = await Runner.run_agent(
        agent=agent,
        inputs={"query": "用一句话介绍杭州。", "conversation_id": "spike-001"},
    )
    print("=== AGENT OUTPUT ===", flush=True)
    print(res.get("output", res) if isinstance(res, dict) else res, flush=True)

    shutdown_observability()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:  # noqa: BLE001 - spike: surface everything
        import traceback

        print("=== ERROR ===", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)
