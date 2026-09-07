from __future__ import annotations


def classify_harness_result(report: dict | None, patch_apply_failed: bool):
    if patch_apply_failed:
        return "submission_invalid", {
            "code": "SWE_PATCH_APPLY_FAILED",
            "message": "Agent Patch 无法应用到官方 Case 镜像",
            "retryable": False,
        }
    if report and not report.get("infra_failure"):
        return "completed", None
    reason = (report or {}).get("infra_failure_reason")
    return "failed", {
        "code": "SWE_HARNESS_FAILED",
        "message": reason or "SWE-bench Harness 未生成完整官方报告",
        "retryable": True,
    }
