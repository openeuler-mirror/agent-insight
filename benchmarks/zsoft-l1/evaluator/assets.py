from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

SCHEMA = "zsoft-assets/v1"
HASH = re.compile(r"^sha256:[0-9a-f]{64}$")
TASK_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
REGISTRY_IMAGE = re.compile(r"^[a-z0-9][a-z0-9.:-]*/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$")


class AssetError(RuntimeError):
    pass


def digest_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def digest_file(file: Path) -> str:
    value = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return "sha256:" + value.hexdigest()


def fingerprint(value: object) -> str:
    return digest_bytes(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode())


def safe_file(root: Path, relative: str) -> Path:
    if not isinstance(relative, str) or not relative or "\\" in relative:
        raise AssetError("ZSOFT_ASSET_PATH_INVALID")
    parts = Path(relative).parts
    if Path(relative).is_absolute() or any(part in (".", "..") for part in parts):
        raise AssetError("ZSOFT_ASSET_PATH_INVALID")
    current = root
    for part in parts:
        current = current / part
        if current.is_symlink():
            raise AssetError("ZSOFT_ASSET_SYMLINK_FORBIDDEN")
    if not current.is_file() or not current.resolve().is_relative_to(root.resolve()):
        raise AssetError("ZSOFT_ASSET_MISSING")
    return current


def tree_files(root: Path, directory: str) -> dict[str, str]:
    base = root / directory
    if not base.is_dir() or base.is_symlink():
        raise AssetError("ZSOFT_ASSET_MISSING")
    result = {}
    for item in sorted(base.rglob("*")):
        if item.is_symlink():
            raise AssetError("ZSOFT_ASSET_SYMLINK_FORBIDDEN")
        if item.is_file():
            relative = item.relative_to(root).as_posix()
            result[relative] = digest_file(safe_file(root, relative))
    if not result:
        raise AssetError("ZSOFT_ASSET_MISSING")
    return result


def verify_files(root: Path, files: dict[str, str]) -> None:
    if not isinstance(files, dict) or not files:
        raise AssetError("ZSOFT_ASSET_LOCK_INVALID")
    for name, digest in files.items():
        if not isinstance(digest, str) or not HASH.fullmatch(digest) or digest_file(safe_file(root, name)) != digest:
            raise AssetError("ZSOFT_ASSET_DIGEST_MISMATCH")


def source_task_digest(root: Path, task_id: str) -> str:
    manifest = json.loads(safe_file(root, f"tasks/{task_id}/task.json").read_text())
    return fingerprint({"manifest": manifest, "publicFiles": tree_files(root, f"tasks/{task_id}/public")})


def task_identity(task: dict) -> dict:
    identity = {key: task[key] for key in ("public", "files", "stateFiles", "images", "sourceTaskDigest")}
    if "registryImages" in task:
        identity["registryImages"] = task["registryImages"]
    return identity


def task_tags(manifest: dict) -> list[str]:
    tags = list(manifest.get("tags", []))
    track = "kernel" if "kernel" in tags or str(manifest.get("task_id", "")).startswith("linux-rxrpc-") else "userspace"
    if ("userspace" if track == "kernel" else "kernel") in tags:
        raise AssetError("ZSOFT_TASK_TRACK_INVALID")
    if track not in tags:
        tags.append(track)
    return tags


def userspace_tags(manifest: dict) -> list[str]:
    tags = task_tags(manifest)
    if "kernel" in tags:
        raise AssetError("ZSOFT_USERSPACE_ONLY")
    return tags


def select_tasks(root: Path, task_ids: list[str], track: str | None = None) -> list[str]:
    if track is not None:
        task_ids = []
        for manifest_path in sorted((root / "tasks").glob("*/task.json")):
            task_id = manifest_path.parent.name
            manifest = json.loads(safe_file(root, f"tasks/{task_id}/task.json").read_text())
            if task_id.startswith("sample-") or (track != "all" and track not in task_tags(manifest)):
                continue
            task_ids.append(task_id)
    if not task_ids or len(task_ids) != len(set(task_ids)):
        raise AssetError("select unique formal tasks")
    for task_id in task_ids:
        if not TASK_ID.fullmatch(task_id) or task_id.startswith("sample-"):
            raise AssetError("invalid formal task ID")
        manifest = json.loads(safe_file(root, f"tasks/{task_id}/task.json").read_text())
        if manifest.get("task_id") != task_id:
            raise AssetError("task ID differs from manifest")
        task_tags(manifest)
    return task_ids


def select_userspace_tasks(root: Path, task_ids: list[str], all_userspace: bool) -> list[str]:
    selected = select_tasks(root, task_ids, "userspace" if all_userspace else None)
    for task_id in selected:
        userspace_tags(json.loads(safe_file(root, f"tasks/{task_id}/task.json").read_text()))
    return selected


