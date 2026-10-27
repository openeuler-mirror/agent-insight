from __future__ import annotations

import json
import re
import shutil
import stat
import zipfile
from pathlib import Path

from assets import AssetError

MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 256 * 1024 * 1024
ROOT_FILES = (
    "evaluation.json", "record.json", "evaluator.stdout.log", "evaluator.stderr.log",
    "cleanup.stdout.log", "cleanup.stderr.log",
)
OUTPUT_DIRS = ("judge-evidence", "public-feedback")


def reject_nonfinite(value: str) -> None:
    raise ValueError(value)


def safe_name(name: str) -> bool:
    segments = name.split("/")
    return len(name) <= 512 and len(segments) <= 16 and all(
        re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", segment) for segment in segments
    )


def collect_evidence(work: Path, task_id: str, output: Path) -> tuple[list[dict], dict]:
    files: dict[str, Path] = {}
    errors: list[str] = []
    runs = work / "runs" / task_id
    if runs.is_symlink():
        raise AssetError("ZSOFT_EVIDENCE_INVALID")
    attempts = sorted(runs.iterdir()) if runs.is_dir() else []
    if len(attempts) > 1:
        raise AssetError("ZSOFT_EVIDENCE_INVALID")
    run = attempts[0] if attempts else None

    def add(source: Path, name: str) -> None:
        if not safe_name(name) or not stat.S_ISREG(source.lstat().st_mode) or not source.resolve().is_relative_to(work.resolve()):
            errors.append(f"不安全的证据文件：{name}")
            return
        files[name] = source

    def walk(directory: Path, prefix: str) -> None:
        for source in sorted(directory.iterdir()):
            name = f"{prefix}/{source.name}"
            mode = source.lstat().st_mode
            if stat.S_ISDIR(mode) and safe_name(name):
                walk(source, name)
            else:
                add(source, name)

    if run is not None:
        if run.is_symlink() or not run.is_dir():
            raise AssetError("ZSOFT_EVIDENCE_INVALID")
        for name in ROOT_FILES:
            source = run / name
            if source.exists() or source.is_symlink():
                add(source, name)
        for name in OUTPUT_DIRS:
            source = run / name
            if source.is_symlink():
                errors.append(f"不安全的证据目录：{name}")
            elif source.is_dir():
                walk(source, name)
    if "record.json" not in files and (work / "record.json").is_file():
        add(work / "record.json", "record.json")

    evidence = []
    total = 0
    for name, source in files.items():
        try:
            size = source.stat().st_size
            if size > MAX_FILE_BYTES or total + size > MAX_TOTAL_BYTES or len(evidence) >= 1024:
                errors.append(f"证据超过上传限制，未截断：{name}")
                continue
            target = output / "official" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        except OSError:
            errors.append(f"证据读取或复制失败：{name}")
            continue
        total += size
        media_type = "application/octet-stream"
        if name.endswith(".json"):
            try:
                json.loads(target.read_text(encoding="utf-8"), parse_constant=reject_nonfinite)
                media_type = "application/json"
            except (ValueError, UnicodeError):
                pass
        elif name.endswith((".log", ".stdout", ".stderr", ".txt")):
            media_type = "text/plain"
        kind = "official-report" if name == "evaluation.json" else "official-record" if name == "record.json" else "test-output" if name.startswith(OUTPUT_DIRS) else "harness-log"
        evidence.append({"name": name, "kind": kind, "mediaType": media_type, "path": f"official/{name}"})

    if evidence:
        archive_path = output / "official-output.zip"
        try:
            with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for item in evidence:
                    archive.write(output / item["path"], arcname=item["name"])
            if archive_path.stat().st_size <= MAX_FILE_BYTES:
                evidence.append({"name": archive_path.name, "kind": "official-output-archive", "mediaType": "application/zip", "path": archive_path.name})
            else:
                errors.append("完整证据包超过 64 MiB，未截断；请使用单文件下载")
        except OSError:
            errors.append("证据包生成失败，已保留单文件输出")
    return evidence, {"missingFiles": [name for name in ROOT_FILES if name not in files], "errors": errors}
