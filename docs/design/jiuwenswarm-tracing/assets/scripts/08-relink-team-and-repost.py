#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Spike: relink the saved TEAM payload with the sub-agent spawn convention
(leader emits task tool_calls w/ subagent_type per member; members tagged
subagent_name == type) and re-POST. No team re-run — the captured spans are
identical; this just applies the bridge fix. Expect AGENTS = 1 + N members."""
import json
import os
import re
import sys
import uuid
from pathlib import Path

from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")
sys.path.insert(0, str(HERE))

from insight_bridge import post_to_insight

d = json.loads((HERE / "last-team-payload.json").read_text())
leader = d.get("agentName", "team_leader")


def clean(n: str) -> str:
    return re.sub(r"[^\w-]", "-", str(n))


members: list[str] = []
for it in d["interactions"]:
    if it.get("role") == "subagent":
        m = clean(it.get("subagent_name") or it.get("agent") or "member")
        it["subagent_name"] = m
        it["agent"] = m
        if m not in members:
            members.append(m)

spawn_calls = [
    {
        "id": f"spawn_{m}",
        "type": "function",
        "function": {"name": "task", "arguments": json.dumps(
            {"subagent_type": m, "description": f"spawn teammate {m}"}, ensure_ascii=False)},
        "state": "success",
        "output": f"{m} joined the team",
    }
    for m in members
]
d["interactions"].insert(1, {"role": "assistant", "agent": leader, "content": "", "tool_calls": spawn_calls})
d["task_id"] = "jiuwen-team-linked-" + uuid.uuid4().hex[:6]
d["agents"] = [leader] + members
d["subagentCount"] = len(members)
(HERE / "last-team-payload-linked.json").write_text(json.dumps(d, ensure_ascii=False, indent=2))

base = os.getenv("INSIGHT_BASE_URL", "http://localhost:3010")
st, txt = post_to_insight(d, base_url=base, api_key=os.getenv("INSIGHT_API_KEY"))
print("task_id =", d["task_id"])
print("leader =", leader, "| members =", members)
print("POST", st, txt[:160])
print(f"VIEW: {base}/trace?ownership=all&scope=all&time=all&taskId={d['task_id']}")
