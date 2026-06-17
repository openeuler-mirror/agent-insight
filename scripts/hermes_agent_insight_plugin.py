from __future__ import annotations

import atexit
import hashlib
import json
import os
import queue
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Iterable, Optional


PLUGIN_VERSION = "0.2.0"
DEFAULT_MAX_CONTENT_CHARS = 200_000
DEFAULT_LOG_MAX_BYTES = 2 * 1024 * 1024


def _now_ns() -> int:
    return time.time_ns()


def _seconds_to_ns(value: Any) -> Optional[int]:
    try:
        return int(float(value) * 1_000_000_000)
    except (TypeError, ValueError):
        return None


def _stable_hex(value: str, length: int) -> str:
    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()[:length]


def _json_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    try:
        return json.dumps(value, ensure_ascii=False, default=str, separators=(",", ":"))
    except Exception:
        return str(value)


def _limited_text(value: Any, max_chars: int) -> tuple[str, bool, int]:
    text = _json_text(value)
    original_chars = len(text)
    if max_chars > 0 and original_chars > max_chars:
        return text[:max_chars], True, original_chars
    return text, False, original_chars


def _get(value: Any, key: str, default: Any = None) -> Any:
    if isinstance(value, dict):
        return value.get(key, default)
    return getattr(value, key, default)


def _first(*values: Any) -> Any:
    for value in values:
        if value is not None and value != "":
            return value
    return None


def _content_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (str, bytes)):
        return _json_text(value)
    if isinstance(value, list):
        return "\n".join(part for part in (_content_text(item) for item in value) if part)
    if isinstance(value, dict):
        for key in ("text", "output_text", "content", "parts"):
            text = _content_text(value.get(key))
            if text:
                return text
        if value.get("type") in ("text", "output_text"):
            return _json_text(value.get("value"))
        return ""
    for key in ("text", "output_text", "content"):
        text = _content_text(_get(value, key))
        if text:
            return text
    return ""


def _message_content(message: Any) -> str:
    if isinstance(message, (str, bytes, list)):
        return _content_text(message)
    return _content_text(_get(message, "content"))


def _response_text(kwargs: Dict[str, Any]) -> str:
    assistant_message = kwargs.get("assistant_message")
    text = _message_content(assistant_message)
    if text:
        return text

    response = kwargs.get("response")
    text = _message_content(_get(response, "assistant_message"))
    if text:
        return text

    choices = _get(response, "choices", []) or []
    for choice in choices:
        text = _message_content(_first(_get(choice, "message"), _get(choice, "delta"), choice))
        if text:
            return text

    text = _content_text(_get(response, "output"))
    if text:
        return text

    for candidate in _get(response, "candidates", []) or []:
        text = _content_text(_first(_get(candidate, "content"), _get(candidate, "output"), candidate))
        if text:
            return text

    return _content_text(_first(
        kwargs.get("response_content"),
        kwargs.get("assistant_response"),
        _get(response, "output_text"),
    ))


def _read_dotenv(path: Path) -> Dict[str, str]:
    result: Dict[str, str] = {}
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


def _load_config() -> Dict[str, Any]:
    plugin_dir = Path(__file__).resolve().parent
    config: Dict[str, Any] = {}
    try:
        loaded = json.loads((plugin_dir / "config.json").read_text(encoding="utf-8-sig"))
        if isinstance(loaded, dict):
            config.update(loaded)
    except (OSError, ValueError):
        pass

    env_file = _read_dotenv(Path.home() / ".agent-insight" / ".env")
    host = _first(
        os.getenv("AGENT_INSIGHT_HOST"),
        env_file.get("AGENT_INSIGHT_HOST"),
        config.get("host"),
    )
    normalized_host = str(host).rstrip("/") if host else ""
    if normalized_host and not normalized_host.startswith(("http://", "https://")):
        normalized_host = f"http://{normalized_host}"
    endpoint = _first(
        os.getenv("AGENT_INSIGHT_OTLP_ENDPOINT"),
        config.get("endpoint"),
        f"{normalized_host}/api/ingest/otel/v1/traces" if normalized_host else None,
    )
    if endpoint and not str(endpoint).startswith(("http://", "https://")):
        endpoint = f"http://{str(endpoint).lstrip('/')}"
    api_key = _first(
        os.getenv("AGENT_INSIGHT_API_KEY"),
        env_file.get("AGENT_INSIGHT_API_KEY"),
        config.get("api_key"),
    )
    config["endpoint"] = endpoint or ""
    config["api_key"] = api_key or ""
    config.setdefault("service_name", "hermes")
    config.setdefault("max_content_chars", DEFAULT_MAX_CONTENT_CHARS)
    config.setdefault("timeout_seconds", 10)
    config.setdefault("spool_dir", str(Path.home() / ".agent-insight" / "data" / "hermes-otel-spool"))
    config.setdefault("log_file", str(Path.home() / ".agent-insight" / "logs" / "hermes-plugin.log"))
    config.setdefault("retry_base_seconds", 1)
    config.setdefault("retry_max_seconds", 60)
    return config


