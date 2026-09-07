#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import platform
import sys
import time
import traceback
from pathlib import Path

import docker

from swebench.harness.constants import (
    APPLY_PATCH_FAIL,
    LOG_INSTANCE,
    LOG_REPORT,
    LOG_TEST_OUTPUT,
    RUN_EVALUATION_LOG_DIR,
)
from swebench.harness.run_evaluation import run_instance
from swebench.harness.utils import make_test_spec


class ControlledContainers:
    def __init__(self, containers, evaluation_id: str, cpu: float, memory_mib: int):
        self._containers = containers
        self._evaluation_id = evaluation_id
        self._cpu = cpu
        self._memory_mib = memory_mib

    def create(self, *args, **kwargs):
        labels = dict(kwargs.pop("labels", {}) or {})
        labels["agent-insight.evaluation-id"] = self._evaluation_id
        kwargs["labels"] = labels
        kwargs["mem_limit"] = f"{self._memory_mib}m"
        kwargs["nano_cpus"] = int(self._cpu * 1_000_000_000)
        return self._containers.create(*args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._containers, name)


class ControlledDockerClient:
    def __init__(self, client, evaluation_id: str, cpu: float, memory_mib: int):
        self._client = client
        self.api = client.api
        self.images = client.images
        self.containers = ControlledContainers(
            client.containers, evaluation_id, cpu, memory_mib
        )

    def __getattr__(self, name):
        return getattr(self._client, name)


def ensure_file(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text(content, encoding="utf-8")


def test_counts(report: dict, key: str) -> dict[str, int]:
    metric = (report.get("tests_status") or {}).get(key) or {}
    passed = len(metric.get("success") or [])
    failed = len(metric.get("failure") or [])
    return {"passed": passed, "total": passed + failed}


def cleanup_labeled(client, evaluation_id: str) -> dict:
    failures = []
    for container in client.containers.list(
        all=True, filters={"label": f"agent-insight.evaluation-id={evaluation_id}"}
    ):
        try:
            container.remove(force=True)
        except Exception as error:
            failures.append(f"{container.id}: {error}")
    if failures:
        return {"status": "failed", "errors": failures}
    return {"status": "succeeded"}


def main(input_path: str, output_path: str) -> int:
    started = time.monotonic()
    payload = json.loads(Path(input_path).read_text(encoding="utf-8"))
    evaluation_id = payload["evaluationId"]
    instance = payload["instance"]
    prediction_input = payload["prediction"]
    limits = payload["limits"]
    prediction = {
        "instance_id": prediction_input["instance_id"],
        "model_name_or_path": prediction_input["model_name_or_path"],
        "model_patch": Path(prediction_input["model_patch_path"]).read_text(
            encoding="utf-8"
        ),
    }
    model_log_name = prediction["model_name_or_path"].replace("/", "__")
    log_dir = (
        RUN_EVALUATION_LOG_DIR
        / evaluation_id
        / model_log_name
        / instance["instance_id"]
    )
    report_path = log_dir / LOG_REPORT
    test_output_path = log_dir / LOG_TEST_OUTPUT
    instance_log_path = log_dir / LOG_INSTANCE
    client = docker.from_env(
        timeout=int(os.environ.get("SWEBENCH_DOCKER_TIMEOUT", "1800")),
        max_pool_size=int(os.environ.get("SWEBENCH_DOCKER_POOL_SIZE", "16")),
    )
    controlled = ControlledDockerClient(
        client,
        evaluation_id,
        float(limits["cpu"]),
        int(limits["memoryMiB"]),
    )
    status = "failed"
    error = None
    report_map = None
    cleanup = {"status": "failed", "errors": ["cleanup did not run"]}
    try:
        test_spec = make_test_spec(instance)
        result = run_instance(
            test_spec,
            prediction,
            controlled,
            evaluation_id,
            timeout=int(limits["timeoutSeconds"]),
        )
        if result:
            report_map = result[1]
        elif report_path.exists():
            report_map = json.loads(report_path.read_text(encoding="utf-8"))
        report = (report_map or {}).get(instance["instance_id"])
        log_text = (
            instance_log_path.read_text(encoding="utf-8", errors="replace")
            if instance_log_path.exists()
            else ""
        )
        if report and not report.get("infra_failure") and "tests_status" in report:
            status = "completed"
        elif APPLY_PATCH_FAIL in log_text:
            status = "submission_invalid"
            error = {
                "code": "SWE_PATCH_APPLY_FAILED",
                "message": "Agent Patch 无法应用到官方 Case 镜像",
                "retryable": False,
            }
        else:
            reason = (report or {}).get("infra_failure_reason")
            error = {
                "code": "SWE_HARNESS_FAILED",
                "message": reason or "SWE-bench Harness 未生成完整官方报告",
                "retryable": True,
            }
    except Exception as exc:
        ensure_file(instance_log_path, traceback.format_exc())
        error = {
            "code": "SWE_HARNESS_FAILED",
            "message": str(exc)[:2000],
            "retryable": True,
        }
    finally:
        cleanup = cleanup_labeled(client, evaluation_id)
        client.close()

    report = (report_map or {}).get(instance["instance_id"]) or {}
    raw_result = {
        "instanceId": instance["instance_id"],
        "resolved": bool(report.get("resolved", False)),
        "patchSuccessfullyApplied": bool(
            report.get("patch_successfully_applied", False)
        ),
        "failToPass": test_counts(report, "FAIL_TO_PASS"),
        "passToPass": test_counts(report, "PASS_TO_PASS"),
        "officialReport": report_map or {},
    }
    ensure_file(report_path, json.dumps(report_map or {}, indent=2) + "\n")
    ensure_file(test_output_path, "Harness did not produce test_output.txt\n")
    ensure_file(instance_log_path, "Harness did not produce run_instance.log\n")
    runtime_facts = {
        **payload["runtimeFacts"],
        "controllerPlatform": platform.platform(),
        "durationMs": round((time.monotonic() - started) * 1000),
    }
    output = {
        "status": status,
        "rawResult": raw_result,
        "runtimeFacts": runtime_facts,
        "cleanup": cleanup,
        "evidenceFiles": [
            {
                "name": "report.json",
                "kind": "official-report",
                "mediaType": "application/json",
                "path": str(report_path),
            },
            {
                "name": "test_output.txt",
                "kind": "test-output",
                "mediaType": "text/plain",
                "path": str(test_output_path),
            },
            {
                "name": "run_instance.log",
                "kind": "harness-log",
                "mediaType": "text/plain",
                "path": str(instance_log_path),
            },
        ],
        **({"error": error} if error else {}),
    }
    Path(output_path).write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: run.py INPUT_JSON OUTPUT_JSON")
    raise SystemExit(main(sys.argv[1], sys.argv[2]))
