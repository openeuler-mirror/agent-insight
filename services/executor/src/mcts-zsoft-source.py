from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shlex
import tarfile
from pathlib import Path, PurePosixPath


def download_script(lock) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", lock.source_id):
        raise RuntimeError("ZSOFT_SOURCE_INVALID")
    root = Path(os.environ["AGENT_INSIGHT_ZSOFT_WORKSPACE"])
    metadata = json.loads((root / "source-locks" / f"{lock.source_id}.json").read_text())
    if (metadata["source_id"] != lock.source_id or metadata["kind"] != lock.kind
            or metadata["url"] != lock.url or metadata.get("commit") != lock.commit):
        raise RuntimeError("ZSOFT_SOURCE_INVALID")
    quote = shlex.quote
    parts = ["rm -rf repo repo.dl", "mkdir -p repo.dl"]
    if lock.kind == "archive":
        parts.append(f"curl -fsSL -o repo.dl/source.tar.gz -- {quote(lock.url)}")
        if metadata.get("sha256"):
            checksum = metadata["sha256"]
            if not re.fullmatch(r"[a-f0-9]{64}", checksum):
                raise RuntimeError("ZSOFT_SOURCE_INVALID")
            parts.append(f"printf '%s  %s\\n' {quote(checksum)} repo.dl/source.tar.gz | sha256sum -c -")
        parts += ["tar --no-same-owner --no-same-permissions -xzf repo.dl/source.tar.gz -C repo.dl",
                  'd="$(find repo.dl -mindepth 1 -maxdepth 1 -type d | head -n1)"',
                  '[ -n "$d" ]', 'mv "$d" repo', "rm -rf repo.dl"]
    elif lock.kind == "git_snapshot" and re.fullmatch(r"[a-f0-9]{40}", lock.commit or ""):
        parts += ["git init --quiet repo.dl",
                  f"git -C repo.dl fetch --depth=1 -- {quote(lock.url)} {quote(lock.commit)}",
                  "git -C repo.dl checkout --quiet --detach FETCH_HEAD",
                  f'test "$(git -C repo.dl rev-parse HEAD)" = {quote(lock.commit)}', "mv repo.dl repo"]
    else:
        raise RuntimeError("ZSOFT_SOURCE_INVALID")
    parts.append("echo ZSOFT_REPO_SOURCE=locked")
    return "\n".join(parts)


def validate_agent_bundle(content: bytes, task) -> None:
    root = Path(os.environ["AGENT_INSIGHT_ZSOFT_WORKSPACE"]).resolve() / "tasks"
    if Path(task.tasks_dir).resolve() != root or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", task.task_id):
        raise RuntimeError("ZSOFT_AGENT_BUNDLE_INVALID")
    task_root = root / task.task_id
    public = task_root / "public"
    allowed = {"task.json": task_root / "task.json", "TASK.md": public / "README.md"}
    for file in public.rglob("*"):
        if file.is_symlink() or not (file.is_dir() or file.is_file()):
            raise RuntimeError("ZSOFT_AGENT_BUNDLE_INVALID")
        if file.is_file():
            allowed[f"task/{file.relative_to(public).as_posix()}"] = file
    directories = {str(parent) for name in allowed for parent in PurePosixPath(name).parents}
    seen = set()
    total = 0
    try:
        with tarfile.open(fileobj=io.BytesIO(content), mode="r:gz") as archive:
            for item in archive:
                name = item.name
                if name in seen or name.startswith("/") or ".." in PurePosixPath(name).parts:
                    raise ValueError()
                seen.add(name)
                if len(seen) > 100_000:
                    raise ValueError()
                if item.isdir() and name in directories:
                    continue
                if not item.isfile() or name not in allowed or item.size < 0:
                    raise ValueError()
                total += item.size
                source = allowed[name]
                if total > 512 * 1024 * 1024 or source.is_symlink() or source.stat().st_size != item.size:
                    raise ValueError()
                with source.open("rb") as original:
                    expected = hashlib.file_digest(original, "sha256").digest()
                with archive.extractfile(item) as uploaded:
                    actual = hashlib.file_digest(uploaded, "sha256").digest()
                if actual != expected:
                    raise ValueError()
        if not set(allowed).issubset(seen):
            raise ValueError()
    except (OSError, ValueError, KeyError, tarfile.TarError):
        raise RuntimeError("ZSOFT_AGENT_BUNDLE_INVALID") from None
