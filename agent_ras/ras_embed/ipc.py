# coding: utf-8
"""Unix-socket IPC so subprocess hooks share one SessionHub process.

Platform-neutral: any stdin-hook host can point ``RAS_EMBED_SOCK`` here.
Default path: ``$AGENT_INSIGHT_RAS_HOME/ras_embed.sock``.
"""
from __future__ import annotations

import json
import logging
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_ENV_SOCK = "RAS_EMBED_SOCK"
_ENV_HOME = "AGENT_INSIGHT_RAS_HOME"


def default_sock_path() -> Path:
    override = (os.environ.get(_ENV_SOCK) or "").strip()
    if override:
        return Path(override)
    home = (os.environ.get(_ENV_HOME) or "").strip()
    if not home:
        home = str(Path.home() / ".agent-insight" / "ras")
    return Path(home) / "ras_embed.sock"


def default_control_path() -> Path:
    home = (os.environ.get(_ENV_HOME) or "").strip()
    if not home:
        home = str(Path.home() / ".agent-insight" / "ras")
    return Path(home) / "ras_control.sock"


def _recv_line(conn: socket.socket, *, timeout: float = 30.0) -> bytes:
    conn.settimeout(timeout)
    buf = bytearray()
    while True:
        chunk = conn.recv(4096)
        if not chunk:
            break
        buf.extend(chunk)
        if b"\n" in buf:
            line, _, _rest = bytes(buf).partition(b"\n")
            return line
    return bytes(buf)


def call_ipc(
    op: str,
    session_id: str,
    payload: dict[str, Any] | None = None,
    *,
    sock_path: Path | None = None,
    timeout: float = 30.0,
) -> dict[str, Any]:
    path = sock_path or default_sock_path()
    req = {
        "op": op,
        "session_id": session_id,
        "payload": payload or {},
    }
    data = (json.dumps(req, ensure_ascii=False) + "\n").encode("utf-8")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        sock.connect(str(path))
        sock.sendall(data)
        raw = _recv_line(sock, timeout=timeout)
    if not raw:
        return {"error": "empty ipc response"}
    try:
        out = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as exc:
        return {"error": f"invalid ipc json: {exc}"}
    return out if isinstance(out, dict) else {"error": "ipc response not object"}


def ipc_available(sock_path: Path | None = None) -> bool:
    path = sock_path or default_sock_path()
    if not path.exists():
        return False
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.5)
            sock.connect(str(path))
        return True
    except OSError:
        return False


def ensure_worker(
    *,
    sock_path: Path | None = None,
    wait_s: float = 5.0,
) -> Path:
    """Connect to existing worker or spawn ``python -m ras_embed.ipc_worker``."""
    path = sock_path or default_sock_path()
    if ipc_available(path):
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        try:
            path.unlink()
        except OSError:
            pass
    env = os.environ.copy()
    env[_ENV_SOCK] = str(path)
    subprocess.Popen(
        [sys.executable, "-m", "ras_embed.ipc_worker"],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    deadline = time.time() + wait_s
    while time.time() < deadline:
        if ipc_available(path):
            return path
        time.sleep(0.05)
    raise RuntimeError(f"ras_embed ipc worker not ready: {path}")


def publish_host_control(
    op: str,
    session_id: str,
    *,
    message: str | None = None,
    sock_path: Path | None = None,
) -> bool:
    """Best-effort notify host gateway (xiaoO etc.) of wire delivery."""
    path = sock_path or default_control_path()
    payload: dict[str, Any] = {"op": op, "session_id": session_id}
    if message is not None:
        payload["message"] = message
    data = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(1.0)
            sock.connect(str(path))
            sock.sendall(data)
        return True
    except OSError:
        logger.debug("host control sock unavailable path=%s op=%s", path, op)
        return False


__all__ = [
    "call_ipc",
    "default_control_path",
    "default_sock_path",
    "ensure_worker",
    "ipc_available",
    "publish_host_control",
]
