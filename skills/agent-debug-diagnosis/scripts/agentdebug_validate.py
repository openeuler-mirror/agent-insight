#!/usr/bin/env python3
"""校验 AgentDebug 最终报告是否符合当前 UI 可消费的 JSON 协议。"""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any, Dict, List

from agentdebug_common import MODULES, SEVERITIES, read_json


NATURAL_KEYS = {
    "title",
    "inputContext",
    "agentOutput",
    "environmentResponse",
    "content",
    "evidence",
    "reasoning",
    "summary",
    "consequence",
    "correctionGuidance",
    "humanSummary",
    "recommendation",
    "rawErrorEvidence",
    "resolutionEvidence",
}


def main() -> None:
    parser = argparse.ArgumentParser(description="校验 AgentDebug 诊断报告 JSON。")
    parser.add_argument("--input", required=True, help="最终报告 JSON 路径")
    parser.add_argument("--static", dest="static_path", help="静态分析 JSON 路径")
    args = parser.parse_args()

    report = read_json(args.input)
    static = read_json(args.static_path) if args.static_path else None
    errors: List[str] = []
    warnings: List[str] = []

    require_object(report, "根对象", errors)
    require_array(report, "stepRecords", errors)
    require_array(report, "phase1Grid", errors)
    require_array(report, "issues", errors)
    if "triage" not in report or not isinstance(report.get("triage"), dict):
        errors.append("缺少 triage 对象。")
    if "humanSummary" not in report or not isinstance(report.get("humanSummary"), str):
        errors.append("缺少 humanSummary 中文摘要。")

    validate_step_records(report.get("stepRecords", []), errors, warnings)
    validate_phase1(report.get("phase1Grid", []), errors, warnings)
    validate_issues(report.get("issues", []), errors, warnings)
    validate_findings(report.get("findings"), report.get("issues", []), errors, warnings)
    validate_root_cause(report.get("rootCause"), errors, warnings)
    if static is not None:
        final_records = report.get("stepRecords") if isinstance(report.get("stepRecords"), list) else []
        static_records = static.get("stepRecords") if isinstance(static.get("stepRecords"), list) else []
        if len(final_records) != len(static_records):
            errors.append(f"最终 stepRecords 数量 {len(final_records)} 与静态结果 {len(static_records)} 不一致。")

        final_issues = report.get("issues") if isinstance(report.get("issues"), list) else []
        static_issues = static.get("issues") if isinstance(static.get("issues"), list) else []
        final_by_id = {str(issue.get("id")): issue for issue in final_issues if isinstance(issue, dict) and issue.get("id")}
        for issue in static_issues:
            if not isinstance(issue, dict) or not issue.get("id"):
                continue
            issue_id = str(issue["id"])
            final_issue = final_by_id.get(issue_id)
            if final_issue is None:
                errors.append(f"最终 issues 删除了静态 issue：{issue_id}")
            elif final_issue.get("evidence") != issue.get("evidence"):
                errors.append(f"最终 issue {issue_id} 修改了静态 evidence；应保留证据并通过 resolution 标记误报或恢复。")

        final_cells = {phase1_key(cell) for cell in report.get("phase1Grid", []) if isinstance(cell, dict)}
        for cell in static.get("phase1Grid", []):
            if isinstance(cell, dict) and phase1_key(cell) not in final_cells:
                errors.append(f"最终 phase1Grid 丢失静态单元格：{phase1_key(cell)}")
    scan_language(report, warnings)

    result = {"ok": not errors, "errors": errors, "warnings": warnings}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if errors:
        sys.exit(1)


def phase1_key(cell: Dict[str, Any]) -> str:
    return f"{cell.get('traceStepIndex') or cell.get('step')}:{cell.get('module')}:{cell.get('errorType')}"

def require_object(value: Any, name: str, errors: List[str]) -> None:
    if not isinstance(value, dict):
        errors.append(f"{name} 必须是 JSON object。")


def require_array(obj: Dict[str, Any], key: str, errors: List[str]) -> None:
    if not isinstance(obj.get(key), list):
        errors.append(f"{key} 必须是数组。")


def validate_step_records(records: Any, errors: List[str], warnings: List[str]) -> None:
    if not isinstance(records, list):
        return
    for idx, record in enumerate(records, start=1):
        if not isinstance(record, dict):
            errors.append(f"stepRecords[{idx}] 必须是对象。")
            continue
        modules = record.get("modules")
        if not isinstance(modules, dict):
            errors.append(f"stepRecords[{idx}] 缺少 modules。")
            continue
        validate_trace_location(record, f"stepRecords[{idx}]", warnings)
        for module in MODULES:
            item = modules.get(module)
            if not isinstance(item, dict):
                errors.append(f"stepRecords[{idx}].modules.{module} 缺失。")
                continue
            if item.get("module") != module:
                errors.append(f"stepRecords[{idx}].modules.{module}.module 不匹配。")
            if not isinstance(item.get("content", ""), str):
                errors.append(f"stepRecords[{idx}].modules.{module}.content 必须是字符串。")
            if module in {"memory", "reflection"} and idx == 1 and item.get("content"):
                warnings.append(f"首个记录的 {module} 有内容，请确认是否确实引用了 trace 前历史。")


