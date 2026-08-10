# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""Per-session detector state, observe → actions, and UI event emission."""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, cast

from agents.base import NoOpAgentAdapter
from .platform_capabilities import supports_host_skill_judge
from agents.host_callback_adapter import HostCallbackAgentAdapter
from agents.ras_agents import RASAgents
from core.config import AgentRASConfig, coerce_message_locale
from core.models import Anomaly, Signal, SignalKind
from detectors.base import AsyncRecoveryDetector, Detector, is_async_recovery_detector
from detectors.registry import (
    FLAT_PAYLOAD_DOMAIN,
    build_member_detectors,
    detector_config_models,
)
from recovery.engine import LocalAutoRecovery, RecoveryPolicy
from recovery.operations import build_recovery_actions
from recovery.robustness_prompt import host_messages_for_locale
from .event_bus import EventBus
from .insight_push import fire_push_action_result, fire_push_anomaly

logger = logging.getLogger(__name__)

PROTOCOL_VERSION = 1

# abort 生效性探针窗口：请求 abort 后该窗口内仍有新 assistant 文本到达，
# 说明 abort 未真正停流，补记一条 abort_stream ok=false(no_effect)。
ABORT_PROBE_WINDOW_S = 3.0

_LLM_ANCHOR_KEYS = ("message_id", "part_id", "channel")
_TOOL_ANCHOR_KEYS = ("call_id", "channel")
_ALL_ANCHOR_KEYS = ("message_id", "part_id", "call_id", "channel")


def _normalize_anchor(
    raw: dict[str, Any] | None,
    *,
    keys: tuple[str, ...] = _ALL_ANCHOR_KEYS,
) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    out = {key: value for key, value in raw.items() if key in keys and value}
    return out or None


def _is_tool_channel(channel: str | None) -> bool:
    return str(channel or "").strip() == "tool_call"


def _is_llm_anomaly_kind(kind: str | None) -> bool:
    value = str(kind or "").strip()
    return value in {"llm_thinking_loop", "llm_thinking_dead_loop"}


def _anchor_for_anomaly(state: "SessionState", kind: str | None) -> dict[str, Any] | None:
    """LLM anomalies bind to LLM identity only; tool anomalies to call_id only."""
    if _is_llm_anomaly_kind(kind):
        return dict(state.last_llm_anchor) if state.last_llm_anchor else None
    return dict(state.last_tool_anchor) if state.last_tool_anchor else None


def _config_from_payload(raw: dict[str, Any] | None) -> AgentRASConfig:
    """Registry-driven: nested per-domain dicts; flat keys only for the legacy domain."""
    raw = dict(raw or {})
    cfg = AgentRASConfig()
    for name, model_cls in detector_config_models().items():
        merged = getattr(cfg.detectors, name).model_dump()
        sub = raw.get(name)
        if isinstance(sub, dict):
            merged.update({k: v for k, v in sub.items() if k in merged})
        if name == FLAT_PAYLOAD_DOMAIN:
            for key in model_cls.model_fields:
                if key in raw:
                    merged[key] = raw[key]
        setattr(cfg.detectors, name, model_cls(**merged))
    if "notify_user_on_warning" in raw:
        cfg.recovery.notify_user_on_warning = bool(raw["notify_user_on_warning"])
    return cfg


def _locale_from_payload(raw: dict[str, Any] | None) -> str:
    raw = dict(raw or {})
    return coerce_message_locale(str(raw.get("locale") or raw.get("language") or "cn"))


async def _dispatch_signal(state: "SessionState", signal: Signal) -> Anomaly | None:
    """First-hit dispatch across session detectors; irrelevant kinds return None."""
    for detector in state.detectors:
        anomaly = await detector.observe(signal)
        if anomaly is not None:
            return anomaly
    return None


