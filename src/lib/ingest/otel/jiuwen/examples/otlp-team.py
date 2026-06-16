#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Prototype: jiuwen multi-agent TEAM reporting via agent-core's built-in OTLP
exporter (no upload script). Exercises the server-side spool (spans arrive in
many batches) + team-tree reconstruction in the jiuwen OTEL adapter."""
import os
import sys
import asyncio
import uuid
from pathlib import Path

import yaml
from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")

from openjiuwen.agent_teams.observability import init_observability, shutdown_observability, ObservabilityConfig
from openjiuwen.agent_teams.schema.blueprint import TeamAgentSpec
from openjiuwen.core.runner.runner import Runner

INSIGHT_OTLP = os.getenv("INSIGHT_OTLP", "http://localhost:3011/api/ingest/otel/v1/traces")


def load_spec():
    raw = os.path.expandvars((HERE / "team_min.yaml").read_text())
    cfg = yaml.safe_load(raw)
    runtime = cfg.pop("runtime", {})
    cfg = {k: v for k, v in cfg.items() if not k.startswith("x-")}
    return TeamAgentSpec.model_validate(cfg), runtime


async def main() -> None:
    spec, runtime = load_spec()
    init_observability(ObservabilityConfig(
        enabled=True, exporter="otlp_http", endpoint=INSIGHT_OTLP,
        service_name="jiuwenswarm", sample_rate=1.0))

    await Runner.start()
    query = runtime.get("initial_query", "拉2个人报数")
    session_id = "jiuwen-otlp-team-" + uuid.uuid4().hex[:6]
    print(f"=== TEAM RUN (OTLP push -> {INSIGHT_OTLP}) session={session_id} ===", flush=True)
    n = 0
    try:
        async for _ in Runner.run_agent_team_streaming(agent_team=spec, inputs={"query": query}, session=session_id):
            n += 1
    finally:
        await Runner.stop()
    print(f"=== stream done: {n} chunks ===", flush=True)
    shutdown_observability()
    print("=== spans flushed ===", flush=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        import traceback
        traceback.print_exc()
        sys.exit(1)
