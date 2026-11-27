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
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "benchmarks/zsoft-l1/evaluator"))
from assets import AssetError, HASH, REGISTRY_IMAGE, safe_file, select_tasks, task_tags, prepared_assets

SCHEMA = "zsoft-registry-images/v1"


def run(args: list[str], *, root: Path | None = None, capture: bool = False) -> str:
    environment = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    if root:
        environment["PYTHONPATH"] = str(root / "src")
    result = subprocess.run(args, cwd=root, env=environment, check=True,
                            stdout=subprocess.PIPE if capture else None, text=True)
    return result.stdout.strip() if capture else ""


def publish(root: Path, revision: str, task_ids: list[str], repository: str, output: Path) -> dict:
    mapping = {"schemaVersion": SCHEMA, "revision": revision, "repository": repository, "tasks": {}}
    if output.exists():
        mapping = json.loads(output.read_text())
        if any(mapping.get(key) != value for key, value in (("schemaVersion", SCHEMA), ("revision", revision), ("repository", repository))):
            raise AssetError("existing mapping belongs to another release")
    for task_id in task_ids:
        manifest = json.loads(safe_file(root, f"tasks/{task_id}/task.json").read_text())
        refs, _ = prepared_assets(root, task_id, task_tags(manifest))
        published = {}
        for role, source in sorted(refs.items()):
            if not isinstance(source, str) or not source or source.startswith("-"):
                raise AssetError("invalid prepared image reference")
            image = json.loads(run(["docker", "image", "inspect", source], capture=True))[0]
            image_id = image["Id"]
            if not HASH.fullmatch(image_id) or image.get("Architecture") != "amd64" or image.get("Os") != "linux":
                raise AssetError("only pinned linux/amd64 images can be published")
            role_name = role.removesuffix("_image").replace("_", "-")
            if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,31}", role_name):
                raise AssetError("invalid prepared image role")
            suffix = f"-{role_name}-{image_id[7:23]}"
            target = f"{repository}:{task_id[:128 - len(suffix)]}{suffix}"
            prior = mapping["tasks"].get(task_id, {}).get(source)
            if prior and prior.get("imageId") == image_id and REGISTRY_IMAGE.fullmatch(prior.get("reference", "")) and prior["reference"].startswith(repository + "@"):
                pinned = prior["reference"]
            else:
                run(["docker", "tag", source, target])
                run(["docker", "push", target])
                pushed = json.loads(run(["docker", "image", "inspect", target], capture=True))[0]
                digests = [ref for ref in pushed.get("RepoDigests", []) if ref.startswith(repository + "@") and REGISTRY_IMAGE.fullmatch(ref)]
                if len(digests) != 1:
                    raise AssetError("push did not return a unique registry digest")
                pinned = digests[0]
            manifest = json.loads(run(["docker", "manifest", "inspect", pinned], capture=True))
            if manifest.get("config", {}).get("digest") != image_id:
                raise AssetError("published image config differs from the prepared image")
            published[source] = {"imageId": image_id, "reference": pinned, "role": role, "tag": target}
            mapping["tasks"].setdefault(task_id, {})[source] = published[source]
            temporary = output.with_name(output.name + ".tmp")
            temporary.write_text(json.dumps(mapping, ensure_ascii=False, indent=2) + "\n")
            temporary.chmod(0o600)
            temporary.replace(output)
        mapping["tasks"][task_id] = published
        temporary = output.with_name(output.name + ".tmp")
        temporary.write_text(json.dumps(mapping, ensure_ascii=False, indent=2) + "\n")
        temporary.chmod(0o600)
        temporary.replace(output)
    return mapping


def main() -> None:
    parser = argparse.ArgumentParser(description="Plan/build/publish ZSoft userspace/kernel images; never runs PoCs or judges")
    parser.add_argument("action", choices=("plan", "build", "publish"))
    parser.add_argument("--root", type=Path, required=True, help="ZSoft asset snapshot, separate from external source checkout")
    parser.add_argument("--revision", required=True)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("--all-userspace", action="store_true")
    selection.add_argument("--all-kernel", action="store_true")
    selection.add_argument("--all-tasks", action="store_true")
    selection.add_argument("--task", action="append")
    parser.add_argument("--python", default=sys.executable, help="Python with official framework build dependencies")
    parser.add_argument("--repository", help="SWR registry/namespace/repository, without tag")
    parser.add_argument("--output", type=Path, help="Registry mapping JSON; supports resuming a publish")
    args = parser.parse_args()
    root = args.root.resolve()
    if not re.fullmatch(r"[0-9a-f]{40}", args.revision):
        parser.error("--revision must be a full source commit")
    tasks = select_tasks(root, args.task or [], "all" if args.all_tasks else "kernel" if args.all_kernel else "userspace" if args.all_userspace else None)
    if args.action == "plan":
        print(json.dumps({"revision": args.revision, "tasks": tasks, "taskCount": len(tasks)}, ensure_ascii=False, indent=2))
    elif args.action == "build":
        if (root / "agent-insight-assets.json").exists():
            parser.error("asset snapshot is already frozen; build into a new snapshot")
        for task_id in tasks:
            run([args.python, "-m", "zsoft_poc", "fetch-sources", "--task-id", task_id, "--tasks-dir", str(root / "tasks")], root=root)
            run([args.python, "-m", "zsoft_poc", "prepare", task_id, "--tasks-dir", str(root / "tasks"), "--state-dir", str(root / ".task-state")], root=root)
    else:
        if not args.repository or not REGISTRY_IMAGE.fullmatch(args.repository + "@sha256:" + "a" * 64):
            parser.error("--repository must be registry/namespace/repository without tag")
        if not args.output or not args.output.resolve().parent.is_dir() or args.output.resolve().is_relative_to(root / "tasks") or args.output.resolve().is_relative_to(root / "src") or args.output.resolve() == root / "agent-insight-assets.json":
            parser.error("--output must be outside source/task trees, with an existing parent")
        if (root / "agent-insight-assets.json").exists():
            parser.error("publish before freezing the asset snapshot")
        mapping = publish(root, args.revision, tasks, args.repository, args.output.resolve())
        print(json.dumps({"mapping": str(args.output), "taskCount": len(mapping["tasks"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
