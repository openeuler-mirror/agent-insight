# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""LlmThinkingLoopDetector — aligned with ``thinking_loop_lock_rail.py`` (PR#3102).

Per stream type, maintain independent eval channels that never mix char/time
anchors across ``llm_output`` / ``llm_reasoning``:

  - **text_repetition** (L1/L2): runs on **both** ``llm_output`` and
    ``llm_reasoning`` via ``LoopDetector`` (suffix_cycle → similar_clauses),
    gated by ``detection_start_chars`` then ``window_max_chars`` since last scan
    (same value is the near-window FIFO size and min detect length).
  - **plan_execution** (L3): semantic Skill via ``RASAgents.invoke_skill``,
    runs on ``llm_reasoning`` and (temporarily) ``llm_output``, gated by
    ``detection_start_chars`` then incremental chars >= ``semantic_eval_chars``
    (default 10k).

``tool_calls.delta`` may still be emitted by ``ReActAgent`` (enterprise-dev
baseline), but this detector does not consume it — only visible assistant
``llm_output`` / ``llm_reasoning`` text is scanned.

``BEFORE_MODEL_CALL`` resets all channel state (per model_call isolation).
"""
from __future__ import annotations

import asyncio
import contextvars
import logging
import re
import time
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from enum import Enum
from typing import Any, Optional

from agents.base import (
    NoOpAgentAdapter,
    SKILL_TIMEOUT_SECONDS,
    skill_for,
)
from agents.ras_agents import RASAgents
from pydantic import BaseModel, ConfigDict, Field, field_validator

from detectors.base import AsyncRecoveryHandler
from detectors.skill_verdicts import SkillVerdict, extract_report_payload
from detectors.types import (
    DetectorPlugin,
    DomainPresentation,
    PromptPresentation,
    SubmodePresentation,
)
from core.models import (
    Anomaly,
    Severity,
    Signal,
    SignalKind,
)

logger = logging.getLogger(__name__)


class LlmThinkingLoopConfig(BaseModel):
    """Thresholds for LLM thinking-loop detection.

    Character-based gates (``len(text)``), not word counts:

    - ``detection_start_chars``: no L1/L2/L3 until cumulative stream length
      reaches this threshold
    - ``text_repetition`` (L1/L2): after start, scan every ``window_max_chars``
      on a near-window of the same size (FIFO trim + scan gate + min length)
    - ``plan_execution`` (L3): after start, semantic skill every
      ``semantic_eval_chars`` incremental chars since last eval
    - Detection / review skill names are bound by fault-domain plugins
      (``detectors.loader``), not host-configurable.
    """

    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    detection_start_chars: int = Field(
        default=30000, ge=1,
        description="Cumulative chars before any L1/L2/L3 detection runs",
    )
    window_max_chars: int = Field(
        default=2000, ge=100,
        description="L1/L2 near-window size, scan interval, and min detect length",
    )
    loop_repeat_threshold: int = Field(default=5, ge=2)
    similar_clause_sim_threshold: float = Field(default=0.95, ge=0.0, le=1.0)
    semantic_eval_chars: int = Field(
        default=10000, ge=1,
        description="Incremental chars since last L3 eval before next detection",
    )
    semantic_content_enabled: bool = True


class ThinkingLoopFault(str, Enum):
    NONE = "none"
    SEMANTIC_DEADLOCK = "semantic_deadlock"
    TEXT_DEGRADATION = "text_degradation"
    OVERTHINKING = "overthinking"


class LlmLoopDetectionVerdict(SkillVerdict):
    primary_fault: ThinkingLoopFault = ThinkingLoopFault.NONE

    @field_validator("primary_fault", mode="before")
    @classmethod
    def _coerce_fault(cls, value: Any) -> ThinkingLoopFault:
        if isinstance(value, ThinkingLoopFault):
            return value
        text = str(value or "").strip().lower()
        try:
            return ThinkingLoopFault(text)
        except ValueError as e:
            raise ValueError(f"unknown primary_fault: {value!r}") from e

    def model_post_init(self, __context: Any) -> None:
        if self.fail_open_reason:
            return
        abnormal = self.abnormal
        fault_abnormal = self.primary_fault != ThinkingLoopFault.NONE
        if abnormal != fault_abnormal:
            raise ValueError(
                f"abnormal ({abnormal}) inconsistent with primary_fault ({self.primary_fault})"
            )


def fail_open_loop_verdict(reason: str = "invalid_or_empty") -> LlmLoopDetectionVerdict:
    return LlmLoopDetectionVerdict(
        abnormal=False,
        primary_fault=ThinkingLoopFault.NONE,
        confidence=0.0,
        rationale="",
        raw={"abnormal": False, "primary_fault": ThinkingLoopFault.NONE.value},
        fail_open_reason=reason,
    )


def parse_llm_loop_verdict(raw: str | dict[str, Any]) -> LlmLoopDetectionVerdict:
    """Parse thinking-loop detection skill output; invalid formats fail-open."""
    payload = extract_report_payload(raw)
    if payload is None:
        return fail_open_loop_verdict("unparseable_payload")

    required = {"abnormal", "primary_fault"}
    if not required.issubset(payload.keys()):
        return fail_open_loop_verdict("missing_required_fields")

    try:
        verdict = LlmLoopDetectionVerdict(
            abnormal=bool(payload.get("abnormal")),
            primary_fault=payload.get("primary_fault"),
            confidence=float(payload.get("confidence") or 0.0),
            rationale=str(payload.get("rationale") or ""),
            raw=dict(payload),
        )
    except (ValueError, TypeError):
        return fail_open_loop_verdict("schema_validation_failed")

    if verdict.primary_fault != ThinkingLoopFault.NONE and not verdict.abnormal:
        return fail_open_loop_verdict("abnormal_primary_fault_inconsistent")
    return verdict


FAULT_DOMAIN_LLM_THINKING_LOOP = "llm_thinking_loop"
KIND_LLM_THINKING_LOOP = "llm_thinking_loop"
KIND_LLM_THINKING_DEAD_LOOP = "llm_thinking_dead_loop"

# Visible assistant token streams scanned for dead-loop text (L1/L2).
STREAM_CHANNELS: tuple[str, ...] = (
    "llm_output",
    "llm_reasoning",
)

# L3 semantic / plan_execution: temporarily includes llm_output for models
# that do not emit a separate reasoning stream (e.g. deepseek-chat).
L3_STREAM_CHANNELS: frozenset[str] = frozenset({"llm_reasoning", "llm_output"})

# --- LoopDetector constants (thinking_loop_lock_rail.py) ---
MIN_CLAUSE_LEN = 5
SUFFIX_CYCLE_MIN_PATTERN_LEN = 10
SUFFIX_CYCLE_MAX_PATTERN_LEN = 150
SUFFIX_CYCLE_TAIL_WINDOW = 600

_CODE_FENCE_RE = re.compile(r"```[\w]*\n.*?```", re.DOTALL)
_CLAUSE_SPLIT_RE = re.compile(r"[。！？\n]+")
# Delete separators (underscore, punctuation, whitespace) — do NOT replace with
# spaces — so xxx_0 → xxx0 and stays one identifier token after findall.
_NON_LEXICAL_CHAR_RE = re.compile(r"[^a-zA-Z0-9\u4e00-\u9fff]+")
# Keep digits glued to letters (p2, v1, xxx0); bare counts (2650字) stay out.
_LEXICAL_TOKEN_RE = re.compile(
    r"[a-zA-Z]+[0-9]*|[0-9]+[a-zA-Z]+|[\u4e00-\u9fff]+"
)
_NORMALIZE_PREFIX_RE = re.compile(r"(^|\n)\s*(\d+[.)]\s*|step\s+[\dA-Z]+:\s*)")


@dataclass
class DetectionResult:
    detected: bool = False
    start_pos: int = 0
    mode: str = ""
    count: int = 0
    threshold: int = 0


def is_degenerate(text: str) -> bool:
    if not text:
        return True
    stripped = text.strip()
    if not stripped:
        return True
    unique_chars = set(stripped.replace(" ", "").replace("\n", "").replace("\t", ""))
    if len(unique_chars) <= 2:
        return True
    total = len(text)
    whitespace = sum(1 for c in text if c.isspace())
    if total > 0 and whitespace / total >= 0.7:
        return True
    return False


def _strip_code_fences(text: str) -> str:
    return _CODE_FENCE_RE.sub("", text)


def _extract_lexical_key(clause: str) -> str:
    if not clause:
        return ""
    lowered = clause.lower()
    compact = _NON_LEXICAL_CHAR_RE.sub("", lowered)
    tokens = _LEXICAL_TOKEN_RE.findall(compact)
    return " ".join(tokens)


def _clause_lexical_char_len(clause: str) -> int:
    return len(_extract_lexical_key(clause).replace(" ", ""))


def _split_clauses(text: str) -> list[str]:
    cleaned = _strip_code_fences(text)
    parts = _CLAUSE_SPLIT_RE.split(cleaned)
    clauses: list[str] = []
    for part in parts:
        stripped = part.strip()
        if len(stripped) <= MIN_CLAUSE_LEN:
            continue
        if _clause_lexical_char_len(stripped) <= MIN_CLAUSE_LEN:
            continue
        clauses.append(stripped)
    return clauses


def _clause_similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    key_a = _extract_lexical_key(a)
    key_b = _extract_lexical_key(b)
    if not key_a or not key_b:
        return 0.0
    if len(key_a.replace(" ", "")) <= MIN_CLAUSE_LEN or len(key_b.replace(" ", "")) <= MIN_CLAUSE_LEN:
        return 0.0
    return SequenceMatcher(None, key_a, key_b).ratio()


def _clause_positions_in_text(text: str, clauses: list[str]) -> list[int]:
    positions: list[int] = []
    search_from = 0
    for clause in clauses:
        idx = text.find(clause, search_from)
        if idx < 0:
            idx = search_from
        positions.append(idx)
        search_from = idx + max(1, len(clause))
    return positions


def normalize(text: str) -> str:
    if not text:
        return text
    try:
        text = text.lower()
        text = re.sub(r"[^\S\n]+", " ", text)
        text = _NORMALIZE_PREFIX_RE.sub(r"\1", text)
        return text
    except Exception:
        return text


def _strategy_suffix_cycle(
    text: str,
    threshold: int,
    tail: int = SUFFIX_CYCLE_TAIL_WINDOW,
    min_p: int = SUFFIX_CYCLE_MIN_PATTERN_LEN,
    max_p: int = SUFFIX_CYCLE_MAX_PATTERN_LEN,
) -> Optional[DetectionResult]:
    if len(text) < threshold * min_p:
        return None
    tail_text = text[-tail:]
    max_period = min(max_p, len(tail_text) // threshold)
    if max_period < min_p:
        return None
    for p_len in range(min_p, max_period + 1):
        pat = tail_text[-p_len:]
        if is_degenerate(pat):
            continue
        repeats = 0
        i = len(tail_text) - p_len
        while i >= 0:
            if tail_text[i:i + p_len] == pat:
                repeats += 1
                if repeats >= threshold:
                    break
                i -= p_len
            else:
                break
        if repeats >= threshold:
            offset_in_tail = len(tail_text) - repeats * p_len
            start_pos = max(0, len(text) - len(tail_text) + offset_in_tail)
            return DetectionResult(
                detected=True,
                start_pos=start_pos,
                mode="suffix_cycle",
                count=repeats,
                threshold=threshold,
            )
    return None


def _largest_similar_cluster(
    clauses: list[str],
    sim_threshold: float,
) -> list[int]:
    """Return indices of the largest connected component under pairwise similarity."""
    n = len(clauses)
    if n < 2:
        return []
    adj: list[set[int]] = [set() for _ in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            if _clause_similarity(clauses[i], clauses[j]) >= sim_threshold:
                adj[i].add(j)
                adj[j].add(i)

    seen: set[int] = set()
    best: list[int] = []
    for start in range(n):
        if start in seen or not adj[start]:
            continue
        stack = [start]
        seen.add(start)
        comp: list[int] = []
        while stack:
            u = stack.pop()
            comp.append(u)
            for v in adj[u]:
                if v not in seen:
                    seen.add(v)
                    stack.append(v)
        if len(comp) > len(best):
            best = comp
    return best


def _strategy_similar_clauses(
    text: str,
    threshold: int,
    sim_threshold: float,
) -> Optional[DetectionResult]:
    clauses = _split_clauses(text)
    if len(clauses) < threshold:
        return None

    # Count the largest similarity connected component (not the union of all
    # pairwise hits), so unrelated small pairs cannot accumulate to threshold.
    cluster = _largest_similar_cluster(clauses, sim_threshold)
    if len(cluster) < threshold:
        return None

    positions = _clause_positions_in_text(text, clauses)
    start_pos = min(positions[i] for i in cluster)
    return DetectionResult(
        detected=True,
        start_pos=start_pos,
        mode="similar_clauses",
        count=len(cluster),
        threshold=threshold,
    )


@dataclass
class LoopDetector:
    """Literal loop detector — suffix_cycle → similar_clauses (stateless)."""

    min_text_length: int = 80
    similar_clause_sim_threshold: float = 0.95
    _strategies: list = field(default_factory=list, init=False, repr=False)

    def __post_init__(self) -> None:
        sim_th = self.similar_clause_sim_threshold
        self._strategies = [
            ("suffix_cycle", _strategy_suffix_cycle),
            (
                "similar_clauses",
                lambda text, threshold: _strategy_similar_clauses(
                    text, threshold, sim_threshold=sim_th,
                ),
            ),
        ]

    def detect(self, text: str, threshold: int = 5) -> DetectionResult:
        if not text or len(text) < self.min_text_length:
            return DetectionResult(detected=False, threshold=threshold)
        if is_degenerate(text):
            return DetectionResult(detected=False, threshold=threshold)
        norm = normalize(text)
        for _mode_name, strategy in self._strategies:
            try:
                result = strategy(norm, threshold)
            except Exception:
                logger.debug(
                    "[LoopDetector] strategy %s failed",
                    _mode_name,
                    exc_info=True,
                )
                result = None
            if result is not None:
                return result
        return DetectionResult(detected=False, threshold=threshold)


@dataclass
class _TextRepetitionChannel:
    buffer: str = ""
    total_length: int = 0
    last_scanned_pos: int = 0
    detection_latched: bool = False


@dataclass
class _PlanExecutionChannel:
    buffer: str = ""
    total_length: int = 0
    last_evaluated_pos: int = 0
    last_evaluated_at: float = field(default_factory=time.monotonic)
    model_call_start: float = field(default_factory=time.monotonic)
    eval_in_flight: bool = False
    detection_latched: bool = False


@dataclass
class _SemanticEvalJob:
    ch: _PlanExecutionChannel
    excerpt: str
    trigger_buffer_len: int
    chunk_type: str
    member: str
    generation: int


class LlmThinkingLoopDetector:
    """Dual-channel LLM thinking-loop detector aligned with ThinkingLoopLockRail."""

    def __init__(
        self,
        config: LlmThinkingLoopConfig | None = None,
        agents: RASAgents | None = None,
    ) -> None:
        self._config = config or LlmThinkingLoopConfig()
        self._agents = agents or RASAgents(NoOpAgentAdapter())
        self._text_rep: dict[str, _TextRepetitionChannel] = {}
        self._plan_exec: dict[str, _PlanExecutionChannel] = {}
        self._buffers: dict[str, tuple[str, int]] = {}
        self._async_recovery_handler: AsyncRecoveryHandler | None = None
        self._generation = 0
        self._eval_tasks: set[asyncio.Task] = set()

    @property
    def name(self) -> str:
        return "llm_thinking_loop"

    def set_async_recovery_handler(
        self,
        handler: AsyncRecoveryHandler | None,
    ) -> None:
        self._async_recovery_handler = handler

    def has_async_recovery_in_flight(self) -> bool:
        return self.has_eval_in_flight()

    async def await_async_recovery(self, timeout: float) -> None:
        await self.await_in_flight_evals(timeout)

    def release_async_recovery(self) -> None:
        self.release_eval_in_flight()

    def reset(self) -> None:
        self._generation += 1
        self._cancel_eval_tasks()
        self._text_rep.clear()
        self._plan_exec.clear()
        self._buffers.clear()

    def release_text_repetition_latch(self) -> None:
        """Allow L1/L2 re-detection after recovery normal in the same model call.

        Clears ``detection_latched`` and advances ``last_scanned_pos`` so the next
        scan requires ``window_max_chars`` of new text (avoids instant re-fire
        on the already-confirmed loop buffer).
        """
        for ch in self._text_rep.values():
            ch.detection_latched = False
            ch.last_scanned_pos = len(ch.buffer)

    def release_plan_execution_latch(self) -> None:
        """Allow L3 semantic re-detection after Reviewer normal / fail-open.

        Clears ``detection_latched`` / ``eval_in_flight`` and advances the eval
        cursor so the next skill invoke needs a fresh ``semantic_eval_chars``
        window of new text.
        """
        now = time.monotonic()
        for ch in self._plan_exec.values():
            ch.detection_latched = False
            ch.eval_in_flight = False
            ch.last_evaluated_pos = len(ch.buffer)
            ch.last_evaluated_at = now

    def release_after_recovery_normal(self) -> None:
        """Release L1/L2 and L3 latches after automatic recovery normal / fail-open."""
        self.release_text_repetition_latch()
        self.release_plan_execution_latch()

    def _cancel_eval_tasks(self) -> None:
        for task in list(self._eval_tasks):
            task.cancel()
        self._eval_tasks.clear()

    async def aclose(self) -> None:
        """Cancel and join semantic evaluation tasks."""
        tasks = list(self._eval_tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._eval_tasks.clear()

    def has_eval_in_flight(self) -> bool:
        if self._eval_tasks:
            return True
        return any(ch.eval_in_flight for ch in self._plan_exec.values())

    def release_eval_in_flight(self) -> None:
        self._cancel_eval_tasks()
        for ch in self._plan_exec.values():
            ch.eval_in_flight = False

    async def await_in_flight_evals(self, timeout: float) -> None:
        """Wait for in-progress L3 skill invocations (used by AgentRASRail.after_invoke)."""
        if timeout <= 0:
            return
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not self.has_eval_in_flight():
                return
            pending = [t for t in self._eval_tasks if not t.done()]
            if pending:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                done, _ = await asyncio.wait(
                    pending,
                    timeout=min(0.05, remaining),
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for task in done:
                    try:
                        await task
                    except asyncio.CancelledError:
                        pass
                    except Exception:
                        logger.warning(
                            "[LlmThinkingLoopDetector] eval task failed "
                            "during await_in_flight_evals",
                            exc_info=True,
                        )
            else:
                await asyncio.sleep(0.05)

        if self.has_eval_in_flight():
            logger.warning(
                "[LlmThinkingLoopDetector] await_in_flight_evals timed out after %.1fs",
                timeout,
            )
            self.release_eval_in_flight()

    def _text_rep_channel(self, chunk_type: str) -> _TextRepetitionChannel:
        ch = self._text_rep.get(chunk_type)
        if ch is None:
            ch = _TextRepetitionChannel()
            self._text_rep[chunk_type] = ch
        return ch

    def _plan_exec_channel(self, chunk_type: str) -> _PlanExecutionChannel:
        ch = self._plan_exec.get(chunk_type)
        if ch is None:
            now = time.monotonic()
            ch = _PlanExecutionChannel(
                model_call_start=now,
                last_evaluated_at=now,
            )
            self._plan_exec[chunk_type] = ch
        return ch

    def _channel(self, chunk_type: str) -> _PlanExecutionChannel:
        return self._plan_exec_channel(chunk_type)

    @staticmethod
    def _trim_text_rep_buffer(
        buffer: str,
        max_chars: int,
        pos_markers: list[int],
    ) -> tuple[str, list[int]]:
        if max_chars <= 0 or len(buffer) <= max_chars:
            return buffer, pos_markers
        overflow = len(buffer) - max_chars
        buffer = buffer[overflow:]
        pos_markers = [max(0, p - overflow) for p in pos_markers]
        return buffer, pos_markers

    @staticmethod
    def _parse_skill_abnormal(result: Any) -> bool:
        if not isinstance(result, dict):
            return False
        return result.get("abnormal") is True

    async def observe(self, signal: Signal) -> Optional[Anomaly]:
        try:
            if signal.kind == SignalKind.STREAM_CHUNK:
                return await self._observe_stream(signal)
            if signal.kind == SignalKind.BEFORE_MODEL_CALL:
                self.reset()
                return None
            return None
        except Exception:
            logger.warning(
                "[LlmThinkingLoopDetector] observe failed member=%s kind=%s",
                signal.member_name,
                signal.kind,
                exc_info=True,
            )
            return None

    async def _observe_stream(self, signal: Signal) -> Optional[Anomaly]:
        chunk_type = signal.chunk_type
        if chunk_type not in STREAM_CHANNELS:
            return None
        text = signal.chunk_text or ""
        if not text:
            return None

        tr = self._text_rep_channel(chunk_type)
        run_l3 = chunk_type in L3_STREAM_CHANNELS
        pe = self._plan_exec_channel(chunk_type) if run_l3 else None

        if tr.detection_latched and (pe is None or pe.detection_latched):
            return None

        tr.buffer += text
        tr.total_length += len(text)
        tr.buffer, [tr.last_scanned_pos] = self._trim_text_rep_buffer(
            tr.buffer,
            self._config.window_max_chars,
            [tr.last_scanned_pos],
        )
        self._buffers[chunk_type] = (tr.buffer, tr.total_length)

        if pe is not None:
            pe.buffer += text
            pe.total_length += len(text)
            semantic_window = max(
                self._config.window_max_chars,
                self._config.semantic_eval_chars * 2,
            )
            if len(pe.buffer) > semantic_window:
                overflow = len(pe.buffer) - semantic_window
                pe.buffer = pe.buffer[overflow:]
                pe.last_evaluated_pos = max(0, pe.last_evaluated_pos - overflow)

        start_chars = self._config.detection_start_chars

        if (
            not tr.detection_latched
            and tr.total_length >= start_chars
        ):
            anomaly = self._run_text_repetition(
                tr, chunk_type, signal.member_name, text,
            )
            if anomaly is not None:
                return anomaly

        if (
            pe is not None
            and not pe.detection_latched
            and pe.total_length >= start_chars
        ):
            return await self._maybe_invoke_semantic_skill(
                pe, chunk_type, signal.member_name,
            )
        return None

    def _run_text_repetition(
        self,
        ch: _TextRepetitionChannel,
        chunk_type: str,
        member: str,
        last_chunk_text: str,
    ) -> Optional[Anomaly]:
        pending = len(ch.buffer) - ch.last_scanned_pos
        if pending < self._config.window_max_chars:
            return None

        ch.last_scanned_pos = len(ch.buffer)
        detector = LoopDetector(
            min_text_length=self._config.window_max_chars,
            similar_clause_sim_threshold=self._config.similar_clause_sim_threshold,
        )
        result = detector.detect(ch.buffer, threshold=self._config.loop_repeat_threshold)
        if not result.detected:
            return None

        ch.detection_latched = True
        severity = Severity.LOW if result.mode == "suffix_cycle" else Severity.MEDIUM
        chunk_start = len(ch.buffer) - len(last_chunk_text)
        keep_len = (
            max(0, result.start_pos - chunk_start)
            if result.start_pos > chunk_start
            else 0
        )
        return self._build_anomaly(
            KIND_LLM_THINKING_LOOP,
            severity,
            member,
            {
                "mode": result.mode,
                "channel": "text_repetition",
                "source": "text_repetition",
                "recovery_profile": "thinking_loop_text_rep",
                "needs_l3_review": False,
                "steer_key": "thinking_loop_lock_steering_recovery",
                "notice_key": "thinking_loop_recovery_user_notice",
                "count": result.count,
                "start_pos": result.start_pos,
                "threshold": result.threshold,
                "buffer_len": ch.total_length,
                "chunk_type": chunk_type,
                "scanned_text": ch.buffer,
                "stream_chunk_keep_len": keep_len,
            },
        )

    async def _maybe_invoke_semantic_skill(
        self,
        ch: _PlanExecutionChannel,
        chunk_type: str,
        member: str,
    ) -> Optional[Anomaly]:
        if not self._config.semantic_content_enabled or ch.eval_in_flight:
            return None

        incremental_len = len(ch.buffer) - ch.last_evaluated_pos
        if incremental_len < self._config.semantic_eval_chars:
            return None

        excerpt = ch.buffer[ch.last_evaluated_pos:]
        if not excerpt.strip():
            ch.last_evaluated_pos = len(ch.buffer)
            ch.last_evaluated_at = time.monotonic()
            return None

        ch.eval_in_flight = True
        trigger_buffer_len = len(ch.buffer)
        excerpt_copy = excerpt
        generation = self._generation
        # Empty Context cuts parent write_stream ContextVars (_current_session,
        # tool_batch, cwd) so nested detection does not inherit host state.
        task = asyncio.create_task(
            self._run_semantic_eval(
                _SemanticEvalJob(
                    ch=ch,
                    excerpt=excerpt_copy,
                    trigger_buffer_len=trigger_buffer_len,
                    chunk_type=chunk_type,
                    member=member,
                    generation=generation,
                )
            ),
            context=contextvars.Context(),
        )
        self._eval_tasks.add(task)
        task.add_done_callback(self._eval_tasks.discard)
        return None

    async def _run_semantic_eval(self, job: _SemanticEvalJob) -> None:
        ch = job.ch
        excerpt = job.excerpt
        trigger_buffer_len = job.trigger_buffer_len
        chunk_type = job.chunk_type
        member = job.member
        generation = job.generation
        if generation != self._generation:
            return
        abnormal = False
        skill_result: dict[str, Any] = {}
        detection_skill = skill_for(FAULT_DOMAIN_LLM_THINKING_LOOP, "detection")
        try:
            result = await self._agents.invoke_skill(
                role="detection",
                skill_name=detection_skill,
                payload=excerpt,
                timeout=float(SKILL_TIMEOUT_SECONDS),
            )
            if isinstance(result, dict):
                skill_result = result
            abnormal = self._parse_skill_abnormal(skill_result)
            if not abnormal:
                fail_reason = (
                    skill_result.get("fail_open_reason")
                    if isinstance(skill_result, dict)
                    else None
                )
                if not skill_result:
                    logger.warning(
                        "[LlmThinkingLoopDetector] semantic eval fail-open "
                        "member=%s skill=%s reason=empty_result",
                        member,
                        detection_skill,
                    )
                elif fail_reason:
                    logger.warning(
                        "[LlmThinkingLoopDetector] semantic eval fail-open "
                        "member=%s skill=%s reason=%s",
                        member,
                        detection_skill,
                        fail_reason,
                    )
                else:
                    logger.info(
                        "[LlmThinkingLoopDetector] semantic eval normal "
                        "member=%s skill=%s",
                        member,
                        detection_skill,
                    )
        except Exception:
            logger.warning(
                "[LlmThinkingLoopDetector] semantic evaluation failed member=%s",
                member,
                exc_info=True,
            )
            abnormal = False
        finally:
            stale = generation != self._generation
            if not stale and not abnormal:
                ch.eval_in_flight = False
                ch.last_evaluated_pos = trigger_buffer_len
                ch.last_evaluated_at = time.monotonic()

        if generation != self._generation:
            return

        if not abnormal:
            return

        ch.detection_latched = True
        primary_fault = str(skill_result.get("primary_fault") or "semantic_deadlock")
        from recovery.llm_thinking_loop import plan_exec_message_keys

        steer_key, notice_key = plan_exec_message_keys(primary_fault)
        anomaly = self._build_anomaly(
            KIND_LLM_THINKING_DEAD_LOOP,
            Severity.HIGH,
            member,
            {
                "mode": "plan_execution_loop_lock",
                "channel": "plan_execution",
                "source": "plan_execution_loop_lock",
                "recovery_profile": "thinking_loop_plan_exec",
                "needs_l3_review": True,
                "steer_key": steer_key,
                "notice_key": notice_key,
                "chunk_type": chunk_type,
                "buffer_len": ch.total_length,
                "incremental_len": len(excerpt),
                "thinking_excerpt": excerpt,
                "scanned_text": ch.buffer,
                "skill_name": detection_skill,
                "fault_domain": FAULT_DOMAIN_LLM_THINKING_LOOP,
                "stream_chunk_keep_len": 0,
                "primary_fault": primary_fault,
                "skill_rationale": str(skill_result.get("rationale") or ""),
                "skill_confidence": skill_result.get("confidence"),
            },
        )
        handler = self._async_recovery_handler
        if handler is None:
            ch.eval_in_flight = False
            return
        try:
            await handler(anomaly, chunk_type)
        except Exception:
            logger.warning(
                "[LlmThinkingLoopDetector] async recovery failed member=%s",
                member,
                exc_info=True,
            )
            ch.eval_in_flight = False

    @staticmethod
    def _build_anomaly(
        kind: str,
        severity: Severity,
        member: str,
        evidence: dict[str, Any],
    ) -> Anomaly:
        kind_value = getattr(kind, "value", kind)
        return Anomaly(
            detector="llm_thinking_loop",
            kind=str(kind_value),
            severity=severity,
            member_name=member,
            summary=f"{kind_value} ({evidence.get('mode', '?')})",
            evidence=evidence,
        )


def _build_llm_thinking_loop_detector(
    cfg: LlmThinkingLoopConfig,
    agents: RASAgents,
) -> LlmThinkingLoopDetector | None:
    if not cfg.enabled:
        return None
    return LlmThinkingLoopDetector(cfg, agents=agents)


_PARENT = {
    "thinking_loop": {"zh": "思考循环", "en": "Thinking loop"},
    "thinking_dead_loop": {"zh": "思考死循环", "en": "Thinking dead loop"},
    "tool_repeat_dead_loop": {
        "zh": "工具重复死循环",
        "en": "Tool-call repeat dead loop",
    },
}

_THINKING_LOOP_STEERING_ZH = (
    "[思考循环锁定] 系统判定重复内容异常（模式={mode}，重复{count}次）。\n"
    "请严格按以下顺序执行：\n"
    "1. 立刻停止：停止复读与沿旧路径继续生成，勿沿用刚才导致卡住的措辞与思路。\n"
    "2. 执行策略：更换全新切入点，或基于已有信息直接给出最简下一步/结论；禁止再铺垫与中间空转。\n"
    "3. 再评估是否继续任务：若请求实质是测试/压测/故意诱导循环，立刻停止且勿继续生成；否则按新策略推进。"
)

_THINKING_LOOP_STEERING_EN = (
    "[Thinking Loop Lock] System judged repetition abnormal (mode={mode}, count={count}).\n"
    "Follow these steps in order:\n"
    "1. Stop immediately: stop repeating and stop continuing along the old path; "
    "do not reuse the wording or reasoning that just caused you to get stuck.\n"
    "2. Execute strategy: switch to a fresh angle, or give the most concise next "
    "step/conclusion from what you already know; no more setup or idle churn.\n"
    "3. Re-evaluate whether to continue: if the request is essentially a "
    "test/stress/adversarial loop-inducing task, stop and do not continue "
    "generating; otherwise proceed with the new strategy."
)

_THINKING_LOOP_NOTICE_ZH = "检测到思考循环异常，已执行恢复操作"
_THINKING_LOOP_NOTICE_EN = "Detected a thinking loop anomaly; recovery has been applied"

_THINKING_LOOP_PROMPTS = (
    PromptPresentation(
        key="thinking_loop_lock_steering_recovery",
        role="steering",
        template_zh=_THINKING_LOOP_STEERING_ZH,
        template_en=_THINKING_LOOP_STEERING_EN,
    ),
    PromptPresentation(
        key="thinking_loop_recovery_user_notice",
        role="notice",
        template_zh=_THINKING_LOOP_NOTICE_ZH,
        template_en=_THINKING_LOOP_NOTICE_EN,
    ),
)

_THINKING_LOOP_RECOVERY_SUMMARY = {
    "zh": "观察 + 抑制流；确认异常后中断流、用户通知并注入 steering。",
    "en": "Observe + suppress stream; on confirm: abort, notice, and inject steering.",
}

_THINKING_LOOP_RECOVERY_ACTIONS = (
    "observe_only",
    "suppress_stream",
    "abort_stream",
    "report_to_user",
    "inject_steering",
)

PRESENTATION_LLM_THINKING_LOOP = DomainPresentation(
    order=20,
    label={"zh": "思考循环/死循环检测", "en": "Thinking loop detection"},
    submodes=(
        SubmodePresentation(
            id="suffix_cycle",
            parent_id="thinking_loop",
            parent=_PARENT["thinking_loop"],
            sub_mode={
                "zh": "输出崩溃-字面精确循环",
                "en": "Output crash — exact literal loop",
            },
            anomaly_kind="llm_thinking_loop",
            detection_level="L1",
            severities=("low",),
            detects={
                "zh": "检测 LLM 输出末尾的严格周期重复（字面死循环）。",
                "en": "Detects strict periodic repetition at the end of LLM output (literal loop).",
            },
            recovery_summary=_THINKING_LOOP_RECOVERY_SUMMARY,
            recovery_actions=_THINKING_LOOP_RECOVERY_ACTIONS,
            runtime_keys={"mode": "suffix_cycle", "channel": "text_repetition"},
            prompts=_THINKING_LOOP_PROMPTS,
        ),
        SubmodePresentation(
            id="similar_clauses",
            parent_id="thinking_loop",
            parent=_PARENT["thinking_loop"],
            sub_mode={"zh": "逻辑死循环", "en": "Logical dead loop"},
            anomaly_kind="llm_thinking_loop",
            detection_level="L2",
            severities=("medium",),
            detects={
                "zh": "检测输出中高度相似的分句/模板循环。",
                "en": "Detects highly similar clause / template loops in output.",
            },
            recovery_summary=_THINKING_LOOP_RECOVERY_SUMMARY,
            recovery_actions=_THINKING_LOOP_RECOVERY_ACTIONS,
            runtime_keys={"mode": "similar_clauses", "channel": "text_repetition"},
            prompts=_THINKING_LOOP_PROMPTS,
        ),
        SubmodePresentation(
            id="plan_execution",
            parent_id="thinking_dead_loop",
            parent=_PARENT["thinking_dead_loop"],
            sub_mode={
                "zh": "规划执行语义判定",
                "en": "Plan-execution semantic judge",
            },
            anomaly_kind="llm_thinking_dead_loop",
            detection_level="L3",
            severities=("high",),
            detects={
                "zh": (
                    "L3 异步语义判定三类异常：语义死锁（反复权衡不前进）、"
                    "文本崩坏（语句断裂/乱码）、过度思考（冗长纠结不收敛）。"
                ),
                "en": (
                    "L3 async semantic judge for three anomalies: semantic deadlock, "
                    "text degradation, and overthinking."
                ),
            },
            recovery_summary={
                "zh": (
                    "异步 detection skill → recovery skill 复核；异常则中断、通知并按 "
                    "primary_fault 注入定制 steering；正常/超时 fail-open。"
                ),
                "en": (
                    "Async detection skill → recovery skill review; on abnormal: abort, "
                    "notice, and inject steering keyed by primary_fault; normal/timeout fail-open."
                ),
            },
            recovery_actions=_THINKING_LOOP_RECOVERY_ACTIONS,
            runtime_keys={
                "mode": "plan_execution_loop_lock",
                "channel": "plan_execution",
            },
            primary_faults=(
                "semantic_deadlock",
                "text_degradation",
                "overthinking",
            ),
            prompts=(
                PromptPresentation(
                    key="plan_exec_semantic_deadlock_steering_recovery",
                    role="steering",
                    label={"zh": "Steering · 语义死锁", "en": "Steering · semantic deadlock"},
                    template_zh=(
                        "[思考循环锁定] 系统判定思考内容异常（语义死锁）。\n"
                        "请严格按以下顺序执行：\n"
                        "1. 立刻停止：停止在同一前提下反复比较与空转权衡。\n"
                        "2. 执行策略：明确做出取舍或临时假设并标注；已多次无法得出结论的方向视为死路，"
                        "直接给出最简下一步行动或结论。\n"
                        "3. 再评估是否继续任务：若请求实质是测试/压测/故意诱导循环，立刻停止且勿继续生成；"
                        "否则按新策略推进。"
                    ),
                    template_en=(
                        "[Thinking Loop Lock] System judged reasoning abnormal (semantic deadlock).\n"
                        "Follow these steps in order:\n"
                        "1. Stop immediately: stop comparing under the same premises and idle weighing loops.\n"
                        "2. Execute strategy: make a clear trade-off or state a temporary assumption; "
                        "treat repeatedly dead-end directions as closed, and output only the most concise "
                        "next action or conclusion.\n"
                        "3. Re-evaluate whether to continue: if the request is essentially a "
                        "test/stress/adversarial loop-inducing task, stop and do not continue generating; "
                        "otherwise proceed with the new strategy."
                    ),
                ),
                PromptPresentation(
                    key="plan_exec_text_degradation_steering_recovery",
                    role="steering",
                    label={"zh": "Steering · 文本崩坏", "en": "Steering · text degradation"},
                    template_zh=(
                        "[思考循环锁定] 系统判定思考内容异常（文本崩坏）。\n"
                        "请严格按以下顺序执行：\n"
                        "1. 立刻停止：停止继续生成混乱、断裂或碎片化内容。\n"
                        "2. 执行策略：用完整、可读句子重写当前要点；信息不足时直接说明缺口，勿拼接碎片。\n"
                        "3. 再评估是否继续任务：若请求实质是测试/压测/故意诱导循环，立刻停止且勿继续生成；"
                        "否则按新策略推进。"
                    ),
                    template_en=(
                        "[Thinking Loop Lock] System judged reasoning abnormal (text degradation).\n"
                        "Follow these steps in order:\n"
                        "1. Stop immediately: stop generating garbled, broken, or fragmented text.\n"
                        "2. Execute strategy: rewrite the current point in complete, readable sentences; "
                        "if information is missing, state the gap—do not stitch fragments together.\n"
                        "3. Re-evaluate whether to continue: if the request is essentially a "
                        "test/stress/adversarial loop-inducing task, stop and do not continue generating; "
                        "otherwise proceed with the new strategy."
                    ),
                ),
                PromptPresentation(
                    key="plan_exec_overthinking_steering_recovery",
                    role="steering",
                    label={"zh": "Steering · 过度思考", "en": "Steering · overthinking"},
                    template_zh=(
                        "[思考循环锁定] 系统判定思考内容异常（过度思考）。\n"
                        "请严格按以下顺序执行：\n"
                        "1. 立刻停止：停止冗长纠结与重复论证。\n"
                        "2. 执行策略：已确认事实与待验证假设各不超过 3 条；跳过铺垫，直接输出最简下一步或阶段性结论。\n"
                        "3. 再评估是否继续任务：若请求实质是测试/压测/故意诱导循环，立刻停止且勿继续生成；"
                        "否则按新策略推进。"
                    ),
                    template_en=(
                        "[Thinking Loop Lock] System judged reasoning abnormal (overthinking).\n"
                        "Follow these steps in order:\n"
                        "1. Stop immediately: stop verbose indecision and repeated argumentation.\n"
                        "2. Execute strategy: at most 3 confirmed facts and 3 open hypotheses; "
                        "skip setup and output the most concise next step or interim conclusion.\n"
                        "3. Re-evaluate whether to continue: if the request is essentially a "
                        "test/stress/adversarial loop-inducing task, stop and do not continue generating; "
                        "otherwise proceed with the new strategy."
                    ),
                ),
                PromptPresentation(
                    key="plan_exec_semantic_deadlock_recovery_user_notice",
                    role="notice",
                    label={"zh": "通知 · 语义死锁", "en": "Notice · semantic deadlock"},
                    template_zh="检测到思考语义死锁异常，已执行恢复操作",
                    template_en="Detected a semantic deadlock anomaly; recovery has been applied",
                ),
                PromptPresentation(
                    key="plan_exec_text_degradation_recovery_user_notice",
                    role="notice",
                    label={"zh": "通知 · 文本崩坏", "en": "Notice · text degradation"},
                    template_zh="检测到思考文本崩坏异常，已执行恢复操作",
                    template_en="Detected a text degradation anomaly; recovery has been applied",
                ),
                PromptPresentation(
                    key="plan_exec_overthinking_recovery_user_notice",
                    role="notice",
                    label={"zh": "通知 · 过度思考", "en": "Notice · overthinking"},
                    template_zh="检测到过度思考异常，已执行恢复操作",
                    template_en="Detected an overthinking anomaly; recovery has been applied",
                ),
            ),
        ),
    ),
)

DETECTOR_PLUGIN = DetectorPlugin(
    id="llm_thinking_loop",
    kinds=("llm_thinking_loop", "llm_thinking_dead_loop"),
    kind_to_domain={
        "llm_thinking_loop": "llm_thinking_loop",
        "llm_thinking_dead_loop": "llm_thinking_loop",
    },
    config_model=LlmThinkingLoopConfig,
    factory=_build_llm_thinking_loop_detector,
    detection_skill="llm-loop-detection",
    verdict_parser=parse_llm_loop_verdict,
    anchor="llm",
    priority=20,
    presentation=PRESENTATION_LLM_THINKING_LOOP,
)
