"""Enumerate OpenCode agents/models via official CLI interfaces."""

from __future__ import annotations

import json
import os
import re
import signal
import socket
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

# Agent lines look like: ``build (subagent)`` or ``Sisyphus - Ultraworker (primary)``.
_AGENT_LINE_RE = re.compile(
    r"^(?P<name>.+?)\s+\((?P<mode>[^)]+)\)\s*$"
)
_EXCLUDED_AGENTS = frozenset(
    {
        "compaction",
        "summary",
        "title",
        "ras-judge",
    }
)
_BUILTIN_AGENTS = ("build", "plan", "general", "explore")
_ZERO_WIDTH_RE = re.compile(r"[\u200b\u200c\u200d\ufeff]")
# Env vars OpenCode commonly uses for provider credentials.
_ENV_PROVIDER_HINTS: tuple[tuple[str, str], ...] = (
    ("MINIMAX_API_KEY", "minimax"),
    ("MINIMAX_API_KEY", "minimax-cn"),
    ("DEEPSEEK_API_KEY", "deepseek"),
    ("OPENAI_API_KEY", "openai"),
    ("ANTHROPIC_API_KEY", "anthropic"),
    ("GOOGLE_GENERATIVE_AI_API_KEY", "google"),
    ("GEMINI_API_KEY", "google"),
)
_CLI_TIMEOUT_SECONDS = 30.0
_AGENT_SERVER_TIMEOUT_SECONDS = 15.0
_AGENT_SERVER_SETTLE_SECONDS = 2.0
_OH_MY_CONFIG_NAMES = ("oh-my-openagent.json", "oh-my-opencode.json")


def strip_zero_width(text: str) -> str:
    return _ZERO_WIDTH_RE.sub("", text).strip()


def parse_opencode_agent_list_output(text: str) -> list[dict[str, Any]]:
    """Parse ``opencode agent list`` stdout into agent entries."""
    agents: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw_line in text.splitlines():
        line = strip_zero_width(raw_line)
        if not line or line.startswith("{") or line.startswith("["):
            continue
        if line.startswith('"') or line in {"]", "},", "}"}:
            continue
        # Skip AET / plugin noise banners.
        if line.startswith("[") and "]" in line[:40]:
            continue
        match = _AGENT_LINE_RE.match(line)
        if match is None:
            continue
        name = strip_zero_width(match.group("name"))
        if not name or name in seen or name in _EXCLUDED_AGENTS:
            continue
        seen.add(name)
        mode = match.group("mode")
        entry: dict[str, Any] = {
            "id": name,
            "name": name,
        }
        if isinstance(mode, str) and mode.strip():
            entry["mode"] = mode.strip()
        agents.append(entry)
    return agents


def parse_opencode_agent_api_payload(payload: Any) -> list[dict[str, Any]]:
    """Parse the resolved ``GET /agent`` response, including plugin agents."""
    raw_agents = payload
    if isinstance(payload, dict):
        raw_agents = payload.get("agents", payload.get("data"))
    if not isinstance(raw_agents, list):
        return []

    agents: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in raw_agents:
        if not isinstance(raw, dict) or raw.get("hidden") is True:
            continue
        name = strip_zero_width(str(raw.get("name") or raw.get("id") or ""))
        if not name or name in seen or name in _EXCLUDED_AGENTS:
            continue
        seen.add(name)
        entry: dict[str, Any] = {
            "id": name,
            "name": name,
        }
        mode = raw.get("mode")
        if isinstance(mode, str) and mode.strip():
            entry["mode"] = mode.strip()
        label = raw.get("label") or raw.get("description")
        if isinstance(label, str) and label.strip():
            entry["label"] = label.strip()
        agents.append(entry)
    return agents


