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
from uuid import uuid4
from pathlib import Path

from assets import AssetError, digest_bytes, load_inventory, source_task_digest, verify_task
from docker_proxy import REAL_DOCKER, host_path
from evidence import collect_evidence

HERE = Path(__file__).resolve().parent
MESSAGES = {
    "ZSOFT_ASSET_ROOT_MISSING": "ZSoft 评测资产目录未配置或不存在",
    "ZSOFT_ASSET_MISSING": "ZSoft 评测资产缺失",
    "ZSOFT_IMAGE_MISSING": "ZSoft 预构建镜像缺失或摘要不一致",
    "ZSOFT_SHARED_MOUNT_MISSING": "ZSoft 资产或运行目录未通过 Controller 数据卷共享",
    "ZSOFT_ARTIFACT_INVALID": "ZSoft 提交物描述与当前任务不匹配",
    "ZSOFT_ARTIFACT_PATH_INVALID": "ZSoft 提交物路径无效或不在输入目录内",
    "ZSOFT_ARTIFACT_DIGEST_MISMATCH": "ZSoft 提交物大小或 SHA-256 与任务记录不一致",
    "ZSOFT_KERNEL_ACCEL_INVALID": "ZSoft 内核加速模式应为 tcg 或 kvm",
    "ZSOFT_KERNEL_KVM_UNAVAILABLE": "评测机 Docker 无法使用 /dev/kvm，请启用虚拟化或使用 tcg",
    "ZSOFT_KERNEL_RESOURCES_INSUFFICIENT": "评测资源不足以运行题目声明的两版内核环境",
    "ZSOFT_EVALUATION_TIMEOUT": "ZSoft 评测超时",
    "ZSOFT_EVALUATION_CANCELLED": "ZSoft 评测已取消",
    "ZSOFT_CLEANUP_FAILED": "ZSoft 运行资源清理未完成",
    "ZSOFT_EVIDENCE_INVALID": "ZSoft 官方输出目录不合法或包含不安全文件",
    "ZSOFT_EVIDENCE_COLLECTION_FAILED": "ZSoft 官方输出未完整收集，请查看证据采集状态",
    "ZSOFT_OFFICIAL_REPORT_MISSING": "ZSoft 未生成官方判定报告或报告与最终记录不一致",
    "ZSOFT_OFFICIAL_INFRASTRUCTURE_ERROR": "ZSoft 官方判题发生基础设施故障，请查看已保留的官方输出",
}


