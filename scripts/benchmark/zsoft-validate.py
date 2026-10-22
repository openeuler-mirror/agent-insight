#!/usr/bin/env python3
"""Audit public task exports and run local ZSoft reference/negative controls."""

import argparse
import collections
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(path)


def configured_kernel_acceleration():
    loader = Path(__file__).resolve().parents[2] / "packages/project-config/index.cjs"
    result = subprocess.run(["node", str(loader), "evaluator"], capture_output=True, text=True, check=True, timeout=30)
    if result.stderr:
        print(result.stderr, end="", file=sys.stderr)
    return json.loads(result.stdout)["benchmarks"]["zsoft-l1"]["kernelAccel"]


def cli(args, output, label, command, timeout):
    stdout = output / (label + ".stdout.json")
    stderr = output / (label + ".stderr.log")
    started = time.monotonic()
    with stdout.open("w") as out, stderr.open("w") as err:
        result = subprocess.run([args.binary, *command], cwd=args.bench_root,
                                stdout=out, stderr=err, timeout=timeout,
                                env={**os.environ, "ZSOFT_KERNEL_ACCEL": args.kernel_accel})
    metadata = {"exit_code": result.returncode, "elapsed_seconds": round(time.monotonic() - started, 2),
                "stdout": str(stdout), "stderr": str(stderr)}
    return metadata


def public_files(root):
    files = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("public bundles must not contain symlinks: " + str(path))
        if path.is_file():
            files[path.relative_to(root).as_posix()] = sha256(path)
    return files


def inventory(args, output):
    rows = []
    for manifest_path in sorted((args.bench_root / "tasks").glob("*/task.json")):
        manifest = json.loads(manifest_path.read_text())
        task_id = manifest["task_id"]
        if task_id != manifest_path.parent.name or not re.fullmatch(r"[a-z0-9]+(?:[._-][a-z0-9]+)*", task_id):
            raise ValueError("invalid task identity: " + task_id)
        task_root = manifest_path.parent
        source_path = task_root / "private/source-manifest.json"
        source = json.loads(source_path.read_text()) if source_path.is_file() else {}
        source_id = source.get("source_id")
        lock = args.bench_root / "source-locks" / (str(source_id) + ".json")
        row = {"task_id": task_id, "sample": task_id.startswith("sample-"),
               "profile": "kernel" if "kernel" in manifest.get("tags", []) else "userspace",
               "manifest_sha256": sha256(manifest_path), "source_id": source_id,
               "source_lock_sha256": sha256(lock) if source_id else None,
               "submission": manifest["submission"], "evaluator": manifest["evaluator"],
               "oracle": manifest["oracle"], "prepare": manifest.get("prepare"),
               "subjects": manifest["subjects"], "public_files": public_files(task_root / "public"),
               "controls": {name: sha256(task_root / "private" / (name + "-poc"))
                            for name in ("reference", "negative") if (task_root / "private" / (name + "-poc")).is_file()}}
        if not row["sample"]:
            bundle = output / "public" / task_id
            result = cli(args, output, "export-" + task_id,
                         ["export", task_id, str(bundle), "--server-url", "http://127.0.0.1:8666",
                          "--tasks-dir", str(args.bench_root / "tasks")], 30)
            if result["exit_code"]:
                raise ValueError("public export failed: " + task_id)
            exported = public_files(bundle)
            if set(exported) != set(row["public_files"]) | {"submit.sh"}:
                raise ValueError("unexpected files in public export: " + task_id)
            if any(exported[name] != digest for name, digest in row["public_files"].items() if name != "submit.sh"):
                raise ValueError("public export content mismatch: " + task_id)
            row["public_export_verified"] = True
        rows.append(row)
    formal = [row for row in rows if not row["sample"]]
    if len(formal) != 30 or any(len(row["controls"]) != 2 for row in formal):
        raise ValueError("expected 30 formal tasks, each with reference and negative controls")
    report = {"schema_version": 1, "framework_revision": args.framework_revision,
              "formal_count": len(formal), "sample_count": len(rows) - len(formal),
              "profiles": dict(collections.Counter(row["profile"] for row in formal)),
              "public_exports_verified": len(formal), "tasks": rows}
    write_json(output / "inventory.json", report)
    return rows


def resources():
    result = {}
    for kind, command in (("containers", ["docker", "ps", "-aq", "--filter", "label=com.docker.compose.project"]),
                          ("networks", ["docker", "network", "ls", "-q", "--filter", "label=com.docker.compose.project"])):
        value = subprocess.run(command, capture_output=True, text=True, check=True)
        result[kind] = set(value.stdout.split())
    return result


