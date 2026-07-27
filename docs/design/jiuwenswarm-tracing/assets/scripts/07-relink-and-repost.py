#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Spike step 5c: take the saved Task-fanout payload and rewrite it to satisfy
agent-insight's sub-agent tree convention (parent emits tool_call name='task'
with args.subagent_type=X; child subagent_name's inferred type == X), then
re-POST. No agent re-run — proves the AGENTS=1 cause was the missing spawn
linkage, not a tracing limitation. Expect AGENTS=3 (coordinator + 2 workers)."""
import json
import os
import sys
import uuid
from pathlib import Path

from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")
sys.path.insert(0, str(HERE))

from insight_bridge import post_to_insight

d = json.loads((HERE / "last-task-payload.json").read_text())

coord = next(i for i in d["interactions"] if i.get("role") == "assistant" and i.get("agent") == "coordinator")
subs = [i for i in d["interactions"] if i.get("role") == "subagent"]

for idx, (tc, sub) in enumerate(zip(coord.get("tool_calls", []), subs)):
    wtype = f"worker-{idx + 1}"                       # clean token: inferSubagentType -> "worker-1"
    orig_desc = tc["function"].get("arguments", "")
    tc["function"]["name"] = "task"
    # structured args so buildAgentCallTree reads args.subagent_type
    tc["function"]["arguments"] = json.dumps(
        {"subagent_type": wtype, "description": orig_desc}, ensure_ascii=False
    )
    sub["agent"] = wtype
    sub["subagent_name"] = wtype                       # must match subagent_type

d["task_id"] = "jiuwen-task-linked-" + uuid.uuid4().hex[:6]
d["agents"] = ["coordinator"] + [s["subagent_name"] for s in subs]
(HERE / "last-task-payload-linked.json").write_text(json.dumps(d, ensure_ascii=False, indent=2))

base_url = os.getenv("INSIGHT_BASE_URL", "http://localhost:3010")
st, txt = post_to_insight(d, base_url=base_url, api_key=os.getenv("INSIGHT_API_KEY"))
print("task_id =", d["task_id"])
print("subagent types:", [s["subagent_name"] for s in subs])
print("POST", st, txt[:200])
print(f"VIEW: {base_url}/trace?ownership=all&scope=all&time=all&taskId={d['task_id']}")