def _profile_name_from_home_path(home_path: Any) -> str:
    raw = str(home_path or "").strip()
    if not raw:
        return ""
    try:
        path = Path(raw).expanduser().resolve()
    except Exception:
        path = Path(raw).expanduser()
    if path.parent.name == "profiles" and path.name:
        return path.name
    return ""


def _resolve_active_profile_name() -> str:
    try:
        from hermes_constants import get_hermes_home  # type: ignore

        name = _profile_name_from_home_path(get_hermes_home())
        if name:
            return name
    except Exception:
        pass

    name = _profile_name_from_home_path(os.getenv("HERMES_HOME"))
    if name:
        return name

    env_profile = str(os.getenv("HERMES_PROFILE") or "").strip()
    if env_profile:
        return env_profile

    try:
        from hermes_cli.profiles import get_active_profile_name  # type: ignore

        name = str(get_active_profile_name() or "").strip()
        return name or "default"
    except Exception:
        return "default"


def _agent_name_from_profile(profile_name: Any) -> str:
    name = str(profile_name or "").strip()
    if not name or name.lower() == "default":
        return "hermes"
    return name


def _otel_value(value: Any) -> Dict[str, Any]:
    if isinstance(value, bool):
        return {"boolValue": value}
    if isinstance(value, int):
        return {"intValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    return {"stringValue": _json_text(value)}


def _attributes(values: Dict[str, Any]) -> list[Dict[str, Any]]:
    return [
        {"key": key, "value": _otel_value(value)}
        for key, value in values.items()
        if value is not None and value != ""
    ]


class _FileLogger:
    def __init__(self, path: str, max_bytes: int = DEFAULT_LOG_MAX_BYTES) -> None:
        self.path = Path(path).expanduser()
        self.max_bytes = max_bytes
        self.lock = threading.Lock()

    def write(self, level: str, message: str) -> None:
        try:
            with self.lock:
                self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                if self.path.exists() and self.path.stat().st_size >= self.max_bytes:
                    rotated = self.path.with_suffix(self.path.suffix + ".1")
                    try:
                        rotated.unlink(missing_ok=True)
                        self.path.replace(rotated)
                    except OSError:
                        pass
                timestamp = time.strftime("%Y-%m-%dT%H:%M:%S%z")
                with self.path.open("a", encoding="utf-8") as handle:
                    handle.write(f"{timestamp} {level.upper()} {message}\n")
                try:
                    self.path.chmod(0o600)
                except OSError:
                    pass
        except OSError:
            pass


class _SnapshotExporter:
    def __init__(self, config: Dict[str, Any]) -> None:
        self.endpoint = str(config.get("endpoint") or "")
        self.api_key = str(config.get("api_key") or "")
        self.service_name = str(config.get("service_name") or "hermes")
        self.timeout = float(config.get("timeout_seconds") or 10)
        self.retry_base = max(0.1, float(config.get("retry_base_seconds") or 1))
        self.retry_max = max(self.retry_base, float(config.get("retry_max_seconds") or 60))
        self.spool_dir = Path(str(config.get("spool_dir") or (Path.home() / ".agent-insight" / "data" / "hermes-otel-spool"))).expanduser()
        self.spool_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.logger = _FileLogger(str(config.get("log_file") or (Path.home() / ".agent-insight" / "logs" / "hermes-plugin.log")))
        self._queue: queue.PriorityQueue[tuple[float, int, Optional[Path]]] = queue.PriorityQueue()
        self._lock = threading.Lock()
        self._scheduled: set[Path] = set()
        self._attempts: Dict[Path, int] = {}
        self._sequence = 0
        self._stopping = False
        for path in self.spool_dir.glob("*.json"):
            self._schedule(path)
        self._worker = threading.Thread(target=self._run, name="agent-insight-hermes-exporter", daemon=True)
        self._worker.start()
        self.logger.write("info", f"exporter started spool={self.spool_dir} endpoint_configured={bool(self.endpoint)}")

    def submit(self, root_id: str, payload: Dict[str, Any]) -> None:
        path = self.spool_dir / f"{_stable_hex(root_id, 32)}.json"
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        temp_path = path.with_name(f".{path.name}.{threading.get_ident()}.tmp")
        try:
            temp_path.write_bytes(data)
            try:
                temp_path.chmod(0o600)
            except OSError:
                pass
            os.replace(temp_path, path)
            self._schedule(path)
        except OSError as error:
            self.logger.write("error", f"spool write failed type={type(error).__name__}")
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass

    def _schedule(self, path: Path, due: Optional[float] = None) -> None:
        with self._lock:
            if self._stopping or path in self._scheduled:
                return
            self._scheduled.add(path)
            self._sequence += 1
            self._queue.put((due if due is not None else time.monotonic(), self._sequence, path))

    def flush(self, timeout: float = 3.0) -> None:
        deadline = time.monotonic() + timeout
        while self._queue.unfinished_tasks and time.monotonic() < deadline:
            time.sleep(0.02)

    def close(self) -> None:
        self.flush()
        with self._lock:
            self._stopping = True
            self._sequence += 1
            self._queue.put((time.monotonic(), self._sequence, None))

    def _run(self) -> None:
        while True:
            due, sequence, path = self._queue.get()
            needs_task_done = True
            try:
                if path is None:
                    return
                delay = due - time.monotonic()
                if delay > 0:
                    self._queue.task_done()
                    needs_task_done = False
                    self._queue.put((due, sequence, path))
                    time.sleep(min(delay, 0.25))
                    continue
                with self._lock:
                    self._scheduled.discard(path)
                self._send_path(path)
            finally:
                if needs_task_done:
                    self._queue.task_done()

    def _send_path(self, path: Path) -> None:
        try:
            data = path.read_bytes()
            json.loads(data.decode("utf-8"))
        except (OSError, ValueError, UnicodeError) as error:
            self.logger.write("error", f"spool read failed file={path.name} type={type(error).__name__}")
            return

        success, retryable, detail = self._send(data)
        if success:
            self._attempts.pop(path, None)
            self.logger.write("info", f"export success file={path.name} bytes={len(data)} detail={detail}")
            try:
                if path.read_bytes() == data:
                    path.unlink(missing_ok=True)
                else:
                    self._schedule(path)
            except OSError as error:
                self.logger.write("warning", f"spool cleanup failed file={path.name} type={type(error).__name__}")
            return

        if retryable:
            attempt = self._attempts.get(path, 0) + 1
            self._attempts[path] = attempt
            delay = min(self.retry_max, self.retry_base * (2 ** min(attempt - 1, 8)))
            self.logger.write("warning", f"export retry file={path.name} attempt={attempt} delay={delay:.1f}s detail={detail}")
            self._schedule(path, time.monotonic() + delay)
        else:
            self.logger.write("error", f"export paused file={path.name} detail={detail}")

    def _send(self, data: bytes) -> tuple[bool, bool, str]:
        if not self.endpoint:
            return False, False, "endpoint_not_configured"
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["x-witty-api-key"] = self.api_key
        request = urllib.request.Request(
            self.endpoint,
            data=data,
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                response.read()
                status = int(getattr(response, "status", 200) or 200)
                return 200 <= status < 300, status in (408, 429) or status >= 500, f"http_{status}"
        except urllib.error.HTTPError as error:
            status = int(error.code or 0)
            return False, status in (408, 429) or status >= 500, f"http_{status}"
        except (OSError, urllib.error.URLError) as error:
            return False, True, type(error).__name__


class _Collector:
    def __init__(self, config: Optional[Dict[str, Any]] = None) -> None:
        self.config = config or _load_config()
        self.max_chars = int(self.config.get("max_content_chars") or DEFAULT_MAX_CONTENT_CHARS)
        self.root_profile_name = _resolve_active_profile_name()
        self.root_agent_name = _agent_name_from_profile(self.root_profile_name)
        self.exporter = _SnapshotExporter(self.config)
        self.lock = threading.RLock()
        self.sessions: Dict[str, Dict[str, Any]] = {}
        self.turns: Dict[tuple[str, str], Dict[str, Any]] = {}
        self.current_turn: Dict[str, str] = {}
        self.api_spans: Dict[str, Dict[str, Any]] = {}
        self.tool_spans: Dict[str, Dict[str, Any]] = {}
        self.subagents: Dict[str, Dict[str, Any]] = {}
        self.completed_by_root: Dict[str, Dict[str, Dict[str, Any]]] = {}
        self.ended_roots: set[str] = set()

    def close(self) -> None:
        self.exporter.close()

    def _session_id(self, kwargs: Dict[str, Any]) -> str:
        return str(_first(kwargs.get("session_id"), kwargs.get("child_session_id"), "unknown"))

    def _root_id(self, session_id: str) -> str:
        return str(self.sessions.get(session_id, {}).get("root_session_id") or session_id)

    def _trace_id(self, root_session_id: str) -> str:
        return _stable_hex(f"agent-insight:hermes:trace:{root_session_id}", 32)

    def _span_id(self, *parts: Any) -> str:
        return _stable_hex("agent-insight:hermes:span:" + ":".join(map(str, parts)), 16)

    def _base_attributes(self, session_id: str, model: Any = None) -> Dict[str, Any]:
        state = self.sessions.get(session_id, {})
        root_id = self._root_id(session_id)
        role = state.get("role") or "root"
        root_profile_name = str(getattr(self, "root_profile_name", "default") or "default")
        root_agent_name = str(getattr(self, "root_agent_name", _agent_name_from_profile(root_profile_name)) or "hermes")
        agent_name = state.get("agent_name") or (root_agent_name if role == "root" else role)
        return {
            "service.name": self.config.get("service_name", "hermes"),
            "agent.insight.framework": "hermes",
            "session.id": root_id,
            "hermes.session_id": session_id,
            "hermes.root_session_id": root_id,
            "hermes.parent_session_id": state.get("parent_session_id"),
            "hermes.subagent.id": state.get("subagent_id"),
            "hermes.subagent.parent_id": state.get("parent_subagent_id"),
            "hermes.agent.role": role,
            "hermes.agent.name": agent_name,
            "hermes.profile.name": state.get("profile_name") or root_profile_name,
            "llm.model_name": model,
            "agent.insight.plugin.version": PLUGIN_VERSION,
        }

    def _new_span(
        self,
        name: str,
        session_id: str,
        span_id: str,
        parent_span_id: Optional[str],
        attributes: Dict[str, Any],
        start_ns: Optional[int] = None,
    ) -> Dict[str, Any]:
        root_id = self._root_id(session_id)
        return {
            "traceId": self._trace_id(root_id),
            "spanId": span_id,
            "parentSpanId": parent_span_id or "",
            "name": name,
            "kind": 1,
            "startTimeUnixNano": str(start_ns or _now_ns()),
            "endTimeUnixNano": str(start_ns or _now_ns()),
            "attributes": _attributes(attributes),
            "status": {"code": 1},
        }

    def _finish_span(self, span: Dict[str, Any], attributes: Dict[str, Any], end_ns: Optional[int] = None) -> None:
        merged: Dict[str, Any] = {}
        for item in span.get("attributes", []):
            key = item.get("key")
            value = item.get("value", {})
            if key:
                merged[key] = next(iter(value.values()), "")
        merged.update(attributes)
        span["attributes"] = _attributes(merged)
        span["endTimeUnixNano"] = str(end_ns or _now_ns())

    def _complete(self, session_id: str, span: Dict[str, Any]) -> None:
        root_id = self._root_id(session_id)
        spans = self.completed_by_root.setdefault(root_id, {})
        spans[str(span["spanId"])] = span
        self.exporter.submit(root_id, self._payload(root_id, spans.values()))

    def _payload(self, root_id: str, spans: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
        resource_attrs = {
            "service.name": self.config.get("service_name", "hermes"),
            "agent.insight.framework": "hermes",
            "session.id": root_id,
            "service.instance.id": root_id,
        }
        return {
            "resourceSpans": [
                {
                    "resource": {"attributes": _attributes(resource_attrs)},
                    "scopeSpans": [
                        {
                            "scope": {"name": "agent-insight-hermes", "version": PLUGIN_VERSION},
                            "spans": sorted(spans, key=lambda item: int(item["startTimeUnixNano"])),
                        }
                    ],
                }
            ]
        }

    def _cleanup_root(self, root_id: str) -> None:
        session_ids = {
            sid for sid in self.sessions
            if sid == root_id or self._root_id(sid) == root_id
        }
        span_count = len(self.completed_by_root.get(root_id, {}))
        self.completed_by_root.pop(root_id, None)
        self.ended_roots.discard(root_id)
        for sid in session_ids:
            self.sessions.pop(sid, None)
            self.current_turn.pop(sid, None)
        self.turns = {key: value for key, value in self.turns.items() if key[0] not in session_ids}
        self.api_spans = {
            key: value for key, value in self.api_spans.items()
            if value.get("session_id") not in session_ids
        }
        self.tool_spans = {
            key: value for key, value in self.tool_spans.items()
            if value.get("session_id") not in session_ids
        }
        self.subagents = {
            key: value for key, value in self.subagents.items()
            if key not in session_ids and value.get("parent_session_id") not in session_ids
        }
        self.exporter.logger.write(
            "info",
            f"root state cleaned root={root_id} sessions={len(session_ids)} spans={span_count}",
        )

    def _maybe_cleanup_root(self, root_id: str) -> bool:
        if root_id not in self.ended_roots:
            return False
        active_children = [
            child_session_id for child_session_id in self.subagents
            if self._root_id(child_session_id) == root_id
        ]
        if active_children:
            self.exporter.logger.write(
                "info",
                f"root cleanup deferred root={root_id} active_subagents={len(active_children)}",
            )
            return False
        self._cleanup_root(root_id)
        return True

    def pre_llm_call(self, **kwargs: Any) -> None:
        with self.lock:
            session_id = self._session_id(kwargs)
            turn_id = str(_first(kwargs.get("turn_id"), kwargs.get("task_id"), _now_ns()))
            model = kwargs.get("model")
            self.current_turn[session_id] = turn_id
            session_state = self.sessions.setdefault(
                session_id,
                {
                    "root_session_id": session_id,
                    "role": "root",
                    "agent_name": self.root_agent_name,
                    "profile_name": self.root_profile_name,
                },
            )
            session_state.setdefault("agent_name", self.root_agent_name)
            session_state.setdefault("profile_name", self.root_profile_name)
            parent_span_id = session_state.get("container_span_id")
            agent_span = None
            if session_state.get("role") == "root":
                agent_span = self._new_span(
                    "agent",
                    session_id,
                    self._span_id(session_id, turn_id, "agent"),
                    None,
                    {
                        **self._base_attributes(session_id, model),
                        "openinference.span.kind": "AGENT",
                        "input.value": kwargs.get("user_message"),
                        "llm.input.value": kwargs.get("user_message"),
                    },
                )
                parent_span_id = agent_span["spanId"]
            llm_span = self._new_span(
                f"llm.{model or 'unknown'}",
                session_id,
                self._span_id(session_id, turn_id, "llm"),
                parent_span_id,
                {
                    **self._base_attributes(session_id, model),
                    "openinference.span.kind": "LLM",
                    "input.value": kwargs.get("user_message"),
                    "llm.input.value": kwargs.get("user_message"),
                    "llm.input_messages": kwargs.get("conversation_history"),
                },
            )
            self.turns[(session_id, turn_id)] = {
                "agent": agent_span,
                "llm": llm_span,
                "model": model,
            }

    def pre_api_request(self, **kwargs: Any) -> None:
        with self.lock:
            session_id = self._session_id(kwargs)
            turn_id = str(_first(kwargs.get("turn_id"), self.current_turn.get(session_id), "unknown"))
            request_id = str(_first(kwargs.get("api_request_id"), f"{session_id}:{turn_id}:{kwargs.get('api_call_count', 0)}"))
            turn = self.turns.get((session_id, turn_id), {})
            model = kwargs.get("model") or turn.get("model")
            self.api_spans[request_id] = {
                "session_id": session_id,
                "span": self._new_span(
                    f"api.{model or 'unknown'}",
                    session_id,
                    self._span_id(session_id, request_id, "api"),
                    _get(turn.get("llm"), "spanId"),
                    {
                        **self._base_attributes(session_id, model),
                        "openinference.span.kind": "LLM",
                        "gen_ai.operation.name": "chat",
                        "gen_ai.request.model": model,
                        "llm.input_messages": kwargs.get("request_messages"),
                        "input.value": kwargs.get("request_messages"),
                        "hermes.api_request_id": request_id,
                        "hermes.provider": kwargs.get("provider"),
                    },
                ),
            }

    def post_api_request(self, **kwargs: Any) -> None:
        with self.lock:
            request_id = str(_first(kwargs.get("api_request_id"), ""))
            state = self.api_spans.pop(request_id, None)
            if not state:
                return
            session_id = state["session_id"]
            output, truncated, original_chars = _limited_text(_response_text(kwargs), self.max_chars)
            usage = kwargs.get("usage") or {}
            self._finish_span(
                state["span"],
                {
                    "output.value": output,
                    "llm.output.content": output,
                    "llm.response.output_chars": original_chars,
                    "agent.insight.content.truncated": truncated,
                    "llm.token_count.prompt": _first(_get(usage, "prompt_tokens"), _get(usage, "input_tokens")),
                    "llm.token_count.completion": _first(_get(usage, "completion_tokens"), _get(usage, "output_tokens")),
                    "llm.token_count.total": _get(usage, "total_tokens"),
                    "gen_ai.response.finish_reasons": kwargs.get("finish_reason"),
                    "llm.response.finish_reason": kwargs.get("finish_reason"),
                },
            )
            self._complete(session_id, state["span"])

    def api_request_error(self, **kwargs: Any) -> None:
        with self.lock:
            request_id = str(_first(kwargs.get("api_request_id"), ""))
            state = self.api_spans.pop(request_id, None)
            if state:
                session_id = state["session_id"]
                span = state["span"]
            else:
                session_id = self._session_id(kwargs)
                turn_id = str(_first(kwargs.get("turn_id"), self.current_turn.get(session_id), "unknown"))
                model = kwargs.get("model")
                turn = self.turns.get((session_id, turn_id), {})
                span = self._new_span(
                    f"api.{model or turn.get('model') or 'unknown'}",
                    session_id,
                    self._span_id(session_id, request_id or _now_ns(), "api-error"),
                    _get(turn.get("llm"), "spanId"),
                    {
                        **self._base_attributes(session_id, model or turn.get("model")),
                        "openinference.span.kind": "LLM",
                        "gen_ai.operation.name": "chat",
                        "input.value": kwargs.get("request"),
                        "hermes.api_request_id": request_id,
                    },
                    start_ns=_seconds_to_ns(kwargs.get("started_at")),
                )
            error = kwargs.get("error") or {}
            error_type = _first(_get(error, "type"), kwargs.get("reason"), "api_request_error")
            error_message = _first(_get(error, "message"), kwargs.get("reason"), "Hermes API request failed")
            self._finish_span(
                span,
                {
                    "error.type": error_type,
                    "error.message": error_message,
                    "http.response.status_code": kwargs.get("status_code"),
                    "hermes.retry_count": kwargs.get("retry_count"),
                    "hermes.max_retries": kwargs.get("max_retries"),
                    "hermes.retryable": kwargs.get("retryable"),
                    "hermes.api_error.reason": kwargs.get("reason"),
                    "hermes.api_duration": kwargs.get("api_duration"),
                    "llm.response.finish_reason": "error",
                },
                end_ns=_seconds_to_ns(kwargs.get("ended_at")),
            )
            span["status"] = {"code": 2, "message": str(error_message)}
            self._complete(session_id, span)

    def pre_tool_call(self, **kwargs: Any) -> None:
        with self.lock:
            tool_name = str(_first(kwargs.get("tool_name"), "unknown"))
            if tool_name == "delegate_task":
                return
            session_id = self._session_id(kwargs)
            turn_id = str(_first(kwargs.get("turn_id"), self.current_turn.get(session_id), "unknown"))
            tool_call_id = str(_first(kwargs.get("tool_call_id"), f"{session_id}:{turn_id}:{tool_name}:{_now_ns()}"))
            turn = self.turns.get((session_id, turn_id), {})
            attributes = {
                **self._base_attributes(session_id, turn.get("model")),
                "openinference.span.kind": "TOOL",
                "tool.name": tool_name,
                "tool.call.id": tool_call_id,
                "tool.input": kwargs.get("args"),
                "input.value": kwargs.get("args"),
            }
            if tool_name == "skill_view":
                attributes["hermes.skill.name"] = _first(
                    _get(kwargs.get("args"), "name"),
                    _get(kwargs.get("args"), "skill"),
                    _get(kwargs.get("args"), "skill_name"),
                )
            self.tool_spans[tool_call_id] = {
                "session_id": session_id,
                "span": self._new_span(
                    f"tool.{tool_name}",
                    session_id,
                    self._span_id(session_id, tool_call_id, "tool"),
                    _get(turn.get("llm"), "spanId"),
                    attributes,
                ),
            }

    def post_tool_call(self, **kwargs: Any) -> None:
        with self.lock:
            tool_name = str(_first(kwargs.get("tool_name"), "unknown"))
            if tool_name == "delegate_task":
                return
            tool_call_id = str(_first(kwargs.get("tool_call_id"), ""))
            state = self.tool_spans.pop(tool_call_id, None)
            if not state:
                return
            output, truncated, original_chars = _limited_text(kwargs.get("result"), self.max_chars)
            self._finish_span(
                state["span"],
                {
                    "tool.output": output,
                    "output.value": output,
                    "tool.output.original_chars": original_chars,
                    "agent.insight.content.truncated": truncated,
                    "tool.status": kwargs.get("status"),
                    "error.message": kwargs.get("error"),
                },
            )
            self._complete(state["session_id"], state["span"])

    def post_llm_call(self, **kwargs: Any) -> None:
        with self.lock:
            session_id = self._session_id(kwargs)
            turn_id = str(_first(kwargs.get("turn_id"), self.current_turn.get(session_id), "unknown"))
            turn = self.turns.get((session_id, turn_id))
            if not turn:
                return
            output, truncated, original_chars = _limited_text(kwargs.get("assistant_response"), self.max_chars)
            attrs = {
                "output.value": output,
                "llm.output.content": output,
                "llm.response.output_chars": original_chars,
                "agent.insight.content.truncated": truncated,
            }
            self._finish_span(turn["llm"], attrs)
            self._complete(session_id, turn["llm"])
            if turn.get("agent"):
                self._finish_span(turn["agent"], attrs)
                self._complete(session_id, turn["agent"])

    def subagent_start(self, **kwargs: Any) -> None:
        with self.lock:
            parent_session_id = str(_first(kwargs.get("parent_session_id"), "unknown"))
            child_session_id = str(_first(kwargs.get("child_session_id"), "unknown"))
            parent_turn_id = str(_first(kwargs.get("parent_turn_id"), self.current_turn.get(parent_session_id), "unknown"))
            root_id = self._root_id(parent_session_id)
            role = str(_first(kwargs.get("child_role"), "subagent"))
            child_agent_name = str(_first(kwargs.get("child_agent_name"), role))
            goal = kwargs.get("child_goal")
            self.sessions[child_session_id] = {
                "root_session_id": root_id,
                "parent_session_id": parent_session_id,
                "subagent_id": kwargs.get("child_subagent_id"),
                "parent_subagent_id": kwargs.get("parent_subagent_id"),
                "role": role,
                "agent_name": child_agent_name,
                "profile_name": self.root_profile_name,
            }
            parent_turn = self.turns.get((parent_session_id, parent_turn_id), {})
            task_span = self._new_span(
                "tool.task",
                parent_session_id,
                self._span_id(parent_session_id, child_session_id, "task"),
                _get(parent_turn.get("llm"), "spanId"),
                {
                    **self._base_attributes(parent_session_id, parent_turn.get("model")),
                    "openinference.span.kind": "TOOL",
                    "tool.name": "task",
                    "tool.call.id": self._span_id(parent_session_id, child_session_id, "task-call"),
                    "tool.input": {
                        "subagent_type": role,
                        "description": goal,
                        "session_id": child_session_id,
                    },
                    "input.value": {
                        "subagent_type": role,
                        "description": goal,
                        "session_id": child_session_id,
                    },
                    "hermes.child_session_id": child_session_id,
                },
            )
            child_agent_span = self._new_span(
                f"agent.subagent.{role}",
                child_session_id,
                self._span_id(child_session_id, "subagent-agent"),
                task_span["spanId"],
                {
                    **self._base_attributes(child_session_id),
                    "openinference.span.kind": "AGENT",
                    "input.value": goal,
                    "llm.input.value": goal,
                },
            )
            self.sessions[child_session_id]["container_span_id"] = child_agent_span["spanId"]
            self.subagents[child_session_id] = {
                "parent_session_id": parent_session_id,
                "task_span": task_span,
                "agent_span": child_agent_span,
            }

    def subagent_stop(self, **kwargs: Any) -> None:
        with self.lock:
            child_session_id = str(_first(kwargs.get("child_session_id"), ""))
            root_id = self._root_id(child_session_id)
            state = self.subagents.pop(child_session_id, None)
            if not state:
                return
            summary, truncated, original_chars = _limited_text(kwargs.get("child_summary"), self.max_chars)
            attrs = {
                "output.value": summary,
                "llm.output.content": summary,
                "llm.response.output_chars": original_chars,
                "agent.insight.content.truncated": truncated,
                "hermes.subagent.status": kwargs.get("child_status"),
            }
            self._finish_span(state["agent_span"], attrs)
            self._complete(child_session_id, state["agent_span"])
            self._finish_span(
                state["task_span"],
                {
                    "tool.output": {
                        "session_id": child_session_id,
                        "result": summary,
                        "status": kwargs.get("child_status"),
                    },
                    "output.value": {
                        "session_id": child_session_id,
                        "result": summary,
                        "status": kwargs.get("child_status"),
                    },
                },
            )
            self._complete(state["parent_session_id"], state["task_span"])
            self._maybe_cleanup_root(root_id)

    def on_session_end(self, **kwargs: Any) -> None:
        with self.lock:
            session_id = self._session_id(kwargs)
            root_id = self._root_id(session_id)
            is_root_session = session_id == root_id
            if is_root_session:
                self.ended_roots.add(root_id)
        self.exporter.flush()
        with self.lock:
            if is_root_session:
                self._maybe_cleanup_root(root_id)
            else:
                self.exporter.logger.write(
                    "info",
                    f"child session ended session={session_id} root={root_id}; root state retained",
                )


_collector: Optional[_Collector] = None


def register(ctx: Any) -> None:
    global _collector
    _collector = _Collector()
    for hook_name in (
        "pre_llm_call",
        "pre_api_request",
        "post_api_request",
        "api_request_error",
        "pre_tool_call",
        "post_tool_call",
        "post_llm_call",
        "subagent_start",
        "subagent_stop",
        "on_session_end",
    ):
        ctx.register_hook(hook_name, getattr(_collector, hook_name))


def _close() -> None:
    if _collector is not None:
        _collector.close()


atexit.register(_close)