@dataclass
class SessionState:
    session_id: str
    platform: str
    config: AgentRASConfig
    detectors: list[Detector]
    auto: LocalAutoRecovery
    policy: RecoveryPolicy
    locale: str = "cn"
    last_text: dict[str, str] = field(default_factory=dict)
    latched_abort: bool = False
    last_seen: float = field(default_factory=time.time)
    last_anomaly: dict[str, Any] | None = None
    last_llm_anchor: dict[str, Any] | None = None
    last_tool_anchor: dict[str, Any] | None = None
    observe_count: int = 0
    host_adapter: HostCallbackAgentAdapter | None = None
    deferred_actions: list[dict[str, Any]] = field(default_factory=list)
    deferred_anomaly: dict[str, Any] | None = None
    # abort 生效性探针状态；reset(idle 轮次结束）即视为生效并结案。
    last_abort_ts: float | None = None
    abort_no_effect_reported: bool = False

    @classmethod
    def create(cls, session_id: str, platform: str, config_payload: dict[str, Any] | None) -> SessionState:
        config = _config_from_payload(config_payload)
        locale = _locale_from_payload(config_payload)
        host_adapter: HostCallbackAgentAdapter | None = None
        # L3 host skill judge: capability flag + semantic switch on any domain.
        semantic_on = any(
            bool(getattr(getattr(config.detectors, name), "semantic_content_enabled", False))
            for name in detector_config_models()
        )
        if supports_host_skill_judge(platform) and semantic_on:
            host_adapter = HostCallbackAgentAdapter()
            agents = RASAgents(host_adapter)
        else:
            agents = RASAgents(NoOpAgentAdapter())
        detectors = build_member_detectors(config, agents=agents)
        policy = RecoveryPolicy.from_config(config.policy)
        auto = LocalAutoRecovery(policy, locale=locale)
        state = cls(
            session_id=session_id,
            platform=platform,
            config=config,
            detectors=detectors,
            auto=auto,
            policy=policy,
            locale=locale,
            host_adapter=host_adapter,
        )
        if host_adapter is not None:
            async def _on_async_recovery(anomaly: Anomaly, _chunk_type: str) -> None:
                actions = build_recovery_actions(
                    anomaly,
                    locale=state.locale,
                    policy=state.policy,
                    auto=state.auto,
                    notify_user_on_warning=bool(
                        state.config.recovery.notify_user_on_warning
                    ),
                )
                anomaly_dict = {
                    "kind": anomaly.kind.value,
                    "summary": anomaly.summary,
                    "evidence": anomaly.evidence,
                    "severity": anomaly.severity.value
                    if hasattr(anomaly.severity, "value")
                    else str(anomaly.severity),
                }
                if state.last_llm_anchor:
                    anomaly_dict["trace_anchor"] = dict(state.last_llm_anchor)
                state.latched_abort = True
                state.last_anomaly = anomaly_dict
                state.deferred_actions = list(actions)
                state.deferred_anomaly = anomaly_dict

            for detector in state.detectors:
                if is_async_recovery_detector(detector):
                    cast(AsyncRecoveryDetector, detector).set_async_recovery_handler(
                        _on_async_recovery
                    )
        return state

    def reset(self) -> None:
        for detector in self.detectors:
            detector.reset()
        self.last_text.clear()
        self.latched_abort = False
        self.last_anomaly = None
        self.last_llm_anchor = None
        self.last_tool_anchor = None
        self.deferred_actions.clear()
        self.deferred_anomaly = None
        # idle/reset 说明轮次真的结束了：abort 已生效，探针结案。
        self.last_abort_ts = None
        self.abort_no_effect_reported = False
        self.last_seen = time.time()

    def to_public(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "platform": self.platform,
            "latched_abort": self.latched_abort,
            "last_seen": self.last_seen,
            "observe_count": self.observe_count,
            "last_anomaly": self.last_anomaly,
            "text_chars": {k: len(v) for k, v in self.last_text.items()},
        }


