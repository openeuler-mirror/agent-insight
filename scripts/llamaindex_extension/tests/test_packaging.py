from __future__ import annotations

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def test_downloaded_collector_layout_is_self_contained() -> None:
    assert (
        PROJECT_ROOT
        / "src"
        / "agent_insight_llamaindex"
        / "_bootstrap"
        / "sitecustomize.py"
    ).is_file()
    project_config = (PROJECT_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    assert "[build-system]" not in project_config
    assert "[project]" not in project_config
    assert not (PROJECT_ROOT / "install.py").exists()
    assert not (PROJECT_ROOT / "bootstrap" / "sitecustomize.py").exists()
