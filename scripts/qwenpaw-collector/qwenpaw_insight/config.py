# Copyright (c) 2026 Huawei Technologies Co., Ltd.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Configuration loading for the QwenPaw AgentInsight collector."""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

# AC16: prompts / responses longer than 2000 characters are truncated.
DEFAULT_MAX_CONTENT_CHARS = 2_000
DEFAULT_TIMEOUT_SECONDS = 10.0
DEFAULT_RETRY_BASE_SECONDS = 1.0
DEFAULT_RETRY_MAX_SECONDS = 60.0
DEFAULT_SCAN_INTERVAL_SECONDS = 30.0
DEFAULT_SENT_RETENTION_SECONDS = 86_400.0  # 24h


def default_spool_dir() -> str:
    """AC3: spool directory created by the installer."""
    return str(Path.home() / ".agent-insight" / "otel_data" / "qwenpaw")


def ensure_spool_dir(config: "CollectorConfig") -> Path:
    """Create and return the configured spool root before collection starts."""
    spool_dir = Path(config.spool_dir).expanduser()
    spool_dir.mkdir(parents=True, exist_ok=True)
    return spool_dir


def default_log_file() -> str:
    return str(Path.home() / ".agent-insight" / "logs" / "qwenpaw-plugin.log")


@dataclass
class CollectorConfig:
    """Runtime configuration for the collector."""

    endpoint: str = ""
    api_key: str = ""
    service_name: str = "qwenpaw"
    enabled: bool = True
    max_content_chars: int = DEFAULT_MAX_CONTENT_CHARS
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    spool_dir: str = field(default_factory=default_spool_dir)
    log_file: str = field(default_factory=default_log_file)
    retry_base_seconds: float = DEFAULT_RETRY_BASE_SECONDS
    retry_max_seconds: float = DEFAULT_RETRY_MAX_SECONDS
    scan_interval_seconds: float = DEFAULT_SCAN_INTERVAL_SECONDS
    sent_retention_seconds: float = DEFAULT_SENT_RETENTION_SECONDS
    account_isolation: bool = True
    plugin_config: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _read_dotenv(path: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    try:
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            result[key.strip()] = value.strip().strip('"').strip("'")
    except OSError:
        pass
    return result


def _plugin_config_path() -> Path:
    # Package lives at <plugin_root>/qwenpaw_insight/config.py
    return Path(__file__).resolve().parent.parent / "config.json"


def _read_json(path: Path) -> dict[str, Any]:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8-sig"))
        return loaded if isinstance(loaded, dict) else {}
    except (OSError, ValueError):
        return {}


def load_config(existing: dict[str, Any] | None = None) -> CollectorConfig:
    """Load config with precedence: env > plugin config.json > ~/.agent-insight/.env > defaults."""

    plugin_cfg = _read_json(_plugin_config_path())
    if isinstance(existing, dict):
        plugin_cfg = {**plugin_cfg, **existing}

    user_env = _read_dotenv(Path.home() / ".agent-insight" / ".env")
    host = (
        os.getenv("AGENT_INSIGHT_HOST")
        or user_env.get("AGENT_INSIGHT_HOST")
        or plugin_cfg.get("host")
    )
    normalized_host = str(host).rstrip("/") if host else ""
    if normalized_host and not normalized_host.startswith(("http://", "https://")):
        normalized_host = f"http://{normalized_host}"

    endpoint = (
        os.getenv("AGENT_INSIGHT_OTLP_ENDPOINT")
        or os.getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
        or plugin_cfg.get("endpoint")
        or (f"{normalized_host}/api/ingest/otel/v1/traces" if normalized_host else "")
    )
    if endpoint and not str(endpoint).startswith(("http://", "https://")):
        endpoint = f"http://{str(endpoint).lstrip('/')}"

    api_key = (
        os.getenv("AGENT_INSIGHT_API_KEY")
        or user_env.get("AGENT_INSIGHT_API_KEY")
        or plugin_cfg.get("api_key")
        or ""
    )

    def _float(name: str, default: float) -> float:
        try:
            return float(plugin_cfg.get(name) or default)
        except (TypeError, ValueError):
            return default

    return CollectorConfig(
        endpoint=str(endpoint or ""),
        api_key=str(api_key or ""),
        service_name=str(plugin_cfg.get("service_name") or os.getenv("OTEL_SERVICE_NAME") or "qwenpaw"),
        enabled=bool(plugin_cfg.get("enabled", True)),
        max_content_chars=int(plugin_cfg.get("max_content_chars") or DEFAULT_MAX_CONTENT_CHARS),
        timeout_seconds=_float("timeout_seconds", DEFAULT_TIMEOUT_SECONDS),
        spool_dir=str(plugin_cfg.get("spool_dir") or default_spool_dir()),
        log_file=str(plugin_cfg.get("log_file") or default_log_file()),
        retry_base_seconds=_float("retry_base_seconds", DEFAULT_RETRY_BASE_SECONDS),
        retry_max_seconds=_float("retry_max_seconds", DEFAULT_RETRY_MAX_SECONDS),
        scan_interval_seconds=_float("scan_interval_seconds", DEFAULT_SCAN_INTERVAL_SECONDS),
        sent_retention_seconds=_float("sent_retention_seconds", DEFAULT_SENT_RETENTION_SECONDS),
        account_isolation=bool(plugin_cfg.get("account_isolation", True)),
        plugin_config=plugin_cfg,
    )


def save_config(config: CollectorConfig, path: Path | None = None) -> Path:
    """Persist runtime config (used by the CLI install command)."""

    target = path or _plugin_config_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "endpoint": config.endpoint,
        "api_key": config.api_key,
        "service_name": config.service_name,
        "enabled": config.enabled,
        "max_content_chars": config.max_content_chars,
        "timeout_seconds": config.timeout_seconds,
        "spool_dir": config.spool_dir,
        "log_file": config.log_file,
        "retry_base_seconds": config.retry_base_seconds,
        "retry_max_seconds": config.retry_max_seconds,
        "scan_interval_seconds": config.scan_interval_seconds,
        "sent_retention_seconds": config.sent_retention_seconds,
        "account_isolation": config.account_isolation,
    }
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return target
