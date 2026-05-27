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
}


def main() -> None:
    parser = argparse.ArgumentParser(description="校验 AgentDebug 诊断报告 JSON。")
    parser.add_argument("--input", required=True, help="最终报告 JSON 路径")
    args = parser.parse_args()

    report = read_json(args.input)
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
    validate_root_cause(report.get("rootCause"), errors, warnings)
    scan_language(report, warnings)

    result = {"ok": not errors, "errors": errors, "warnings": warnings}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if errors:
        sys.exit(1)


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
                warnings.append(f"Step 1 的 {module} 有内容，请确认是否确实引用了 trace 前历史。")


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

