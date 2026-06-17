# -*- coding: utf-8 -*-
"""Bridge: openJiuwen agent-core OTEL spans -> agent-insight rich ingest payload.

Seam: we feed jiuwen's built-in observability an InMemorySpanExporter
(`init_observability(config, span_exporter_override=make_exporter())`), let
agent-core's OtelCallbackHandler do all the span correlation, then after the
run we transform the collected spans into agent-insight's `/api/ingest/upload`
JSON and POST it. Zero changes to jiuwen core.

Why /api/ingest/upload (rich) and NOT /api/ingest/otel/v1/traces (thin):
  - agent-core emits gen_ai.usage.prompt_tokens / indexed gen_ai.prompt.N /
    gen_ai.tool.name; the OTEL endpoint reads input_tokens / flat gen_ai.prompt
    / tool.name -> tokens, text, tool names would be dropped.
  - single-agent run splits agent span vs llm span across two trace_ids;
    the OTEL endpoint groups by traceId -> one execution becomes two sessions.
  Collecting the whole run here and mapping names ourselves fixes both.
"""
from __future__ import annotations

import json
from typing import Any, Iterable

import httpx
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter


def make_exporter() -> InMemorySpanExporter:
    """Exporter to pass as init_observability(span_exporter_override=...)."""
    return InMemorySpanExporter()


# --------------------------------------------------------------------------
# span attribute helpers
# --------------------------------------------------------------------------

def _attrs(span: Any) -> dict[str, Any]:
    return dict(span.attributes or {})


