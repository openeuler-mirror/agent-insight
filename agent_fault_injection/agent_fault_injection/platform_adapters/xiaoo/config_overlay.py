"""Generate per-run xiaoO config.toml and plugin.json overlay."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any


HOOKER_DIR = Path(__file__).resolve().parent / "hooker"
HOOK_SCRIPT = HOOKER_DIR / "ras_eval_hook.py"
PLUGIN_TEMPLATE = HOOKER_DIR / "plugin.json"
PLUGIN_CHAT_LLM_TEMPLATE = HOOKER_DIR / "plugin.chat-llm.json"


def default_user_config_path() -> Path:
    env = __import__("os").environ.get("XIAOO_CONFIG", "").strip()
    if env:
        return Path(env).expanduser()
    return Path.home() / ".config" / "xiaoo" / "config.toml"


def _parse_simple_toml_section(text: str, section: str) -> dict[str, Any]:
    """Minimal TOML section reader for [llm] / string-ish values (no deps)."""

    import re

    lines = text.splitlines()
    in_section = False
    values: dict[str, Any] = {}
    section_header = f"[{section}]"
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("[") and stripped.endswith("]"):
            in_section = stripped == section_header
            continue
        if not in_section:
            continue
        match = re.match(
            r'^([A-Za-z0-9_]+)\s*=\s*(.+)$',
            stripped,
        )
        if not match:
            continue
        key, raw = match.group(1), match.group(2).strip()
        if raw.startswith('"') and raw.endswith('"'):
            values[key] = raw[1:-1]
        elif raw.startswith("'") and raw.endswith("'"):
            values[key] = raw[1:-1]
        elif raw.lower() in {"true", "false"}:
            values[key] = raw.lower() == "true"
        else:
            try:
                values[key] = int(raw)
            except ValueError:
                try:
                    values[key] = float(raw)
                except ValueError:
                    values[key] = raw
    return values


def load_user_llm_config(path: Path | None = None) -> dict[str, Any]:
    config_path = path or default_user_config_path()
    if not config_path.is_file():
        return {}
    try:
        text = config_path.read_text(encoding="utf-8")
    except OSError:
        return {}
    return _parse_simple_toml_section(text, "llm")


def _toml_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _format_llm_toml(llm: dict[str, Any], model_override: str | None) -> str:
    lines = ["[llm]"]
    provider = llm.get("provider")
    model = model_override or llm.get("model")
    api_key_env = llm.get("api_key_env")
    api_base = llm.get("api_base")
    if isinstance(provider, str) and provider.strip():
        lines.append(f'provider = "{_toml_escape(provider.strip())}"')
    if isinstance(model, str) and model.strip():
        lines.append(f'model = "{_toml_escape(model.strip())}"')
    if isinstance(api_key_env, str) and api_key_env.strip():
        lines.append(f'api_key_env = "{_toml_escape(api_key_env.strip())}"')
    if isinstance(api_base, str) and api_base.strip():
        lines.append(f'api_base = "{_toml_escape(api_base.strip())}"')
    # Keep max_tokens / reasoning if present as numbers/strings.
    for key in ("max_tokens", "reasoning_effort"):
        value = llm.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            lines.append(f"{key} = {value}")
        elif isinstance(value, str) and value.strip():
            lines.append(f'{key} = "{_toml_escape(value.strip())}"')
    return "\n".join(lines) + "\n"


def write_plugin_json(
    destination: Path,
    *,
    enable_chat_llm_hooks: bool = False,
) -> Path:
    """Copy plugin template with absolute hook script path."""

    if not HOOK_SCRIPT.is_file():
        raise FileNotFoundError(f"Missing xiaoO hook script: {HOOK_SCRIPT}")
    template = (
        PLUGIN_CHAT_LLM_TEMPLATE if enable_chat_llm_hooks else PLUGIN_TEMPLATE
    )
    if not template.is_file():
        raise FileNotFoundError(f"Missing plugin template: {template}")

    entries = json.loads(template.read_text(encoding="utf-8"))
    if not isinstance(entries, list):
        raise ValueError("plugin.json must be a JSON array")
    hook_cmd = f"python3 {HOOK_SCRIPT.resolve()}"
    rewritten: list[dict[str, Any]] = []
    for item in entries:
        if not isinstance(item, dict):
            continue
        copy = dict(item)
        copy["command"] = hook_cmd
        rewritten.append(copy)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(rewritten, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return destination


def write_run_config(
    *,
    destination: Path,
    plugin_json: Path,
    llm: dict[str, Any] | None = None,
    model_override: str | None = None,
) -> Path:
    """Write isolated XIAOO_CONFIG for one experiment run."""

    llm_data = dict(llm or {})
    parts = [
        "# Generated by agent-fault-injection XiaoOAdapter — do not edit by hand.\n",
        _format_llm_toml(llm_data, model_override),
        "\n[hooker]\n",
        'default = "All"\n',
        "plugins = [\n",
        f'  "{_toml_escape(str(plugin_json.resolve()))}"\n',
        "]\n",
        "enabled = []\n",
        "disabled = []\n",
    ]
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text("".join(parts), encoding="utf-8")
    return destination


def prepare_overlay(
    *,
    overlay_root: Path,
    model_override: str | None = None,
    user_config_path: Path | None = None,
    enable_chat_llm_hooks: bool = False,
) -> tuple[Path, Path]:
    """Create plugin.json + config.toml under overlay_root.

    Returns ``(config_toml_path, plugin_json_path)``.
    """

    overlay_root.mkdir(parents=True, exist_ok=True)
    plugin_json = write_plugin_json(
        overlay_root / "plugin.json",
        enable_chat_llm_hooks=enable_chat_llm_hooks,
    )
    llm = load_user_llm_config(user_config_path)
    config_toml = write_run_config(
        destination=overlay_root / "config.toml",
        plugin_json=plugin_json,
        llm=llm,
        model_override=model_override,
    )
    # Keep a copy of the hook script next to overlay for debugging (optional).
    shutil.copy2(HOOK_SCRIPT, overlay_root / "ras_eval_hook.py")
    return config_toml, plugin_json