def verify_task(args, output, row):
    task_id = row["task_id"]
    state = args.state_dir
    runs = output / "runs"
    item = {"task_id": task_id, "status": "running", "controls": {}}
    before = resources()
    try:
        if args.prepare:
            prepared = cli(args, output, task_id + "-prepare",
                           ["prepare", task_id, "--tasks-dir", str(args.bench_root / "tasks"),
                            "--state-dir", str(state)], (row.get("prepare") or {}).get("timeout_seconds", 600) + 60)
            item["prepare"] = prepared
            if prepared["exit_code"]:
                raise ValueError("prepare failed; inspect state/" + task_id + "/prepare.stderr.log")
        refs_path = state / task_id / "image-refs.json"
        refs = json.loads(refs_path.read_text()) if refs_path.is_file() else {}
        item["image_refs"] = refs
        item["image_ids"] = {}
        item["assets"] = {}
        for role, value in refs.items():
            if role.endswith("image"):
                result = subprocess.run(["docker", "image", "inspect", value, "--format", "{{.Id}}"],
                                        capture_output=True, text=True, check=True)
                item["image_ids"][role] = result.stdout.strip()
            elif role.endswith("artifact_dir"):
                path = Path(value)
                if not path.is_absolute():
                    path = args.bench_root / path
                item["assets"][role] = public_files(path)
        for control, expected in (("reference", True), ("negative", False)):
            label = task_id + "-" + control
            result = cli(args, output, label,
                         ["evaluate", task_id, str(args.bench_root / "tasks" / task_id / "private" / (control + "-poc")),
                          "--phase", "p1_" + control, "--submission-kind", "final",
                          "--tasks-dir", str(args.bench_root / "tasks"), "--state-dir", str(state),
                          "--runs-dir", str(runs)], row["evaluator"]["timeout_seconds"] + row["evaluator"]["cleanup_timeout_seconds"] + 90)
            record = json.loads(Path(result["stdout"]).read_text())
            verdict = record["result"]
            result.update({"attempt_id": record["attempt_id"], "submission_kind": record.get("submission_kind"),
                           "status": verdict["status"], "success": verdict["success"], "summary": verdict["summary"]})
            result["passed"] = (result["exit_code"] == (0 if expected else 1)
                                and verdict["status"] == "completed" and verdict["success"] is expected
                                and record.get("submission_kind") == "final")
            item["controls"][control] = result
            if not result["passed"]:
                raise ValueError(control + " did not produce the expected completed verdict")
        item["status"] = "passed"
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        item.update(status="failed", error=str(error))
    after = resources()
    item["new_compose_resources"] = {kind: sorted(after[kind] - before[kind]) for kind in before}
    if any(item["new_compose_resources"].values()):
        item.update(status="failed", error="new Compose resources remain; inspect their ownership before cleanup")
    return item


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bench-root", required=True, type=Path)
    parser.add_argument("--binary", required=True)
    parser.add_argument("--framework-revision", required=True)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--state-dir", type=Path)
    parser.add_argument("--task", action="append", default=[])
    parser.add_argument("--prepare", action="store_true")
    args = parser.parse_args()
    args.bench_root = args.bench_root.resolve()
    args.output_dir = args.output_dir.resolve()
    args.state_dir = (args.state_dir or args.bench_root / ".task-state").resolve()
    if not re.fullmatch(r"[0-9a-f]{40}", args.framework_revision):
        parser.error("--framework-revision must be a full commit hash")
    try:
        args.kernel_accel = configured_kernel_acceleration()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        detail = error.stderr.strip() if isinstance(error, subprocess.CalledProcessError) else str(error)
        parser.error("无法读取 ZSoft YAML 评测配置（需要 Node.js）：" + detail)
    args.output_dir.mkdir(parents=True, exist_ok=False)
    rows = inventory(args, args.output_dir)
    by_id = {row["task_id"]: row for row in rows}
    if any(task_id not in by_id for task_id in args.task):
        parser.error("unknown task ID")
    report = {"schema_version": 1, "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "framework_revision": args.framework_revision, "backend": "local-docker",
              "e2b_used": False, "kernel_accel": args.kernel_accel,
              "p0_inventory_passed": True, "tasks": [], "passed": not args.task}
    write_json(args.output_dir / "summary.json", report)
    for task_id in args.task:
        print(json.dumps({"event": "task_started", "task_id": task_id}), flush=True)
        item = verify_task(args, args.output_dir, by_id[task_id])
        report["tasks"].append(item)
        report["passed"] = len(report["tasks"]) == len(args.task) and all(task["status"] == "passed" for task in report["tasks"])
        write_json(args.output_dir / "summary.json", report)
        print(json.dumps({"event": "task_finished", "task_id": task_id, "status": item["status"],
                          "error": item.get("error")}), flush=True)
    report["completed_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    write_json(args.output_dir / "summary.json", report)
    print(json.dumps({"passed": report["passed"], "report": str(args.output_dir / "summary.json")}), flush=True)
    return 0 if report["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
