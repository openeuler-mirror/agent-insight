#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Spike step 3b (后多): run ONE jiuwen multi-agent TEAM execution, capture spans,
transform the agent tree (leader + spawned teammates + their tools) -> agent-insight
multi-agent trace, and POST it to /api/ingest/upload."""
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

from insight_bridge import make_exporter, transform_team_spans_v2, post_to_insight


def load_spec():
    raw = os.path.expandvars((HERE / "team_min.yaml").read_text())
    cfg = yaml.safe_load(raw)
    runtime = cfg.pop("runtime", {})
    team_name = cfg.get("team_name", "jiuwen_spike_team")
    cfg = {k: v for k, v in cfg.items() if not k.startswith("x-")}
    return TeamAgentSpec.model_validate(cfg), runtime, team_name


async def main() -> None:
    spec, runtime, team_name = load_spec()
    task_id = "jiuwen-team-" + uuid.uuid4().hex[:8]
    exporter = make_exporter()
    init_observability(
        ObservabilityConfig(enabled=True, exporter="console", service_name="jiuwenswarm", sample_rate=1.0),
        span_exporter_override=exporter,
    )

    await Runner.start()
    query = runtime.get("initial_query", "拉2个人报数")
    print(f"=== TEAM RUN task_id={task_id} ===", flush=True)
    try:
        async for _ in Runner.run_agent_team_streaming(
            agent_team=spec, inputs={"query": query}, session=task_id
        ):
            pass
    finally:
        await Runner.stop()

    spans = list(exporter.get_finished_spans())
    from collections import Counter
    names = Counter(s.name.split(".")[0] for s in spans)
    print(f"=== collected {len(spans)} spans: {dict(names)} ===", flush=True)
    shutdown_observability()

    payload = transform_team_spans_v2(
        spans, task_id=task_id, query=query, team_name=team_name,
        leader="team_leader", framework="jiuwenswarm",
        user=os.getenv("INSIGHT_USER") or None,
    )

    import json as _json
    (HERE / "last-team-payload.json").write_text(_json.dumps(payload, ensure_ascii=False, indent=2))
    print("=== PAYLOAD summary ===", flush=True)
    print(_json.dumps({k: v for k, v in payload.items() if k != "interactions"}, ensure_ascii=False, indent=2), flush=True)
    print("interactions:", [(i.get("role"), i.get("agent"), len(i.get("tool_calls", []))) for i in payload["interactions"]], flush=True)

    base_url = os.getenv("INSIGHT_BASE_URL", "http://localhost:3010")
    api_key = os.getenv("INSIGHT_API_KEY")
    status, text = post_to_insight(payload, base_url=base_url, api_key=api_key)
    print(f"=== POST {base_url}/api/ingest/upload -> {status} ===", flush=True)
    print(text[:600], flush=True)
    print(f"VIEW: {base_url}/trace?ownership=all&scope=all&time=all&taskId={task_id}", flush=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        import traceback
        print("=== ERROR ===", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)
