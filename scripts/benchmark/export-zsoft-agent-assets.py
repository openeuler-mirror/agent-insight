#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "benchmarks/zsoft-l1/evaluator"))
from assets import userspace_tags

HASH = re.compile(r"^sha256:[0-9a-f]{64}$")
TASK_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
PRIVATE_NAMES = {"reference-poc", "negative-poc", "vulnerable.fix.patch", "source-manifest.json", "prepare.context.json", "evaluation.context.json", "image-refs.json", "submit.sh"}
PRIVATE_DIRS = {"private", "judge", ".task-state", ".runs", ".cache", ".work", ".git", ".hg", ".svn", "logs", "__pycache__"}
MAX_BYTES = 512 * 1024 * 1024
MAX_FILES = 100000


def digest(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()


def public_files(public_root: Path) -> dict[str, bytes]:
    if public_root.is_symlink() or not public_root.is_dir():
        raise ValueError("public task directory missing or symlinked")
    files = {}
    total = 0
    for file in sorted(public_root.rglob("*")):
        relative = file.relative_to(public_root)
        if file.is_symlink():
            raise ValueError("symlinks are forbidden in public task assets")
        if not re.fullmatch(r"[A-Za-z0-9._/-]+", relative.as_posix()):
            raise ValueError("public asset paths must use ASCII letters, digits, dot, dash, slash or underscore")
        if relative.parts[0] in PRIVATE_DIRS or any(part in {".git", ".hg", ".svn"} for part in relative.parts) or file.name in PRIVATE_NAMES or file.suffix.lower() in {".pyc", ".pyo", ".pyd"}:
            raise ValueError("judge-private or VCS material found in public task assets")
        if file.is_dir():
            continue
        if not file.is_file():
            raise ValueError("special files are forbidden")
        total += file.stat().st_size
        if total > MAX_BYTES or len(files) >= MAX_FILES:
            raise ValueError("public task assets exceed the size or file count limit")
        files[relative.as_posix()] = file.read_bytes()
    if "README.md" not in files:
        raise ValueError("public README.md is required")
    return files


def export(dataset: Path, tasks_dir: Path, output_dir: Path, output_dataset: Path) -> None:
    cases = json.loads(dataset.read_text(encoding="utf-8"))
    if not isinstance(cases, list) or not cases or output_dataset.exists() or not output_dataset.parent.is_dir():
        raise ValueError("expected a P2 JSON case array and a new output dataset file")
    if output_dir.is_relative_to(tasks_dir) or tasks_dir.is_relative_to(output_dir):
        raise ValueError("agent assets must be stored separately from the official tasks")
    seen = set()
    for case in cases:
        public = case["public"]
        task_id = public["taskId"]
        if not TASK_ID.fullmatch(task_id) or task_id in seen or "userspace" not in public["tags"] or "kernel" in public["tags"]:
            raise ValueError("expected unique userspace task IDs")
        seen.add(task_id)
        task_root = tasks_dir / task_id
        if task_root.is_symlink() or not task_root.is_dir() or (task_root / "task.json").is_symlink():
            raise ValueError("official task directory is missing or symlinked")
        raw = json.loads((task_root / "task.json").read_text())
        if (raw["task_id"], raw["title"], raw["description"], userspace_tags(raw), raw["submission"]["max_bytes"]) != (task_id, public["title"], public["description"], public["tags"], public["maxBytes"]):
            raise ValueError("dataset metadata differs from the official public task")
        content = {f"tasks/{task_id}/public/{name}": value for name, value in public_files(task_root / "public").items()}
        # Keep only the metadata read by the executor plugin; judge entrypoints stay on the evaluator.
        metadata = {"task_id": task_id, "title": public["title"], "description": public["description"], "tags": public["tags"], "submission_kind": public["submissionKind"], "max_bytes": public["maxBytes"]}
        content[f"tasks/{task_id}/task.json"] = canonical(metadata)
        lock = {"schemaVersion": "public-bundle/v1", "taskId": task_id, "files": {name: {"sha256": digest(value), "sizeBytes": len(value), "executable": False} for name, value in content.items()}}
        if sum(len(value) for value in content.values()) > MAX_BYTES or len(content) > MAX_FILES:
            raise ValueError("public task bundle exceeds limits")
        bundle_digest = digest(canonical(lock))
        target = output_dir / bundle_digest[7:]
        if target.exists():
            raise ValueError("immutable bundle already exists; use a fresh export directory")
        target.mkdir(parents=True, mode=0o700)
        for name, value in content.items():
            file = target / name
            file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with file.open("xb") as stream:
                stream.write(value)
            file.chmod(0o444)
        with (target / "bundle.json").open("xb") as stream:
            stream.write(canonical(lock))
        (target / "bundle.json").chmod(0o444)
        public["agentBundle"] = {"digest": bundle_digest}
    with output_dataset.open("x", encoding="utf-8") as stream:
        json.dump(cases, stream, ensure_ascii=False, indent=2)


def main() -> None:
    parser = argparse.ArgumentParser(description="Export public-only ZSoft executor bundles; never builds or executes tasks")
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--tasks-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--output-dataset", type=Path, required=True)
    args = parser.parse_args()
    export(args.dataset.resolve(), args.tasks_dir.resolve(), args.output_dir.resolve(), args.output_dataset.resolve())


if __name__ == "__main__":
    main()