def _ms(ns: int | None) -> int:
    return int((ns or 0) // 1_000_000)


def _prompt_messages(attrs: dict[str, Any]) -> list[dict[str, str]]:
    """Reassemble indexed gen_ai.prompt.{i}.role/content -> [{role,content}]."""
    idxs = sorted(
        {
            int(k.split(".")[2])
            for k in attrs
            if k.startswith("gen_ai.prompt.") and k.endswith(".role")
        }
    )
    out = []
    for i in idxs:
        out.append(
            {
                "role": str(attrs.get(f"gen_ai.prompt.{i}.role", "")),
                "content": str(attrs.get(f"gen_ai.prompt.{i}.content", "")),
            }
        )
    return out


def _completion_text(attrs: dict[str, Any]) -> str:
    return str(attrs.get("gen_ai.completion.0.content", ""))


# --------------------------------------------------------------------------
# transform
# --------------------------------------------------------------------------

def transform_spans(
    spans: Iterable[Any],
    *,
    task_id: str,
    query: str,
    framework: str = "jiuwenswarm",
    user: str | None = None,
    agent_name: str = "jiuwenswarm",
) -> dict[str, Any]:
    """Turn a run's collected ReadableSpans into an agent-insight ExecutionRecord.

    Maps:
      llm.call span   -> one assistant interaction (content + usage + model)
      tool.* span     -> a tool_call attached to the assistant whose llm span
                         is its parent (falls back to the last assistant turn)
      agent.* span    -> agent boundary (agentteam.agent.* drives multi-agent)
    """
    spans = sorted(spans, key=lambda s: s.start_time or 0)

    # index tool spans by parent span id so we can nest them under their llm call
    tool_by_parent: dict[int, list[Any]] = {}
    for s in spans:
        if s.name.startswith("tool."):
            pid = s.parent.span_id if s.parent else 0
            tool_by_parent.setdefault(pid, []).append(s)

    interactions: list[dict[str, Any]] = []

    # human turn first
    interactions.append(
        {
            "role": "user",
            "content": query,
            "timestamp": None,
        }
    )

    in_tok = out_tok = total_tok = 0
    llm_calls = 0
    tool_calls_total = 0
    model_name = ""
    final_result = ""
    first_start = None
    last_end = None

    for s in spans:
        if first_start is None or (s.start_time or 0) < first_start:
            first_start = s.start_time
        if last_end is None or (s.end_time or 0) > last_end:
            last_end = s.end_time

        if s.name != "llm.call":
            continue

        a = _attrs(s)
        llm_calls += 1
        pt = int(a.get("gen_ai.usage.prompt_tokens", 0) or 0)
        ct = int(a.get("gen_ai.usage.completion_tokens", 0) or 0)
        tt = int(a.get("gen_ai.usage.total_tokens", 0) or (pt + ct))
        in_tok += pt
        out_tok += ct
        total_tok += tt
        model_name = str(a.get("gen_ai.request.model") or model_name)
        content = _completion_text(a)
        if content:
            final_result = content

        # tool calls that ran under this llm span
        my_tools = tool_by_parent.get(s.context.span_id, [])
        tool_calls = []
        for t in my_tools:
            ta = _attrs(t)
            tool_calls_total += 1
            tool_calls.append(
                {
                    "id": str(ta.get("gen_ai.tool.id", t.context.span_id)),
                    "type": "function",
                    "function": {
                        "name": str(ta.get("gen_ai.tool.name", t.name)),
                        "arguments": str(ta.get("gen_ai.tool.input", "")),
                    },
                    "state": "success",
                    "output": ta.get("gen_ai.tool.output", ""),
                }
            )

        interactions.append(
            {
                "role": "assistant",
                "content": content,
                "tool_calls": tool_calls,
                "usage": {"input": pt, "output": ct, "total": tt},
                "modelID": model_name,
                "providerID": str(a.get("gen_ai.system", "openjiuwen")),
                "agent": agent_name,
                "timeInfo": {"created": _ms(s.start_time), "completed": _ms(s.end_time)},
                "timestamp": None,
            }
        )

    latency_s = (((last_end or 0) - (first_start or 0)) / 1_000_000_000.0) if first_start else 0.0

    payload: dict[str, Any] = {
        "task_id": task_id,
        "query": query,
        "framework": framework,
        "agentName": agent_name,
        "model": model_name or "unknown",
        "tokens": total_tok,
        "input_tokens": in_tok,
        "output_tokens": out_tok,
        "tool_call_count": tool_calls_total,
        "llm_call_count": llm_calls,
        "latency": round(latency_s, 3),
        "final_result": final_result,
        "interactions": interactions,
        "label": framework,
    }
    if user:
        payload["user"] = user
    return payload


def _extract_output_text(raw: Any) -> str:
    """agentteam.agent.output looks like "{'output': '...', 'result_type': 'answer'}"."""
    import ast
    s = str(raw or "")
    try:
        obj = ast.literal_eval(s)
        if isinstance(obj, dict):
            return str(obj.get("output", s))
    except (ValueError, SyntaxError):
        pass
    return s


def _unwrap_tool_data(raw: Any) -> str:
    """jiuwen task tool output: "success=True data={'output': '...', ...} error=None".
    Pull out data['output']; the trailing " error=..." after the dict otherwise
    breaks a naive literal_eval on the whole tail."""
    import ast
    s = str(raw or "")
    d = s.find("data=")
    if d >= 0:
        frag = s[d + 5:]
        e = frag.rfind("} error=")          # strip trailing " error=None"
        if e >= 0:
            frag = frag[:e + 1]
        try:
            obj = ast.literal_eval(frag)
            if isinstance(obj, dict) and "output" in obj:
                return str(obj["output"])
        except (ValueError, SyntaxError):
            pass
    return _extract_output_text(s) or s


def transform_team_spans(
    spans: Iterable[Any],
    *,
    task_id: str,
    query: str,
    team_name: str,
    leader: str = "team_leader",
    framework: str = "jiuwenswarm",
    user: str | None = None,
) -> dict[str, Any]:
    """Turn a multi-agent TEAM run's spans into an agent-insight multi-agent trace.

    Member identity comes from tool span ids (`<tool>_<team>_<member>`); LLM spans
    are absent in team runs (streaming spans aren't closed by jiuwen's wired
    handlers), so per-call tokens are unavailable here — we render the agent tree
    + tool calls + each agent's output. Tree shape (per agent-insight builder):
      - leader = root (role=assistant, agent=<leader>)
      - each other member = sub-agent node (role=subagent + subagent_session_id)
    """
    spans = sorted(spans, key=lambda s: s.start_time or 0)
    marker = team_name + "_"

    # group tool spans by member
    tools_by_member: dict[str, list[dict[str, Any]]] = {}
    tool_total = 0
    first_start = last_end = None
    for s in spans:
        if first_start is None or (s.start_time or 0) < first_start:
            first_start = s.start_time
        if last_end is None or (s.end_time or 0) > last_end:
            last_end = s.end_time
        if not s.name.startswith("tool."):
            continue
        a = _attrs(s)
        tid = str(a.get("gen_ai.tool.id", ""))
        member = tid.split(marker, 1)[1] if marker in tid else leader
        tool_total += 1
        tools_by_member.setdefault(member, []).append(
            {
                "id": tid or str(s.context.span_id),
                "type": "function",
                "function": {
                    "name": str(a.get("gen_ai.tool.name", s.name)),
                    "arguments": str(a.get("gen_ai.tool.input", ""))[:2000],
                },
                "state": "success",
                "output": str(a.get("gen_ai.tool.output", ""))[:2000],
                "_start": s.start_time or 0,
            }
        )

    # final summary: longest agent output across agent.* spans
    summary = ""
    for s in spans:
        if s.name.startswith("agent."):
            txt = _extract_output_text(_attrs(s).get("agentteam.agent.output"))
            if len(txt) > len(summary):
                summary = txt

    members = list(tools_by_member.keys())
    # leader first, others as sub-agents
    others = [m for m in members if m != leader]

    interactions: list[dict[str, Any]] = [{"role": "user", "content": query}]
    # leader (root)
    leader_tools = sorted(tools_by_member.get(leader, []), key=lambda t: t.pop("_start"))
    interactions.append(
        {
            "role": "assistant",
            "agent": leader,
            "content": summary,
            "tool_calls": leader_tools,
        }
    )
    # each other member -> sub-agent node
    for m in others:
        mtools = sorted(tools_by_member.get(m, []), key=lambda t: t.pop("_start"))
        interactions.append(
            {
                "role": "subagent",
                "agent": m,
                "subagent_name": m,
                "subagent_session_id": f"{team_name}_{m}",
                "content": "",
                "tool_calls": mtools,
            }
        )

    latency_s = (((last_end or 0) - (first_start or 0)) / 1_000_000_000.0) if first_start else 0.0
    payload: dict[str, Any] = {
        "task_id": task_id,
        "query": query,
        "framework": framework,
        "agentName": leader,
        "agents": [leader] + others,
        "model": "deepseek-v4-flash",
        "tool_call_count": tool_total,
        "llm_call_count": 0,
        "latency": round(latency_s, 3),
        "final_result": summary,
        "interactions": interactions,
        "label": framework,
        "subagentCount": len(others),
    }
    if user:
        payload["user"] = user
    return payload


def post_to_insight(payload: dict[str, Any], *, base_url: str, api_key: str | None) -> tuple[int, str]:
    url = base_url.rstrip("/") + "/api/ingest/upload"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["x-witty-api-key"] = api_key
    resp = httpx.post(url, content=json.dumps(payload), headers=headers, timeout=30.0)
    return resp.status_code, resp.text


def transform_team_spans_v2(
    spans: Iterable[Any],
    *,
    task_id: str,
    query: str,
    team_name: str,
    leader: str = "team_leader",
    framework: str = "jiuwenswarm",
    user: str | None = None,
) -> dict[str, Any]:
    """Like transform_team_spans but ALSO folds in llm.call spans (now that the
    streaming-span fix exports them): aggregate tokens + llm_call_count, and emit
    a time-ordered per-turn timeline (each llm call + each tool call) tagged by
    member. llm spans lack a member id, so they're attributed by trace_id ->
    dominant tool-member in that trace (best-effort; documented)."""
    from collections import defaultdict

    spans = sorted(spans, key=lambda s: s.start_time or 0)
    marker = team_name + "_"

    def member_of_tool(a: dict[str, Any]) -> str:
        tid = str(a.get("gen_ai.tool.id", ""))
        return tid.split(marker, 1)[1] if marker in tid else leader

    votes: dict[int, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for s in spans:
        if s.name.startswith("tool."):
            votes[s.context.trace_id][member_of_tool(_attrs(s))] += 1

    def trace_member(tr: int) -> str:
        v = votes.get(tr)
        return max(v, key=v.get) if v else leader

    turns: list[tuple[int, str, dict[str, Any]]] = []
    in_tok = out_tok = tot_tok = llm_count = tool_count = 0
    first = last = None
    for s in spans:
        st, en = s.start_time or 0, s.end_time or 0
        first = st if first is None else min(first, st)
        last = en if last is None else max(last, en)
        a = _attrs(s)
        if s.name == "llm.call":
            llm_count += 1
            pt = int(a.get("gen_ai.usage.prompt_tokens", 0) or 0)
            ct = int(a.get("gen_ai.usage.completion_tokens", 0) or 0)
            tt = int(a.get("gen_ai.usage.total_tokens", 0) or (pt + ct))
            in_tok += pt
            out_tok += ct
            tot_tok += tt
            turns.append(
                (st, trace_member(s.context.trace_id), {
                    "content": str(a.get("gen_ai.completion.0.content", "")),
                    "usage": {"input": pt, "output": ct, "total": tt},
                    "modelID": str(a.get("gen_ai.request.model", "")),
                    "tool_calls": [],
                    "timeInfo": {"created": _ms(st), "completed": _ms(en)},
                })
            )
        elif s.name.startswith("tool."):
            tool_count += 1
            turns.append(
                (st, member_of_tool(a), {
                    "content": "",
                    "tool_calls": [{
                        "id": str(a.get("gen_ai.tool.id", s.context.span_id)),
                        "type": "function",
                        "function": {
                            "name": str(a.get("gen_ai.tool.name", s.name)),
                            "arguments": str(a.get("gen_ai.tool.input", ""))[:2000],
                        },
                        "state": "success",
                        "output": str(a.get("gen_ai.tool.output", ""))[:2000],
                    }],
                    "timeInfo": {"created": _ms(st), "completed": _ms(en)},
                })
            )

    summary = ""
    for s in spans:
        if s.name.startswith("agent."):
            t = _extract_output_text(_attrs(s).get("agentteam.agent.output"))
            if len(t) > len(summary):
                summary = t

    interactions: list[dict[str, Any]] = [{"role": "user", "content": query}]
    for st, m, frag in sorted(turns, key=lambda x: x[0]):
        if m == leader:
            interactions.append({"role": "assistant", "agent": leader, **frag})
        else:
            interactions.append({
                "role": "subagent", "agent": m, "subagent_name": m,
                "subagent_session_id": f"{team_name}_{m}", **frag,
            })

    latency_s = (((last or 0) - (first or 0)) / 1_000_000_000.0) if first else 0.0
    members = sorted({m for _, m, _ in turns})

    # Emit a `task` spawn event from the leader for each member so agent-insight's
    # buildAgentCallTree links them as child AGENT nodes. The tool_call must be
    # named "task" with args.subagent_type == the member's inferred subagent_name;
    # without this the member interactions fold into root (AGENTS stays 1).
    others = [m for m in members if m != leader]
    if others:
        spawn_calls = [
            {
                "id": f"spawn_{m}",
                "type": "function",
                "function": {
                    "name": "task",
                    "arguments": json.dumps(
                        {"subagent_type": m, "description": f"spawn teammate {m}"},
                        ensure_ascii=False,
                    ),
                },
                "state": "success",
                "output": f"{m} joined the team",
            }
            for m in others
        ]
        interactions.insert(1, {"role": "assistant", "agent": leader, "content": "", "tool_calls": spawn_calls})

    payload: dict[str, Any] = {
        "task_id": task_id,
        "query": query,
        "framework": framework,
        "agentName": leader,
        "agents": members,
        "model": "deepseek-v4-flash",
        "tokens": tot_tok,
        "input_tokens": in_tok,
        "output_tokens": out_tok,
        "tool_call_count": tool_count,
        "llm_call_count": llm_count,
        "latency": round(latency_s, 3),
        "final_result": summary,
        "interactions": interactions,
        "label": framework,
        "subagentCount": max(0, len(members) - 1),
    }
    if user:
        payload["user"] = user
    return payload


# ---------------------------------------------------------------------------
# v3: parent-chain attribution for agent-core develop >= 8b2a384 ("agent team
# observability" rework). The whole run is now ONE trace with proper nesting:
#   team.<name> -> agent.<member>.task_iteration.<n> -> llm.call / tool.<name>
# so we attribute each llm/tool span to its ENCLOSING agent span's member
# (agentteam.agent.id), replacing v2's trace-id voting (which collapses now that
# everything shares one trace_id) and v2's fixed `leader` (the real leader id is
# the agent card name, e.g. "TeamLeader", not the "team_leader" hint).
# ---------------------------------------------------------------------------

def _index_by_span_id(spans: Iterable[Any]) -> dict[int, Any]:
    idx: dict[int, Any] = {}
    for s in spans:
        try:
            idx[s.context.span_id] = s
        except Exception:
            pass
    return idx


def _is_agent_span(s: Any) -> bool:
    return s.name.startswith("agent.") and ".task_iteration." in s.name


def _agent_member(s: Any) -> str:
    m = _attrs(s).get("agentteam.agent.id")
    if m:
        return str(m)
    parts = s.name.split(".")  # agent.<member>.task_iteration.<n>
    return parts[1] if len(parts) > 2 else s.name


def _enclosing_member(s: Any, idx: dict[int, Any], default: str) -> str:
    cur, seen = s, set()
    while cur is not None:
        if _is_agent_span(cur):
            return _agent_member(cur)
        pid = cur.parent.span_id if cur.parent else None
        if pid is None or pid in seen:
            break
        seen.add(pid)
        cur = idx.get(pid)
    return default


def transform_team_spans_v3(
    spans: Iterable[Any],
    *,
    task_id: str,
    query: str,
    team_name: str,
    leader: str | None = None,
    framework: str = "jiuwenswarm",
    user: str | None = None,
) -> dict[str, Any]:
    spans = sorted(spans, key=lambda s: s.start_time or 0)
    idx = _index_by_span_id(spans)

    # Leader = the member running team-management tools (spawn/build/create);
    # fallback to the earliest agent span's member, then the caller's hint.
    LEADER_TOOLS = ("tool.spawn_teammate", "tool.build_team", "tool.create_task")
    detected = None
    for s in spans:
        if s.name in LEADER_TOOLS:
            detected = _enclosing_member(s, idx, leader or "")
            if detected:
                break
    if not detected:
        agent_spans = [s for s in spans if _is_agent_span(s)]
        if agent_spans:
            detected = _agent_member(min(agent_spans, key=lambda s: s.start_time or 0))
    leader = detected or leader or "team_leader"

    turns: list[tuple[int, str, dict[str, Any]]] = []
    in_tok = out_tok = tot_tok = llm_count = tool_count = 0
    first = last = None
    for s in spans:
        st, en = s.start_time or 0, s.end_time or 0
        first = st if first is None else min(first, st)
        last = en if last is None else max(last, en)
        a = _attrs(s)
        if s.name == "llm.call":
            llm_count += 1
            pt = int(a.get("gen_ai.usage.prompt_tokens", 0) or 0)
            ct = int(a.get("gen_ai.usage.completion_tokens", 0) or 0)
            tt = int(a.get("gen_ai.usage.total_tokens", 0) or (pt + ct))
            in_tok += pt
            out_tok += ct
            tot_tok += tt
            turns.append((st, _enclosing_member(s, idx, leader), {
                "content": str(a.get("gen_ai.completion.0.content", "")),
                "usage": {"input": pt, "output": ct, "total": tt},
                "modelID": str(a.get("gen_ai.request.model", "")),
                "tool_calls": [],
                "timeInfo": {"created": _ms(st), "completed": _ms(en)},
            }))
        elif s.name.startswith("tool."):
            tool_count += 1
            turns.append((st, _enclosing_member(s, idx, leader), {
                "content": "",
                "tool_calls": [{
                    "id": str(a.get("gen_ai.tool.id", s.context.span_id)),
                    "type": "function",
                    "function": {
                        "name": str(a.get("gen_ai.tool.name", s.name.split(".", 1)[-1])),
                        "arguments": str(a.get("gen_ai.tool.input", ""))[:2000],
                    },
                    "state": "success",
                    "output": str(a.get("gen_ai.tool.output", ""))[:2000],
                }],
                "timeInfo": {"created": _ms(st), "completed": _ms(en)},
            }))

    summary = ""
    for s in spans:
        if _is_agent_span(s):
            t = _extract_output_text(_attrs(s).get("agentteam.agent.output"))
            if len(t) > len(summary):
                summary = t
    model_name = next((t[2]["modelID"] for t in turns if t[2].get("modelID")), "")

    interactions: list[dict[str, Any]] = [{"role": "user", "content": query}]
    members = sorted({m for _, m, _ in turns})
    others = [m for m in members if m != leader]
    # The spawn-linkage turn must precede the first member turn (so buildAgentCallTree
    # has the pending task claims ready), but NOT precede the leader's own setup turns
    # (build_team / create_task etc.) — else those render after the spawns. So insert
    # it lazily, right before the first subagent turn in time order.
    spawn_turn = None
    if others:
        spawn_turn = {"role": "assistant", "agent": leader, "content": "", "tool_calls": [
            {
                "id": f"spawn_{m}",
                "type": "function",
                "function": {"name": "task", "arguments": json.dumps(
                    {"subagent_type": m, "description": f"spawn teammate {m}"}, ensure_ascii=False)},
                "state": "success",
                "output": f"{m} joined the team",
            } for m in others
        ]}
    spawned = False
    for st, m, frag in sorted(turns, key=lambda x: x[0]):
        if m != leader and not spawned and spawn_turn is not None:
            spawn_turn["timeInfo"] = {"created": _ms(st), "completed": _ms(st)}
            interactions.append(spawn_turn)
            spawned = True
        if m == leader:
            interactions.append({"role": "assistant", "agent": leader, **frag})
        else:
            interactions.append({
                "role": "subagent", "agent": m, "subagent_name": m,
                "subagent_session_id": f"{team_name}_{m}", **frag,
            })
    if spawn_turn is not None and not spawned:   # no member turns seen — still link
        interactions.append(spawn_turn)

    latency_s = (((last or 0) - (first or 0)) / 1_000_000_000.0) if first else 0.0
    payload: dict[str, Any] = {
        "task_id": task_id,
        "query": query,
        "framework": framework,
        "agentName": leader,
        "agents": members,
        "model": model_name or "unknown",
        "tokens": tot_tok,
        "input_tokens": in_tok,
        "output_tokens": out_tok,
        "tool_call_count": tool_count,
        "llm_call_count": llm_count,
        "latency": round(latency_s, 3),
        "final_result": summary,
        "interactions": interactions,
        "label": framework,
        "subagentCount": max(0, len(members) - 1),
    }
    if user:
        payload["user"] = user
    return payload


def transform_task_spans(
    spans: Iterable[Any],
    *,
    task_id: str,
    query: str,
    coordinator: str = "coordinator",
    framework: str = "jiuwenswarm",
    user: str | None = None,
) -> dict[str, Any]:
    """Map a Task/fan-out run (one coordinator delegating to ISOLATED sub-agents
    via the task tool, no peer comms) into an agent-insight trace: coordinator
    root with each `task` delegation as a tool_call, plus one sub-agent node per
    delegation (content = that worker's returned result)."""
    import ast as _ast

    spans = sorted(spans, key=lambda s: s.start_time or 0)
    in_tok = out_tok = tot_tok = llm_count = 0
    first = last = None
    task_spans: list[Any] = []
    summary = ""          # from agentteam.agent.output (team mode only)
    llm_summary = ""      # fallback: longest llm completion (task fan-out has no agent spans)
    plan_content = ""     # earliest llm completion = coordinator's "delegate" turn
    merge_content = ""    # latest llm completion = coordinator's final synthesis
    model_name = ""
    for s in spans:       # spans are sorted by start_time (above)
        st, en = s.start_time or 0, s.end_time or 0
        first = st if first is None else min(first, st)
        last = en if last is None else max(last, en)
        a = _attrs(s)
        if s.name == "llm.call":
            llm_count += 1
            pt = int(a.get("gen_ai.usage.prompt_tokens", 0) or 0)
            ct = int(a.get("gen_ai.usage.completion_tokens", 0) or 0)
            tot_tok += int(a.get("gen_ai.usage.total_tokens", 0) or (pt + ct))
            in_tok += pt
            out_tok += ct
            model_name = str(a.get("gen_ai.request.model") or model_name)
            _c = str(a.get("gen_ai.completion.0.content", ""))
            if len(_c) > len(llm_summary):
                llm_summary = _c
            if llm_count == 1:
                plan_content = _c
            if _c:
                merge_content = _c
        elif s.name.startswith("tool.task"):
            task_spans.append(s)
        if s.name.startswith("agent."):
            t = _extract_output_text(a.get("agentteam.agent.output"))
            if len(t) > len(summary):
                summary = t
    final = summary or merge_content or llm_summary

    coord_tools: list[dict[str, Any]] = []
    sub_interactions: list[dict[str, Any]] = []
    for i, ts in enumerate(sorted(task_spans, key=lambda x: x.start_time or 0)):
        a = _attrs(ts)
        raw_in = str(a.get("gen_ai.tool.input", ""))
        raw_out = str(a.get("gen_ai.tool.output", ""))
        desc, sub_type = raw_in, "general-purpose"
        try:
            obj = _ast.literal_eval(raw_in)
            params = (obj[0][0] if isinstance(obj, list) and obj and isinstance(obj[0], list) and obj[0]
                      else (obj if isinstance(obj, dict) else {}))
            if isinstance(params, dict):
                desc = str(params.get("task_description", raw_in))
                sub_type = str(params.get("subagent_type", sub_type))
        except (ValueError, SyntaxError, IndexError, TypeError):
            pass
        # tool output is wrapped as "success=True data={...} error=None" -> unwrap
        # the dict (note the trailing " error=..." after the dict breaks literal_eval).
        result = _unwrap_tool_data(raw_out)
        # Clean, distinct token (no '#': inferSubagentType truncates at non-[\w-]).
        # subagent_type in the task tool_call MUST equal inferSubagentType(subagent_name)
        # or buildAgentCallTree can't claim the spawn → sub-agent collapses into root.
        name = (f"{sub_type}-{i + 1}").replace(" ", "-").replace("#", "")
        # the delegation span's [start,end] = how long that sub-agent ran
        ts_start, ts_end = _ms(ts.start_time), _ms(ts.end_time)
        coord_tools.append({
            "id": f"{a.get('gen_ai.tool.id', ts.context.span_id)}#{i}",
            "type": "function",
            "function": {"name": "task", "arguments": json.dumps(
                {"subagent_type": name, "description": desc[:1500]}, ensure_ascii=False)},
            "state": "success",
            "output": result[:1500],
            "timing": {"started_at": ts_start, "completed_at": ts_end},
        })
        sub_interactions.append({
            "role": "subagent", "agent": name, "subagent_name": name,
            "subagent_session_id": f"{task_id}_sub_{i + 1}",
            "content": result[:1500], "tool_calls": [],
            "timeInfo": {"created": ts_start, "completed": ts_end},
        })

    # Order: spawn turn (delegates) FIRST, sub-agents, then the merge turn LAST —
    # else the final synthesis text renders before the spawns (UI draws an
    # interaction's llm text before its tool_calls).
    task_ends = [_ms(t.end_time) for t in task_spans] or [_ms(last)]
    spawn_done = max(task_ends)
    interactions: list[dict[str, Any]] = [
        {"role": "user", "content": query},
        {"role": "assistant", "agent": coordinator,
         "content": plan_content if plan_content and plan_content != merge_content else "",
         "tool_calls": coord_tools,
         "timeInfo": {"created": _ms(first), "completed": spawn_done}},
    ]
    interactions += sub_interactions
    interactions.append({
        "role": "assistant", "agent": coordinator, "content": final,
        "usage": {"input": in_tok, "output": out_tok, "total": tot_tok},
        "timeInfo": {"created": spawn_done, "completed": _ms(last)},
    })

    latency_s = (((last or 0) - (first or 0)) / 1_000_000_000.0) if first else 0.0
    payload: dict[str, Any] = {
        "task_id": task_id,
        "query": query,
        "framework": framework,
        "agentName": coordinator,
        "agents": [coordinator] + [s["agent"] for s in sub_interactions],
        "model": model_name or "unknown",
        "tokens": tot_tok,
        "input_tokens": in_tok,
        "output_tokens": out_tok,
        "tool_call_count": len(task_spans),
        "llm_call_count": llm_count,
        "latency": round(latency_s, 3),
        "final_result": final,
        "interactions": interactions,
        "label": framework,
        "subagentCount": len(sub_interactions),
    }
    if user:
        payload["user"] = user
    return payload