def merge_agent_snapshots(
    *snapshots: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Union successive ``/agent`` snapshots while plugins finish loading."""
    merged: list[dict[str, Any]] = []
    positions: dict[str, int] = {}
    for snapshot in snapshots:
        for raw in snapshot:
            name = strip_zero_width(str(raw.get("name") or raw.get("id") or ""))
            if not name or name in _EXCLUDED_AGENTS:
                continue
            item = dict(raw)
            item["id"] = name
            item["name"] = name
            if name in positions:
                merged[positions[name]].update(item)
            else:
                positions[name] = len(merged)
                merged.append(item)
    return merged


def parse_opencode_models_output(text: str) -> list[dict[str, Any]]:
    """Parse ``opencode models`` stdout (one ``provider/model`` per line)."""
    models: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or "/" not in line:
            continue
        if line.startswith("[") or line.startswith("{") or line.startswith('"'):
            continue
        # Plain listing lines are provider/model without spaces.
        if any(ch.isspace() for ch in line):
            continue
        provider, sep, model_id = line.partition("/")
        if not sep or not provider or not model_id:
            continue
        entry_id = f"{provider}/{model_id}"
        if entry_id in seen:
            continue
        seen.add(entry_id)
        models.append(
            {
                "id": entry_id,
                "providerID": provider,
                "modelID": model_id,
                "name": model_id,
                "default": False,
            }
        )
    return models


def choose_default_agent(agents: list[dict[str, Any]]) -> str | None:
    ids = [str(item.get("id") or "") for item in agents]
    if "build" in ids:
        return "build"
    return ids[0] if ids else None


def filter_models_by_providers(
    models: list[dict[str, Any]],
    providers: set[str] | None,
) -> list[dict[str, Any]]:
    if not providers:
        return models
    allowed = {item.strip() for item in providers if item and item.strip()}
    if not allowed:
        return models
    return [
        item
        for item in models
        if str(item.get("providerID") or "").strip() in allowed
    ]


def mark_default_model(
    models: list[dict[str, Any]],
    default_id: str | None,
) -> list[dict[str, Any]]:
    if not default_id:
        for item in models:
            item["default"] = False
        return models
    found = False
    for item in models:
        is_default = item.get("id") == default_id
        item["default"] = bool(is_default)
        found = found or is_default
    if not found and "/" in default_id:
        provider, _, model_id = default_id.partition("/")
        models.insert(
            0,
            {
                "id": default_id,
                "providerID": provider,
                "modelID": model_id,
                "name": model_id,
                "default": True,
            },
        )
    models.sort(key=lambda item: (not item.get("default"), str(item.get("id") or "")))
    return models


def provider_has_inline_api_key(provider_body: dict[str, Any]) -> bool:
    options = provider_body.get("options")
    if not isinstance(options, dict):
        return False
    api_key = options.get("apiKey")
    return isinstance(api_key, str) and bool(api_key.strip())


def models_from_config_providers(
    config: dict[str, Any] | None,
    *,
    credentialed: set[str] | None = None,
    require_usable: bool = False,
) -> list[dict[str, Any]]:
    """Build model entries from explicit ``provider.*.models`` definitions.

    When ``require_usable`` is True, only include providers that either embed an
    ``options.apiKey`` or appear in ``credentialed``.
    """
    data = config if isinstance(config, dict) else {}
    providers = data.get("provider")
    if not isinstance(providers, dict):
        return []
    allowed = {p.strip() for p in (credentialed or set()) if p and p.strip()}
    models: list[dict[str, Any]] = []
    seen: set[str] = set()
    for provider_id, provider_body in providers.items():
        if not isinstance(provider_id, str) or not provider_id.strip():
            continue
        provider = provider_body if isinstance(provider_body, dict) else {}
        if require_usable:
            usable = provider_has_inline_api_key(provider) or (
                provider_id.strip() in allowed
            )
            if not usable:
                continue
        provider_models = provider.get("models")
        if not isinstance(provider_models, dict) or not provider_models:
            continue
        for model_id, model_body in provider_models.items():
            if not isinstance(model_id, str) or not model_id.strip():
                continue
            entry_id = f"{provider_id.strip()}/{model_id.strip()}"
            if entry_id in seen:
                continue
            seen.add(entry_id)
            meta = model_body if isinstance(model_body, dict) else {}
            display = meta.get("name")
            if not isinstance(display, str) or not display.strip():
                display = model_id.strip()
            models.append(
                {
                    "id": entry_id,
                    "providerID": provider_id.strip(),
                    "modelID": model_id.strip(),
                    "name": display.strip(),
                    "default": False,
                }
            )
    return models


def merge_model_entries(
    *groups: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Union model lists by id; earlier groups win on display metadata."""
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for group in groups:
        for item in group:
            entry_id = str(item.get("id") or "")
            if not entry_id or entry_id in seen:
                continue
            seen.add(entry_id)
            merged.append(dict(item))
    return merged


def configured_user_agents(config: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Agents declared in user config with ``hidden`` not true."""
    data = config if isinstance(config, dict) else {}
    agents_map = data.get("agent")
    if not isinstance(agents_map, dict):
        return []
    agents: list[dict[str, Any]] = []
    for name, body in agents_map.items():
        if not isinstance(name, str) or not name.strip():
            continue
        agent_id = name.strip()
        if agent_id in _EXCLUDED_AGENTS:
            continue
        meta = body if isinstance(body, dict) else {}
        if meta.get("hidden") is True:
            continue
        entry: dict[str, Any] = {"id": agent_id, "name": agent_id}
        mode = meta.get("mode")
        if isinstance(mode, str) and mode.strip():
            entry["mode"] = mode.strip()
        agents.append(entry)
    return agents


def load_oh_my_agent_keys(
    *,
    config_home: Path | None = None,
    oh_my_config: dict[str, Any] | None = None,
) -> set[str]:
    """Return agent keys from oh-my-openagent / legacy oh-my-opencode config."""
    if oh_my_config is not None:
        agents_map = oh_my_config.get("agents")
        if not isinstance(agents_map, dict):
            return set()
        return {
            str(key).strip()
            for key in agents_map
            if isinstance(key, str) and key.strip()
        }

    home = config_home or (Path.home() / ".config" / "opencode")
    for filename in _OH_MY_CONFIG_NAMES:
        path = home / filename
        if not path.is_file():
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            continue
        if not isinstance(payload, dict):
            continue
        agents_map = payload.get("agents")
        if not isinstance(agents_map, dict):
            continue
        return {
            str(key).strip()
            for key in agents_map
            if isinstance(key, str) and key.strip()
        }
    return set()


def agent_matches_oh_my_key(cli_id: str, key: str) -> bool:
    """Match CLI display names to oh-my config keys (e.g. Sisyphus - Ultraworker)."""
    norm = strip_zero_width(cli_id).lower()
    key_l = strip_zero_width(key).lower()
    if not norm or not key_l:
        return False
    if norm == key_l:
        return True
    head = norm.split(" - ", 1)[0].strip()
    if head == key_l:
        return True
    compact_norm = re.sub(r"[\s_]+", "-", norm)
    compact_key = re.sub(r"[\s_]+", "-", key_l)
    if compact_norm == compact_key:
        return True
    if head.replace(" ", "-") == key_l:
        return True
    return False


def select_usable_agents(
    cli_agents: list[dict[str, Any]],
    *,
    config: dict[str, Any] | None = None,
    oh_my_keys: set[str] | None = None,
) -> list[dict[str, Any]]:
    """Prefer known builtins that appear in CLI, then config users, then oh-my matches.

    Does not synthesize missing ``build``/``plan``/``general``/``explore``.
    """
    by_id = {
        str(item.get("id") or ""): item
        for item in cli_agents
        if isinstance(item.get("id"), str)
    }
    selected: list[dict[str, Any]] = []
    seen: set[str] = set()

    for builtin in _BUILTIN_AGENTS:
        if builtin in seen or builtin not in by_id:
            continue
        selected.append(by_id[builtin])
        seen.add(builtin)

    for item in configured_user_agents(config):
        agent_id = str(item["id"])
        if agent_id in seen:
            continue
        selected.append(by_id.get(agent_id, item))
        seen.add(agent_id)

    keys = {k.strip() for k in (oh_my_keys or set()) if k and k.strip()}
    if keys:
        for item in cli_agents:
            agent_id = str(item.get("id") or "")
            if not agent_id or agent_id in seen or agent_id in _EXCLUDED_AGENTS:
                continue
            if any(agent_matches_oh_my_key(agent_id, key) for key in keys):
                selected.append(item)
                seen.add(agent_id)

    return selected


def _resolve_executable(executable: str | None = None) -> str | None:
    configured = (executable or "opencode").strip() or "opencode"
    has_separator = (
        ("/" in configured)
        or ("\\" in configured)
        or (configured.startswith("~"))
    )
    if has_separator:
        path = Path(configured).expanduser()
        return str(path) if path.is_file() else None
    return shutil.which(configured)


def _reserve_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _stop_process_tree(process: subprocess.Popen[Any]) -> None:
    if process.poll() is not None:
        return
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGTERM)
        else:
            process.terminate()
        process.wait(timeout=2.0)
        return
    except (OSError, subprocess.TimeoutExpired):
        pass
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
        process.wait(timeout=2.0)
    except (OSError, subprocess.TimeoutExpired):
        pass


def _list_agents_via_server(
    *,
    executable: str | None = None,
    timeout: float = _AGENT_SERVER_TIMEOUT_SECONDS,
) -> tuple[list[dict[str, Any]] | None, str | None]:
    """Load fully resolved agents through OpenCode's loopback ``/agent`` API."""
    resolved = _resolve_executable(executable)
    if resolved is None:
        return None, f"OpenCode executable {(executable or 'opencode')!r} not found"

    port = _reserve_loopback_port()
    env = dict(os.environ)
    env.pop("OPENCODE_SERVER_PASSWORD", None)
    popen_kwargs: dict[str, Any] = {
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "env": env,
    }
    if os.name == "posix":
        popen_kwargs["start_new_session"] = True
    elif os.name == "nt":
        popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP

    try:
        process = subprocess.Popen(
            [
                resolved,
                "serve",
                "--hostname",
                "127.0.0.1",
                "--port",
                str(port),
            ],
            **popen_kwargs,
        )
    except OSError as exc:
        return None, str(exc)

    deadline = time.monotonic() + max(1.0, timeout)
    last_error = "OpenCode agent endpoint did not become ready"
    agents: list[dict[str, Any]] = []
    settle_deadline: float | None = None
    try:
        while time.monotonic() < deadline:
            if process.poll() is not None:
                if agents:
                    return agents, None
                return None, f"OpenCode agent server exited with code {process.returncode}"
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/agent",
                    timeout=1.0,
                ) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                agents = merge_agent_snapshots(
                    agents,
                    parse_opencode_agent_api_payload(payload),
                )
                now = time.monotonic()
                if settle_deadline is None:
                    settle_deadline = min(
                        deadline,
                        now + _AGENT_SERVER_SETTLE_SECONDS,
                    )
                if now >= settle_deadline:
                    return agents, None
                time.sleep(0.1)
            except (
                OSError,
                UnicodeError,
                json.JSONDecodeError,
                urllib.error.URLError,
            ) as exc:
                last_error = str(exc)
                time.sleep(0.1)
        if agents:
            return agents, None
        return None, last_error
    finally:
        _stop_process_tree(process)


def _run_opencode_cli(
    args: list[str],
    *,
    executable: str | None = None,
    timeout: float = _CLI_TIMEOUT_SECONDS,
) -> tuple[str | None, str | None]:
    resolved = _resolve_executable(executable)
    if resolved is None:
        return None, f"OpenCode executable {(executable or 'opencode')!r} not found"
    try:
        completed = subprocess.run(
            [resolved, *args],
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, str(exc)
    stdout = completed.stdout or ""
    stderr = completed.stderr or ""
    if completed.returncode != 0 and not stdout.strip():
        detail = stderr.strip() or f"exit code {completed.returncode}"
        return None, detail
    return stdout, None


def configured_default_model(config: dict[str, Any] | None) -> str | None:
    data = config if isinstance(config, dict) else {}
    raw = data.get("model")
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    return None


def auth_provider_ids(auth_file: Path | None = None) -> set[str]:
    path = auth_file or (Path.home() / ".local" / "share" / "opencode" / "auth.json")
    if not path.is_file():
        return set()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return set()
    if not isinstance(payload, dict):
        return set()
    return {
        str(key).strip()
        for key in payload
        if isinstance(key, str) and key.strip()
    }


def env_provider_ids(environ: dict[str, str] | None = None) -> set[str]:
    env = environ if environ is not None else dict(os.environ)
    found: set[str] = set()
    for env_key, provider_id in _ENV_PROVIDER_HINTS:
        value = env.get(env_key)
        if isinstance(value, str) and value.strip():
            found.add(provider_id)
    return found


def parse_providers_list_output(text: str) -> set[str]:
    """Best-effort parse of ``opencode providers list`` for credentialed ids."""
    found: set[str] = set()
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        match = re.search(r"\b([a-z0-9][a-z0-9_-]{1,40})\b", line.lower())
        if match is None:
            continue
        token = match.group(1)
        if token in {"api", "credentials", "environment", "variables", "list"}:
            continue
        if re.fullmatch(r"[a-z][a-z0-9_-]+", token):
            found.add(token)
    return found


def credentialed_provider_ids(
    *,
    auth_providers: set[str] | None = None,
    providers_list_output: str | None = None,
    environ: dict[str, str] | None = None,
    executable: str | None = None,
) -> set[str]:
    providers: set[str] = set()
    if auth_providers is not None:
        providers |= {p.strip() for p in auth_providers if p and p.strip()}
    else:
        providers |= auth_provider_ids()
    providers |= env_provider_ids(environ)
    if providers_list_output is not None:
        providers |= parse_providers_list_output(providers_list_output)
    elif providers_list_output is None and executable is not None:
        stdout, _error = _run_opencode_cli(
            ["providers", "list"],
            executable=executable,
        )
        if stdout:
            providers |= parse_providers_list_output(stdout)
    return providers


def list_opencode_agents(
    *,
    executable: str | None = None,
    cli_output: str | None = None,
    agent_api_payload: Any | None = None,
    config: dict[str, Any] | None = None,
    oh_my_keys: set[str] | None = None,
    oh_my_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    note: str | None = None
    resolved_oh_my = (
        oh_my_keys
        if oh_my_keys is not None
        else load_oh_my_agent_keys(oh_my_config=oh_my_config)
    )
    if agent_api_payload is not None:
        agents = parse_opencode_agent_api_payload(agent_api_payload)
        return {
            "platform": "opencode",
            "default": choose_default_agent(agents),
            "agents": agents,
            "note": "Showing resolved non-hidden agents from OpenCode /agent.",
        }

    if cli_output is None:
        agents, server_error = _list_agents_via_server(executable=executable)
        if agents is not None:
            return {
                "platform": "opencode",
                "default": choose_default_agent(agents),
                "agents": agents,
                "note": "Showing resolved non-hidden agents from OpenCode /agent.",
            }
        stdout, error = _run_opencode_cli(
            ["agent", "list"],
            executable=executable,
        )
        if error is not None:
            agents = select_usable_agents(
                [],
                config=config,
                oh_my_keys=resolved_oh_my,
            )
            return {
                "platform": "opencode",
                "default": choose_default_agent(agents),
                "agents": agents,
                "note": "; ".join(filter(None, [server_error, error])),
            }
        text = stdout or ""
    else:
        text = cli_output

    cli_agents = parse_opencode_agent_list_output(text)
    agents = select_usable_agents(
        cli_agents,
        config=config,
        oh_my_keys=resolved_oh_my,
    )
    default = choose_default_agent(agents)
    if not agents:
        note = "No usable agents after filtering."
    else:
        note = (
            "OpenCode /agent unavailable; showing built-in agents, non-hidden "
            "user agents, and oh-my-openagent agents from CLI fallback."
        )
    return {
        "platform": "opencode",
        "default": default,
        "agents": agents,
        **({"note": note} if note else {}),
    }


def list_opencode_models(
    *,
    executable: str | None = None,
    cli_output: str | None = None,
    config: dict[str, Any] | None = None,
    auth_providers: set[str] | None = None,
    providers_list_output: str | None = None,
    environ: dict[str, str] | None = None,
) -> dict[str, Any]:
    note: str | None = None
    default_id = configured_default_model(config)

    credentialed = credentialed_provider_ids(
        auth_providers=auth_providers,
        providers_list_output=providers_list_output,
        environ=environ,
        executable=(
            executable
            if providers_list_output is None and cli_output is None
            else None
        ),
    )

    # Config models only when provider is usable (inline apiKey or credentialed).
    config_models = models_from_config_providers(
        config,
        credentialed=credentialed,
        require_usable=True,
    )

    # CLI catalog filtered to credentialed providers (auth/env), e.g. deepseek.
    if cli_output is None:
        stdout, error = _run_opencode_cli(
            ["models"],
            executable=executable,
        )
        if error is not None and not config_models:
            return {
                "platform": "opencode",
                "default": default_id,
                "models": [],
                "note": error,
            }
        text = stdout or ""
        cli_error = error
    else:
        text = cli_output
        cli_error = None

    cli_models = parse_opencode_models_output(text)
    if credentialed:
        cli_models = filter_models_by_providers(cli_models, credentialed)
    elif cli_models and not config_models:
        note = (
            "No usable config models and no credentialed providers found; "
            "showing full `opencode models` catalog."
        )

    models = merge_model_entries(config_models, cli_models)
    models = mark_default_model(models, default_id)

    if not models:
        note = cli_error or "No models available from usable config or credentialed CLI."
    elif note is None:
        parts: list[str] = []
        if config_models:
            parts.append("usable config provider.*.models")
        if credentialed:
            parts.append(
                "credentialed CLI providers ("
                + ", ".join(sorted(credentialed))
                + ")"
            )
        if parts:
            note = "Showing union of " + " and ".join(parts) + "."

    return {
        "platform": "opencode",
        "default": default_id,
        "models": models,
        **({"note": note} if note else {}),
    }
