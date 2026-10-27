# Copyright (c) 2026 Huawei Technologies Co., Ltd.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Asynchronous OTLP exporter with local spool and retry.

Reliability contract (AC20-AC23):

* Every completed span is written to a spool file **before** it is sent,
  so a network failure never loses data (AC21).
* A daemon worker thread drains the queue; transient failures are retried.
  The first two failures use a fixed short delay, the third and later
  failures use exponential backoff (AC23).
* After a successful upload the spool file is renamed to ``<name>.json.sent``
  instead of being deleted immediately; on restart ``.sent`` files are
  skipped (no duplicate upload) and garbage-collected after a retention
  window (AC22).
* A periodic scanner re-discovers spool files written by the process or a
  previous run (AC20).
* When ``account_isolation`` is enabled, files for different API keys are
  written to per-account sub-directories (AC4).
"""

from __future__ import annotations

import hashlib
import json
import os
import queue
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

from .otlp import stable_hex

SENT_SUFFIX = ".json.sent"
REJECTED_SUFFIX = ".json.rejected"
TMP_SUFFIX = ".tmp"


def account_hash(api_key: str) -> str:
    """Deterministic 8-hex account id derived from the API key (AC4)."""
    return hashlib.sha256(str(api_key or "").encode("utf-8", errors="replace")).hexdigest()[:8]


class FileLogger:
    """Small rotating file logger used by the exporter thread."""

    def __init__(self, path: str, max_bytes: int = 2 * 1024 * 1024):
        self.path = Path(path).expanduser()
        self.max_bytes = max_bytes
        self.lock = threading.Lock()

    def write(self, level: str, message: str) -> None:
        try:
            with self.lock:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                if self.path.exists() and self.path.stat().st_size >= self.max_bytes:
                    rotated = self.path.with_suffix(self.path.suffix + ".1")
                    try:
                        rotated.unlink(missing_ok=True)
                        self.path.replace(rotated)
                    except OSError:
                        pass
                timestamp = time.strftime("%Y-%m-%dT%H:%M:%S%z")
                with self.path.open("a", encoding="utf-8") as handle:
                    handle.write(f"{timestamp} {level.upper()} {message}\n")
        except OSError:
            pass


class DeltaExporter:
    """Spool-first exporter: write JSON, then send with retry."""

    def __init__(self, config: Any) -> None:
        self.endpoint = str(getattr(config, "endpoint", "") or "")
        self.api_key = str(getattr(config, "api_key", "") or "")
        self.service_name = str(getattr(config, "service_name", "") or "qwenpaw")
        self.timeout = float(getattr(config, "timeout_seconds", 10) or 10)
        self.retry_base = max(0.1, float(getattr(config, "retry_base_seconds", 1) or 1))
        self.retry_max = max(self.retry_base, float(getattr(config, "retry_max_seconds", 60) or 60))
        self.scan_interval = max(1.0, float(getattr(config, "scan_interval_seconds", 30) or 30))
        self.sent_retention = max(0.0, float(getattr(config, "sent_retention_seconds", 86400) or 86400))
        self.account_isolation = bool(getattr(config, "account_isolation", True))

        self.spool_dir = Path(str(getattr(config, "spool_dir", "") or "")).expanduser()
        self.account_dir = self.spool_dir
        if self.account_isolation:
            self.account_dir = self.spool_dir / account_hash(self.api_key)
        self.account_dir.mkdir(parents=True, exist_ok=True)
        self.logger = FileLogger(str(getattr(config, "log_file", "") or ""))

        self._queue: queue.PriorityQueue[tuple[float, int, Optional[Path]]] = queue.PriorityQueue()
        self._lock = threading.Lock()
        self._scheduled: set[Path] = set()
        self._attempts: dict[Path, int] = {}
        self._paused: set[Path] = set()
        self._sequence = 0
        self._stopping = False
        self._stop_event = threading.Event()

        self._cleanup_stale()
        self._scan_once()

        self._worker = threading.Thread(
            target=self._run,
            name="agent-insight-qwenpaw-exporter",
            daemon=True,
        )
        self._worker.start()
        self._scanner = threading.Thread(
            target=self._scan_loop,
            name="agent-insight-qwenpaw-scanner",
            daemon=True,
        )
        self._scanner.start()
        self.logger.write(
            "info",
            f"exporter started spool={self.account_dir} "
            f"endpoint_configured={bool(self.endpoint)} account_isolation={self.account_isolation}",
        )

    # ------------------------------------------------------------------
    # spooling
    # ------------------------------------------------------------------

    def submit(self, item_id: str, payload: dict[str, Any]) -> None:
        path = self.account_dir / f"{stable_hex(item_id, 32)}.json"
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        temp_path = path.with_name(f".{path.name}.{threading.get_ident()}{TMP_SUFFIX}")
        try:
            temp_path.write_bytes(data)
            try:
                temp_path.chmod(0o600)
            except OSError:
                pass
            sent_path = path.with_name(path.name + SENT_SUFFIX)
            if sent_path.exists():
                # A previous identical span was already uploaded; drop the
                # stale marker so this newer copy can be sent.
                try:
                    sent_path.unlink(missing_ok=True)
                except OSError:
                    pass
            os.replace(temp_path, path)
            self._schedule(path)
        except OSError:
            self.logger.write("error", "spool write failed")
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass

    def _schedule(self, path: Path, due: Optional[float] = None) -> None:
        with self._lock:
            if self._stopping or path in self._scheduled:
                return
            self._scheduled.add(path)
            self._sequence += 1
            self._queue.put((due if due is not None else time.monotonic(), self._sequence, path))

    def flush(self, timeout: float = 3.0) -> None:
        deadline = time.monotonic() + timeout
        while self._queue.unfinished_tasks and time.monotonic() < deadline:
            time.sleep(0.02)

    def close(self) -> None:
        self.flush()
        with self._lock:
            self._stopping = True
            self._sequence += 1
            self._queue.put((time.monotonic(), self._sequence, None))
        self._stop_event.set()

    # ------------------------------------------------------------------
    # periodic scan (AC20)
    # ------------------------------------------------------------------

    def _scan_loop(self) -> None:
        while not self._stop_event.wait(self.scan_interval):
            try:
                self._scan_once()
            except Exception:  # noqa: BLE001
                self.logger.write("warning", "periodic scan failed")

    def _scan_once(self) -> None:
        with self._lock:
            scheduled = set(self._scheduled)
            paused = set(self._paused)
            attempts = set(self._attempts)
        for path in self.account_dir.rglob("*.json"):
            if path in scheduled or path in paused or path in attempts:
                continue
            if path.suffix != ".json":
                continue
            self._schedule(path)
        self._cleanup_stale()

    def _cleanup_stale(self) -> None:
        now = time.time()
        for pattern in (f"*{SENT_SUFFIX}", f"*{REJECTED_SUFFIX}"):
            try:
                for path in self.spool_dir.rglob(pattern):
                    try:
                        if now - path.stat().st_mtime > self.sent_retention:
                            path.unlink(missing_ok=True)
                    except OSError:
                        pass
            except OSError:
                pass
        try:
            for path in self.spool_dir.rglob(f"*{TMP_SUFFIX}"):
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass
        except OSError:
            pass

    # ------------------------------------------------------------------
    # worker
    # ------------------------------------------------------------------

    def _run(self) -> None:
        while True:
            due, sequence, path = self._queue.get()
            needs_task_done = True
            try:
                if path is None:
                    return
                delay = due - time.monotonic()
                if delay > 0:
                    self._queue.task_done()
                    needs_task_done = False
                    self._queue.put((due, sequence, path))
                    time.sleep(min(delay, 0.25))
                    continue
                with self._lock:
                    self._scheduled.discard(path)
                self._send_path(path)
            finally:
                if needs_task_done:
                    self._queue.task_done()

    @staticmethod
    def backoff_delay(retry_base: float, retry_max: float, attempt: int) -> float:
        """AC23: fixed delay for the first 2 failures, exponential from the 3rd."""
        if attempt <= 2:
            return retry_base
        return min(retry_max, retry_base * (2 ** (attempt - 2)))

    def _send_path(self, path: Path) -> None:
        try:
            data = path.read_bytes()
            json.loads(data.decode("utf-8"))
        except (OSError, ValueError, UnicodeError):
            self.logger.write("error", f"spool read failed file={path.name}")
            return

        success, retryable, detail = self._send(data)
        if success:
            self._attempts.pop(path, None)
            self.logger.write("info", f"export success file={path.name} bytes={len(data)} detail={detail}")
            sent_path = path.with_name(path.name + SENT_SUFFIX)
            try:
                if path.read_bytes() == data:
                    os.replace(path, sent_path)
                else:
                    self._schedule(path)
            except OSError:
                self.logger.write("warning", f"spool cleanup failed file={path.name}")
            return

        if not retryable:
            # Permanently rejected (bad payload / auth) or no endpoint
            # configured: keep the file but do not retry in a loop.
            if detail == "endpoint_not_configured":
                with self._lock:
                    self._paused.add(path)
                self.logger.write("warning", f"export paused file={path.name} detail={detail}")
            else:
                try:
                    os.replace(path, path.with_name(path.name + REJECTED_SUFFIX))
                except OSError:
                    with self._lock:
                        self._paused.add(path)
                self.logger.write("error", f"export rejected file={path.name} detail={detail}")
            return

        attempt = self._attempts.get(path, 0) + 1
        self._attempts[path] = attempt
        delay = self.backoff_delay(self.retry_base, self.retry_max, attempt)
        self.logger.write(
            "warning",
            f"export retry file={path.name} attempt={attempt} delay={delay:.1f}s detail={detail}",
        )
        self._schedule(path, time.monotonic() + delay)

    def _send(self, data: bytes) -> tuple[bool, bool, str]:
        if not self.endpoint:
            return False, False, "endpoint_not_configured"
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["x-witty-api-key"] = self.api_key
        request = urllib.request.Request(
            self.endpoint,
            data=data,
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                response.read()
                status = int(getattr(response, "status", 200) or 200)
                return 200 <= status < 300, status in (408, 429) or status >= 500, f"http_{status}"
        except urllib.error.HTTPError as error:
            status = int(error.code or 0)
            return False, status in (408, 429) or status >= 500, f"http_{status}"
        except (OSError, urllib.error.URLError):
            return False, True, "network_error"
