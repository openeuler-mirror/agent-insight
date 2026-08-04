# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""Per-session detector state, observe → actions, and UI event emission."""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from core.agents.base import NoOpAgentAdapter
from .platform_capabilities import supports_host_skill_judge
from core.agents.host_callback_adapter import HostCallbackAgentAdapter
from core.agents.ras_agents import RASAgents
from core.config import AgentRASConfig, LlmThinkingLoopConfig, RepeatToolConfig, coerce_message_locale
from core.detectors.llm_thinking_loop import LlmThinkingLoopDetector
from core.detectors.registry import build_member_detectors
from core.detectors.repeat_tool import RepeatToolCallDetector
from core.models import Anomaly, Signal, SignalKind
from core.recovery.engine import LocalAutoRecovery, RecoveryPolicy
from core.recovery.operations import build_recovery_actions
from core.recovery.robustness_prompt import host_messages_for_locale
from .event_bus import EventBus
from .insight_push import fire_push_action_result, fire_push_anomaly

logger = logging.getLogger(__name__)

PROTOCOL_VERSION = 1


def _config_from_payload(raw: dict[str, Any] | None) -> AgentRASConfig:
    raw = dict(raw or {})
    # Omit semantic_content_enabled so LlmThinkingLoopConfig default (True) applies.
    thinking_kw: dict[str, Any] = {}
    for key in (
        "detection_start_chars",
        "window_max_chars",
        "loop_repeat_threshold",
        "similar_clause_sim_threshold",
        "semantic_eval_chars",
        "semantic_content_enabled",
        "enabled",
    ):
        if key in raw:
            thinking_kw[key] = raw[key]
    cfg = AgentRASConfig()
    cfg.detectors.llm_thinking_loop = LlmThinkingLoopConfig(
        **{
            **cfg.detectors.llm_thinking_loop.model_dump(),
            **thinking_kw,
        }
    )
    if isinstance(raw.get("repeat_tool"), dict):
        cfg.detectors.repeat_tool = RepeatToolConfig(
            **{
                **cfg.detectors.repeat_tool.model_dump(),
                **raw["repeat_tool"],
            }
        )
    if "notify_user_on_warning" in raw:
        cfg.recovery.notify_user_on_warning = bool(raw["notify_user_on_warning"])
    return cfg


def _locale_from_payload(raw: dict[str, Any] | None) -> str:
    raw = dict(raw or {})
    return coerce_message_locale(str(raw.get("locale") or raw.get("language") or "cn"))


@dataclass
class SessionState:
    session_id: str
    platform: str
    config: AgentRASConfig
    thinking: LlmThinkingLoopDetector
    repeat: RepeatToolCallDetector | None
    auto: LocalAutoRecovery
    policy: RecoveryPolicy
    locale: str = "cn"
    last_text: dict[str, str] = field(default_factory=dict)
    latched_abort: bool = False
    last_seen: float = field(default_factory=time.time)
    last_anomaly: dict[str, Any] | None = None
    last_trace_anchor: dict[str, Any] | None = None
    observe_count: int = 0
    host_adapter: HostCallbackAgentAdapter | None = None
    deferred_actions: list[dict[str, Any]] = field(default_factory=list)
    deferred_anomaly: dict[str, Any] | None = None

    @classmethod
    def create(cls, session_id: str, platform: str, config_payload: dict[str, Any] | None) -> SessionState:
        config = _config_from_payload(config_payload)
        locale = _locale_from_payload(config_payload)
        loop_cfg = config.detectors.llm_thinking_loop
        host_adapter: HostCallbackAgentAdapter | None = None
        # L3 host skill judge: capability flag, not platform name string.
        if supports_host_skill_judge(platform) and bool(loop_cfg.semantic_content_enabled):
            host_adapter = HostCallbackAgentAdapter()
            agents = RASAgents(host_adapter)
        else:
            agents = RASAgents(NoOpAgentAdapter())
        # Protocol path historically always installs thinking-loop detector.
        detectors = build_member_detectors(
            config, agents=agents, force_thinking_loop=True
        )
        thinking = next(d for d in detectors if isinstance(d, LlmThinkingLoopDetector))
        repeat = next(
            (d for d in detectors if isinstance(d, RepeatToolCallDetector)),
            None,
        )
        policy = RecoveryPolicy.from_config(config.policy)
        auto = LocalAutoRecovery(policy, locale=locale)
        state = cls(
            session_id=session_id,
            platform=platform,
            config=config,
            thinking=thinking,
            repeat=repeat,
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
                if state.last_trace_anchor:
                    anomaly_dict["trace_anchor"] = dict(state.last_trace_anchor)
                state.latched_abort = True
                state.last_anomaly = anomaly_dict
                state.deferred_actions = list(actions)
                state.deferred_anomaly = anomaly_dict

            thinking.set_async_recovery_handler(_on_async_recovery)
        return state

    def reset(self) -> None:
        self.thinking.reset()
        if self.repeat is not None:
            reset = getattr(self.repeat, "reset", None)
            if callable(reset):
                reset()
        self.last_text.clear()
        self.latched_abort = False
        self.last_anomaly = None
        self.last_trace_anchor = None
        self.deferred_actions.clear()
        self.deferred_anomaly = None
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
                if key in ("message_id", "part_id", "call_id", "channel") and value
            }
        elif state is not None and state.last_trace_anchor:
            body["trace_anchor"] = dict(state.last_trace_anchor)
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

    async def observe(self, session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        state = self._sessions.get(session_id)
        if state is None:
            platform = str(payload.get("platform") or "").strip()
            if not platform:
                return {"error": "missing platform", "session_id": session_id}
            state = self.ensure(session_id, platform, payload.get("config"))
        state.last_seen = time.time()
        state.observe_count += 1
        trace_anchor = payload.get("trace_anchor")
        if isinstance(trace_anchor, dict):
            normalized_anchor = {
                key: value
                for key, value in trace_anchor.items()
                if key in ("message_id", "part_id", "call_id", "channel") and value
            }
            if normalized_anchor:
                state.last_trace_anchor = normalized_anchor

        kind = str(payload.get("kind") or "assistant_text")
        channel = str(payload.get("channel") or "")
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
        anomaly_dict = {
            "kind": anomaly.kind.value,
            "summary": anomaly.summary,
            "evidence": anomaly.evidence,
            "severity": anomaly.severity.value
            if hasattr(anomaly.severity, "value")
            else str(anomaly.severity),
        }
        if state.last_trace_anchor:
            anomaly_dict["trace_anchor"] = dict(state.last_trace_anchor)
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
                t for t in getattr(state.thinking, "_eval_tasks", ()) if not t.done()
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
        return await state.thinking.observe(
            Signal(
                kind=SignalKind.STREAM_CHUNK,
                member_name=state.session_id,
                chunk_type=channel,
                chunk_text=delta,
            )
        )

    async def _observe_tool(
        self,
        state: SessionState,
        payload: dict[str, Any],
    ) -> Anomaly | None:
        if state.repeat is None:
            return None
        tool = payload.get("tool") or {}
        name = str(tool.get("name") or "tool")
        phase = str(tool.get("phase") or "after")
        args = tool.get("args")
        kind = SignalKind.AFTER_TOOL_CALL if phase != "before" else SignalKind.BEFORE_TOOL_CALL
        if kind == SignalKind.BEFORE_TOOL_CALL:
            return None
        return await state.repeat.observe(
            Signal(
                kind=SignalKind.AFTER_TOOL_CALL,
                member_name=state.session_id,
                tool_name=name,
                tool_args=args,
            )
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
