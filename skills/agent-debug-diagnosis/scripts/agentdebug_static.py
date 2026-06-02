#!/usr/bin/env python3
"""按 v0.4 方案执行 AgentDebug 静态拆分和规则检测。"""

from __future__ import annotations

import argparse
import re
from collections import Counter, defaultdict
from typing import Any, Dict, List, Optional, Tuple

from agentdebug_common import (
    compact_json,
    has_dangerous_command,
    is_shell_like,
    is_write_action,
    issue_from_cell,
    module_output,
    phase1_cell,
    read_json,
    split_sentences,
    text,
    tool_command,
    tool_output,
    truncate,
    write_json,
)


MEMORY_RE = re.compile(r"(之前|刚才|上一步|前面|已经|根据.*(?:输出|结果)|previously|already|last step)", re.I)
REFLECTION_RE = re.compile(r"(失败|错误|异常|通过|成功|说明|可见|还需要|已经完成|没有找到|not found|failed|success|passed)", re.I)
PLANNING_RE = re.compile(r"(接下来|下一步|我会|我先|先|然后|计划|准备|需要|todo|to-do|let me|next|I will)", re.I)
SUCCESS_RE = re.compile(r"(成功|通过|完成|没问题|可以提交|passed|success|done)", re.I)
FAILURE_RE = re.compile(r"(failed|failure|error|exception|traceback|assertionerror|npm err|失败|错误|异常|command not found|no such file)", re.I)
AUTH_FAILURE_RE = re.compile(
    r"("
    r"\b(?:http\s*)?401\b(?:\s+unauthorized)?"
    r"|unauthorized"
    r"|auth(?:entication)?(?:error| failed| failure| required| denied)"
    r"|(?:invalid|expired|missing)\s+(?:api[_ -]?key|token|credential)"
    r"|(?:api[_ -]?key|token|credential)\s+(?:invalid|expired|missing|denied)"
    r")",
    re.I,
)
CONTEXT_OVERFLOW_RE = re.compile(r"(contextoverflow|context_overflow|context length exceeded|context window exceeded)", re.I)


def main() -> None:
    parser = argparse.ArgumentParser(description="生成 AgentDebug 静态分析 JSON。")
    parser.add_argument("--input", required=True, help="后端准备的 agent-debug-input.json")
    parser.add_argument("--output", required=True, help="静态分析输出路径")
    args = parser.parse_args()

    data = read_json(args.input)
    turns = data.get("turns") if isinstance(data.get("turns"), list) else []
    execution = data.get("execution") if isinstance(data.get("execution"), dict) else {}

    step_records = build_step_records(turns)
    static_cells = run_static_detectors(step_records)
    triage = run_phase0_triage(step_records)
    issues = [issue_from_cell(cell) for cell in static_cells]

    result = {
        "schemaVersion": 1,
        "execution": execution,
        "triage": triage,
        "stepRecords": step_records,
        "phase1Grid": static_cells,
        "issues": issues,
        "staticSummary": {
            "stepCount": len(step_records),
            "issueCount": len(issues),
            "说明": "该文件由脚本生成，只包含确定性拆分和规则检测；LLM 需继续补充语义检测和根因归因。",
        },
    }
    write_json(args.output, result)


