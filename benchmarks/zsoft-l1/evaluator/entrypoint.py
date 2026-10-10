#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import os
import re
import signal
import subprocess
import sys
from pathlib import Path

from assets import AssetError, digest_bytes, load_inventory, verify_task
from docker_proxy import REAL_DOCKER, host_path

HERE = Path(__file__).resolve().parent
MESSAGES = {
    "ZSOFT_ASSET_ROOT_MISSING": "ZSoft 评测资产目录未配置或不存在",
    "ZSOFT_ASSET_MISSING": "ZSoft 评测资产缺失",
    "ZSOFT_IMAGE_MISSING": "ZSoft 预构建镜像缺失或摘要不一致",
    "ZSOFT_SHARED_MOUNT_MISSING": "ZSoft 资产或运行目录未通过 Controller 数据卷共享",
    "ZSOFT_P2_USERSPACE_ONLY": "ZSoft P2 当前仅支持 userspace 题目",
    "ZSOFT_EVALUATION_TIMEOUT": "ZSoft 评测超时",
    "ZSOFT_EVALUATION_CANCELLED": "ZSoft 评测已取消",
    "ZSOFT_CLEANUP_FAILED": "ZSoft 运行资源清理未完成",
}


def docker(args: list[str], timeout: int = 30) -> str:
    result = subprocess.run([REAL_DOCKER, *args], capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise AssetError("ZSOFT_DOCKER_UNAVAILABLE")
    return result.stdout.strip()


def asset_root() -> Path:
    configured = os.environ.get("ZSOFT_L1_ASSETS_DIR", "/data/benchmark-assets/zsoft-l1")
    root = Path(configured)
    if not root.is_absolute() or not root.is_dir() or root.is_symlink():
        raise AssetError("ZSOFT_ASSET_ROOT_MISSING")
    return root.resolve()


def shared_mounts() -> list[dict]:
    instance = os.environ.get("EVALUATOR_INSTANCE_ID", "")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,160}", instance):
        raise AssetError("ZSOFT_CONTROLLER_ID_MISSING")
    containers = json.loads(docker(["inspect", instance]))
    mounts = [mount for mount in containers[0]["Mounts"] if mount.get("Type") in ("bind", "volume") and mount.get("Destination") != "/var/run/docker.sock"]
    if not mounts:
        raise AssetError("ZSOFT_SHARED_MOUNT_MISSING")
    return mounts


def inspect_images(images: dict[str, str]) -> None:
    for tag, expected in images.items():
        try:
            actual = docker(["image", "inspect", tag, "--format", "{{.Id}}"])
        except Exception:
            raise AssetError("ZSOFT_IMAGE_MISSING") from None
        if actual != expected:
            raise AssetError("ZSOFT_IMAGE_MISSING")


def error_code(error: Exception) -> str:
    value = str(error)
    return value if re.fullmatch(r"ZSOFT_[A-Z0-9_]+", value) else "ZSOFT_EVALUATION_FAILED"


def cleanup(evaluation_id: str) -> dict:
    filters = ["--filter", f"label=agent-insight.evaluation-id={evaluation_id}", "--filter", "label=agent-insight.role=zsoft-task", "--filter", f"label=agent-insight.evaluator-instance={os.environ.get('EVALUATOR_INSTANCE_ID', '')}"]
    removed = []
    try:
        for resource, query, remove in (("container", ["ps", "-aq"], ["rm", "-f"]), ("network", ["network", "ls", "-q"], ["network", "rm"])):
            ids = docker([*query, *filters]).split()
            if any(not re.fullmatch(r"[0-9a-f]{12,64}", item) for item in ids):
                raise AssetError("ZSOFT_CLEANUP_FAILED")
            if ids:
                docker([*remove, *ids])
                removed.extend({"kind": resource, "id": item} for item in ids)
            if docker([*query, *filters]):
                raise AssetError("ZSOFT_CLEANUP_FAILED")
        return {"status": "succeeded", "removed": removed}
    except Exception:
        return {"status": "failed", "code": "ZSOFT_CLEANUP_FAILED"}


def doctor() -> int:
    try:
        root = asset_root()
        inventory = load_inventory(root)
        mounts = shared_mounts()
        host_path(str(root), {"allowedRoots": [str(root)], "mounts": mounts})
        docker(["compose", "version"])
        for task_id in inventory["tasks"]:
            task = verify_task(root, inventory, task_id)
            inspect_images(task["images"])
        result = {"ready": True, "formalEligible": True, "runtimeFacts": {"revision": inventory["revision"], "bundleDigest": inventory["bundleDigest"], "installedTaskCount": len(inventory["tasks"]), "track": "userspace"}}
    except Exception as error:
        code = error_code(error)
        result = {"ready": False, "formalEligible": False, "reason": MESSAGES.get(code, code)}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ready"] else 1


