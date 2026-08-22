# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""RepeatToolCallDetector — fix/circuit_breaker_recovery-aligned tool-loop detection.

Algorithms and thresholds match jiuwenswarm_enterprise branch
``fix/circuit_breaker_recovery`` → ``circuit_breaker_rail.py``:

  - generic_repeat:      same tool+args repeat (WARNING≥5)
  - unknown_tool_repeat: failing tool streak (WARNING≥threshold/2, CRITICAL≥threshold)
  - global_breaker:      no-progress streak (CRITICAL≥10)
  - ping_pong:           A↔B alternation (WARNING≥5, CRITICAL≥10 + no_progress)

Default thresholds: warning=5, critical=10, global_breaker=10, unknown_tool=10.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from collections import deque
from dataclasses import dataclass
from typing import Any

import logging
logger = logging.getLogger(__name__)
from pydantic import BaseModel, ConfigDict, Field, model_validator

from core.models import (
    Anomaly,
    Severity,
    Signal,
    SignalKind,
)
from detectors.types import (
    DetectorPlugin,
    DomainPresentation,
    PromptPresentation,
    SubmodePresentation,
)

KIND_REPEAT_TOOL_CALL = "repeat_tool_call"
KIND_TOOL_CALL_LOOP = "tool_call_loop"


