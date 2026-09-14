from __future__ import annotations


def _invalid_report(message: str):
    return "failed", {
        "code": "SWE_HARNESS_RESULT_INVALID",
        "message": message,
        "retryable": True,
    }


def _report_issue(report: object) -> str | None:
    if not isinstance(report, dict):
        return "SWE-bench Harness 未生成 Case 官方报告"
    if "infra_failure" in report and not isinstance(report["infra_failure"], bool):
        return "SWE-bench 官方报告 infra_failure 不是 boolean"
    if report.get("infra_failure") is True:
        return None
    for field in ("resolved", "patch_successfully_applied"):
        if not isinstance(report.get(field), bool):
            return f"SWE-bench 官方报告 {field} 缺失或不是 boolean"
    tests_status = report.get("tests_status")
    if not isinstance(tests_status, dict):
        return "SWE-bench 官方报告 tests_status 缺失或不是对象"
    for test_group in ("FAIL_TO_PASS", "PASS_TO_PASS"):
        status = tests_status.get(test_group)
        if not isinstance(status, dict):
            return f"SWE-bench 官方报告 tests_status.{test_group} 缺失或不是对象"
        for outcome in ("success", "failure"):
            tests = status.get(outcome)
            if not isinstance(tests, list) or any(
                not isinstance(item, str) for item in tests
            ):
                return (
                    "SWE-bench 官方报告 "
                    f"tests_status.{test_group}.{outcome} 不是字符串数组"
                )
    return None


def classify_harness_result(report: dict | None, patch_apply_failed: bool):
    if patch_apply_failed:
        return "submission_invalid", {
            "code": "SWE_PATCH_APPLY_FAILED",
            "message": "Agent Patch 无法应用到官方 Case 镜像",
            "retryable": False,
        }
    issue = _report_issue(report)
    if issue:
        return _invalid_report(issue)
    if report.get("infra_failure") is not True:
        return "completed", None
    reason = report.get("infra_failure_reason")
    return "failed", {
        "code": "SWE_HARNESS_FAILED",
        "message": reason if isinstance(reason, str) and reason else "SWE-bench Harness 执行失败",
        "retryable": True,
    }
