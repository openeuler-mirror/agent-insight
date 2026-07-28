from __future__ import annotations

import getpass
import hashlib
import json
import os
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any


def _default_home() -> Path:
    return Path(os.environ.get("AGENT_INSIGHT_HOME", Path.home() / ".agent-insight"))


def _default_spool_root() -> Path:
    return _default_home() / "otel_data" / "llamaindex"


def _account_namespace(api_key: str) -> str:
    if not api_key:
        return "unconfigured"
    digest = hashlib.sha256(api_key.encode("utf-8")).hexdigest()[:16]
    return f"account-{digest}"


def _default_spool_dir(api_key: str = "") -> Path:
    return _default_spool_root() / _account_namespace(api_key) / "spool"


def _default_user() -> str:
    return (
        os.environ.get("AGENT_INSIGHT_USER")
        or os.environ.get("USER")
        or os.environ.get("USERNAME")
        or getpass.getuser()
        or "anonymous"
    )


def _env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() not in {"0", "false", "no", "off", ""}


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _normalize_endpoint(value: str) -> str:
    endpoint = value.strip().rstrip("/")
    if not endpoint:
        return ""
    if endpoint.endswith("/api/ingest/otel/v1/traces") or endpoint.endswith("/v1/traces"):
        return endpoint
    return f"{endpoint}/api/ingest/otel/v1/traces"


