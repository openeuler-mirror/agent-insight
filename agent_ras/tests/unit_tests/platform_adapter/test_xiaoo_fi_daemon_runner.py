# coding: utf-8
from __future__ import annotations

from platform_adapter.xiaoo.fi_daemon_runner import (
    _compose_daemon_prompt,
    build_daemon_open_kwargs,
    build_parser,
    build_runner,
)


def test_compose_daemon_prompt_requires_skill_first() -> None:
    class Fault:
        skill_name = "thinking-dead-loop"

    text = _compose_daemon_prompt(Fault(), "执行场景2")  # type: ignore[arg-type]
    assert "thinking-dead-loop" in text
    assert "skill" in text
    assert "执行场景2" in text


def test_build_runner_registers_ras_xiaoo_adapter() -> None:
    runner = build_runner()
    adapter = runner.platform_registry.get("xiaoo")
    assert adapter.__class__.__name__ == "RasOwnedXiaooDaemonAdapter"


def test_daemon_open_kwargs_never_bind_agent() -> None:
    kwargs = build_daemon_open_kwargs(
        title="run-1",
        workspace="/tmp/ws",
        model="minimax/Minimax-M2.7-highspeed",
    )
    assert kwargs == {
        "title": "run-1",
        "workspace": "/tmp/ws",
        "model": "minimax/Minimax-M2.7-highspeed",
    }
    assert "runtime_profile_id" not in kwargs
    bare = build_daemon_open_kwargs(title="run-2", workspace="/tmp/ws2")
    assert list(bare.keys()) == ["title", "workspace"]


def test_parser_accepts_fi_worker_shape() -> None:
    parser = build_parser()
    args = parser.parse_args(
        [
            "run",
            "--platform",
            "xiaoo",
            "--agent",
            "default",
            "--fault",
            "thinking-dead-loop",
            "--prompt",
            "go",
            "--workspace",
            "/tmp",
            "--output-dir",
            "/tmp/out",
            "--run-id",
            "run-test",
            "--submode",
            "2",
            "--timeout-seconds",
            "120",
        ]
    )
    assert args.platform == "xiaoo"
    assert args.submode == "2"
    assert args.run_id == "run-test"