class RepeatToolConfig(BaseModel):
    """Thresholds for repeat / loop tool-call detection."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    warning_threshold: int = Field(default=5, ge=2)
    critical_threshold: int = Field(default=10, ge=2)
    global_breaker_threshold: int = Field(default=10, ge=2)
    unknown_tool_threshold: int = Field(default=10, ge=2)

    @property
    def history_size(self) -> int:
        return max(
            4 * self.critical_threshold,
            2 * self.global_breaker_threshold,
            2 * self.unknown_tool_threshold,
        )

    @model_validator(mode="after")
    def _validate_thresholds(self) -> "RepeatToolConfig":
        if self.critical_threshold < self.warning_threshold:
            raise ValueError("critical_threshold must be >= warning_threshold")
        return self

_TOOL_ARGUMENTS_MAX_LEN = 400


@dataclass
class ToolCallRecord:
    """One completed (or failed) tool call kept in the per-session history."""

    tool_name: str
    args_hash: str
    result_hash: str | None
    timestamp: float
    has_error: bool = False


@dataclass
class _PingPongResult:
    count: int = 0
    paired_tool: str | None = None
    no_progress: bool = False


class ToolResultErrorDetector:
    """Infer tool-call failure from structured result fields (fix branch)."""

    _ERROR_STATUSES = frozenset({"error", "failed", "failure"})
    _EXIT_KEYS = ("exit_code", "exitCode", "returncode", "return_code")
    _REPR_SUCCESS_FALSE = re.compile(r"^success\s*=\s*False\b", re.IGNORECASE)
    _REPR_SUCCESS_TRUE = re.compile(r"^success\s*=\s*True\b", re.IGNORECASE)

    @staticmethod
    def has_error(value: Any) -> bool:
        payload = ToolResultErrorDetector._normalize(value)
        if payload is None:
            return False
        return ToolResultErrorDetector._dict_has_error(payload)

    @staticmethod
    def has_explicit_success(value: Any) -> bool:
        payload = ToolResultErrorDetector._normalize(value)
        if payload is None or "success" not in payload:
            return False
        return ToolResultErrorDetector._boolish_true(payload.get("success"))

    @staticmethod
    def signal_has_error(signal: Signal) -> bool:
        if signal.error is not None:
            return True
        if signal.tool_msg_content is not None:
            return ToolResultErrorDetector.has_error(signal.tool_msg_content)
        return False

    @staticmethod
    def infer_record_has_error(tool_result: Any, signal: Signal) -> bool:
        if ToolResultErrorDetector.has_error(tool_result):
            return True
        if ToolResultErrorDetector.has_explicit_success(tool_result):
            return False
        return ToolResultErrorDetector.signal_has_error(signal)

    @staticmethod
    def _normalize(value: Any) -> dict | None:
        if value is None:
            return None
        if isinstance(value, dict):
            return value
        model_dump = getattr(value, "model_dump", None)
        if callable(model_dump):
            try:
                dumped = model_dump()
                if isinstance(dumped, dict):
                    return dumped
            except Exception:
                logger.debug(
                    "ToolResultErrorDetector model_dump failed",
                    exc_info=True,
                )
        if hasattr(value, "success"):
            return {
                "success": getattr(value, "success", None),
                "data": getattr(value, "data", None),
                "error": getattr(value, "error", None),
            }
        if isinstance(value, str):
            text = value.strip()
            if not text:
                return None
            if text.startswith("{"):
                try:
                    parsed = json.loads(text)
                except (TypeError, ValueError):
                    parsed = None
                if isinstance(parsed, dict):
                    return parsed
            if ToolResultErrorDetector._REPR_SUCCESS_FALSE.match(text):
                return {"success": False}
            if ToolResultErrorDetector._REPR_SUCCESS_TRUE.match(text):
                return {"success": True}
        return None

    @staticmethod
    def _dict_has_error(payload: dict, *, check_data: bool = True) -> bool:
        if "success" in payload:
            if ToolResultErrorDetector._boolish_false(payload.get("success")):
                return True
            if ToolResultErrorDetector._boolish_true(payload.get("success")):
                return False
        if (
            ToolResultErrorDetector._boolish_true(payload.get("is_error"))
            or ToolResultErrorDetector._boolish_true(payload.get("isError"))
        ):
            return True
        status = payload.get("status")
        if isinstance(status, str) and status.strip().lower() in ToolResultErrorDetector._ERROR_STATUSES:
            return True
        result_type = payload.get("result_type")
        if isinstance(result_type, str) and result_type.strip().lower() == "error":
            return True
        err = payload.get("error")
        if err is not None:
            if isinstance(err, str):
                if err.strip() and err.strip().lower() != "none":
                    return True
            elif err:
                return True
        for key in ToolResultErrorDetector._EXIT_KEYS:
            code = payload.get(key)
            if isinstance(code, int) and code != 0:
                return True
        if check_data:
            data = payload.get("data")
            if isinstance(data, dict) and ToolResultErrorDetector._dict_has_error(data, check_data=False):
                return True
        return False

    @staticmethod
    def _boolish_false(value: Any) -> bool:
        if value is False:
            return True
        return isinstance(value, str) and value.strip().lower() in {"false", "0", "no"}

    @staticmethod
    def _boolish_true(value: Any) -> bool:
        if value is True:
            return True
        return isinstance(value, str) and value.strip().lower() in {"true", "1", "yes"}


def format_tool_arguments(params: Any, max_len: int = _TOOL_ARGUMENTS_MAX_LEN) -> str:
    text = json.dumps(params or {}, sort_keys=True, default=str)
    if len(text) > max_len:
        return text[: max_len - 3] + "..."
    return text


class RepeatToolCallDetector:
    """Detect repeated / looping tool calls (fix/circuit_breaker_recovery)."""

    def __init__(self, config: RepeatToolConfig | None = None) -> None:
        self._config = config or RepeatToolConfig()
        self._histories: dict[str, deque[ToolCallRecord]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._last_emissions: dict[str, tuple[str, str, str]] = {}

    @property
    def name(self) -> str:
        return "repeat_tool_call"

    def reset(self) -> None:
        self._histories.clear()
        self._locks.clear()
        self._last_emissions.clear()

    def _history(self, sid: str) -> deque[ToolCallRecord]:
        h = self._histories.get(sid)
        if h is None:
            h = deque(maxlen=self._config.history_size)
            self._histories[sid] = h
        return h

    def _lock(self, sid: str) -> asyncio.Lock:
        lock = self._locks.get(sid)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[sid] = lock
        return lock

    @staticmethod
    def _resolve_sid(signal: Signal) -> str:
        if signal.member_name:
            return signal.member_name
        return "default"

    async def observe(self, signal: Signal) -> Anomaly | None:
        if signal.kind not in (SignalKind.AFTER_TOOL_CALL, SignalKind.TOOL_EXCEPTION):
            return None
        if not signal.tool_name:
            return None

        sid = self._resolve_sid(signal)
        tool_args = signal.tool_args or {}
        args_hash = self._hash_args(signal.tool_name, tool_args)
        result_hash = self._hash_outcome(signal.tool_result)
        has_error = ToolResultErrorDetector.infer_record_has_error(
            signal.tool_result,
            signal,
        )

        async with self._lock(sid):
            history = self._history(sid)
            history.append(
                ToolCallRecord(
                    tool_name=signal.tool_name,
                    args_hash=args_hash,
                    result_hash=result_hash,
                    timestamp=time.time(),
                    has_error=has_error,
                )
            )
            anomaly = self._detect(
                list(history),
                signal.member_name,
                signal.tool_name,
                args_hash,
                tool_args,
            )
            if anomaly is None:
                self._last_emissions.pop(sid, None)
                return None
            signature = (
                str(getattr(anomaly.kind, "value", anomaly.kind)),
                anomaly.severity.value,
                str(anomaly.evidence.get("detector_kind") or ""),
            )
            if self._last_emissions.get(sid) == signature:
                return None
            self._last_emissions[sid] = signature
            return anomaly

    @staticmethod
    def _hash_args(tool_name: str, params: dict) -> str:
        canonical = json.dumps(params or {}, sort_keys=True, default=str)
        return hashlib.sha256(f"{tool_name}:{canonical}".encode()).hexdigest()

    @staticmethod
    def _normalize_result(result: Any) -> dict:
        if isinstance(result, dict):
            return {
                "content": str(result.get("content", "")).strip(),
                "output": str(result.get("output", "")).strip(),
                "error": str(result.get("error", "")).strip(),
                "status": str(result.get("status", "")),
            }
        return {"raw": str(result)}

    @staticmethod
    def _hash_outcome(result: Any) -> str | None:
        if result is None:
            return None
        normalized = RepeatToolCallDetector._normalize_result(result)
        return hashlib.sha256(
            json.dumps(normalized, sort_keys=True, default=str).encode()
        ).hexdigest()

    def _detect(
        self,
        history: list[ToolCallRecord],
        member_name: str,
        tool_name: str,
        args_hash: str,
        tool_args: dict[str, Any],
    ) -> Anomaly | None:
        cfg = self._config
        tool_arguments = format_tool_arguments(tool_args)

        no_progress = self._get_no_progress_streak(history, tool_name, args_hash)
        if no_progress >= cfg.global_breaker_threshold:
            return self._build(
                KIND_TOOL_CALL_LOOP,
                Severity.CRITICAL,
                member_name,
                tool_name,
                {
                    "detector_kind": "global_circuit_breaker",
                    "msg_key": "global_circuit_breaker",
                    "critical_key": "repeat_tool_global_breaker_critical",
                    "count": no_progress,
                    "tool_arguments": tool_arguments,
                },
            )

        unknown_streak = self._get_unknown_tool_streak(history, tool_name)
        unknown_critical = self._unknown_tool_critical_threshold(cfg)
        unknown_warning = self._unknown_tool_warning_threshold(cfg)
        if unknown_streak >= unknown_critical:
            return self._build(
                KIND_REPEAT_TOOL_CALL,
                Severity.CRITICAL,
                member_name,
                tool_name,
                {
                    "detector_kind": "unknown_tool_repeat",
                    "msg_key": "unknown_tool_repeat",
                    "critical_key": "repeat_tool_unknown_tool_critical",
                    "count": unknown_streak,
                    "tool_arguments": tool_arguments,
                },
            )
        if unknown_streak >= unknown_warning:
            return self._build(
                KIND_REPEAT_TOOL_CALL,
                Severity.LOW,
                member_name,
                tool_name,
                {
                    "detector_kind": "unknown_tool_repeat",
                    "msg_key": "unknown_tool_repeat_warning",
                    "steer_key": "repeat_tool_unknown_steering",
                    "notice_key": "repeat_tool_unknown_user",
                    "count": unknown_streak,
                    "tool_arguments": tool_arguments,
                },
            )

        ping_pong = self._get_ping_pong_streak(history, args_hash)
        if ping_pong.count >= cfg.critical_threshold and ping_pong.no_progress:
            return self._build(
                KIND_TOOL_CALL_LOOP,
                Severity.CRITICAL,
                member_name,
                tool_name,
                {
                    "detector_kind": "ping_pong",
                    "msg_key": "ping_pong_critical",
                    "critical_key": "repeat_tool_pingpong_critical",
                    "count": ping_pong.count,
                    "paired_tool": ping_pong.paired_tool,
                    "tool_arguments": tool_arguments,
                },
            )
        if ping_pong.count >= cfg.warning_threshold:
            return self._build(
                KIND_TOOL_CALL_LOOP,
                Severity.LOW,
                member_name,
                tool_name,
                {
                    "detector_kind": "ping_pong",
                    "msg_key": "ping_pong_warning",
                    "steer_key": "repeat_tool_pingpong_steering",
                    "notice_key": "repeat_tool_pingpong_user",
                    "count": ping_pong.count,
                    "paired_tool": ping_pong.paired_tool,
                    "tool_arguments": tool_arguments,
                },
            )

        recent = self._count_recent_same(history, tool_name, args_hash)
        if recent >= cfg.warning_threshold:
            return self._build(
                KIND_REPEAT_TOOL_CALL,
                Severity.LOW,
                member_name,
                tool_name,
                {
                    "detector_kind": "generic_repeat",
                    "msg_key": "generic_repeat",
                    "steer_key": "repeat_tool_generic_steering",
                    "notice_key": "repeat_tool_generic_user",
                    "count": recent,
                    "tool_arguments": tool_arguments,
                },
            )

        return None

    @staticmethod
    def _build(
        kind: str,
        severity: Severity,
        member_name: str,
        tool_name: str,
        evidence: dict[str, Any],
    ) -> Anomaly:
        kind_value = getattr(kind, "value", kind)
        return Anomaly(
            detector="repeat_tool_call",
            kind=str(kind_value),
            severity=severity,
            member_name=member_name,
            summary=f"{kind_value} on {tool_name}",
            evidence=evidence,
        )

    @staticmethod
    def _unknown_tool_warning_threshold(cfg: RepeatToolConfig) -> int:
        return max(1, cfg.unknown_tool_threshold // 2)

    @staticmethod
    def _unknown_tool_critical_threshold(cfg: RepeatToolConfig) -> int:
        if cfg.unknown_tool_threshold == cfg.warning_threshold:
            return cfg.unknown_tool_threshold + 1
        return cfg.unknown_tool_threshold

    @staticmethod
    def _get_no_progress_streak(
        history: list[ToolCallRecord],
        tool_name: str,
        args_hash: str,
    ) -> int:
        streak = 0
        latest_hash: str | None = None
        for record in reversed(history):
            if record.tool_name != tool_name or record.args_hash != args_hash:
                break
            if record.result_hash is None:
                break
            if latest_hash is None:
                latest_hash = record.result_hash
                streak = 1
            elif record.result_hash == latest_hash:
                streak += 1
            else:
                break
        return streak

    @staticmethod
    def _side_outputs_stable(records: list[ToolCallRecord]) -> bool:
        hashes = [r.result_hash for r in records if r.result_hash is not None]
        if len(hashes) != len(records) or not hashes:
            return False
        return all(h == hashes[0] for h in hashes)

    @staticmethod
    def _collect_alternating_streak(
        history: list[ToolCallRecord],
    ) -> tuple[list[ToolCallRecord], str | None]:
        if len(history) < 2:
            return [], None
        last_hash = history[-1].args_hash
        other_hash: str | None = None
        other_name: str | None = None
        for record in reversed(history[:-1]):
            if record.args_hash != last_hash:
                other_hash = record.args_hash
                other_name = record.tool_name
                break
        if other_hash is None:
            return [], None

        streak_rev = [history[-1]]
        expect = other_hash
        for record in reversed(history[:-1]):
            if record.args_hash != expect:
                break
            streak_rev.append(record)
            expect = last_hash if expect == other_hash else other_hash
        streak_rev.reverse()
        return streak_rev, other_name

    def _get_ping_pong_streak(
        self,
        history: list[ToolCallRecord],
        _current_args_hash: str,
    ) -> _PingPongResult:
        streak, paired_tool = self._collect_alternating_streak(history)
        if len(streak) < 2:
            return _PingPongResult()

        count = len(streak) // 2
        hash_last = streak[-1].args_hash
        hash_other = next(r.args_hash for r in streak if r.args_hash != hash_last)

        side_last = [r for r in streak if r.args_hash == hash_last]
        side_other = [r for r in streak if r.args_hash == hash_other]

        no_progress = (
            len(side_last) >= 2
            and len(side_other) >= 2
            and self._side_outputs_stable(side_last)
            and self._side_outputs_stable(side_other)
        )

        return _PingPongResult(
            count=count,
            paired_tool=paired_tool,
            no_progress=no_progress,
        )

    @staticmethod
    def _count_recent_same(
        history: list[ToolCallRecord],
        tool_name: str,
        args_hash: str,
    ) -> int:
        count = 0
        for record in reversed(history):
            if record.tool_name != tool_name or record.args_hash != args_hash:
                break
            count += 1
        return count

    @staticmethod
    def _get_unknown_tool_streak(
        history: list[ToolCallRecord],
        tool_name: str,
    ) -> int:
        streak = 0
        for record in reversed(history):
            if record.tool_name != tool_name:
                break
            if not record.has_error:
                break
            streak += 1
        return streak


def _build_repeat_tool_detector(
    cfg: RepeatToolConfig,
    agents: Any,
) -> RepeatToolCallDetector | None:
    del agents
    if not cfg.enabled:
        return None
    return RepeatToolCallDetector(cfg)


_PARENT = {
    "thinking_loop": {"zh": "思考循环", "en": "Thinking loop"},
    "thinking_dead_loop": {"zh": "思考死循环", "en": "Thinking dead loop"},
    "tool_repeat_dead_loop": {
        "zh": "工具重复死循环",
        "en": "Tool-call repeat dead loop",
    },
}

PRESENTATION_REPEAT_TOOL = DomainPresentation(
    order=10,
    label={"zh": "工具重复死循环", "en": "Tool-call repeat"},
    submodes=(
        SubmodePresentation(
            id="generic_repeat",
            parent_id="tool_repeat_dead_loop",
            parent=_PARENT["tool_repeat_dead_loop"],
            sub_mode={"zh": "同参重复调用", "en": "Generic repeat"},
            anomaly_kind="repeat_tool_call",
            detection_level=None,
            severities=("low",),
            detects={
                "zh": "同一工具 + 相同参数重复调用达到阈值（默认 ≥5）。",
                "en": "Same tool + identical arguments repeated to threshold (default ≥5).",
            },
            recovery_summary={
                "zh": "观察 + 注入 steering（低危默认策略）。",
                "en": "Observe + inject steering (low-severity default policy).",
            },
            recovery_actions=("observe_only", "inject_steering"),
            runtime_keys={"detector_kind": "generic_repeat"},
            prompts=(
                PromptPresentation(
                    key="repeat_tool_generic_steering",
                    role="steering",
                    template_zh=(
                        "你已多次使用完全相同参数重复调用同一工具，且未取得进展。\n"
                        "重复工具调用检测结果：\n"
                        "- 工具：{tool_name}\n"
                        "- 重复次数：{count}\n"
                        "- 参数：{tool_arguments}\n"
                        "上述重复调用未产生有效进展。请勿再次使用完全相同的工具与参数进行调用。\n"
                        "请分析导致工具重复调用的原因，并采取应对方案：立刻停止工具重复调用，"
                        "调整参数、更换工具/策略，或在已有证据充分时结束任务。"
                    ),
                    template_en=(
                        "You have repeatedly called the same tool with identical parameters many times.\n"
                        "Repeated tool call detected:\n"
                        "- tool: {tool_name}\n"
                        "- repeated_times: {count}\n"
                        "- arguments: {tool_arguments}\n"
                        "The previous repeated calls did not make progress. "
                        "Do not call this exact same tool with the exact same arguments again.\n"
                        "Analyze why the tool is being called repeatedly and take corrective action: "
                        "stop repeating the same tool call immediately, adjust parameters, switch tools/strategy, "
                        "or finish the task if enough evidence has been gathered."
                    ),
                ),
            ),
        ),
        SubmodePresentation(
            id="unknown_tool_repeat",
            parent_id="tool_repeat_dead_loop",
            parent=_PARENT["tool_repeat_dead_loop"],
            sub_mode={"zh": "失败工具连打", "en": "Unknown/failing tool repeat"},
            anomaly_kind="repeat_tool_call",
            detection_level=None,
            severities=("medium", "critical"),
            detects={
                "zh": "失败或未知工具连续重试；警告约阈值/2，严重度达阈值。",
                "en": "Failing/unknown tool retried in a streak; warning ≈ threshold/2, critical at threshold.",
            },
            recovery_summary={
                "zh": "中危：注入 steering；严重：注入 steering + 升级用户通知。",
                "en": "Medium: inject steering; critical: steering + escalate user notice.",
            },
            recovery_actions=("inject_steering", "escalate_user", "report_to_user"),
            runtime_keys={"detector_kind": "unknown_tool_repeat"},
            prompts=(
                PromptPresentation(
                    key="repeat_tool_unknown_steering",
                    role="steering",
                    severity_band="medium",
                    template_zh=(
                        "未知或失败的工具已被连续多次调用，且未取得进展。\n"
                        "重复工具调用检测结果：\n"
                        "- 工具：{tool_name}\n"
                        "- 重复次数：{count}\n"
                        "- 参数：{tool_arguments}\n"
                        "上述重复调用未产生有效进展。请勿再次使用完全相同的工具与参数进行调用。\n"
                        "请分析导致工具重复调用的原因，并采取应对方案：立刻停止工具重复调用，"
                        "调整参数、更换工具/策略，或在已有证据充分时结束任务。"
                    ),
                    template_en=(
                        "An unknown or failing tool has been called repeatedly with no progress.\n"
                        "Repeated tool call detected:\n"
                        "- tool: {tool_name}\n"
                        "- repeated_times: {count}\n"
                        "- arguments: {tool_arguments}\n"
                        "The previous repeated calls did not make progress. "
                        "Do not call this exact same tool with the exact same arguments again.\n"
                        "Analyze why the tool is being called repeatedly and take corrective action: "
                        "stop repeating the same tool call immediately, adjust parameters, switch tools/strategy, "
                        "or finish the task if enough evidence has been gathered."
                    ),
                ),
                PromptPresentation(
                    key="repeat_tool_unknown_user",
                    role="notice",
                    severity_band="medium",
                    template_zh="[工具调用异常] 工具 {tool_name} 已连续失败 {count} 次。",
                    template_en="[Tool Call Anomaly] Tool {tool_name} has failed {count} times in a row.",
                ),
                PromptPresentation(
                    key="repeat_tool_unknown_tool_critical",
                    role="critical",
                    severity_band="critical",
                    template_zh="未知工具 {tool_name} 连续调用 {count} 次，停止重试",
                    template_en="Unknown tool {tool_name} called {count} times in a row, stopping retries",
                ),
            ),
        ),
        SubmodePresentation(
            id="ping_pong",
            parent_id="tool_repeat_dead_loop",
            parent=_PARENT["tool_repeat_dead_loop"],
            sub_mode={"zh": "ping_pong", "en": "ping_pong"},
            anomaly_kind="tool_call_loop",
            detection_level=None,
            severities=("medium", "critical"),
            detects={
                "zh": "工具 A↔B 交替调用；警告 ≥5 轮，严重 ≥10 轮且无进展。",
                "en": "Alternating A↔B tool calls; warning ≥5 rounds, critical ≥10 with no progress.",
            },
            recovery_summary={
                "zh": "中危：注入 steering；严重：注入 steering + 升级用户通知。",
                "en": "Medium: inject steering; critical: steering + escalate user notice.",
            },
            recovery_actions=("inject_steering", "escalate_user", "report_to_user"),
            runtime_keys={"detector_kind": "ping_pong"},
            prompts=(
                PromptPresentation(
                    key="repeat_tool_pingpong_steering",
                    role="steering",
                    severity_band="medium",
                    template_zh=(
                        "检测到 Ping-Pong 交替工具调用且未取得进展。\n"
                        "- 交替轮次：{count}\n"
                        "- 最新工具：{tool_name}\n"
                        "请停止 A↔B 工具循环。合并步骤、更换策略或换路径；若已有证据充分，请结束任务。"
                    ),
                    template_en=(
                        "Ping-pong alternating tool calls detected with no progress.\n"
                        "- rounds: {count}\n"
                        "- latest tool: {tool_name}\n"
                        "Stop the A↔B tool loop. Merge steps, change approach, "
                        "or finish the task if enough evidence has been gathered."
                    ),
                ),
                PromptPresentation(
                    key="repeat_tool_pingpong_user",
                    role="notice",
                    severity_band="medium",
                    template_zh="[工具调用异常] Ping-Pong 交替调用已持续 {count} 轮。",
                    template_en="[Tool Call Anomaly] Ping-pong alternating calls have continued for {count} rounds.",
                ),
                PromptPresentation(
                    key="repeat_tool_pingpong_critical",
                    role="critical",
                    severity_band="critical",
                    template_zh="Ping-Pong 循环: {count} 轮交替无进展，阻断",
                    template_en="Ping-pong loop: {count} alternating calls with no progress, blocked",
                ),
            ),
        ),
        SubmodePresentation(
            id="global_circuit_breaker",
            parent_id="tool_repeat_dead_loop",
            parent=_PARENT["tool_repeat_dead_loop"],
            sub_mode={"zh": "全局断路", "en": "Global circuit breaker"},
            anomaly_kind="tool_call_loop",
            detection_level=None,
            severities=("critical",),
            detects={
                "zh": "同工具+参数连续无进展达到全局断路阈值（默认 ≥10）。",
                "en": "Same tool+args with no progress hits global circuit-breaker threshold (default ≥10).",
            },
            recovery_summary={
                "zh": "注入 steering + 升级用户通知（严重默认策略）。",
                "en": "Inject steering + escalate user notice (critical default policy).",
            },
            recovery_actions=("inject_steering", "escalate_user"),
            runtime_keys={"detector_kind": "global_circuit_breaker"},
            prompts=(
                PromptPresentation(
                    key="repeat_tool_global_breaker_critical",
                    role="critical",
                    template_zh="全局断路器: {tool_name} 连续 {count} 次无进展",
                    template_en="Circuit breaker: {tool_name} made no progress for {count} consecutive calls",
                ),
            ),
        ),
    ),
)

DETECTOR_PLUGIN = DetectorPlugin(
    id="repeat_tool",
    kinds=("repeat_tool_call", "tool_call_loop"),
    kind_to_domain={
        "repeat_tool_call": "repeat_tool",
        "tool_call_loop": "repeat_tool",
    },
    config_model=RepeatToolConfig,
    factory=_build_repeat_tool_detector,
    detection_skill=None,
    anchor="tool",
    priority=10,
    presentation=PRESENTATION_REPEAT_TOOL,
)
