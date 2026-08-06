from __future__ import annotations

import json
import os
import secrets
import time
from itertools import chain
from pathlib import Path
from threading import Lock
from typing import Any

from .config import CollectorConfig


class Spool:
    def __init__(self, config: CollectorConfig) -> None:
        self.config = config
        self.directory = config.spool_dir
        self.directory.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.directory, 0o700)
        except OSError:
            pass
        self._lock = Lock()
        self._prefix = f"{os.getpid()}-{secrets.token_hex(4)}"
        self._sequence = 0
        self._recover_stale_claims()
        self._size_bytes = self._scan_size_bytes()
        self._size_checked_at = time.monotonic()

    def _recover_stale_claims(self) -> None:
        cutoff = time.time() - self.config.spool_claim_timeout_seconds
        for path in self.directory.glob("*.uploading-*"):
            try:
                if path.stat().st_mtime > cutoff:
                    continue
                stem = path.name.split(".uploading-", 1)[0]
                os.replace(path, self.directory / f"{stem}.ready")
            except (FileNotFoundError, OSError):
                continue

    def _scan_size_bytes(self) -> int:
        try:
            paths = chain(
                self.directory.glob("*.ready"),
                self.directory.glob("*.uploading-*"),
                self.directory.glob("*.rejected"),
            )
            return sum(path.stat().st_size for path in paths)
        except OSError:
            return 0

    def size_bytes(self, *, refresh: bool = False) -> int:
        # Periodic reconciliation sees files written by sibling processes while
        # avoiding an O(number-of-files) directory walk for every local batch.
        if refresh or time.monotonic() - self._size_checked_at >= 1.0:
            self._size_bytes = self._scan_size_bytes()
            self._size_checked_at = time.monotonic()
        return self._size_bytes

    def _reclaim_rejected(self, required: int) -> None:
        if self.size_bytes() + required <= self.config.spool_max_bytes:
            return
        if self.size_bytes(refresh=True) + required <= self.config.spool_max_bytes:
            return
        rejected: list[tuple[float, Path]] = []
        for path in self.directory.glob("*.rejected"):
            try:
                rejected.append((path.stat().st_mtime, path))
            except FileNotFoundError:
                continue
        for _, path in sorted(rejected):
            try:
                size = path.stat().st_size
                path.unlink()
                self._size_bytes = max(0, self._size_bytes - size)
            except FileNotFoundError:
                continue
            if self._size_bytes + required <= self.config.spool_max_bytes:
                break

    def write(self, payload: dict[str, Any]) -> Path | None:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        with self._lock:
            self._reclaim_rejected(len(encoded))
            if self.size_bytes() + len(encoded) > self.config.spool_max_bytes:
                return None
            self._sequence += 1
            stem = f"{time.time_ns()}-{self._prefix}-{self._sequence:08d}"
            temporary = self.directory / f".{stem}.tmp"
            ready = self.directory / f"{stem}.ready"
            with temporary.open("xb") as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, ready)
            self._size_bytes += len(encoded)
            return ready

    def pending(self) -> list[Path]:
        return sorted(self.directory.glob("*.ready"), key=lambda path: path.name)

    def has_pending(self) -> bool:
        return next(self.directory.glob("*.ready"), None) is not None

    def claim_next(self) -> Path | None:
        while True:
            # Upload order is not semantically significant; taking the first
            # directory entry avoids rescanning the entire backlog for every
            # claimed batch.
            ready = next(self.directory.glob("*.ready"), None)
            if ready is None:
                return None
            claimed = ready.with_suffix(f".uploading-{self._prefix}")
            try:
                os.replace(ready, claimed)
                os.utime(claimed, None)
                return claimed
            except FileNotFoundError:
                continue

    def release(self, path: Path) -> Path | None:
        if ".uploading-" not in path.name:
            return path if path.exists() else None
        ready = path.with_name(f"{path.name.split('.uploading-', 1)[0]}.ready")
        try:
            os.replace(path, ready)
            return ready
        except FileNotFoundError:
            return None

    def acknowledge(self, path: Path) -> None:
        with self._lock:
            try:
                size = path.stat().st_size
                path.unlink()
                self._size_bytes = max(0, self._size_bytes - size)
            except FileNotFoundError:
                pass

    def reject(self, path: Path) -> Path:
        rejected = path.with_suffix(".rejected")
        os.replace(path, rejected)
        return rejected

    def purge(self) -> int:
        count = 0
        for pattern in ("*.ready", "*.rejected", "*.uploading-*", ".*.tmp"):
            for path in self.directory.glob(pattern):
                try:
                    path.unlink()
                    count += 1
                except FileNotFoundError:
                    pass
        self._size_bytes = 0
        self._size_checked_at = time.monotonic()
        return count