def validate_request(request: dict, root: Path, inventory: dict) -> tuple[dict, Path]:
    job = request.get("evaluationJob", {})
    payload = job.get("payload", {})
    if request.get("schemaVersion") != "evaluator-entrypoint/v1" or job.get("benchmark", {}).get("key") != "zsoft-l1" or job.get("evaluator", {}).get("key") != "zsoft-l1" or not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", str(job.get("evaluationId", ""))):
        raise AssetError("ZSOFT_REQUEST_INVALID")
    if payload.get("revision") != inventory["revision"] or payload.get("bundleDigest") != inventory["bundleDigest"]:
        raise AssetError("ZSOFT_BUNDLE_MISMATCH")
    task = verify_task(root, inventory, str(payload.get("taskId", "")))
    if payload.get("taskDigest") != task["taskDigest"] or payload.get("maxBytes") != task["public"]["maxBytes"] or payload.get("submissionKind") != task["public"]["submissionKind"]:
        raise AssetError("ZSOFT_TASK_MISMATCH")
    limits = job.get("limits", {})
    if type(limits.get("timeoutSeconds")) is not int or not 1 <= limits["timeoutSeconds"] <= 86400 or not isinstance(limits.get("cpu"), (int, float)) or not math.isfinite(limits["cpu"]) or limits["cpu"] <= 0 or type(limits.get("memoryMiB")) is not int or limits["memoryMiB"] < 1:
        raise AssetError("ZSOFT_REQUEST_INVALID")
    artifacts = request.get("artifacts", [])
    if len(artifacts) != 1 or len(job.get("artifacts", [])) != 1 or artifacts[0].get("descriptor") != job["artifacts"][0]:
        raise AssetError("ZSOFT_ARTIFACT_INVALID")
    descriptor = artifacts[0]["descriptor"]
    if descriptor.get("name") != "poc" or descriptor.get("mediaType") != "application/octet-stream" or descriptor.get("executionRunId") != job.get("executionRunId"):
        raise AssetError("ZSOFT_ARTIFACT_INVALID")
    return task, Path(str(artifacts[0].get("path", "")))


def stop_worker(worker: subprocess.Popen | None) -> None:
    if worker is not None and worker.poll() is None:
        try:
            os.killpg(worker.pid, signal.SIGKILL)
            worker.wait(timeout=10)
        except ProcessLookupError:
            pass


