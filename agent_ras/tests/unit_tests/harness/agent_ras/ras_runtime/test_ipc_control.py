# coding: utf-8
"""send_host_control ack 语义：ack / 无 ack / 连接失败三态。"""
from __future__ import annotations

import json
import socket
import threading
from pathlib import Path

from platform_adapter.common.transport.subprocess_ipc import send_host_control


def _serve_once(path: Path, responder) -> threading.Thread:
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(str(path))
    srv.listen(1)

    def _run() -> None:
        conn, _ = srv.accept()
        with conn:
            data = b""
            while b"\n" not in data:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                data += chunk
            responder(conn, json.loads(data.decode("utf-8")))
        srv.close()

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return t


def test_send_host_control_ack_ok(tmp_path: Path) -> None:
    sock = tmp_path / "ctl.sock"

    def responder(conn, req) -> None:
        assert req["op"] == "abort"
        conn.sendall(b'{"ok": true}\n')

    t = _serve_once(sock, responder)
    res = send_host_control("abort", "s1", sock_path=sock)
    t.join(timeout=5)
    assert res["delivered"] is True
    assert res["ack"] == {"ok": True}
    assert res["error"] is None


def test_send_host_control_ack_failure(tmp_path: Path) -> None:
    sock = tmp_path / "ctl.sock"

    def responder(conn, _req) -> None:
        conn.sendall(b'{"ok": false, "error": "no active turn"}\n')

    t = _serve_once(sock, responder)
    res = send_host_control("abort", "s1", sock_path=sock)
    t.join(timeout=5)
    assert res["ack"] == {"ok": False, "error": "no active turn"}


def test_send_host_control_legacy_listener_no_ack(tmp_path: Path) -> None:
    sock = tmp_path / "ctl.sock"

    def responder(_conn, _req) -> None:
        pass  # 老式 fire-and-forget listener：读完后直接关连接

    t = _serve_once(sock, responder)
    res = send_host_control("abort", "s1", sock_path=sock)
    t.join(timeout=5)
    assert res["delivered"] is True
    assert res["ack"] is None


def test_send_host_control_connect_failure(tmp_path: Path) -> None:
    res = send_host_control("abort", "s1", sock_path=tmp_path / "missing.sock")
    assert res["delivered"] is False
    assert res["ack"] is None
    assert res["error"]
