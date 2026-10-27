#!/usr/bin/env python3
from __future__ import annotations

import argparse
import io
import json
import tarfile
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "benchmarks/zsoft-l1/evaluator"))
from assets import AssetError, fingerprint, load_inventory, safe_file, verify_task


def pack(root: Path, output: Path, additional_roots: list[Path] | None = None) -> None:
    roots = [root, *(additional_roots or [])]
    inventory = load_inventory(root)
    merged = {**inventory, "tasks": {}}
    files = {}
    for source in roots:
        current = load_inventory(source)
        if current["revision"] != inventory["revision"] or current["frameworkFiles"] != inventory["frameworkFiles"]:
            raise AssetError("ZSOFT_BUNDLE_MISMATCH")
        files.update({name: safe_file(source, name) for name in current["frameworkFiles"]})
        for task_id in current["tasks"]:
            task = verify_task(source, current, task_id)
            if task_id in merged["tasks"] and merged["tasks"][task_id] != task:
                raise AssetError("ZSOFT_TASK_LOCK_INVALID")
            merged["tasks"][task_id] = task
            files.update({name: safe_file(source, name) for name in [*task["files"], *task["stateFiles"]]})
    merged.pop("bundleDigest", None)
    merged["bundleDigest"] = fingerprint(merged)
    encoded = json.dumps(merged, ensure_ascii=False, indent=2).encode()
    with output.open("xb") as stream:
        with tarfile.open(fileobj=stream, mode="w:gz") as archive:
            manifest = tarfile.TarInfo("agent-insight-assets.json")
            manifest.size = len(encoded)
            manifest.mode = 0o600
            archive.addfile(manifest, io.BytesIO(encoded))
            for relative, source in sorted(files.items()):
                archive.add(source, arcname=relative, recursive=False)


def main() -> None:
    parser = argparse.ArgumentParser(description="Package frozen ZSoft private assets without build caches or Docker images")
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--additional-root", type=Path, action="append", default=[], help="Merge another frozen snapshot from the same official revision/framework")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root, output = args.root.resolve(), args.output.resolve()
    additional_roots = [source.resolve() for source in args.additional_root]
    if any(output.is_relative_to(source) for source in [root, *additional_roots]):
        parser.error("--output must be outside the frozen asset snapshot")
    pack(root, output, additional_roots)


if __name__ == "__main__":
    main()
