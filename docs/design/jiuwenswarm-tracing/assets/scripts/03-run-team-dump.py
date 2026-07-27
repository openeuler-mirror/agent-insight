#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Spike step 3a: run ONE jiuwen multi-agent (TEAM) execution and DUMP its spans,
so we can see the multi-agent span shape (agent.* / agentteam.* / team.* / task.*)
before writing the team->insight transform."""
import os
import sys
import asyncio
import uuid
from pathlib import Path

import yaml
from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")
sys.path.insert(0, str(HERE))

from openjiuwen.agent_teams.observability import (
    ObservabilityConfig,
    init_observability,
    shutdown_observability,
)
from openjiuwen.agent_teams.schema.blueprint import TeamAgentSpec
from openjiuwen.core.runner.runner import Runner

from insight_bridge import make_exporter


def load_spec():
    raw = os.path.expandvars((HERE / "team_min.yaml").read_text())
    cfg = yaml.safe_load(raw)
    runtime = cfg.pop("runtime", {})
    cfg = {k: v for k, v in cfg.items() if not k.startswith("x-")}
    return TeamAgentSpec.model_validate(cfg), runtime


def dump_spans(spans):
    print(f"\n=== {len(spans)} spans ===", flush=True)
    for s in sorted(spans, key=lambda x: x.start_time or 0):
        a = dict(s.attributes or {})
        tid = format(s.context.trace_id, "032x")[:8]
        sid = format(s.context.span_id, "016x")[:8]
        pid = format(s.parent.span_id, "016x")[:8] if s.parent else "----"
        keys = [k for k in a if k.startswith(("agentteam.", "gen_ai.", "deepagent."))]
        interesting = {k: (str(a[k])[:60]) for k in keys if not k.startswith("gen_ai.prompt.") and not k.startswith("gen_ai.completion.")}
        print(f"[{tid}/{sid} ^{pid}] {s.name}", flush=True)
        if interesting:
            for k, v in interesting.items():
                print(f"      {k} = {v}", flush=True)


async def main() -> None:
    spec, runtime = load_spec()
    exporter = make_exporter()
    init_observability(
        ObservabilityConfig(enabled=True, exporter="console", service_name="jiuwenswarm-team", sample_rate=1.0),
        span_exporter_override=exporter,
    )

    await Runner.start()
    query = runtime.get("initial_query", "拉2个人报数")
    session_id = runtime.get("session_id", "jiuwen-team-" + uuid.uuid4().hex[:8])
    print(f"=== TEAM RUN session={session_id} ===", flush=True)
    n_chunks = 0
    final_texts = []
    try:
        async for chunk in Runner.run_agent_team_streaming(
            agent_team=spec, inputs={"query": query}, session=session_id
        ):
            n_chunks += 1
            payload = getattr(chunk, "payload", None)
            ctype = getattr(chunk, "type", "")
            if isinstance(payload, str) and payload.strip():
                final_texts.append(payload)
            elif isinstance(payload, dict) and payload.get("content"):
                final_texts.append(str(payload.get("content")))
    finally:
        await Runner.stop()

    print(f"=== stream done: {n_chunks} chunks ===", flush=True)
    if final_texts:
        print("=== last text ===", flush=True)
        print(final_texts[-1][:500], flush=True)

    spans = list(exporter.get_finished_spans())
    dump_spans(spans)
    shutdown_observability()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        import traceback
        print("=== ERROR ===", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)