def validate_phase1(cells: Any, errors: List[str], warnings: List[str]) -> None:
    if not isinstance(cells, list):
        return
    for idx, cell in enumerate(cells, start=1):
        if not isinstance(cell, dict):
            errors.append(f"phase1Grid[{idx}] 必须是对象。")
            continue
        module = cell.get("module")
        if module not in MODULES and module != "others":
            errors.append(f"phase1Grid[{idx}].module 非法：{module}")
        if cell.get("severity") not in SEVERITIES:
            errors.append(f"phase1Grid[{idx}].severity 非法：{cell.get('severity')}")
        if not cell.get("errorType"):
            errors.append(f"phase1Grid[{idx}] 缺少 errorType。")
        if cell.get("errorDetected") is False and cell.get("errorType") != "no_error":
            warnings.append(f"phase1Grid[{idx}] errorDetected=false 时建议使用 no_error。")
        if module in {"memory", "reflection", "planning", "action"} and not cell.get("evidence"):
            warnings.append(f"phase1Grid[{idx}] 缺少证据，前端解释性会变差。")
        if cell.get("errorDetected") is not False:
            validate_trace_location(cell, f"phase1Grid[{idx}]", warnings)


def validate_issues(issues: Any, errors: List[str], warnings: List[str]) -> None:
    if not isinstance(issues, list):
        return
    seen_keys: set[str] = set()
    for idx, issue in enumerate(issues, start=1):
        if not isinstance(issue, dict):
            errors.append(f"issues[{idx}] 必须是对象。")
            continue
        if not issue.get("id"):
            errors.append(f"issues[{idx}] 缺少 id。")
        module = issue.get("module")
        if module not in MODULES and module != "others":
            errors.append(f"issues[{idx}].module 非法：{module}")
        if issue.get("severity") not in SEVERITIES:
            errors.append(f"issues[{idx}].severity 非法：{issue.get('severity')}")
        resolution = issue.get("resolution")
        if resolution is not None and resolution not in {"unresolved", "recovered", "non_blocking"}:
            errors.append(f"issues[{idx}].resolution 非法：{resolution}")
        if not issue.get("errorType"):
            errors.append(f"issues[{idx}] 缺少 errorType。")
        key = f"{issue.get('traceStepIndex') or issue.get('step')}:{module}:{issue.get('errorType')}"
        if key in seen_keys:
            warnings.append(f"issues[{idx}] 与前面的 issue 重复：{key}")
        seen_keys.add(key)
        validate_trace_location(issue, f"issues[{idx}]", warnings)


