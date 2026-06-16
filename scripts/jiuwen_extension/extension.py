# coding: utf-8
"""agent-insight observability extension for JiuwenSwarm.

零代码接入 agent-insight 观测。把 jiuwenswarm 的 ``telemetry`` 配置（config.yaml 的
``telemetry:`` 段，或环境变量）接到 agent-core 内建的 OTLP exporter 上：一旦启用，
运行时产生的 agent / LLM / tool span 会自动推到 agent-insight 的 OTLP 摄入端点，
无需在业务代码里写任何 init_observability。

加载机制
--------
jiuwenswarm 的 ExtensionLoader 在 **agentserver 启动时**（``app_agentserver.py`` →
``ExtensionManager.load_all_extensions()``）import 本文件并调用模块级
``register_extensions(registry)``（见 ``jiuwenswarm/extensions/loader.py``——loader
只调 register_extensions，不调 BaseExtension.initialize）。agentserver 正是跑
``Runner`` 的进程，所以我们在 register_extensions 里调一次 init_observability，
就能把 OtelCallbackHandler 挂到 ``Runner.callback_framework`` 上，覆盖之后所有 run。

鉴权（user 归属）
----------------
agent-core 的 ``ObservabilityConfig`` 没有通用 headers 字段（只在配 langfuse 时注入
basic auth）。但它构造 OTLP http exporter 时传的是 **空 dict**，底层
``OTLPSpanExporter`` 对空 headers 会回退读 ``OTEL_EXPORTER_OTLP_TRACES_HEADERS`` /
``OTEL_EXPORTER_OTLP_HEADERS`` 环境变量。所以我们把 ``x-witty-api-key`` 放进这些 env，
agent-insight 的 ``/api/ingest/otel/v1/traces`` route 据此把记录归属到对应 user。

配置来源（优先级从高到低）
------------------------
- endpoint:   env AGENT_INSIGHT_OTLP_ENDPOINT > OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
              > telemetry.traces.endpoint > telemetry.endpoint
- api key:    env AGENT_INSIGHT_API_KEY（→ x-witty-api-key），与 telemetry.headers 合并
- enabled:    env OTEL_ENABLED > telemetry.enabled（默认 False；exporter=none 视为关闭）
- protocol:   env AGENT_INSIGHT_OTLP_PROTOCOL > "http"（agent-insight 摄入是 OTLP/HTTP；
              **不读 config.yaml 的 protocol**——其默认 grpc 对我们的 http 端点是陷阱）
- service:    telemetry.service_name > "jiuwenswarm"（须为 jiuwenswarm，服务端据此路由）
"""
from __future__ import annotations

import os
from typing import Any, Optional

_TRUTHY = {"1", "true", "yes", "on"}
_FALSY = {"0", "false", "no", "off"}
_LOG_PREFIX = "[agent-insight-observability]"


def _log(level: str, msg: str) -> None:
    try:
        from jiuwenswarm.common.utils import logger

        getattr(logger, level)("%s %s", _LOG_PREFIX, msg)
    except Exception:
        print(f"{_LOG_PREFIX} {msg}")


def _bool_env(name: str) -> Optional[bool]:
    raw = os.environ.get(name)
    if raw is None:
        return None
    val = raw.strip().lower()
    if val in _TRUTHY:
        return True
    if val in _FALSY:
        return False
    return None


def _read_telemetry_config() -> dict:
    try:
        from jiuwenswarm.common.config import get_config

        cfg = get_config() or {}
    except Exception as exc:  # 配置不可读时静默退化，绝不拖垮宿主启动
        _log("warning", f"read config failed, falling back to env only: {exc}")
        return {}
    tel = cfg.get("telemetry")
    return tel if isinstance(tel, dict) else {}


def _format_headers(headers: dict) -> str:
    """OTLP 规范的 *_HEADERS 格式：逗号分隔的 key=value。"""
    parts = []
    for key, value in headers.items():
        if key and value is not None and str(value) != "":
            parts.append(f"{key}={value}")
    return ",".join(parts)


