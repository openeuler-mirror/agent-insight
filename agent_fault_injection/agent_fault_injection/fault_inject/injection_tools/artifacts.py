"""Artifact snapshots for structural injections."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_optional_bytes(path: Path) -> bytes | None:
    if not path.exists():
        return None
    if path.is_dir():
        return None
    return path.read_bytes()


def write_snapshot(
    artifacts_dir: Path,
    *,
    label: str,
    relative_path: str,
    data: bytes | None,
) -> Path:
    injection_dir = artifacts_dir / "injection"
    injection_dir.mkdir(parents=True, exist_ok=True)
    safe_label = label.replace("/", "_")
    target = injection_dir / f"{safe_label}.bin"
    meta = injection_dir / f"{safe_label}.txt"
    if data is None:
        target.write_bytes(b"")
        meta.write_text(
            f"path={relative_path}\nmissing=true\nsha256=\n",
            encoding="utf-8",
        )
    else:
        target.write_bytes(data)
        meta.write_text(
            f"path={relative_path}\nmissing=false\nsha256={sha256_bytes(data)}\n",
            encoding="utf-8",
        )
    return target


def write_text_snapshot(
    artifacts_dir: Path,
    *,
    label: str,
    relative_path: str,
    text: str | None,
) -> Path:
    injection_dir = artifacts_dir / "injection"
    injection_dir.mkdir(parents=True, exist_ok=True)
    safe_label = label.replace("/", "_")
    target = injection_dir / f"{safe_label}.md"
    if text is None:
        target.write_text("", encoding="utf-8")
        (injection_dir / f"{safe_label}.meta.txt").write_text(
            f"path={relative_path}\nmissing=true\n",
            encoding="utf-8",
        )
    else:
        target.write_text(text, encoding="utf-8")
        (injection_dir / f"{safe_label}.meta.txt").write_text(
            f"path={relative_path}\nmissing=false\n"
            f"sha256={sha256_bytes(text.encode('utf-8'))}\n",
            encoding="utf-8",
        )
    return target


def write_diff(
    artifacts_dir: Path,
    *,
    before: str | None,
    after: str | None,
    name: str = "memory-diff.txt",
) -> Path:
    import difflib

    injection_dir = artifacts_dir / "injection"
    injection_dir.mkdir(parents=True, exist_ok=True)
    before_lines = (before or "").splitlines(keepends=True)
    after_lines = (after or "").splitlines(keepends=True)
    diff = "".join(
        difflib.unified_diff(
            before_lines,
            after_lines,
            fromfile="before",
            tofile="after",
        )
    )
    target = injection_dir / name
    target.write_text(diff, encoding="utf-8")
    return target


def snapshot_info(path: Path, data: bytes | None) -> dict[str, Any]:
    return {
        "path": str(path),
        "exists": data is not None,
        "sha256": sha256_bytes(data) if data is not None else None,
        "size": len(data) if data is not None else 0,
    }
