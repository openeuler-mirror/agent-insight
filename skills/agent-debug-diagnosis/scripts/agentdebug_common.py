#!/usr/bin/env python3
"""AgentDebug 诊断脚本的共享工具。"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, Iterable, List, Optional


MODULES = ["memory", "reflection", "planning", "action", "system"]
SEVERITIES = {"high", "medium", "low"}

SHELL_TOOL_RE = re.compile(r"(bash|shell|exec|python|node|npm|pnpm|yarn|pip)", re.I)
DANGEROUS_COMMAND_RE = re.compile(
    r"\b(rm\s+-rf\s+/(?:\s|$)|git\s+push\s+--force|drop\s+table|mkfs|shutdown|reboot)\b",
    re.I,
)
WRITE_TOOL_RE = re.compile(r"(edit|write|patch|apply|save|create|delete|remove)", re.I)


def read_json(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, dict) else {}


def write_json(path: str, data: Dict[str, Any]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def text(value: Any, max_len: int = 4000) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        out = value
    else:
        try:
            out = json.dumps(value, ensure_ascii=False)
        except Exception:
            out = str(value)
    out = out.strip()
    return out if len(out) <= max_len else out[:max_len] + "\n...<截断>"


def compact_json(value: Any, max_len: int = 1800) -> str:
    try:
        raw = json.dumps(value, ensure_ascii=False, sort_keys=True)
    except Exception:
        raw = str(value)
    return raw if len(raw) <= max_len else raw[:max_len] + "...<截断>"


def truncate(value: str, max_len: int = 600) -> str:
    value = (value or "").strip()
    return value if len(value) <= max_len else value[:max_len] + "...<截断>"


def module_output(module: str, content: str = "", confidence: float = 0.0, source: str = "implicit") -> Dict[str, Any]:
    if module == "action":
        source = "raw_tool"
    if module == "system":
        source = "system"
    return {
        "module": module,
        "content": truncate(content, 4000),
        "confidence": round(max(0.0, min(1.0, float(confidence))), 2),
        "source": source if source in {"tag", "llm", "raw_tool", "implicit", "system"} else "implicit",
    }


def phase1_cell(
    step: int,
    module: str,
    error_type: str,
    severity: str,
    evidence: str,
    reasoning: str,
    confidence: float,
    anchor_id: Optional[str] = None,
    diagnostic_step: Optional[int] = None,
    trace_step_index: Optional[int] = None,
    trace_node_label: Optional[str] = None,
    trace_node_kind: Optional[str] = None,
) -> Dict[str, Any]:
    node_index = trace_step_index or step
    item: Dict[str, Any] = {
        "step": node_index,
        "module": module,
        "errorDetected": True,
        "errorType": error_type,
        "severity": severity if severity in SEVERITIES else "medium",
        "evidence": truncate(evidence, 900),
        "reasoning": truncate(reasoning, 900),
        "confidence": round(max(0.0, min(1.0, float(confidence))), 2),
        "traceStepIndex": node_index,
    }
    if diagnostic_step:
        item["diagnosticStep"] = diagnostic_step
    if anchor_id:
        item["anchorId"] = anchor_id
    if trace_node_label:
        item["traceNodeLabel"] = trace_node_label
    if trace_node_kind:
        item["traceNodeKind"] = trace_node_kind
    return item


def issue_from_cell(cell: Dict[str, Any]) -> Dict[str, Any]:
    item = {
        "id": f"N{cell.get('traceStepIndex') or cell.get('step')}-{cell.get('module')}-{cell.get('errorType')}",
        "step": cell.get("step"),
        "module": cell.get("module"),
        "errorType": cell.get("errorType"),
        "severity": cell.get("severity"),
        "evidence": cell.get("evidence", ""),
        "reasoning": cell.get("reasoning", ""),
        "confidence": cell.get("confidence", 0.5),
    }
    for key in ("anchorId", "diagnosticStep", "traceStepIndex", "traceNodeLabel", "traceNodeKind"):
        if cell.get(key):
            item[key] = cell[key]
    return item


def tool_command(tool: Dict[str, Any]) -> str:
    args = tool.get("args")
    if isinstance(args, dict):
        for key in ("command", "cmd", "script", "path", "file_path", "filepath"):
            if args.get(key):
                return text(args.get(key), 2000)
    return text(args, 2000)


def tool_output(tool: Dict[str, Any]) -> str:
    return "\n".join(
        part for part in [text(tool.get("rawError"), 1600), text(tool.get("output"), 2200)] if part
    )


def is_shell_like(tool_name: str) -> bool:
    return bool(SHELL_TOOL_RE.search(tool_name or ""))


def is_write_action(tool: Dict[str, Any]) -> bool:
    name = text(tool.get("name"), 200)
    command = tool_command(tool)
    return bool(WRITE_TOOL_RE.search(name)) or bool(
        re.search(r"\b(apply_patch|sed\s+-i|tee\s+|cat\s+>|echo\s+.*>|rm\s+|mv\s+|cp\s+)", command)
    )


def has_dangerous_command(tools: Iterable[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    for tool in tools:
        command = tool_command(tool)
        if DANGEROUS_COMMAND_RE.search(command):
            return tool
    return None


def split_sentences(value: str) -> List[str]:
    raw = re.split(r"(?<=[。！？.!?])\s+|\n+", value or "")
    return [x.strip() for x in raw if x and x.strip()]
