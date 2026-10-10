"""Enumerate xiaoO agents/models for Web UI."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .config_overlay import default_user_config_path, load_user_llm_config


def list_xiaoo_agents() -> dict[str, Any]:
    """CLI uses AgentId strings; it does not load ``[agent.X]`` from config."""

    return {
        "platform": "xiaoo",
        "default": "defaultagent",
        "agents": [
            {
                "id": "defaultagent",
                "name": "defaultagent",
                "description": (
                    "Default xiaoO CLI AgentId "
                    "(CLI does not load [agent.*] role prompts)."
                ),
            }
        ],
        "note": (
            "xiaoO CLI accepts --agent as an AgentId only; "
            "use defaultagent unless your runtime registers other ids."
        ),
    }


def list_xiaoo_models(*, config_path: Path | None = None) -> dict[str, Any]:
    path = config_path or default_user_config_path()
    llm = load_user_llm_config(path)
    provider = llm.get("provider")
    model = llm.get("model")
    models: list[dict[str, Any]] = []
    default: str | None = None
    if isinstance(provider, str) and isinstance(model, str):
        provider = provider.strip()
        model = model.strip()
        if provider and model:
            model_id = f"{provider}/{model}"
            default = model_id
            models.append(
                {
                    "id": model_id,
                    "providerID": provider,
                    "modelID": model,
                    "name": model,
                    "default": True,
                }
            )
    note = None
    if not models:
        note = (
            f"No [llm] provider/model found in {path}. "
            "Configure ~/.config/xiaoo/config.toml before running."
        )
    return {
        "platform": "xiaoo",
        "default": default,
        "models": models,
        "note": note,
    }