def prepared_assets(root: Path, task_id: str, tags: list[str]) -> tuple[dict[str, str], dict[str, str]]:
    relative = f".task-state/{task_id}/image-refs.json"
    refs = json.loads(safe_file(root, relative).read_text())
    if not isinstance(refs, dict) or not refs:
        raise AssetError("ZSOFT_PREPARED_REFS_INVALID")
    images = {role: ref for role, ref in refs.items() if role.endswith("_image")}
    if not images or any(not isinstance(ref, str) or not ref or ref.startswith("-") for ref in images.values()):
        raise AssetError("ZSOFT_PREPARED_REFS_INVALID")
    files = {relative: digest_file(safe_file(root, relative))}
    if "kernel" in tags:
        if set(refs) != {"runner_image", "vuln_artifact_dir", "fix_artifact_dir"}:
            raise AssetError("ZSOFT_KERNEL_ARTIFACTS_INVALID")
        for variant in ("vuln", "fix"):
            directory = refs[f"{variant}_artifact_dir"]
            if directory != f".task-state/{task_id}/{variant}/artifacts":
                raise AssetError("ZSOFT_KERNEL_ARTIFACTS_INVALID")
            safe_file(root, f"{directory}/bzImage")
            metadata = json.loads(safe_file(root, f"{directory}/metadata.json").read_text())
            if any(type(metadata.get(key)) is not int or metadata[key] < 1 for key in ("memory_mb", "smp")):
                raise AssetError("ZSOFT_KERNEL_METADATA_INVALID")
            files.update(tree_files(root, directory))
    elif set(images) != set(refs):
        raise AssetError("ZSOFT_PREPARED_REFS_INVALID")
    return images, files


def verify_registry_images(task: dict) -> None:
    if "registryImages" not in task:
        return
    refs = task["registryImages"]
    if not isinstance(refs, dict) or set(refs) != set(task["images"]):
        raise AssetError("ZSOFT_REGISTRY_IMAGES_INVALID")
    for ref in refs.values():
        if not isinstance(ref, str) or not REGISTRY_IMAGE.fullmatch(ref):
            raise AssetError("ZSOFT_REGISTRY_IMAGES_INVALID")


def load_inventory(root: Path) -> dict:
    inventory = json.loads(safe_file(root, "agent-insight-assets.json").read_text())
    if inventory.get("schemaVersion") != SCHEMA or not re.fullmatch(r"[0-9a-f]{40}", str(inventory.get("revision", ""))):
        raise AssetError("ZSOFT_ASSET_LOCK_INVALID")
    content = {key: value for key, value in inventory.items() if key != "bundleDigest"}
    if inventory.get("bundleDigest") != fingerprint(content) or not inventory.get("tasks"):
        raise AssetError("ZSOFT_ASSET_LOCK_INVALID")
    return inventory


def verify_task(root: Path, inventory: dict, task_id: str) -> dict:
    if not TASK_ID.fullmatch(task_id) or task_id not in inventory["tasks"]:
        raise AssetError("ZSOFT_TASK_NOT_INSTALLED")
    task = inventory["tasks"][task_id]
    if not HASH.fullmatch(str(task.get("sourceTaskDigest", ""))):
        raise AssetError("ZSOFT_TASK_LOCK_INVALID")
    if task.get("taskDigest") != fingerprint(task_identity(task)) or task.get("public", {}).get("taskId") != task_id:
        raise AssetError("ZSOFT_TASK_LOCK_INVALID")
    manifest = json.loads(safe_file(root, f"tasks/{task_id}/task.json").read_text())
    tags = task_tags(manifest)
    if task["public"]["tags"] != tags or ("kernel" in tags and task["public"]["submissionKind"] != "c"):
        raise AssetError("ZSOFT_TASK_TRACK_INVALID")
    verify_files(root, inventory["frameworkFiles"])
    if tree_files(root, "src") != inventory["frameworkFiles"]:
        raise AssetError("ZSOFT_FRAMEWORK_CHANGED")
    verify_files(root, task["files"])
    if tree_files(root, f"tasks/{task_id}") != task["files"]:
        raise AssetError("ZSOFT_TASK_CHANGED")
    verify_files(root, task["stateFiles"])
    image_refs, state_files = prepared_assets(root, task_id, tags)
    if state_files != task["stateFiles"] or set(image_refs.values()) != set(task["images"]):
        raise AssetError("ZSOFT_PREPARED_REFS_MISMATCH")
    if task.get("sourceTaskDigest") != source_task_digest(root, task_id):
        raise AssetError("ZSOFT_TASK_SOURCE_MISMATCH")
    if not task.get("images") or any(not HASH.fullmatch(str(image)) for image in task["images"].values()):
        raise AssetError("ZSOFT_IMAGES_NOT_PINNED")
    verify_registry_images(task)
    return task