def _resolve_settings() -> Optional[dict]:
    tel = _read_telemetry_config()
    traces = tel.get("traces") if isinstance(tel.get("traces"), dict) else {}

    # ---- enabled：env OTEL_ENABLED 优先（与 config.yaml 注释一致） ----
    enabled = _bool_env("OTEL_ENABLED")
    if enabled is None:
        enabled = bool(tel.get("enabled", False))

    exporter_kind = str(traces.get("exporter") or tel.get("exporter") or "otlp").strip().lower()
    if exporter_kind in ("none", ""):
        enabled = False
    if not enabled:
        return None

    endpoint = (
        os.environ.get("AGENT_INSIGHT_OTLP_ENDPOINT")
        or os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
        or traces.get("endpoint")
        or tel.get("endpoint")
    )
    # agent-insight 的 OTLP 摄入端点是 OTLP/HTTP（protobuf）→ 默认 http。
    # **不读 config.yaml telemetry.protocol**：它的默认值是 grpc（通用 OTEL 默认，
    # 指向 localhost:4317），对我们的 http 端点是陷阱。只认显式 env 覆盖。
    protocol = str(os.environ.get("AGENT_INSIGHT_OTLP_PROTOCOL") or "http").strip().lower()
    service_name = str(tel.get("service_name") or "jiuwenswarm").strip() or "jiuwenswarm"

    try:
        sample_rate = float(tel.get("sample_rate", 1.0))
    except (TypeError, ValueError):
        sample_rate = 1.0

    # ---- headers：telemetry.headers + traces.headers + api-key env，逐层覆盖 ----
    headers: dict = {}
    if isinstance(tel.get("headers"), dict):
        headers.update(tel["headers"])
    if isinstance(traces.get("headers"), dict):
        headers.update(traces["headers"])
    api_key = os.environ.get("AGENT_INSIGHT_API_KEY")
    if api_key:
        headers["x-witty-api-key"] = api_key

    # exporter kind → agent-core ObservabilityConfig.exporter（otlp_http / otlp_grpc / console）
    if exporter_kind == "console":
        ac_exporter = "console"
    elif protocol == "grpc":
        ac_exporter = "otlp_grpc"
    else:
        ac_exporter = "otlp_http"

    if ac_exporter != "console" and not endpoint:
        _log("warning", "telemetry enabled but no endpoint configured; skipping")
        return None

    return {
        "exporter": ac_exporter,
        "endpoint": endpoint,
        "service_name": service_name,
        "sample_rate": sample_rate,
        "headers": headers,
    }


def _apply_header_env(headers: dict) -> None:
    """把鉴权 header 通过 OTEL 标准环境变量交给底层 exporter。

    agent-core 不直传通用 headers，但空 headers 时 exporter 会回退读这些 env。
    显式 set（让我们的 x-witty-api-key 生效），仅当用户未自行指定时不覆盖。
    """
    if not headers:
        return
    header_str = _format_headers(headers)
    if not header_str:
        return
    os.environ.setdefault("OTEL_EXPORTER_OTLP_TRACES_HEADERS", header_str)
    os.environ.setdefault("OTEL_EXPORTER_OTLP_HEADERS", header_str)


# BaseExtension 仅在 jiuwenswarm 进程内可 import；测试/独立运行时允许缺失。
try:
    from jiuwenswarm.extensions.sdk import BaseExtension as _BaseExtension
except Exception:  # pragma: no cover - 仅产品进程外发生
    _BaseExtension = object  # type: ignore[assignment, misc]


class AgentInsightObservabilityExtension(_BaseExtension):
    """把 telemetry 配置接到 agent-core 内建 OTLP exporter（零代码观测接入）。"""

    def __init__(self) -> None:
        self._initialized = False

    async def initialize(self, config: Any) -> None:  # noqa: D401 - 契约方法
        # loader 不调用 initialize（只调 register_extensions）；真正接线在 wire() 完成。
        return None

    def wire(self) -> None:
        settings = _resolve_settings()
        if settings is None:
            _log("info", "telemetry 未启用，跳过观测接入")
            return
        try:
            from openjiuwen.agent_teams.observability import (
                ObservabilityConfig,
                init_observability,
                is_initialized,
            )
        except Exception as exc:
            _log("warning", f"import agent-core observability failed: {exc}")
            return

        if is_initialized():
            _log("info", "observability 已初始化，跳过 re-init")
            self._initialized = True
            return

        _apply_header_env(settings["headers"])
        try:
            init_observability(
                ObservabilityConfig(
                    enabled=True,
                    exporter=settings["exporter"],
                    endpoint=settings["endpoint"],
                    service_name=settings["service_name"],
                    sample_rate=settings["sample_rate"],
                )
            )
        except Exception as exc:
            _log("warning", f"init_observability failed: {exc}")
            # init 先建 provider 再建 exporter 才抛 → 复位，避免 is_initialized() 假阳 +
            # 无 exporter/回调的僵尸状态。
            try:
                from openjiuwen.agent_teams.observability import shutdown_observability

                shutdown_observability()
            except Exception:
                pass
            return

        self._initialized = True
        _log(
            "info",
            f"已接入 agent-insight: exporter={settings['exporter']} "
            f"endpoint={settings['endpoint']} service={settings['service_name']}",
        )

    async def shutdown(self) -> None:
        if not self._initialized:
            return
        try:
            from openjiuwen.agent_teams.observability import shutdown_observability

            shutdown_observability()  # flush + 释放 provider
        except Exception as exc:
            _log("warning", f"shutdown_observability failed: {exc}")


async def register_extensions(registry: Any):
    """jiuwenswarm ExtensionLoader 的入口：加载时完成观测接线。"""
    ext = AgentInsightObservabilityExtension()
    ext.wire()
    return [ext]
