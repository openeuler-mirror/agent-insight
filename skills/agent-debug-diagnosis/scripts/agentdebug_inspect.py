#!/usr/bin/env python3
"""对 AgentDebug 大型输入和静态结果执行有界、结构化查询。"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from agentdebug_common import compact_json, read_json, text, truncate


MAX_LIMIT = 20
MAX_RANGE = 20
DEFAULT_LIMIT = 10
PREVIEW_LIMIT = 240

MEMORY_RE = re.compile(r"(之前|刚才|上一步|前面|已经|根据.*(?:输出|结果)|previously|already|last step)", re.I)
COMPRESSION_RE = re.compile(r"(压缩|截断|compression|truncat)", re.I)
REREAD_RE = re.compile(r"(重新读取|重新读|再次读取|恢复完整|获取完整|re-?read)", re.I)
REFLECTION_RE = re.compile(r"(失败|错误|异常|通过|成功|说明|可见|还需要|已经完成|没有找到|failed|success|passed)", re.I)
SUCCESS_RE = re.compile(r"(成功|通过|完成|没问题|可以提交|passed|success|done)", re.I)
FAILURE_RE = re.compile(r"(failed|failure|error|exception|traceback|assertionerror|npm err|失败|错误|异常|command not found|no such file)", re.I)
PLANNING_RE = re.compile(r"(接下来|下一步|我会|我先|先|然后|计划|准备|需要|todo|to-do|let me|next|I will)", re.I)
CONSTRAINT_RE = re.compile(r"(必须|不要|不得|禁止|只能|仅限|务必|must|must not|do not|never|only)", re.I)
CONTEXT_LIMIT_RE = re.compile(r"(contextoverflow|context_overflow|context length exceeded|context window exceeded|上下文溢出)", re.I)
AUTH_RE = re.compile(r"(401 unauthorized|authentication failed|autherror|invalid api key|token expired)", re.I)
DESTRUCTIVE_RE = re.compile(r"\b(rm\s+-rf|push\s+--force|drop\s+table|mkfs|shutdown|reboot)\b", re.I)
VOLATILE_ARG_KEYS = {"session", "session_id", "request_id", "trace_id", "timestamp"}


def main() -> None:
    parser = argparse.ArgumentParser(description="查询 AgentDebug 输入、静态结果和长文本 artifact。")
    parser.add_argument("command", choices=["summary", "tail", "range", "search", "repeated-calls"])
    parser.add_argument("--input", required=True, help="agent-debug-input.json 路径")
    parser.add_argument("--static", dest="static_path", help="agent-debug-static.json 路径")
    parser.add_argument("--count", type=int, default=10, help="tail 返回数量")
    parser.add_argument("--from", dest="from_step", type=int, help="range 起始 trace step")
    parser.add_argument("--to", dest="to_step", type=int, help="range 结束 trace step")
    parser.add_argument("--terms", help="search 关键词，逗号分隔")
    parser.add_argument(
        "--scope",
        choices=["all", "turn-text", "reasoning", "tool-args", "tool-output", "artifact", "user"],
        default="all",
        help="search 数据范围",
    )
    parser.add_argument("--context", type=int, default=0, help="search 返回相邻 turn 数量")
    parser.add_argument("--before-step", type=int, help="search 只检查该 trace step 之前")
    parser.add_argument("--after-step", type=int, help="search 只检查该 trace step 之后")
    parser.add_argument("--tool", help="repeated-calls 限定工具名")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help="最大返回条数，最高 20")
    args = parser.parse_args()

    input_path = Path(args.input).resolve()
    data = read_json(str(input_path))
    static = read_json(args.static_path) if args.static_path else {}
    turns = data.get("turns") if isinstance(data.get("turns"), list) else []
    limit = max(1, min(MAX_LIMIT, args.limit))

    if args.command == "summary":
        result = build_summary(data, static, turns)
    elif args.command == "tail":
        count = max(1, min(MAX_LIMIT, args.count))
        result = bounded_records(turns[-count:], len(turns) - count)
    elif args.command == "range":
        result = query_range(turns, args.from_step, args.to_step)
    elif args.command == "search":
        terms = parse_terms(args.terms)
        if not terms:
            parser.error("search 必须提供 --terms")
        if args.scope == "artifact":
            result = search_artifacts(data, input_path, terms, limit)
        else:
            result = search_turns(
                turns,
                terms,
                args.scope,
                max(0, min(1, args.context)),
                args.before_step,
                args.after_step,
                limit,
            )
    else:
        result = repeated_calls(turns, args.tool, limit)

    print(json.dumps(result, ensure_ascii=False, indent=2))


def build_summary(data: Dict[str, Any], static: Dict[str, Any], turns: List[Dict[str, Any]]) -> Dict[str, Any]:
    issues = static.get("issues") if isinstance(static.get("issues"), list) else []
    records = static.get("stepRecords") if isinstance(static.get("stepRecords"), list) else []
    execution = data.get("execution") if isinstance(data.get("execution"), dict) else {}
    trace_bundle = data.get("traceBundle") if isinstance(data.get("traceBundle"), dict) else {}

    agents = Counter(str(turn.get("agentName") or turn.get("role") or "unknown") for turn in turns if isinstance(turn, dict))
    issue_distribution = Counter(
        f"{issue.get('module')}/{issue.get('errorType')}"
        for issue in issues
        if isinstance(issue, dict)
    )
    tool_distribution: Counter[str] = Counter()
    failed_tool_calls = 0
    destructive_tool_calls = 0
    all_texts: List[str] = []
    reflection_false_success_candidates = 0
    prior_failed = False
    planning_statements = 0
    memory_statements = 0
    reflection_statements = 0
    user_constraint_mentions = 0
    context_limit_mentions = 0
    auth_mentions = 0

    for turn in turns:
        if not isinstance(turn, dict):
            continue
        visible = text(turn.get("text"), 100_000)
        reasoning = text(turn.get("reasoningText"), 100_000)
        combined = "\n".join(part for part in (reasoning, visible) if part)
        all_texts.append(combined)
        if MEMORY_RE.search(combined):
            memory_statements += 1
        if REFLECTION_RE.search(combined):
            reflection_statements += 1
        if PLANNING_RE.search(combined):
            planning_statements += 1
        if str(turn.get("role") or "").lower() == "user" and CONSTRAINT_RE.search(combined):
            user_constraint_mentions += 1
        if CONTEXT_LIMIT_RE.search(combined):
            context_limit_mentions += 1
        if AUTH_RE.search(combined):
            auth_mentions += 1
        if prior_failed and SUCCESS_RE.search(combined):
            reflection_false_success_candidates += 1

        current_failed = False
        for tool in tool_calls(turn):
            name = str(tool.get("name") or "unknown")
            tool_distribution[name] += 1
            evidence = tool_text(tool)
            if tool.get("status") == "error" or tool.get("rawError") or FAILURE_RE.search(evidence):
                failed_tool_calls += 1
                current_failed = True
            if DESTRUCTIVE_RE.search(tool_args_text(tool)):
                destructive_tool_calls += 1
        prior_failed = current_failed

    compression_mentions = sum(1 for value in all_texts if COMPRESSION_RE.search(value))
    reread_mentions = sum(1 for value in all_texts if REREAD_RE.search(value))
    repeated = collect_repeated_groups(turns)
    write_without_plan = issue_count(issues, "planning", "no_explicit_plan")
    plan_action_mismatch = issue_count(issues, "planning", "plan_action_mismatch")
    timeouts = issue_count(issues, "system", "step_timeout")
    tool_errors = issue_count(issues, "system", "tool_execution_error")
    action_errors = sum(1 for issue in issues if isinstance(issue, dict) and issue.get("module") == "action")

    return {
        "execution": {
            "id": execution.get("id"),
            "taskId": execution.get("taskId"),
            "framework": execution.get("framework"),
            "queryPreview": truncate(text(execution.get("query"), 2000), PREVIEW_LIMIT),
        },
        "counts": {
            "turns": len(turns),
            "traceNodes": trace_bundle.get("nodeCount", 0),
            "artifacts": trace_bundle.get("artifactCount", 0),
            "stepRecords": len(records),
            "phase1Grid": len(static.get("phase1Grid", [])) if isinstance(static.get("phase1Grid"), list) else 0,
            "issues": len(issues),
        },
        "agents": dict(agents.most_common(20)),
        "issueDistribution": dict(issue_distribution.most_common()),
        "toolDistribution": dict(tool_distribution.most_common()),
        "semanticCandidateSignals": {
            "memory": {
                "priorKnowledgeStatements": memory_statements,
                "compressionMentions": compression_mentions,
                "explicitRereadMentions": reread_mentions,
                "userConstraintMentions": user_constraint_mentions,
            },
            "reflection": {
                "reflectionStatements": reflection_statements,
                "possibleSuccessAfterFailedTool": reflection_false_success_candidates,
            },
            "planning": {
                "planningStatements": planning_statements,
                "writeWithoutExplicitPlan": write_without_plan,
                "possiblePlanActionMismatch": plan_action_mismatch,
                "repeatedCallGroups": len(repeated),
            },
            "action": {
                "totalToolCalls": sum(tool_distribution.values()),
                "failedToolCalls": failed_tool_calls,
                "staticActionIssues": action_errors,
                "destructiveCommandMentions": destructive_tool_calls,
            },
            "system": {
                "timeoutIssues": timeouts,
                "toolExecutionErrorIssues": tool_errors,
                "contextLimitMentions": context_limit_mentions,
                "authenticationMentions": auth_mentions,
            },
        },
        "head": bounded_records(turns[:3], 0)["records"],
        "tail": bounded_records(turns[-5:], max(0, len(turns) - 5))["records"],
    }


def bounded_records(turns: List[Dict[str, Any]], start_index: int) -> Dict[str, Any]:
    records = [project_turn(turn, start_index + idx) for idx, turn in enumerate(turns) if isinstance(turn, dict)]
    return {"returnedRecords": len(records), "records": records}


def query_range(turns: List[Dict[str, Any]], start: Optional[int], end: Optional[int]) -> Dict[str, Any]:
    if start is None or end is None:
        raise SystemExit("range 必须同时提供 --from 和 --to")
    if start > end:
        start, end = end, start
    if end - start + 1 > MAX_RANGE:
        raise SystemExit(f"range 最大跨度为 {MAX_RANGE}")
    matches = [project_turn(turn, idx) for idx, turn in enumerate(turns) if start <= turn_step(turn, idx) <= end]
    return {"from": start, "to": end, "returnedRecords": len(matches), "records": matches}


def search_turns(
    turns: List[Dict[str, Any]],
    terms: List[str],
    scope: str,
    context: int,
    before_step: Optional[int],
    after_step: Optional[int],
    limit: int,
) -> Dict[str, Any]:
    limit = min(limit, 5) if context else limit
    found: List[Tuple[int, str, str]] = []
    for idx, turn in enumerate(turns):
        if not isinstance(turn, dict):
            continue
        step = turn_step(turn, idx)
        if before_step is not None and step >= before_step:
            continue
        if after_step is not None and step <= after_step:
            continue
        role = str(turn.get("role") or "")
        if scope == "user" and role.lower() != "user":
            continue
        for field, value in searchable_fields(turn, scope):
            lowered = value.lower()
            if any(term.lower() in lowered for term in terms):
                found.append((idx, field, matching_snippet(value, terms)))
                break

    matches = []
    for idx, field, snippet in found[:limit]:
        item: Dict[str, Any] = {
            **project_turn(turns[idx], idx),
            "matchedField": field,
            "snippet": snippet,
        }
        if context:
            item["before"] = [project_turn(turns[pos], pos) for pos in range(max(0, idx - context), idx)]
            item["after"] = [project_turn(turns[pos], pos) for pos in range(idx + 1, min(len(turns), idx + context + 1))]
        matches.append(item)
    return {
        "terms": terms,
        "scope": scope,
        "totalMatches": len(found),
        "returnedMatches": len(matches),
        "truncated": len(found) > len(matches),
        "matches": matches,
    }


def repeated_calls(turns: List[Dict[str, Any]], tool_filter: Optional[str], limit: int) -> Dict[str, Any]:
    groups = collect_repeated_groups(turns, tool_filter)
    items = []
    for _, calls in groups[:limit]:
        sample = calls[0]
        items.append(
            {
                "tool": sample["tool"],
                "count": len(calls),
                "steps": [call["step"] for call in calls[:MAX_LIMIT]],
                "target": sample["target"],
                "argsPreview": sample["argsPreview"],
            }
        )
    return {
        "tool": tool_filter,
        "totalGroups": len(groups),
        "returnedGroups": len(items),
        "truncated": len(groups) > len(items),
        "groups": items,
    }


def collect_repeated_groups(turns: List[Dict[str, Any]], tool_filter: Optional[str] = None) -> List[Tuple[str, List[Dict[str, Any]]]]:
    groups: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for idx, turn in enumerate(turns):
        if not isinstance(turn, dict):
            continue
        step = turn_step(turn, idx)
        for tool in tool_calls(turn):
            name = str(tool.get("name") or "unknown")
            if tool_filter and name != tool_filter:
                continue
            normalized = normalize_args(tool.get("args"))
            signature = f"{name}:{compact_json(normalized, 10_000)}"
            groups[signature].append(
                {
                    "tool": name,
                    "step": step,
                    "target": extract_target(normalized),
                    "argsPreview": truncate(compact_json(normalized, 1000), PREVIEW_LIMIT),
                }
            )
    repeated = [(signature, calls) for signature, calls in groups.items() if len(calls) >= 2]
    return sorted(repeated, key=lambda item: (-len(item[1]), item[0]))


def search_artifacts(data: Dict[str, Any], input_path: Path, terms: List[str], limit: int) -> Dict[str, Any]:
    bundle = data.get("traceBundle") if isinstance(data.get("traceBundle"), dict) else {}
    index_rel = bundle.get("indexRelPath")
    if not isinstance(index_rel, str) or not index_rel:
        return {"terms": terms, "scope": "artifact", "totalMatches": 0, "returnedMatches": 0, "matches": [], "warning": "输入中没有 trace index 路径。"}
    workspace = input_path.parent.parent
    index_path = resolve_workspace_path(workspace, index_rel)
    index = read_json(str(index_path)) if index_path.exists() else {}
    nodes = index.get("nodes") if isinstance(index.get("nodes"), list) else []
    found = []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        for field in ("inputArtifact", "outputArtifact"):
            rel_path = node.get(field)
            if not isinstance(rel_path, str) or not rel_path:
                continue
            artifact_path = resolve_workspace_path(workspace, rel_path)
            try:
                value = artifact_path.read_text(encoding="utf-8")
            except OSError:
                continue
            if not any(term.lower() in value.lower() for term in terms):
                continue
            found.append(
                {
                    "nodeId": node.get("id"),
                    "step": node.get("stepIndex"),
                    "nodeName": node.get("name"),
                    "field": field,
                    "artifactPath": rel_path,
                    "artifactLength": len(value),
                    "snippet": matching_snippet(value, terms),
                }
            )
    return {
        "terms": terms,
        "scope": "artifact",
        "totalMatches": len(found),
        "returnedMatches": min(len(found), limit),
        "truncated": len(found) > limit,
        "matches": found[:limit],
    }


def searchable_fields(turn: Dict[str, Any], scope: str) -> Iterable[Tuple[str, str]]:
    if scope in {"all", "turn-text", "user"}:
        yield "text", text(turn.get("text"), 100_000)
    if scope in {"all", "reasoning"}:
        yield "reasoningText", text(turn.get("reasoningText"), 100_000)
    for idx, tool in enumerate(tool_calls(turn)):
        if scope in {"all", "tool-args"}:
            yield f"toolCalls[{idx}].args", tool_args_text(tool)
        if scope in {"all", "tool-output"}:
            yield f"toolCalls[{idx}].output", tool_text(tool)


def project_turn(turn: Dict[str, Any], index: int) -> Dict[str, Any]:
    return {
        "step": turn_step(turn, index),
        "turnIndex": turn.get("turnIndex") or index + 1,
        "role": turn.get("role"),
        "agentName": turn.get("agentName"),
        "traceNodeLabel": turn.get("traceNodeLabel"),
        "anchorIds": turn.get("anchorIds", [])[:5] if isinstance(turn.get("anchorIds"), list) else [],
        "text": truncate(text(turn.get("text"), 20_000), 120),
        "reasoningText": truncate(text(turn.get("reasoningText"), 20_000), 80),
        "toolCalls": [
            {
                "name": tool.get("name"),
                "status": tool.get("status"),
                "argsPreview": truncate(tool_args_text(tool), 60),
                "outputPreview": truncate(tool_text(tool), 60),
                "anchorId": tool.get("anchorId"),
                "traceStepIndex": tool.get("traceStepIndex"),
            }
            for tool in tool_calls(turn)[:2]
        ],
    }


def turn_step(turn: Dict[str, Any], index: int) -> int:
    for key in ("traceStepIndex", "step", "turnIndex"):
        value = turn.get(key)
        if isinstance(value, (int, float)):
            return int(value)
    return index + 1


def tool_calls(turn: Dict[str, Any]) -> List[Dict[str, Any]]:
    tools = turn.get("toolCalls")
    return [tool for tool in tools if isinstance(tool, dict)] if isinstance(tools, list) else []


def tool_args_text(tool: Dict[str, Any]) -> str:
    return text(tool.get("args"), 100_000)


def tool_text(tool: Dict[str, Any]) -> str:
    return "\n".join(part for part in (text(tool.get("rawError"), 100_000), text(tool.get("output"), 100_000)) if part)


def normalize_args(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return normalize_args(json.loads(value))
        except (json.JSONDecodeError, TypeError):
            return re.sub(r"\s+", " ", value).strip()
    if isinstance(value, dict):
        return {key: normalize_args(child) for key, child in sorted(value.items()) if key.lower() not in VOLATILE_ARG_KEYS}
    if isinstance(value, list):
        return [normalize_args(child) for child in value]
    return value


def extract_target(value: Any) -> Optional[str]:
    if isinstance(value, dict):
        for key in ("file_path", "filepath", "path", "relative_file_path", "url"):
            if isinstance(value.get(key), str):
                return value[key]
        for child in value.values():
            target = extract_target(child)
            if target:
                return target
    if isinstance(value, list):
        for child in value:
            target = extract_target(child)
            if target:
                return target
    return None


def issue_count(issues: List[Any], module: str, error_type: str) -> int:
    return sum(
        1
        for issue in issues
        if isinstance(issue, dict) and issue.get("module") == module and issue.get("errorType") == error_type
    )


def parse_terms(value: Optional[str]) -> List[str]:
    return [part.strip() for part in (value or "").split(",") if part.strip()]


def matching_snippet(value: str, terms: List[str]) -> str:
    lowered = value.lower()
    positions = [lowered.find(term.lower()) for term in terms if lowered.find(term.lower()) >= 0]
    start = max(0, min(positions) - PREVIEW_LIMIT // 3) if positions else 0
    return truncate(value[start:start + PREVIEW_LIMIT], PREVIEW_LIMIT)


def resolve_workspace_path(workspace: Path, value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else workspace / path


if __name__ == "__main__":
    main()
