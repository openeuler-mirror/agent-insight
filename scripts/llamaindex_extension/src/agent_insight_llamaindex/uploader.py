from __future__ import annotations

import json
import logging
import queue
import random
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from .config import CollectorConfig
from .model import SpanRecord
from .otlp import encode_batch
from .spool import Spool

logger = logging.getLogger(__name__)


class _FlushMarker:
    def __init__(self) -> None:
        self.done = threading.Event()


class CollectorRuntime:
    def __init__(self, config: CollectorConfig) -> None:
        self.config = config
        self.spool = Spool(config)
        self.queue: queue.Queue[SpanRecord | object] = queue.Queue(maxsize=config.queue_size)
        self._sentinel = object()
        self._accepting = threading.Event()
        self._writer_stop = threading.Event()
        self._stop = threading.Event()
        self._upload_wakeup = threading.Event()
        self._upload_idle = threading.Event()
        self._upload_idle.set()
        self._writer_done = threading.Event()
        self._writer = threading.Thread(target=self._writer_loop, daemon=True, name="ai-li-writer")
        self._uploader = threading.Thread(
            target=self._uploader_loop, daemon=True, name="ai-li-uploader"
        )
        self.dropped = 0
        self.uploaded_batches = 0
        self.last_error: str | None = None

    def start(self) -> None:
        self._accepting.set()
        self._writer.start()
        self._uploader.start()

    def submit(self, record: SpanRecord) -> bool:
        if not self._accepting.is_set():
            return False
        try:
            self.queue.put_nowait(record)
            return True
        except queue.Full:
            self.dropped += 1
            return False

    def _writer_loop(self) -> None:
        batch: list[SpanRecord] = []
        deadline = time.monotonic() + self.config.flush_interval_seconds
        while True:
            timeout = max(0.0, deadline - time.monotonic())
            try:
                item = self.queue.get(timeout=timeout)
            except queue.Empty:
                if self._writer_stop.is_set():
                    if batch:
                        self._write_batch(batch)
                    break
                item = None
            if item is self._sentinel:
                self.queue.task_done()
                if batch:
                    self._write_batch(batch)
                break
            if isinstance(item, _FlushMarker):
                self.queue.task_done()
                if batch:
                    self._write_batch(batch)
                    batch = []
                item.done.set()
                deadline = time.monotonic() + self.config.flush_interval_seconds
                continue
            if isinstance(item, SpanRecord):
                batch.append(item)
                self.queue.task_done()
            session_completed = (
                isinstance(item, SpanRecord)
                and item.parent_span_id is None
                and item.kind in {"agent", "workflow"}
            )
            if batch and (
                len(batch) >= self.config.batch_size
                or item is None
                or session_completed
            ):
                self._write_batch(batch)
                batch = []
                deadline = time.monotonic() + self.config.flush_interval_seconds
            elif item is None:
                deadline = time.monotonic() + self.config.flush_interval_seconds
        self._writer_done.set()
        self._upload_wakeup.set()

    def _write_batch(self, batch: list[SpanRecord]) -> None:
        if self.spool.write(encode_batch(batch, self.config)) is None:
            self.dropped += len(batch)
            self.last_error = "spool capacity exceeded"
            return
        self._upload_wakeup.set()

    def _upload(self, path: Path) -> tuple[bool, bool, str | None]:
        try:
            payload = path.read_bytes()
            request = urllib.request.Request(
                self.config.endpoint,
                data=payload,
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "x-witty-api-key": self.config.api_key,
                    "User-Agent": "agent-insight-llamaindex/0.2.0",
                },
            )
            with urllib.request.urlopen(
                request, timeout=self.config.request_timeout_seconds
            ) as response:
                return 200 <= response.status < 300, False, None
        except urllib.error.HTTPError as error:
            permanent = 400 <= error.code < 500 and error.code not in {401, 403, 408, 429}
            return False, permanent, f"HTTP {error.code}"
        except (OSError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            return False, False, type(error).__name__

    def _uploader_loop(self) -> None:
        attempt = 0
        claimed: Path | None = None
        try:
            while True:
                if self._stop.is_set() and self._writer_done.is_set():
                    return
                if claimed is None:
                    claimed = self.spool.claim_next()
                    if claimed is not None:
                        self._upload_idle.clear()
                if claimed is None:
                    self._upload_wakeup.wait(self.config.upload_interval_seconds)
                    self._upload_wakeup.clear()
                    continue
                success, permanent, error = self._upload(claimed)
                if success:
                    self.spool.acknowledge(claimed)
                    claimed = None
                    self._upload_idle.set()
                    self.uploaded_batches += 1
                    self.last_error = None
                    attempt = 0
                    continue
                self.last_error = error
                if permanent:
                    self.spool.reject(claimed)
                    claimed = None
                    self._upload_idle.set()
                    attempt = 0
                    continue
                attempt += 1
                delay = self._retry_delay(attempt)
                self._stop.wait(random.uniform(0, delay))
        finally:
            if claimed is not None:
                self.spool.release(claimed)
            self._upload_idle.set()

    def _retry_delay(self, attempt: int) -> float:
        exponent = max(0, min(attempt - 3, 16))
        return min(
            self.config.retry_max_seconds,
            self.config.retry_base_seconds * (2**exponent),
        )

    def flush(self, timeout: float = 10.0) -> bool:
        deadline = time.monotonic() + timeout
        if not self._writer_done.is_set():
            marker = _FlushMarker()
            try:
                self.queue.put(marker, timeout=max(0.01, min(timeout, 1.0)))
                marker.done.wait(max(0.0, deadline - time.monotonic()))
            except queue.Full:
                return False
        self._upload_wakeup.set()
        while (
            self.spool.has_pending() or not self._upload_idle.is_set()
        ) and time.monotonic() < deadline:
            time.sleep(0.02)
        return (
            not self.spool.has_pending()
            and self._upload_idle.is_set()
            and self.queue.unfinished_tasks == 0
        )

    def close(self, timeout: float = 10.0) -> None:
        self._accepting.clear()
        self._writer_stop.set()
        if not self._writer_done.is_set():
            try:
                self.queue.put(self._sentinel, timeout=max(0.1, timeout / 2))
            except queue.Full:
                pass
            self._upload_wakeup.set()
            self._writer.join(timeout=max(0.1, timeout / 2))
        self._stop.set()
        self._upload_wakeup.set()
        self._uploader.join(timeout=max(0.1, timeout / 2))