def evaluate(request_path: Path, output_path: Path) -> None:
    request_path = request_path.resolve()
    output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    request = json.loads(request_path.read_text())
    job = request.get("evaluationJob", {})
    evaluation_id = str(job.get("evaluationId", ""))
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", evaluation_id):
        raise AssetError("ZSOFT_REQUEST_INVALID")
    completion = {"status": "failed", "rawResult": {}, "runtimeFacts": {"track": "userspace"}, "cleanup": {"status": "pending"}}
    evidence = []
    worker = None
    work = output_path.parent.parent / "work"
    work.mkdir(mode=0o700, exist_ok=True)

    def interrupted(_number, _frame):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        raise AssetError("ZSOFT_EVALUATION_CANCELLED")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        root = asset_root()
        inventory = load_inventory(root)
        task, relative_artifact = validate_request(request, root, inventory)
        artifact = (request_path.parent / relative_artifact).resolve()
        if relative_artifact.is_absolute() or not artifact.is_relative_to(request_path.parent) or artifact.is_symlink() or not artifact.is_file():
            raise AssetError("ZSOFT_ARTIFACT_PATH_INVALID")
        descriptor = job["artifacts"][0]
        if artifact.stat().st_size != descriptor["sizeBytes"] or not 1 <= descriptor["sizeBytes"] <= task["public"]["maxBytes"] or digest_bytes(artifact.read_bytes()) != descriptor["sha256"]:
            raise AssetError("ZSOFT_ARTIFACT_DIGEST_MISMATCH")
        inspect_images(task["images"])
        mounts = shared_mounts()
        policy = {"allowedRoots": [str(root), str(work)], "mounts": mounts, "images": task["images"], "evaluationId": evaluation_id, "instanceId": os.environ["EVALUATOR_INSTANCE_ID"], "cpu": job["limits"]["cpu"], "memoryMiB": job["limits"]["memoryMiB"], "projectName": "ai_zsoft_" + digest_bytes(evaluation_id.encode())[7:31], "workDir": str(work), "assetRoot": str(root)}
        host_path(str(root), policy)
        host_path(str(work), policy)
        policy_path = work / "proxy-policy.json"
        policy_path.write_text(json.dumps(policy))
        proxy_dir = work / "bin"
        proxy_dir.mkdir(exist_ok=True)
        proxy = proxy_dir / "docker"
        proxy.write_text(f'#!{sys.executable}\nimport runpy\nrunpy.run_path({str(HERE / "docker_proxy.py")!r}, run_name="__main__")\n')
        proxy.chmod(0o700)
        submission = work / "poc"
        submission.write_bytes(artifact.read_bytes())
        submission.chmod(0o400)
        config = {"tasksDir": str(root / "tasks"), "runsDir": str(work / "runs"), "stateDir": str(root / ".task-state"), "taskId": job["payload"]["taskId"], "submissionPath": str(submission), "recordPath": str(work / "record.json")}
        config_path = work / "worker-config.json"
        config_path.write_text(json.dumps(config))
        environment = {"PATH": f'{proxy_dir}:/usr/local/bin:/usr/bin:/bin', "PYTHONPATH": f'{root / "src"}:{HERE}', "PYTHONDONTWRITEBYTECODE": "1", "HOME": str(work), "LANG": "C.UTF-8", "ZSOFT_PROXY_POLICY": str(policy_path)}
        with (work / "worker.stdout").open("wb") as stdout, (work / "worker.stderr").open("wb") as stderr:
            worker = subprocess.Popen([sys.executable, str(HERE / "worker.py"), str(config_path)], cwd=root, env=environment, stdout=stdout, stderr=stderr, start_new_session=True)
            try:
                worker.wait(timeout=max(1, job["limits"]["timeoutSeconds"] - 30))
            except subprocess.TimeoutExpired:
                raise AssetError("ZSOFT_EVALUATION_TIMEOUT") from None
        if worker.returncode or not Path(config["recordPath"]).is_file():
            raise AssetError("ZSOFT_ATTEMPT_RECORD_MISSING")
        record = json.loads(Path(config["recordPath"]).read_text())
        if record.get("task_id") != config["taskId"] or record.get("submission_sha256") != descriptor["sha256"][7:] or record.get("submission_bytes") != descriptor["sizeBytes"] or record.get("submission_kind") != "final" or record.get("phase") != "final":
            raise AssetError("ZSOFT_ATTEMPT_IDENTITY_MISMATCH")
        result = record.get("result", {})
        status = result.get("status")
        if record.get("evaluator_timed_out") or status == "infrastructure_error":
            raise AssetError("ZSOFT_OFFICIAL_INFRASTRUCTURE_ERROR")
        if record.get("cleanup_timed_out") or record.get("cleanup_exit_code") != 0:
            raise AssetError("ZSOFT_CLEANUP_FAILED")
        if status not in ("completed", "invalid_submission") or type(result.get("success")) is not bool or (status != "completed" and result["success"]):
            raise AssetError("ZSOFT_RESULT_INVALID")
        raw = {"taskId": config["taskId"], "submissionSha256": descriptor["sha256"], "bundleDigest": inventory["bundleDigest"], "taskDigest": task["taskDigest"], "status": status, "success": result["success"]}
        report = output_path.parent / "report.json"
        report.write_text(json.dumps(raw))
        evidence = [{"name": "report.json", "kind": "official-report", "mediaType": "application/json", "path": "report.json"}]
        completion.update(status="completed" if status == "completed" else "submission_invalid", rawResult=raw, runtimeFacts={"revision": inventory["revision"], "bundleDigest": inventory["bundleDigest"], "track": "userspace"})
    except Exception as error:
        code = error_code(error)
        completion["error"] = {"code": code, "message": MESSAGES.get(code, "ZSoft 评测资产或运行状态异常"), "retryable": code in ("ZSOFT_DOCKER_UNAVAILABLE", "ZSOFT_EVALUATION_TIMEOUT")}
    finally:
        stop_worker(worker)
        completion["cleanup"] = cleanup(evaluation_id)
        if completion["cleanup"]["status"] != "succeeded":
            completion.update(status="failed", rawResult={}, error={"code": "ZSOFT_CLEANUP_FAILED", "message": MESSAGES["ZSOFT_CLEANUP_FAILED"], "retryable": True})
            evidence = []
        output_path.write_text(json.dumps({"protocolVersion": "evaluator-output/v1", "completion": completion, "evidenceFiles": evidence}, ensure_ascii=False))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("doctor", "evaluate"))
    parser.add_argument("--request", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.action == "doctor":
        return doctor()
    if args.request is None or args.output is None:
        parser.error("evaluate requires --request and --output")
    evaluate(args.request, args.output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
