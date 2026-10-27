#!/usr/bin/env python3
# Copyright (c) 2026 Huawei Technologies Co., Ltd.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "benchmarks/zsoft-l1/evaluator"))
from assets import AssetError, SCHEMA, TASK_ID, fingerprint, safe_file, select_tasks, source_task_digest, task_identity, tree_files, task_tags, prepared_assets, verify_registry_images


def export(root: Path, revision: str, task_ids: list[str], output: Path, image_mapping: Path | None = None) -> None:
    if output.exists() or not output.parent.is_dir() or output.is_relative_to(root / "src") or output.is_relative_to(root / "tasks") or output == root / "agent-insight-assets.json":
        raise AssetError("output must be a new dataset file outside the source/task trees")
    if not re.fullmatch(r"[0-9a-f]{40}", revision) or not task_ids or len(set(task_ids)) != len(task_ids):
        raise AssetError("revision must be a full commit and task IDs must be unique")
    inventory = {"schemaVersion": SCHEMA, "revision": revision, "frameworkFiles": tree_files(root, "src"), "tasks": {}}
    mapping = json.loads(image_mapping.read_text()) if image_mapping else None
    if mapping is not None and (not isinstance(mapping, dict) or mapping.get("schemaVersion") != "zsoft-registry-images/v1" or mapping.get("revision") != revision or not isinstance(mapping.get("tasks"), dict)):
        raise AssetError("image mapping version/revision mismatch")
    for task_id in task_ids:
        if not TASK_ID.fullmatch(task_id):
            raise AssetError("invalid task ID")
        manifest = json.loads(safe_file(root, f"tasks/{task_id}/task.json").read_text())
        tags = task_tags(manifest)
        max_bytes = manifest["submission"]["max_bytes"]
        if not isinstance(max_bytes, int) or not 0 < max_bytes <= 1048576:
            raise AssetError("unsupported submission size")
        refs, state_files = prepared_assets(root, task_id, tags)
        images = {}
        for tag in refs.values():
            inspected = subprocess.run(["docker", "image", "inspect", tag, "--format", "{{.Id}}"], capture_output=True, text=True, check=True, timeout=30)
            image_id = inspected.stdout.strip()
            if not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
                raise AssetError("invalid local image digest")
            images[tag] = image_id
        task = {
            "sourceTaskDigest": source_task_digest(root, task_id),
            "public": {"taskId": task_id, "title": manifest["title"], "description": manifest["description"], "submissionKind": "c" if "kernel" in tags else "python" if "python" in tags else "c" if "c" in tags else "binary", "maxBytes": max_bytes, "tags": tags},
            "files": tree_files(root, f"tasks/{task_id}"),
            "stateFiles": state_files,
            "images": images,
        }
        if mapping is not None:
            published = mapping.get("tasks", {}).get(task_id, {})
            if not isinstance(published, dict) or set(published) != set(images) or any(not isinstance(published[tag], dict) or published[tag].get("imageId") != image_id for tag, image_id in images.items()):
                raise AssetError("published images differ from prepared images")
            task["registryImages"] = {tag: published[tag]["reference"] for tag in images}
            verify_registry_images(task)
        task["taskDigest"] = fingerprint(task_identity(task))
        inventory["tasks"][task_id] = task
    inventory["bundleDigest"] = fingerprint(inventory)
    cases = [{"public": task["public"], "private": {"revision": revision, "sourceTaskDigest": task["sourceTaskDigest"]}} for task in inventory["tasks"].values()]
    lock_path = root / "agent-insight-assets.json"
    if lock_path.exists() and json.loads(lock_path.read_text()) != inventory:
        raise AssetError("asset inventory already exists with different contents; use a separate immutable snapshot")
    if not lock_path.exists():
        with lock_path.open("x", encoding="utf-8") as stream:
            json.dump(inventory, stream, ensure_ascii=False, indent=2)
    with output.open("x", encoding="utf-8") as stream:
        json.dump(cases, stream, ensure_ascii=False, indent=2)


def main() -> None:
    parser = argparse.ArgumentParser(description="Freeze evaluator assets and export source metadata; never builds images or runs a PoC")
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--revision", required=True)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("--task", action="append")
    selection.add_argument("--all-userspace", action="store_true")
    selection.add_argument("--all-kernel", action="store_true")
    selection.add_argument("--all-tasks", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--image-mapping", type=Path, help="Published SWR mapping with fixed registry digests")
    args = parser.parse_args()
    root = args.root.resolve()
    export(root, args.revision, select_tasks(root, args.task or [], "all" if args.all_tasks else "kernel" if args.all_kernel else "userspace" if args.all_userspace else None), args.output.resolve(), args.image_mapping)


if __name__ == "__main__":
    main()
