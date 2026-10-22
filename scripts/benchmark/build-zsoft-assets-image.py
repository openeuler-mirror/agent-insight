#!/usr/bin/env python3
"""Build an immutable ZSoft asset image from a frozen asset snapshot."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "benchmarks/zsoft-l1/evaluator"))
from assets import AssetError, load_inventory, verify_task  # noqa: E402


RELEASE_SCHEMA = "zsoft-release/v1"
RELEASE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
REPOSITORY = re.compile(r"^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?(?:/[a-z0-9._-]+)+$")


def validate_release_id(value: str) -> str:
    if not RELEASE_ID.fullmatch(value):
        raise AssetError("invalid release id")
    return value


def validate_repository(value: str) -> str:
    if not REPOSITORY.fullmatch(value):
        raise AssetError("invalid image repository")
    return value


def _copy_file(root: Path, context: Path, relative: str) -> None:
    source = root / relative
    target = context / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def build_context(root: Path, context: Path, release_id: str) -> dict:
    """Validate and copy only files covered by the frozen inventory."""
    inventory = load_inventory(root)
    task_ids = sorted(inventory["tasks"])
    for task_id in task_ids:
        verify_task(root, inventory, task_id)

    files = set(inventory["frameworkFiles"])
    for task in inventory["tasks"].values():
        files.update(task["files"])
        files.update(task["stateFiles"])
    if any(not name or name.startswith("/") or "\\" in name for name in files):
        raise AssetError("invalid frozen asset path")

    context.mkdir(parents=True, exist_ok=False)
    _copy_file(root, context, "agent-insight-assets.json")
    for relative in sorted(files):
        _copy_file(root, context, relative)
    metadata = {
        "schemaVersion": RELEASE_SCHEMA,
        "releaseId": release_id,
        "assetSchema": inventory["schemaVersion"],
        "revision": inventory["revision"],
        "bundleDigest": inventory["bundleDigest"],
        "taskCount": len(task_ids),
        "taskIds": task_ids,
    }
    (context / "zsoft-release.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (context / "Dockerfile").write_text(
        "FROM scratch\n"
        "ARG RELEASE_ID\n"
        "ARG BUNDLE_DIGEST\n"
        "LABEL org.opencontainers.image.title=agent-insight-zsoft-l1-assets \\\n"
        "      agent-insight.zsoft.release-id=\"${RELEASE_ID}\" \\\n"
        "      agent-insight.zsoft.bundle-digest=\"${BUNDLE_DIGEST}\"\n"
        "COPY . /opt/agent-insight/zsoft-l1/${RELEASE_ID}/\n",
        encoding="utf-8",
    )
    return metadata


def run(command: list[str], *, capture: bool = False) -> str:
    result = subprocess.run(
        command,
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
    )
    return result.stdout.strip() if capture else ""


def build_image(root: Path, repository: str, release_id: str, tag: str | None, push: bool) -> dict:
    validate_repository(repository)
    validate_release_id(release_id)
    tag = tag or release_id
    if not RELEASE_ID.fullmatch(tag):
        raise AssetError("invalid image tag")
    image = f"{repository}:{tag}"
    with tempfile.TemporaryDirectory(prefix="zsoft-assets-image-") as temporary:
        context = Path(temporary) / "context"
        metadata = build_context(root, context, release_id)
        run([
            "docker", "build", "--platform", "linux/amd64",
            "--build-arg", f"RELEASE_ID={release_id}",
            "--build-arg", f"BUNDLE_DIGEST={metadata['bundleDigest']}",
            "--tag", image, str(context),
        ])
        image_id = run(["docker", "image", "inspect", image, "--format", "{{.Id}}"], capture=True)
        result = {"image": image, "imageId": image_id, **metadata}
        if push:
            run(["docker", "push", image])
            digests = run(["docker", "image", "inspect", image, "--format", "{{json .RepoDigests}}"], capture=True)
            result["repoDigests"] = json.loads(digests or "[]")
        return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Build an immutable ZSoft evaluator asset image from a frozen snapshot")
    parser.add_argument("--root", type=Path, required=True, help="frozen asset snapshot containing agent-insight-assets.json")
    parser.add_argument("--repository", required=True, help="registry/namespace/repository without tag")
    parser.add_argument("--release", required=True, help="immutable release identifier")
    parser.add_argument("--tag", help="image tag; defaults to --release")
    parser.add_argument("--push", action="store_true", help="push the built image after validation")
    args = parser.parse_args()
    try:
        result = build_image(args.root.resolve(), args.repository, args.release, args.tag, args.push)
    except (AssetError, OSError, subprocess.CalledProcessError) as error:
        parser.error(str(error))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
