from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

SCHEMA = "zsoft-assets/v1"
HASH = re.compile(r"^sha256:[0-9a-f]{64}$")
TASK_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class AssetError(RuntimeError):
    pass


def digest_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


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
            result[relative] = digest_bytes(safe_file(root, relative).read_bytes())
    if not result:
        raise AssetError("ZSOFT_ASSET_MISSING")
    return result


def verify_files(root: Path, files: dict[str, str]) -> None:
    if not isinstance(files, dict) or not files:
        raise AssetError("ZSOFT_ASSET_LOCK_INVALID")
    for name, digest in files.items():
        if not isinstance(digest, str) or not HASH.fullmatch(digest) or digest_bytes(safe_file(root, name).read_bytes()) != digest:
            raise AssetError("ZSOFT_ASSET_DIGEST_MISMATCH")


def task_identity(task: dict) -> dict:
    return {key: task[key] for key in ("public", "files", "stateFiles", "images")}


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
    if task.get("taskDigest") != fingerprint(task_identity(task)) or task.get("public", {}).get("taskId") != task_id:
        raise AssetError("ZSOFT_TASK_LOCK_INVALID")
    if "kernel" in task["public"]["tags"] or "userspace" not in task["public"]["tags"]:
        raise AssetError("ZSOFT_P2_USERSPACE_ONLY")
    verify_files(root, inventory["frameworkFiles"])
    if tree_files(root, "src") != inventory["frameworkFiles"]:
        raise AssetError("ZSOFT_FRAMEWORK_CHANGED")
    verify_files(root, task["files"])
    if tree_files(root, f"tasks/{task_id}") != task["files"]:
        raise AssetError("ZSOFT_TASK_CHANGED")
    verify_files(root, task["stateFiles"])
    if not task.get("images") or any(not HASH.fullmatch(str(image)) for image in task["images"].values()):
        raise AssetError("ZSOFT_IMAGES_NOT_PINNED")
    return task