def validate_findings(findings: Any, issues: Any, errors: List[str], warnings: List[str]) -> None:
    if findings is None:
        warnings.append("缺少 findings；将使用 rootCause 兼容展示，无法稳定展示多条关键发现。")
        return
    if not isinstance(findings, list):
        errors.append("findings 必须是数组。")
        return

    issue_ids = {
        str(issue.get("id"))
        for issue in issues
        if isinstance(issue, dict) and issue.get("id")
    } if isinstance(issues, list) else set()
    root_issue_owners: Dict[str, str] = {}
    allowed_impacts = {"result_blocking", "quality_degrading", "recovered_cost", "risk"}
    allowed_roles = {"root", "contributing", "downstream"}

    for idx, finding in enumerate(findings, start=1):
        if not isinstance(finding, dict):
            errors.append(f"findings[{idx}] 必须是对象。")
            continue
        finding_id = str(finding.get("id") or f"finding-{idx}")
        for key in ("id", "summary", "evidence", "correctionGuidance"):
            if not finding.get(key):
                errors.append(f"findings[{idx}] 缺少 {key}。")
        if finding.get("severity") not in SEVERITIES:
            errors.append(f"findings[{idx}].severity 非法：{finding.get('severity')}")
        if finding.get("impact") not in allowed_impacts:
            errors.append(f"findings[{idx}].impact 非法：{finding.get('impact')}")
        confidence = finding.get("confidence")
        if not isinstance(confidence, (int, float)) or not 0 <= float(confidence) <= 1:
            errors.append(f"findings[{idx}].confidence 必须是 0-1 数字。")

        refs = finding.get("issueRefs")
        if not isinstance(refs, list) or not refs:
            errors.append(f"findings[{idx}].issueRefs 必须是非空数组。")
            continue

        seen_refs: set[str] = set()
        root_refs: List[str] = []
        for ref_idx, ref in enumerate(refs, start=1):
            if not isinstance(ref, dict):
                errors.append(f"findings[{idx}].issueRefs[{ref_idx}] 必须是对象。")
                continue
            issue_id = str(ref.get("issueId") or "")
            role = ref.get("role")
            if not issue_id:
                errors.append(f"findings[{idx}].issueRefs[{ref_idx}] 缺少 issueId。")
            elif issue_ids and issue_id not in issue_ids:
                errors.append(f"findings[{idx}].issueRefs[{ref_idx}].issueId 不存在：{issue_id}")
            if issue_id in seen_refs:
                errors.append(f"findings[{idx}] 重复引用 issue：{issue_id}")
            seen_refs.add(issue_id)
            if role not in allowed_roles:
                errors.append(f"findings[{idx}].issueRefs[{ref_idx}].role 非法：{role}")
            if role == "root":
                root_refs.append(issue_id)
                owner = root_issue_owners.get(issue_id)
                if owner and owner != finding_id:
                    errors.append(f"issue {issue_id} 被多个 finding 声明为 root：{owner}, {finding_id}")
                root_issue_owners[issue_id] = finding_id
        if len(root_refs) != 1:
            errors.append(f"findings[{idx}] 必须恰好有一个 role=root 的 issueRef。")


def validate_root_cause(root: Any, errors: List[str], warnings: List[str]) -> None:
    if root is None:
        return
    if not isinstance(root, dict):
        errors.append("rootCause 必须是对象或 null。")
        return
    module = root.get("criticalModule")
    if module not in MODULES and module != "others":
        errors.append(f"rootCause.criticalModule 非法：{module}")
    if module in {"memory", "reflection", "planning", "action"} and not root.get("evidence"):
        warnings.append("rootCause 缺少 evidence，用户难以理解根因依据。")
    if not root.get("summary"):
        errors.append("rootCause.summary 不能为空。")
    if root.get("criticalModule") != "unknown":
        if not root.get("criticalTraceStepIndex"):
            warnings.append("rootCause 缺少 criticalTraceStepIndex，前端只能使用兼容字段定位。")
        if not root.get("criticalTraceNodeLabel"):
            warnings.append("rootCause 缺少 criticalTraceNodeLabel，前端节点解释性会变差。")
        if not root.get("criticalAnchorId") and not root.get("anchorId"):
            warnings.append("rootCause 缺少 criticalAnchorId/anchorId，无法直接跳到左侧节点。")
    chain = root.get("cascadingChain")
    if isinstance(chain, list):
        for idx, item in enumerate(chain, start=1):
            if isinstance(item, dict):
                validate_trace_location(item, f"rootCause.cascadingChain[{idx}]", warnings)


def validate_trace_location(item: Dict[str, Any], path: str, warnings: List[str]) -> None:
    if not item.get("anchorId") and not item.get("criticalAnchorId"):
        warnings.append(f"{path} 缺少 anchorId，跳转左侧节点可能不可用。")
    if not item.get("traceStepIndex") and not item.get("criticalTraceStepIndex"):
        warnings.append(f"{path} 缺少 traceStepIndex，前端只能使用兼容编号。")
    if not item.get("traceNodeLabel") and not item.get("criticalTraceNodeLabel"):
        warnings.append(f"{path} 缺少 traceNodeLabel，前端节点标签会变弱。")


def scan_language(value: Any, warnings: List[str], path: str = "$") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            scan_language(child, warnings, f"{path}.{key}")
    elif isinstance(value, list):
        for idx, child in enumerate(value):
            scan_language(child, warnings, f"{path}[{idx}]")
    elif isinstance(value, str):
        key = path.split(".")[-1]
        if key in NATURAL_KEYS and looks_like_untranslated_english(value):
            warnings.append(f"{path} 可能仍是英文，请改成中文表达；原始命令/报错可保留。")


def looks_like_untranslated_english(value: str) -> bool:
    stripped = value.strip()
    if not stripped:
        return False
    chinese = len(re.findall(r"[\u4e00-\u9fff]", stripped))
    letters = len(re.findall(r"[A-Za-z]", stripped))
    # 允许短 enum、路径、命令和原始英文报错；长自然语言字段才提醒。
    return len(stripped) > 80 and letters > chinese * 2 and not re.search(r"[/\\{}:=`$]", stripped)


if __name__ == "__main__":
    main()
