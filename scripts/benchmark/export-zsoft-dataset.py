#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "benchmarks/zsoft-l1/evaluator"))
from assets import AssetError, SCHEMA, TASK_ID, digest_bytes, fingerprint, safe_file, task_identity, tree_files


def export(root: Path, revision: str, task_ids: list[str], output: Path) -> None:
    if output.exists() or not output.parent.is_dir() or output.is_relative_to(root / "src") or output.is_relative_to(root / "tasks") or output == root / "agent-insight-assets.json":
        raise AssetError("output must be a new dataset file outside the source/task trees")
    if not re.fullmatch(r"[0-9a-f]{40}", revision) or not task_ids or len(set(task_ids)) != len(task_ids):
        raise AssetError("revision must be a full commit and task IDs must be unique")
    inventory = {"schemaVersion": SCHEMA, "revision": revision, "frameworkFiles": tree_files(root, "src"), "tasks": {}}
    for task_id in task_ids:
        if not TASK_ID.fullmatch(task_id):
            raise AssetError("invalid task ID")
        manifest = json.loads(safe_file(root, f"tasks/{task_id}/task.json").read_text())
        tags = manifest.get("tags", [])
        if "userspace" not in tags or "kernel" in tags:
            raise AssetError("P2 exports prepared userspace tasks only")
        max_bytes = manifest["submission"]["max_bytes"]
        if not isinstance(max_bytes, int) or not 0 < max_bytes <= 1048576:
            raise AssetError("unsupported submission size")
        state_relative = f".task-state/{task_id}/image-refs.json"
        refs = json.loads(safe_file(root, state_relative).read_text())
        if not isinstance(refs, dict) or not refs or not all(isinstance(tag, str) and tag and not tag.startswith("-") for tag in refs.values()):
            raise AssetError("invalid prepared image refs")
        images = {}
        for tag in refs.values():
            inspected = subprocess.run(["docker", "image", "inspect", tag, "--format", "{{.Id}}"], capture_output=True, text=True, check=True, timeout=30)
            image_id = inspected.stdout.strip()
            if not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
                raise AssetError("invalid local image digest")
            images[tag] = image_id
        task = {
            "public": {"taskId": task_id, "title": manifest["title"], "description": manifest["description"], "submissionKind": "python" if "python" in tags else "c" if "c" in tags else "binary", "maxBytes": max_bytes, "tags": tags},
            "files": tree_files(root, f"tasks/{task_id}"),
            "stateFiles": {state_relative: digest_bytes(safe_file(root, state_relative).read_bytes())},
            "images": images,
        }
        task["taskDigest"] = fingerprint(task_identity(task))
        inventory["tasks"][task_id] = task
    inventory["bundleDigest"] = fingerprint(inventory)
    cases = [{"public": task["public"], "private": {"revision": revision, "bundleDigest": inventory["bundleDigest"], "taskDigest": task["taskDigest"]}} for task in inventory["tasks"].values()]
    lock_path = root / "agent-insight-assets.json"
    if lock_path.exists() and json.loads(lock_path.read_text()) != inventory:
        raise AssetError("asset inventory already exists with different contents; use a separate immutable snapshot")
    if not lock_path.exists():
        with lock_path.open("x", encoding="utf-8") as stream:
            json.dump(inventory, stream, ensure_ascii=False, indent=2)
    with output.open("x", encoding="utf-8") as stream:
        json.dump(cases, stream, ensure_ascii=False, indent=2)


def main() -> None:
    parser = argparse.ArgumentParser(description="Export prepared ZSoft userspace metadata; never builds images or runs a PoC")
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--task", action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    export(args.root.resolve(), args.revision, args.task, args.output.resolve())


if __name__ == "__main__":
    main()
