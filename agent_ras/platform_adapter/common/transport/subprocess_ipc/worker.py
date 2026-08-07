# coding: utf-8
"""Long-lived SessionHub worker for subprocess-hook hosts (NDJSON over Unix socket)."""
from __future__ import annotations

import json
import logging
import os
import signal
import socket
import sys
from pathlib import Path

from platform_adapter.common.transport.subprocess_ipc.client import default_sock_path
from ras_embed.facade import call as local_call

logger = logging.getLogger(__name__)


def _handle_one(raw: bytes) -> str:
    try:
        req = json.loads(raw.decode("utf-8") or "{}")
    except json.JSONDecodeError as exc:
        return json.dumps({"error": f"invalid json: {exc}"}, ensure_ascii=False)
    if not isinstance(req, dict):
        return json.dumps({"error": "request not object"}, ensure_ascii=False)
    op = str(req.get("op") or "")
    session_id = str(req.get("session_id") or "")
    payload = req.get("payload") if isinstance(req.get("payload"), dict) else {}
    return local_call(op, session_id, json.dumps(payload, ensure_ascii=False))


def serve(sock_path: Path | None = None) -> None:
    path = sock_path or default_sock_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(path))
    server.listen(64)
    os.environ["RAS_EMBED_SOCK"] = str(path)
    # Force local dispatch inside this process (avoid ipc recursion).
    os.environ["RAS_EMBED_IPC_FORCE_LOCAL"] = "1"
    logger.info("subprocess_ipc worker listening on %s", path)

    def _shutdown(*_args: object) -> None:
        try:
            server.close()
        finally:
            if path.exists():
                path.unlink()
        sys.exit(0)

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    while True:
        conn, _addr = server.accept()
        with conn:
            buf = bytearray()
            while b"\n" not in buf:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                buf.extend(chunk)
            line, _, _ = bytes(buf).partition(b"\n")
            if not line:
                continue
            resp = _handle_one(line)
            conn.sendall((resp + "\n").encode("utf-8"))


def main(argv: list[str] | None = None) -> int:
    del argv
    logging.basicConfig(level=logging.INFO)
    serve()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