def build_step_records(turns: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    records: List[Dict[str, Any]] = []
    for index, turn in enumerate(turns):
        source_step = int(turn.get("step") or turn.get("turnIndex") or index + 1)
        trace_step = int(turn.get("traceStepIndex") or source_step)
        trace_label = text(turn.get("traceNodeLabel"), 160) or f"节点 #{trace_step}"
        trace_kind = text(turn.get("traceNodeKind"), 80) or "llm"
        reasoning = text(turn.get("reasoningText"), 6000)
        visible = text(turn.get("text"), 6000)
        agent_output = "\n\n".join(part for part in [reasoning, visible] if part)
        tools = turn.get("toolCalls") if isinstance(turn.get("toolCalls"), list) else []

        memory = extract_memory(source_step, agent_output)
        reflection = extract_reflection(source_step, agent_output)
        planning = extract_planning(agent_output)
        action = extract_action(tools)
        system = extract_system(turn, tools)
        env = extract_environment_response(tools, system.get("content", ""))

        records.append(
            {
                "step": trace_step,
                "diagnosticStep": source_step,
                "traceStepIndex": trace_step,
                "traceNodeLabel": trace_label,
                "traceNodeKind": trace_kind,
                "sourceInteractionIndex": int(turn.get("sourceInteractionIndex") or max(0, source_step - 1)),
                "title": trace_label,
                "inputContext": truncate(text(turn.get("inputContext") or turn.get("requestContextPreview"), 1200), 1200),
                "agentOutput": truncate(agent_output, 4000),
                "environmentResponse": truncate(env, 1600),
                "anchorId": first_anchor(turn, tools),
                "toolCalls": tools,
                "modules": {
                    "memory": memory,
                    "reflection": reflection,
                    "planning": planning,
                    "action": action,
                    "system": system,
                },
            }
        )
    return records


def extract_memory(step: int, agent_output: str) -> Dict[str, Any]:
    if step == 1 and not MEMORY_RE.search(agent_output):
        return module_output("memory")
    hits = [s for s in split_sentences(agent_output) if MEMORY_RE.search(s)]
    if not hits:
        return module_output("memory")
    return module_output("memory", "；".join(hits[:4]), 0.72, "implicit")


def extract_reflection(step: int, agent_output: str) -> Dict[str, Any]:
    if step == 1 and not REFLECTION_RE.search(agent_output):
        return module_output("reflection")
    hits = [s for s in split_sentences(agent_output) if REFLECTION_RE.search(s)]
    if not hits:
        return module_output("reflection")
    return module_output("reflection", "；".join(hits[:4]), 0.7, "implicit")


def extract_planning(agent_output: str) -> Dict[str, Any]:
    hits = [s for s in split_sentences(agent_output) if PLANNING_RE.search(s)]
    if not hits:
        return module_output("planning")
    return module_output("planning", "；".join(hits[:5]), 0.72, "implicit")


def extract_action(tools: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not tools:
        return module_output("action")
    lines = []
    for tool in tools:
        lines.append(
            "tool={name} status={status} args={args} output={output}".format(
                name=text(tool.get("name"), 120) or "unknown",
                status=text(tool.get("status"), 60) or "unknown",
                args=compact_json(tool.get("args"), 900),
                output=truncate(tool_output(tool), 900),
            )
        )
    return module_output("action", "\n".join(lines), 0.95, "raw_tool")


def extract_system(turn: Dict[str, Any], tools: List[Dict[str, Any]]) -> Dict[str, Any]:
    signals: List[str] = []
    started = turn.get("startedAt")
    completed = turn.get("completedAt")
    if isinstance(started, (int, float)) and isinstance(completed, (int, float)) and completed - started > 60000:
        signals.append(f"step_timeout: 当前 step 耗时约 {int(completed - started)}ms")

    for tool in tools:
        status = text(tool.get("status"), 80)
        output = tool_output(tool)
        name = text(tool.get("name"), 100)
        if status == "error":
            signals.append(f"tool_execution_error: {name} 返回错误：{truncate(output, 600)}")
            continue
        if is_shell_like(name) and FAILURE_RE.search(output):
            signals.append(f"tool_execution_error: {name} 输出包含失败信号：{truncate(output, 600)}")

    if not signals:
        return module_output("system")
    return module_output("system", "\n".join(signals), 0.9, "system")


def extract_environment_response(tools: List[Dict[str, Any]], system_content: str) -> str:
    if system_content:
        return system_content
    outputs = [tool_output(tool) for tool in tools if tool_output(tool)]
    return truncate("\n".join(outputs[:2]), 1600)


def first_anchor(turn: Dict[str, Any], tools: List[Dict[str, Any]]) -> Optional[str]:
    for tool in tools:
        if tool.get("anchorId"):
            return str(tool.get("anchorId"))
    anchors = turn.get("anchorIds") if isinstance(turn.get("anchorIds"), list) else []
    return str(anchors[0]) if anchors else None


def record_location(record: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "diagnostic_step": int(record.get("diagnosticStep") or record.get("step") or 1),
        "trace_step_index": int(record.get("traceStepIndex") or record.get("step") or 1),
        "trace_node_label": text(record.get("traceNodeLabel"), 160) or text(record.get("title"), 160),
        "trace_node_kind": text(record.get("traceNodeKind"), 80) or "llm",
    }


def tool_location(tool: Dict[str, Any], record: Dict[str, Any]) -> Dict[str, Any]:
    fallback = record_location(record)
    trace_step = int(tool.get("traceStepIndex") or fallback["trace_step_index"])
    return {
        "diagnostic_step": fallback["diagnostic_step"],
        "trace_step_index": trace_step,
        "trace_node_label": text(tool.get("traceNodeLabel"), 160) or format_tool_label(tool, trace_step),
        "trace_node_kind": text(tool.get("traceNodeKind"), 80) or "tool",
    }


def format_tool_label(tool: Dict[str, Any], trace_step: int) -> str:
    name = text(tool.get("name"), 80) or "tool"
    command = tool_command(tool)
    if command:
        return f"{name} {truncate(command, 96)}"
    return f"{name} 节点 #{trace_step}"


def run_static_detectors(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    cells: List[Dict[str, Any]] = []
    call_counter: Counter[str] = Counter()

    for record in records:
        step = int(record.get("step") or 1)
        tools = parse_tools_from_action(record)
        planning = record["modules"]["planning"]["content"]
        reflection = record["modules"]["reflection"]["content"]
        system_content = record["modules"]["system"]["content"]
        anchor = record.get("anchorId")
        location = record_location(record)

        cells.extend(detect_action(record, tools, call_counter, anchor))
        cells.extend(detect_system(resolve_system_location(record, tools), system_content, anchor))
        cells.extend(detect_planning(step, planning, tools, anchor, location))
        cells.extend(detect_reflection(step, reflection, previous_record(records, step), anchor, location))

        for tool in tools:
            call_counter[f"{tool.get('name')}::{compact_json(tool.get('args'), 400)}"] += 1

    return cells


def parse_tools_from_action(record: Dict[str, Any]) -> List[Dict[str, Any]]:
    if isinstance(record.get("toolCalls"), list):
        return [tool for tool in record["toolCalls"] if isinstance(tool, dict)]
    tools = []
    # 静态检测需要原始工具结构，优先从 agentOutput 对应 step 里无法反推，因此把 action 文本解析为弱结构。
    action = record["modules"]["action"]["content"]
    for line in action.splitlines():
        if not line.startswith("tool="):
            continue
        name = line.split(" ", 1)[0].replace("tool=", "")
        status_match = re.search(r"status=([^ ]+)", line)
        args_match = re.search(r"args=(.*?) output=", line)
        output_match = re.search(r"output=(.*)$", line)
        tools.append(
            {
                "name": name,
                "status": status_match.group(1) if status_match else "unknown",
                "args": args_match.group(1) if args_match else "",
                "output": output_match.group(1) if output_match else "",
            }
        )
    return tools


def resolve_system_location(record: Dict[str, Any], tools: List[Dict[str, Any]]) -> Dict[str, Any]:
    for tool in tools:
        status = text(tool.get("status"), 80)
        evidence = tool_output(tool) or text(tool.get("output"), 1000)
        name = text(tool.get("name"), 100)
        if status == "error" or (is_shell_like(name) and FAILURE_RE.search(evidence)):
            return tool_location(tool, record)
    return record_location(record)


def detect_action(record: Dict[str, Any], tools: List[Dict[str, Any]], call_counter: Counter[str], anchor: Optional[str]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    step = int(record.get("step") or 1)
    for tool in tools:
        name = text(tool.get("name"), 100)
        evidence = tool_output(tool) or text(tool.get("output"), 1000)
        command = tool_command(tool)
        status = text(tool.get("status"), 80)
        display_step = int(tool.get("traceStepIndex") or step)
        location = tool_location(tool, record)

        if status == "error" or (is_shell_like(name) and FAILURE_RE.search(evidence)):
            error_type, reason, severity = classify_action_error(evidence, command)
            out.append(
                phase1_cell(display_step, "action", error_type, severity, evidence or command, reason, 0.88, text(tool.get("anchorId"), 120) or anchor, **location)
            )

        if has_dangerous_command([tool]):
            out.append(
                phase1_cell(
                    display_step,
                    "action",
                    "dangerous_command",
                    "high",
                    command,
                    "动作包含高风险破坏性命令，必须要求人工确认或使用受控替代方案。",
                    0.96,
                    text(tool.get("anchorId"), 120) or anchor,
                    **location,
                )
            )

        key = f"{name}::{compact_json(tool.get('args'), 400)}"
        if call_counter[key] >= 2:
            out.append(
                phase1_cell(
                    display_step,
                    "action",
                    "redundant_call",
                    "low",
                    command or name,
                    "五步窗口内出现第三次及以上相同工具调用，可能是无效重复尝试。",
                    0.78,
                    text(tool.get("anchorId"), 120) or anchor,
                    **location,
                )
            )
    return out


def classify_action_error(evidence: str, command: str) -> Tuple[str, str, str]:
    value = f"{evidence}\n{command}".lower()
    if "command not found" in value:
        return "parameter_error", "命令或工具在当前环境不可用，动作参数选择不当。", "medium"
    if "no such file" in value or "not found" in value and "/" in value:
        return "nonexistent_path", "工具返回路径不存在，后续读写会偏离真实对象。", "medium"
    if "does not match" in value or "no match" in value:
        return "wrong_diff_anchor", "编辑锚点未匹配真实文件内容，修改没有可靠落点。", "high"
    if "schema" in value or "invalid json" in value:
        return "format_error", "工具入参或返回不符合结构要求。", "medium"
    return "parameter_error", "工具调用返回明确失败信号，需要结合上下文复核参数、路径或工具选择。", "medium"


def detect_system(location: Dict[str, Any], system_content: str, anchor: Optional[str]) -> List[Dict[str, Any]]:
    if not system_content:
        return []
    step = int(location.get("trace_step_index") or 1)
    value = system_content.lower()
    if is_context_overflow(value):
        error_type, severity = "context_overflow", "high"
    elif is_auth_failure(value):
        error_type, severity = "auth_failure", "high"
    elif "timeout" in value or "step_timeout" in value:
        error_type, severity = "step_timeout", "low"
    elif "structuredoutput" in value or "schema" in value:
        error_type, severity = "schema_violation", "medium"
    else:
        error_type, severity = "tool_execution_error", "medium"
    return [
        phase1_cell(
            step,
            "system",
            error_type,
            severity,
            system_content,
            "这是工具、运行环境或模型限制层面的外部证据，供根因归因时参考。",
            0.9,
            anchor,
            **location,
        )
    ]


def detect_planning(step: int, planning: str, tools: List[Dict[str, Any]], anchor: Optional[str], location: Dict[str, Any]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    dangerous_tool = has_dangerous_command(tools)
    if dangerous_tool:
        out.append(
            phase1_cell(
                step,
                "planning",
                "unsafe_destructive_action",
                "high",
                tool_command(dangerous_tool),
                "计划或同 step 动作包含破坏性操作，缺少人工确认会造成高风险。",
                0.9,
                anchor,
                **location,
            )
        )
    if not planning and any(is_write_action(tool) for tool in tools):
        out.append(
            phase1_cell(
                step,
                "planning",
                "no_explicit_plan",
                "medium",
                "当前 step 有写入或修改动作，但未抽取到显式计划。",
                "按当前容错规则，空 Planning 本身不是错误；只有写操作缺少计划时才作为规划风险。",
                0.74,
                anchor,
                **location,
            )
        )
    if planning and tools:
        action_text = "\n".join([tool_command(tool) or text(tool.get("name"), 100) for tool in tools])
        if obvious_plan_action_mismatch(planning, action_text):
            out.append(
                phase1_cell(
                    step,
                    "planning",
                    "plan_action_mismatch",
                    "high",
                    f"计划：{planning}\n动作：{action_text}",
                    "计划目标与实际动作出现明显不一致，可能导致轨迹偏离。",
                    0.78,
                    anchor,
                    **location,
                )
            )
    return out


def obvious_plan_action_mismatch(planning: str, action_text: str) -> bool:
    plan = planning.lower()
    action = action_text.lower()
    if "读取" in planning or "read" in plan or "查看" in planning:
        if re.search(r"\b(rm|delete|drop|push\s+--force)\b", action):
            return True
    return False


def detect_reflection(
    step: int,
    reflection: str,
    prev: Optional[Dict[str, Any]],
    anchor: Optional[str],
    location: Dict[str, Any],
) -> List[Dict[str, Any]]:
    if not reflection or not prev:
        return []
    prev_env = text(prev.get("environmentResponse"), 1600)
    if FAILURE_RE.search(prev_env) and SUCCESS_RE.search(reflection):
        return [
            phase1_cell(
                step,
                "reflection",
                "false_success_claim",
                "high",
                reflection,
                f"上一步环境返回包含失败信号：{truncate(prev_env, 500)}；当前反思却声称成功。",
                0.86,
                anchor,
                **location,
            )
        ]
    return []


def previous_record(records: List[Dict[str, Any]], step: int) -> Optional[Dict[str, Any]]:
    for record in records:
        if int(record.get("step") or 0) == step - 1:
            return record
    return None


def run_phase0_triage(records: List[Dict[str, Any]]) -> Dict[str, Any]:
    system_errors = defaultdict(list)
    for record in records:
        content = record["modules"]["system"]["content"]
        if not content:
            continue
        lower = content.lower()
        if is_auth_failure(lower):
            system_errors["auth_failure"].append(record)
        elif is_context_overflow(lower):
            system_errors["context_overflow"].append(record)

    for error_type, hits in system_errors.items():
        if len(hits) >= 2:
            steps = [int(r["step"]) for r in hits]
            sorted_steps = sorted(steps)
            first_location = record_location(hits[0])
            summary = systemic_summary(error_type, sorted_steps)
            return {
                "category": "tool_systemic",
                "shortCircuited": False,
                "fatalDiagnosis": {
                    "errorType": f"tool_systemic.{error_type}",
                    "toolName": None,
                    "affectedSteps": sorted_steps,
                    "affectedTraceStepIndexes": sorted_steps,
                    "traceNodeLabel": first_location.get("trace_node_label"),
                    "traceNodeKind": first_location.get("trace_node_kind"),
                    "summary": summary,
                    "recommendation": "这是静态预检提示，不会跳过后续认知诊断。请结合关键发现、模块卡片和原始节点判断它是否真的是阻断性环境问题。",
                    "rawErrorEvidence": truncate(hits[0]["modules"]["system"]["content"], 900),
                    "anchorId": hits[0].get("anchorId"),
                },
                "prefilterHints": {"forceFullSteps": []},
                "notes": [summary],
            }

    force_steps = [
        int(r["step"])
        for r in records
        if r["modules"]["system"]["content"] and int(r["step"]) <= 3
    ]
    return {
        "category": "normal",
        "shortCircuited": False,
        "fatalDiagnosis": None,
        "prefilterHints": {"forceFullSteps": force_steps[:6]},
        "notes": ["脚本已完成 Phase 0 系统风险预检；未发现明确阻断后续认知诊断的系统性风险。"],
    }


def is_auth_failure(value: str) -> bool:
    return bool(AUTH_FAILURE_RE.search(value or ""))


def is_context_overflow(value: str) -> bool:
    return bool(CONTEXT_OVERFLOW_RE.search(value or ""))


def systemic_summary(error_type: str, steps: List[int]) -> str:
    nodes = "、".join(f"#{step}" for step in steps[:6])
    more = "等" if len(steps) > 6 else ""
    if error_type == "auth_failure":
        return f"静态预检在左侧节点 {nodes}{more} 发现疑似认证/权限失败信号。该信号只作为系统风险提示，仍需继续结合工具状态、输出上下文和认知模块判断是否真的阻断了任务。"
    if error_type == "context_overflow":
        return f"静态预检在左侧节点 {nodes}{more} 发现疑似上下文溢出或输出长度限制信号。该信号只作为系统风险提示，后续仍需完成完整认知诊断。"
    return f"静态预检在左侧节点 {nodes}{more} 发现疑似系统性错误 {error_type}。该信号只作为风险提示，后续仍需完成完整认知诊断。"


if __name__ == "__main__":
    main()
