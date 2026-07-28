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

    def size_bytes(self) -> int:
        try:
            paths = chain(
                self.directory.glob("*.ready"),
                self.directory.glob("*.uploading-*"),
                self.directory.glob("*.rejected"),
            )
            return sum(path.stat().st_size for path in paths)
        except OSError:
            return 0

    def write(self, payload: dict[str, Any]) -> Path | None:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        with self._lock:
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
            return ready

    def pending(self) -> list[Path]:
        return sorted(self.directory.glob("*.ready"), key=lambda path: path.name)

    def has_pending(self) -> bool:
        return next(self.directory.glob("*.ready"), None) is not None

    def claim_next(self) -> Path | None:
        while True:
            ready = min(self.directory.glob("*.ready"), key=lambda path: path.name, default=None)
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
        try:
            path.unlink()
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
        return count