def docker(args: list[str], timeout: int = 30) -> str:
    result = subprocess.run([REAL_DOCKER, *args], capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise AssetError("ZSOFT_DOCKER_UNAVAILABLE")
    return result.stdout.strip()


def asset_root() -> Path:
    configured = os.environ.get("EVALUATOR_ASSETS_DIR")
    if not configured:
        raise AssetError("ZSOFT_ASSET_ROOT_MISSING")
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


def inspect_images(images: dict[str, str], prepared: list[dict] | None = None) -> None:
    if prepared is not None:
        if not isinstance(prepared, list) or len(prepared) != len(images) or any(not isinstance(item, dict) for item in prepared):
            raise AssetError("ZSOFT_PREPARED_IMAGES_MISMATCH")
        resolved = {item.get("key"): item.get("imageId") for item in prepared}
        if resolved != images:
            raise AssetError("ZSOFT_PREPARED_IMAGES_MISMATCH")
    for tag, expected in images.items():
        try:
            actual = docker(["image", "inspect", expected, "--format", "{{.Id}}"])
        except Exception:
            raise AssetError("ZSOFT_IMAGE_MISSING") from None
        if actual != expected:
            raise AssetError("ZSOFT_IMAGE_MISSING")


def kernel_acceleration() -> str:
    try:
        config = json.loads(os.environ.get("AGENT_INSIGHT_EVALUATOR_CONFIG_JSON", "{}"))
        value = config.get("benchmarks", {}).get("zsoft-l1", {}).get("kernelAccel", "tcg")
    except (ValueError, AttributeError):
        raise AssetError("ZSOFT_KERNEL_ACCEL_INVALID") from None
    if value not in ("tcg", "kvm"):
        raise AssetError("ZSOFT_KERNEL_ACCEL_INVALID")
    return value


def kernel_policy(root: Path, task: dict, limits: dict, evaluation_id: str) -> dict:
    if "kernel" not in task["public"]["tags"]:
        return {"track": "userspace"}
    task_id = task["public"]["taskId"]
    metadata = [json.loads((root / f".task-state/{task_id}/{variant}/artifacts/metadata.json").read_text()) for variant in ("vuln", "fix")]
    if limits["memoryMiB"] < 2 * (max(item["memory_mb"] for item in metadata) + 512) or limits["cpu"] < 2 * max(item["smp"] for item in metadata):
        raise AssetError("ZSOFT_KERNEL_RESOURCES_INSUFFICIENT")
    acceleration = kernel_acceleration()
    if acceleration == "kvm":
        image_id = next(iter(task["images"].values()))
        try:
            docker(["run", "--rm", "--network", "none", "--read-only", "--device", "/dev/kvm:/dev/kvm:rw",
                    "--label", f"agent-insight.evaluation-id={evaluation_id}",
                    "--label", "agent-insight.role=zsoft-task",
                    "--label", f"agent-insight.evaluator-instance={os.environ.get('EVALUATOR_INSTANCE_ID', '')}",
                    "--entrypoint", "python3", image_id, "-c",
                    "import os,fcntl; f=os.open('/dev/kvm',os.O_RDWR); assert fcntl.ioctl(f,0xae00,0)==12; os.close(f)"])
        except Exception:
            raise AssetError("ZSOFT_KERNEL_KVM_UNAVAILABLE") from None
    return {"track": "kernel", "kernelAcceleration": acceleration}


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
            if not task.get("registryImages"):
                inspect_images(task["images"])
        tracks = sorted({"kernel" if "kernel" in task["public"]["tags"] else "userspace" for task in inventory["tasks"].values()})
        facts = {"revision": inventory["revision"], "bundleDigest": inventory["bundleDigest"], "installedTaskCount": len(inventory["tasks"]), "tracks": tracks}
        if "kernel" in tracks:
            facts["kernelAcceleration"] = kernel_acceleration()
        result = {"ready": True, "formalEligible": True, "runtimeFacts": facts}
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
    if payload.get("revision") and payload["revision"] != inventory["revision"]:
        raise AssetError("ZSOFT_BUNDLE_MISMATCH")
    task = verify_task(root, inventory, str(payload.get("taskId", "")))
    if payload.get("sourceTaskDigest") != source_task_digest(root, payload["taskId"]) or payload.get("maxBytes") != task["public"]["maxBytes"] or payload.get("submissionKind") != task["public"]["submissionKind"]:
        raise AssetError("ZSOFT_TASK_MISMATCH")
    limits = job.get("limits", {})
    if type(limits.get("timeoutSeconds")) is not int or not 1 <= limits["timeoutSeconds"] <= 86400 or not isinstance(limits.get("cpu"), (int, float)) or not math.isfinite(limits["cpu"]) or limits["cpu"] <= 0 or type(limits.get("memoryMiB")) is not int or limits["memoryMiB"] < 1:
        raise AssetError("ZSOFT_REQUEST_INVALID")
    artifacts = request.get("artifacts", [])
    originals = job.get("artifacts", [])
    if (
        not isinstance(artifacts, list) or not isinstance(originals, list)
        or len(artifacts) != 1 or len(originals) != 1
        or not isinstance(artifacts[0], dict) or not isinstance(originals[0], dict)
    ):
        raise AssetError("ZSOFT_ARTIFACT_INVALID")
    descriptor = artifacts[0].get("descriptor")
    original = originals[0]
    if not isinstance(descriptor, dict) or any(
        field not in original or field not in descriptor
        or type(descriptor[field]) is not type(original[field])
        or descriptor[field] != original[field]
        for field in ("artifactId", "name", "mediaType", "sha256", "sizeBytes")
    ):
        raise AssetError("ZSOFT_ARTIFACT_INVALID")
    if (
        not isinstance(original["artifactId"], str) or not original["artifactId"]
        or type(original["sizeBytes"]) is not int or original["sizeBytes"] < 1
        or not isinstance(original["sha256"], str)
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", original["sha256"])
    ):
        raise AssetError("ZSOFT_ARTIFACT_INVALID")
    if (
        descriptor.get("name") != "poc" or descriptor.get("mediaType") != "application/octet-stream"
        or descriptor.get("evaluationId") != job["evaluationId"] or descriptor.get("kind") != "submission"
        or not isinstance(job.get("executionRunId"), str) or not job["executionRunId"]
        or original.get("executionRunId") != job["executionRunId"]
    ):
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
    completion = {"status": "failed", "rawResult": {}, "runtimeFacts": {}, "cleanup": {"status": "pending"}}
    evidence = []
    worker = None
    work = output_path.parent.parent / "work" / uuid4().hex
    work.mkdir(mode=0o700, parents=True)
    task_id = None

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
        task_id = job["payload"]["taskId"]
        artifact = (request_path.parent / relative_artifact).resolve()
        if relative_artifact.is_absolute() or not artifact.is_relative_to(request_path.parent) or artifact.is_symlink() or not artifact.is_file():
            raise AssetError("ZSOFT_ARTIFACT_PATH_INVALID")
        descriptor = job["artifacts"][0]
        if artifact.stat().st_size != descriptor["sizeBytes"] or not 1 <= descriptor["sizeBytes"] <= task["public"]["maxBytes"] or digest_bytes(artifact.read_bytes()) != descriptor["sha256"]:
            raise AssetError("ZSOFT_ARTIFACT_DIGEST_MISMATCH")
        inspect_images(task["images"], request.get("preparedImages"))
        runtime_policy = kernel_policy(root, task, job["limits"], evaluation_id)
        completion["runtimeFacts"].update(runtime_policy)
        mounts = shared_mounts()
        policy = {**runtime_policy, "allowedRoots": [str(root), str(work)], "mounts": mounts, "images": task["images"], "evaluationId": evaluation_id, "instanceId": os.environ["EVALUATOR_INSTANCE_ID"], "cpu": job["limits"]["cpu"], "memoryMiB": job["limits"]["memoryMiB"], "projectName": "ai_zsoft_" + digest_bytes(evaluation_id.encode())[7:31], "workDir": str(work), "assetRoot": str(root)}
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
        if runtime_policy["track"] == "kernel":
            # The judge container has no KVM device; the proxy configures the host-side runner.
            environment["ZSOFT_KERNEL_ACCEL"] = "tcg"
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
        raw = {"sourceTaskDigest": task["sourceTaskDigest"], "taskId": config["taskId"], "submissionSha256": descriptor["sha256"], "bundleDigest": inventory["bundleDigest"], "taskDigest": task["taskDigest"], "status": status, "success": result["success"]}
        completion.update(status="completed" if status == "completed" else "submission_invalid", rawResult=raw, runtimeFacts={"revision": inventory["revision"], "bundleDigest": inventory["bundleDigest"], **runtime_policy})
        if status == "invalid_submission":
            completion["error"] = {"code": "ZSOFT_SUBMISSION_INVALID", "message": "PoC 不符合官方提交要求", "retryable": False}
    except Exception as error:
        code = error_code(error)
        completion["error"] = {"code": code, "message": MESSAGES.get(code, "ZSoft 评测资产或运行状态异常"), "retryable": code in ("ZSOFT_DOCKER_UNAVAILABLE", "ZSOFT_EVALUATION_TIMEOUT")}
    finally:
        stop_worker(worker)
        completion["cleanup"] = cleanup(evaluation_id)
        if completion["cleanup"]["status"] != "succeeded":
            completion.update(status="failed", rawResult={}, error={"code": "ZSOFT_CLEANUP_FAILED", "message": MESSAGES["ZSOFT_CLEANUP_FAILED"], "retryable": True})
        if task_id is not None:
            try:
                evidence, facts = collect_evidence(work, task_id, output_path.parent)
                completion["runtimeFacts"]["evidenceCollection"] = facts
                if facts["errors"]:
                    raise AssetError("ZSOFT_EVIDENCE_COLLECTION_FAILED")
                if completion["status"] != "failed":
                    report = next((item for item in evidence if item["name"] == "evaluation.json"), None)
                    if not report or report["mediaType"] != "application/json":
                        raise AssetError("ZSOFT_OFFICIAL_REPORT_MISSING")
                    official = json.loads((output_path.parent / report["path"]).read_bytes())
                    if official.get("status") != completion["rawResult"]["status"] or type(official.get("success")) is not bool or official["success"] != completion["rawResult"]["success"]:
                        raise AssetError("ZSOFT_OFFICIAL_REPORT_MISSING")
            except Exception as error:
                code = error_code(error)
                completion["runtimeFacts"].setdefault("evidenceCollection", {}).setdefault("errors", []).append(MESSAGES.get(code, "ZSoft 官方输出采集失败"))
                if completion["status"] != "failed":
                    completion.update(status="failed", rawResult={}, error={"code": code, "message": MESSAGES.get(code, "ZSoft 官方输出采集失败"), "retryable": False})
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