class SessionHub:
    """In-memory multi-session hub owned by the embedding host process."""

    def __init__(self, event_maxlen: int = 500) -> None:
        self._sessions: dict[str, SessionState] = {}
        self.started_at = time.time()
        self.events = EventBus(maxlen=event_maxlen)

    def hello(
        self,
        session_id: str,
        platform: str,
        config: dict[str, Any] | None = None,
    ) -> SessionState:
        state = SessionState.create(session_id, platform, config)
        self._sessions[session_id] = state
        self.events.emit(
            "session_hello",
            session_id=session_id,
            platform=platform,
            payload={"config_keys": sorted((config or {}).keys()), "locale": state.locale},
        )
        return state

    def host_messages(self, session_id: str | None = None) -> dict[str, str]:
        locale = "cn"
        if session_id:
            state = self._sessions.get(session_id)
            if state is not None:
                locale = state.locale
        return host_messages_for_locale(locale)

    def get(self, session_id: str) -> SessionState | None:
        return self._sessions.get(session_id)

    def list_sessions(self) -> list[dict[str, Any]]:
        return [s.to_public() for s in self._sessions.values()]

    def snapshot(self) -> dict[str, Any]:
        return {
            "protocol_version": PROTOCOL_VERSION,
            "runtime": {
                "status": "ok",
                "started_at": self.started_at,
                "uptime_s": time.time() - self.started_at,
                "event_count": self.events.size,
            },
            "sessions": self.list_sessions(),
            "recent_events": self.events.recent(200),
        }

    def ensure(
        self,
        session_id: str,
        platform: str,
        config: dict[str, Any] | None = None,
    ) -> SessionState:
        if not str(platform or "").strip():
            raise ValueError("platform is required")
        existing = self._sessions.get(session_id)
        if existing is not None:
            return existing
        return self.hello(session_id, platform, config)

    def reset(self, session_id: str) -> None:
        state = self._sessions.get(session_id)
        if state is not None:
            platform = state.platform
            state.reset()
            self.events.emit(
                "session_reset",
                session_id=session_id,
                platform=platform,
            )

    def bye(self, session_id: str) -> None:
        state = self._sessions.pop(session_id, None)
        platform = state.platform if state else ""
        self.events.emit(
            "session_bye",
            session_id=session_id,
            platform=platform,
        )

    async def action_result(
        self,
        session_id: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Record host-side action execution result (platform-agnostic ack)."""
        raw = dict(payload or {})
        state = self._sessions.get(session_id)
        platform = state.platform if state else str(raw.get("platform") or "")
        body = {
            "action": str(raw.get("action") or ""),
            "ok": bool(raw.get("ok")),
            "channel": raw.get("channel"),
            "error": raw.get("error"),
            "message": raw.get("message"),
        }
        explicit_anchor = raw.get("trace_anchor")
        if isinstance(explicit_anchor, dict) and explicit_anchor:
            body["trace_anchor"] = {
                key: value
                for key, value in explicit_anchor.items()
                if key in _ALL_ANCHOR_KEYS and value
            }
        elif state is not None:
            fallback = state.last_llm_anchor or state.last_tool_anchor
            if fallback:
                body["trace_anchor"] = dict(fallback)
        delivery_anchor = raw.get("delivery_anchor")
        if isinstance(delivery_anchor, dict) and delivery_anchor:
            body["delivery_anchor"] = {
                key: value
                for key, value in delivery_anchor.items()
                if key in ("message_id", "part_id", "channel") and value
            }
        self.events.emit(
            "action_result",
            session_id=session_id,
            platform=platform,
            payload=body,
        )
        fire_push_action_result(session_id, platform, body)
        return {"session_id": session_id, "ok": True, **body}

    @staticmethod
    def _mark_abort_requested(state: SessionState, actions: list[dict[str, Any]]) -> None:
        if any(str(a.get("type") or "") == "abort_stream" for a in actions if isinstance(a, dict)):
            state.last_abort_ts = time.time()
            state.abort_no_effect_reported = False

    def _probe_abort_effect(self, state: SessionState, *, kind: str, text: str) -> None:
        ts = state.last_abort_ts
        if ts is None or state.abort_no_effect_reported:
            return
        if time.time() - ts > ABORT_PROBE_WINDOW_S:
            state.last_abort_ts = None
            return
        if kind != "assistant_text" or not text:
            return
        state.abort_no_effect_reported = True
        body = {
            "action": "abort_stream",
            "ok": False,
            "channel": f"{state.platform}.abort",
            "error": "no_effect: stream traffic observed after abort request",
            "message": None,
        }
        self.events.emit(
            "action_result",
            session_id=state.session_id,
            platform=state.platform,
            payload=body,
        )
        fire_push_action_result(state.session_id, state.platform, body)

    async def observe(self, session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        state = self._sessions.get(session_id)
        if state is None:
            platform = str(payload.get("platform") or "").strip()
            if not platform:
                return {"error": "missing platform", "session_id": session_id}
            state = self.ensure(session_id, platform, payload.get("config"))
        state.last_seen = time.time()
        state.observe_count += 1
        self._probe_abort_effect(state, kind=str(payload.get("kind") or "assistant_text"), text=str(payload.get("text") or ""))
        kind = str(payload.get("kind") or "assistant_text")
        channel = str(payload.get("channel") or "")
        normalized_anchor = _normalize_anchor(payload.get("trace_anchor"))
        if normalized_anchor:
            if kind == "tool" or _is_tool_channel(str(normalized_anchor.get("channel") or channel)):
                tool_anchor = _normalize_anchor(normalized_anchor, keys=_TOOL_ANCHOR_KEYS)
                if tool_anchor:
                    state.last_tool_anchor = tool_anchor
            else:
                llm_anchor = _normalize_anchor(normalized_anchor, keys=_LLM_ANCHOR_KEYS)
                if llm_anchor:
                    state.last_llm_anchor = llm_anchor

        text = str(payload.get("text") or "")
        self.events.emit(
            "observe",
            session_id=session_id,
            platform=state.platform,
            payload={
                "kind": kind,
                "channel": channel or None,
                "text_chars": len(text),
                "mode": payload.get("mode"),
                "tool": (payload.get("tool") or {}).get("name")
                if isinstance(payload.get("tool"), dict)
                else None,
            },
        )

        if state.latched_abort:
            return {
                "session_id": session_id,
                "actions": [],
                "anomaly": None,
                "skill_requests": [],
            }

        anomaly: Anomaly | None = None
        if kind == "assistant_text":
            anomaly = await self._observe_text(state, payload)
        elif kind == "tool":
            anomaly = await self._observe_tool(state, payload)

        # Let L3 create_task reach HostCallbackAgentAdapter.invoke_skill.
        await asyncio.sleep(0)
        skill_requests: list[dict[str, Any]] = []
        if state.host_adapter is not None:
            skill_requests = state.host_adapter.drain_pending_requests()
            if skill_requests:
                self.events.emit(
                    "skill_request",
                    session_id=session_id,
                    platform=state.platform,
                    payload={"requests": skill_requests},
                )

        if anomaly is None:
            return {
                "session_id": session_id,
                "actions": [],
                "anomaly": None,
                "skill_requests": skill_requests,
            }

        state.latched_abort = True
        actions = self._actions_for(anomaly, state)
        self._mark_abort_requested(state, actions)
        anomaly_dict = {
            "kind": anomaly.kind.value,
            "summary": anomaly.summary,
            "evidence": anomaly.evidence,
            "severity": anomaly.severity.value
            if hasattr(anomaly.severity, "value")
            else str(anomaly.severity),
        }
        if state.last_llm_anchor or state.last_tool_anchor:
            # Prefer kind-appropriate bucket; never hang LLM anomalies on tool call_id.
            selected = _anchor_for_anomaly(state, anomaly.kind.value if hasattr(anomaly.kind, "value") else str(anomaly.kind))
            if selected:
                anomaly_dict["trace_anchor"] = selected
        state.last_anomaly = anomaly_dict
        self.events.emit(
            "anomaly",
            session_id=session_id,
            platform=state.platform,
            payload=anomaly_dict,
        )
        fire_push_anomaly(session_id, state.platform, anomaly_dict, actions)
        self.events.emit(
            "actions",
            session_id=session_id,
            platform=state.platform,
            payload={"actions": actions},
        )
        return {
            "session_id": session_id,
            "actions": actions,
            "anomaly": anomaly_dict,
            "skill_requests": skill_requests,
        }

    async def skill_result(
        self,
        session_id: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Host fulfills a parked L3 skill request (OpenCode inproc)."""
        raw = dict(payload or {})
        state = self._sessions.get(session_id)
        if state is None:
            return {"session_id": session_id, "ok": False, "error": "unknown_session"}
        adapter = state.host_adapter
        if adapter is None:
            return {"session_id": session_id, "ok": False, "error": "no_host_adapter"}

        request_id = str(raw.get("request_id") or "")
        err = raw.get("error")
        if err:
            fulfilled = adapter.fulfill(request_id, error=str(err))
        else:
            result = raw.get("result")
            fulfilled = adapter.fulfill(
                request_id,
                result if isinstance(result, dict) else {},
            )
        if not fulfilled:
            return {
                "session_id": session_id,
                "ok": False,
                "error": "unknown_or_done_request",
                "actions": [],
                "anomaly": None,
            }

        self.events.emit(
            "skill_result",
            session_id=session_id,
            platform=state.platform,
            payload={
                "request_id": request_id,
                "ok": err is None,
                "error": err,
            },
        )

        try:
            timeout = float(raw.get("timeout") or 8.0)
        except (TypeError, ValueError):
            timeout = 8.0

        # Resume L3 task → optional async recovery handler.
        deadline = time.monotonic() + max(0.05, min(timeout, 8.0))
        while time.monotonic() < deadline:
            await asyncio.sleep(0)
            running = [
                t
                for detector in state.detectors
                for t in getattr(detector, "_eval_tasks", ())
                if not t.done()
            ]
            if not running:
                # One more tick so the recovery handler can finish writing deferred_*.
                await asyncio.sleep(0)
                break
            await asyncio.sleep(0.01)

        actions = list(state.deferred_actions)
        anomaly_dict = state.deferred_anomaly
        state.deferred_actions.clear()
        state.deferred_anomaly = None
        if actions:
            self._mark_abort_requested(state, actions)
            self.events.emit(
                "anomaly",
                session_id=session_id,
                platform=state.platform,
                payload=anomaly_dict,
            )
            fire_push_anomaly(session_id, state.platform, anomaly_dict or {}, actions)
            self.events.emit(
                "actions",
                session_id=session_id,
                platform=state.platform,
                payload={"actions": actions},
            )
        return {
            "session_id": session_id,
            "ok": True,
            "actions": actions,
            "anomaly": anomaly_dict,
        }

    async def _observe_text(
        self,
        state: SessionState,
        payload: dict[str, Any],
    ) -> Anomaly | None:
        channel = str(payload.get("channel") or "llm_output")
        if channel not in ("llm_output", "llm_reasoning"):
            channel = "llm_output"
        text = str(payload.get("text") or "")
        mode = str(payload.get("mode") or "snapshot")
        prev = state.last_text.get(channel, "")
        if mode == "snapshot":
            if text.startswith(prev):
                delta = text[len(prev) :]
            else:
                delta = text
            state.last_text[channel] = text
        else:
            delta = text
            state.last_text[channel] = prev + text
        if not delta:
            return None
        return await _dispatch_signal(
            state,
            Signal(
                kind=SignalKind.STREAM_CHUNK,
                member_name=state.session_id,
                chunk_type=channel,
                chunk_text=delta,
            ),
        )

    async def _observe_tool(
        self,
        state: SessionState,
        payload: dict[str, Any],
    ) -> Anomaly | None:
        tool = payload.get("tool") or {}
        name = str(tool.get("name") or "tool")
        phase = str(tool.get("phase") or "after")
        args = tool.get("args")
        tool_result = tool.get("result")
        err_raw = tool.get("error")
        error = str(err_raw) if err_raw is not None and str(err_raw).strip() else None
        if error and tool_result is None:
            tool_result = {"success": False, "error": error, "status": "error"}
        kind = SignalKind.AFTER_TOOL_CALL if phase != "before" else SignalKind.BEFORE_TOOL_CALL
        if kind == SignalKind.BEFORE_TOOL_CALL:
            return None
        return await _dispatch_signal(
            state,
            Signal(
                kind=SignalKind.AFTER_TOOL_CALL,
                member_name=state.session_id,
                tool_name=name,
                tool_args=args,
                tool_result=tool_result,
                error=error,
            ),
        )

    def _actions_for(self, anomaly: Anomaly, state: SessionState) -> list[dict[str, Any]]:
        """Delegate recovery decision to core; platforms only deliver."""
        return build_recovery_actions(
            anomaly,
            locale=state.locale,
            policy=state.policy,
            auto=state.auto,
            notify_user_on_warning=bool(state.config.recovery.notify_user_on_warning),
        )
