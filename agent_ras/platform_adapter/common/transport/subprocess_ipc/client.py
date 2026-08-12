# coding: utf-8
"""Unix-socket client for subprocess-hook embedding.

Any stdin-hook host (xiaoo today) can point ``RAS_EMBED_SOCK`` here so short-lived
hook processes share one SessionHub worker. This is an embedding transport, not
RAS core — see ``platform_adapter.common.transport``.

Default SessionHub path: ``$AGENT_INSIGHT_RAS_HOME/ras_embed.sock``.
Host control path: ``$AGENT_INSIGHT_RAS_HOME/ras_control.sock``.
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


def _runtime_pythonpath_entries() -> list[str]:
    """Resolve install-ras runtime roots so the subprocess IPC worker imports."""

    home = (os.environ.get(_ENV_HOME) or "").strip() or str(
        Path.home() / ".agent-insight" / "ras"
    )
    entries: list[str] = []
    marker = Path(home) / "install.json"
    if marker.is_file():
        try:
            meta = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            meta = {}
        runtime_root = meta.get("runtimeRoot")
        if isinstance(runtime_root, str) and runtime_root.strip():
            root = Path(runtime_root.strip())
            entries.append(str(root))
            packages = root / ".python-packages"
            if packages.is_dir():
                entries.append(str(packages))
            py_packages = meta.get("pythonPackages")
            if isinstance(py_packages, str) and py_packages.strip():
                entries.append(py_packages.strip())
    entries.append(home)
    # Deduplicate while preserving order.
    seen: set[str] = set()
    out: list[str] = []
    for item in entries:
        if item and item not in seen:
            seen.add(item)
            out.append(item)
    return out


def ensure_worker(
    *,
    sock_path: Path | None = None,
    wait_s: float = 5.0,
) -> Path:
    """Connect to existing worker or spawn the subprocess IPC worker module."""
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
    path_entries = _runtime_pythonpath_entries()
    existing = env.get("PYTHONPATH", "")
    if existing:
        path_entries.append(existing)
    if path_entries:
        env["PYTHONPATH"] = os.pathsep.join(path_entries)
    subprocess.Popen(
        [
            sys.executable,
            "-m",
            "platform_adapter.common.transport.subprocess_ipc",
        ],
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
    raise RuntimeError(f"ras_runtime ipc worker not ready: {path}")


def send_host_control(
    op: str,
    session_id: str,
    *,
    message: str | None = None,
    sock_path: Path | None = None,
    ack_timeout: float = 2.0,
) -> dict[str, Any]:
    """Send a control op to the host gateway and wait for its ack.

    Returns ``{"delivered": bool, "ack": dict | None, "error": str | None}``:
    ``delivered=False`` means the socket write itself failed; ``ack=None``
    means the gateway accepted the bytes but gave no execution confirmation
    (legacy fire-and-forget listener), so the caller must not report success.
    """
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
            try:
                raw = _recv_line(sock, timeout=ack_timeout)
            except (OSError, socket.timeout):
                return {"delivered": True, "ack": None, "error": None}
    except OSError as exc:
        logger.debug("host control sock unavailable path=%s op=%s", path, op)
        return {"delivered": False, "ack": None, "error": str(exc) or "socket unavailable"}
    if not raw:
        return {"delivered": True, "ack": None, "error": None}
    try:
        ack = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {"delivered": True, "ack": None, "error": None}
    if not isinstance(ack, dict):
        return {"delivered": True, "ack": None, "error": None}
    return {"delivered": True, "ack": ack, "error": None}


def publish_host_control(
    op: str,
    session_id: str,
    *,
    message: str | None = None,
    sock_path: Path | None = None,
) -> bool:
    """Legacy fire-and-forget wrapper; prefer ``send_host_control``."""
    return bool(
        send_host_control(
            op, session_id, message=message, sock_path=sock_path, ack_timeout=0.2
        )["delivered"]
    )


__all__ = [
    "call_ipc",
    "default_control_path",
    "default_sock_path",
    "ensure_worker",
    "ipc_available",
    "publish_host_control",
    "send_host_control",
]