@dataclass(slots=True)
class CollectorConfig:
    endpoint: str = ""
    api_key: str = ""
    service_name: str = "llamaindex"
    user: str = field(default_factory=_default_user)
    spool_dir: Path = field(default_factory=_default_spool_dir)
    config_path: Path = field(default_factory=lambda: _default_home() / "llamaindex.json")
    enabled: bool = True
    capture_content: bool = True
    max_content_chars: int = 2_000
    queue_size: int = 2048
    max_open_spans: int = 2048
    batch_size: int = 64
    flush_interval_seconds: float = 2.0
    upload_interval_seconds: float = 2.0
    request_timeout_seconds: float = 10.0
    retry_base_seconds: float = 1.0
    retry_max_seconds: float = 60.0
    spool_claim_timeout_seconds: float = 300.0
    spool_max_bytes: int = 512 * 1024 * 1024

    def __post_init__(self) -> None:
        self.endpoint = _normalize_endpoint(self.endpoint)
        if self.spool_dir in {
            _default_spool_dir(),
            _default_home() / "data" / "llamaindex-spool",
        }:
            self.spool_dir = _default_spool_dir(self.api_key)
        self.spool_dir = Path(self.spool_dir).expanduser()
        self.config_path = Path(self.config_path).expanduser()
        self.max_content_chars = max(0, self.max_content_chars)
        self.queue_size = max(16, self.queue_size)
        self.max_open_spans = max(16, self.max_open_spans)
        self.batch_size = max(1, self.batch_size)
        self.flush_interval_seconds = max(0.05, self.flush_interval_seconds)
        self.upload_interval_seconds = max(0.05, self.upload_interval_seconds)
        self.request_timeout_seconds = max(0.1, self.request_timeout_seconds)
        self.retry_base_seconds = max(0.05, self.retry_base_seconds)
        self.retry_max_seconds = max(self.retry_base_seconds, self.retry_max_seconds)
        self.spool_claim_timeout_seconds = max(1.0, self.spool_claim_timeout_seconds)
        self.spool_max_bytes = max(1024 * 1024, self.spool_max_bytes)

    @classmethod
    def load(cls, **overrides: Any) -> CollectorConfig:
        config_path = Path(
            overrides.get("config_path")
            or os.environ.get("AGENT_INSIGHT_LLAMA_CONFIG")
            or (_default_home() / "llamaindex.json")
        ).expanduser()
        stored: dict[str, Any] = {}
        if config_path.is_file():
            try:
                value = json.loads(config_path.read_text(encoding="utf-8"))
                if isinstance(value, dict):
                    stored = value
            except (OSError, json.JSONDecodeError):
                stored = {}

        environment_spool = os.environ.get("AGENT_INSIGHT_LLAMA_SPOOL_DIR")
        env: dict[str, Any] = {
            "endpoint": os.environ.get("AGENT_INSIGHT_OTLP_ENDPOINT")
            or os.environ.get("AGENT_INSIGHT_HOST"),
            "api_key": os.environ.get("AGENT_INSIGHT_API_KEY"),
            "service_name": os.environ.get("AGENT_INSIGHT_LLAMA_SERVICE_NAME"),
            "user": os.environ.get("AGENT_INSIGHT_USER"),
            "spool_dir": environment_spool,
            "enabled": _env_bool("AGENT_INSIGHT_LLAMA_ENABLED", True)
            if "AGENT_INSIGHT_LLAMA_ENABLED" in os.environ
            else None,
            "capture_content": _env_bool("AGENT_INSIGHT_LLAMA_CAPTURE_CONTENT", True)
            if "AGENT_INSIGHT_LLAMA_CAPTURE_CONTENT" in os.environ
            else None,
            "max_content_chars": _env_int("AGENT_INSIGHT_LLAMA_MAX_CONTENT_CHARS", 2_000)
            if "AGENT_INSIGHT_LLAMA_MAX_CONTENT_CHARS" in os.environ
            else None,
            "queue_size": _env_int("AGENT_INSIGHT_LLAMA_QUEUE_SIZE", 2048)
            if "AGENT_INSIGHT_LLAMA_QUEUE_SIZE" in os.environ
            else None,
            "max_open_spans": _env_int("AGENT_INSIGHT_LLAMA_MAX_OPEN_SPANS", 2048)
            if "AGENT_INSIGHT_LLAMA_MAX_OPEN_SPANS" in os.environ
            else None,
            "batch_size": _env_int("AGENT_INSIGHT_LLAMA_BATCH_SIZE", 64)
            if "AGENT_INSIGHT_LLAMA_BATCH_SIZE" in os.environ
            else None,
            "spool_max_bytes": _env_int(
                "AGENT_INSIGHT_LLAMA_SPOOL_MAX_BYTES", 512 * 1024 * 1024
            )
            if "AGENT_INSIGHT_LLAMA_SPOOL_MAX_BYTES" in os.environ
            else None,
            "spool_claim_timeout_seconds": _env_int(
                "AGENT_INSIGHT_LLAMA_SPOOL_CLAIM_TIMEOUT_SECONDS", 300
            )
            if "AGENT_INSIGHT_LLAMA_SPOOL_CLAIM_TIMEOUT_SECONDS" in os.environ
            else None,
        }
        valid = {item.name for item in fields(cls)}
        values = {key: value for key, value in stored.items() if key in valid}
        values.update({key: value for key, value in env.items() if value is not None})
        values.update({key: value for key, value in overrides.items() if value is not None})
        values["config_path"] = config_path
        explicit_spool = overrides.get("spool_dir") or environment_spool
        if not explicit_spool:
            candidate = Path(values.get("spool_dir") or _default_spool_dir()).expanduser()
            default_root = _default_spool_root().expanduser()
            old_default = (_default_home() / "data" / "llamaindex-spool").expanduser()
            try:
                is_managed = candidate == old_default or candidate.is_relative_to(default_root)
            except (OSError, ValueError):
                is_managed = False
            if is_managed:
                values["spool_dir"] = _default_spool_dir(str(values.get("api_key") or ""))
        return cls(**values)

    def write(self) -> None:
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        payload = asdict(self)
        payload["spool_dir"] = str(self.spool_dir)
        payload["config_path"] = str(self.config_path)
        temporary = self.config_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        os.chmod(temporary, 0o600)
        os.replace(temporary, self.config_path)
        os.chmod(self.config_path, 0o600)

    @property
    def ready(self) -> bool:
        return self.enabled and bool(self.endpoint and self.api_key)

    def redacted(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["api_key"] = f"***{self.api_key[-4:]}" if self.api_key else ""
        payload["spool_dir"] = str(self.spool_dir)
        payload["config_path"] = str(self.config_path)
        return payload
