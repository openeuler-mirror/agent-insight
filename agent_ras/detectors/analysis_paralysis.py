# coding: utf-8
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""Analysis paralysis detector — sliding-window trigger count + Skill semantic redundancy.

Counts trigger-phrase hits (REFRAIN Appendix A vocabulary, 4 categories) per step,
accumulates them in a sliding window of *history_steps* steps, and invokes the
semantic-redundancy Skill when the window total reaches *trigger_count_threshold*.

Problem definition: Cuadron et al. Analysis Paralysis (arXiv:2502.08235).
"""
from __future__ import annotations

import asyncio
import contextvars
import logging
import re
import time
from dataclasses import dataclass, field
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
from detectors.skill_verdicts import (
    SkillVerdict,
    extract_report_payload,
    verdict_to_dict,
)
from detectors.types import (
    DetectorPlugin,
    DomainPresentation,
    PromptPresentation,
    SubmodePresentation,
)
from core.models import Anomaly, Severity, Signal, SignalKind

logger = logging.getLogger(__name__)

FAULT_DOMAIN_ANALYSIS_PARALYSIS = "analysis_paralysis"
KIND_ANALYSIS_PARALYSIS = "analysis_paralysis"

STREAM_CHANNELS: tuple[str, ...] = ("llm_output", "llm_reasoning")

# REFRAIN Appendix A — English, used as-is in their experiments.
_VCHECK_EN = (
    "wait",
    "let me check",
    "hold on",
    "have made a mistake",
    "let me double check",
    "wait a moment",
    "is that correct",
    "let me re-read",
)
_VSHIFT_EN = (
    "alternatively",
    "let me try",
    "think of it as",
    "let me consider",
    "what if we try",
    "let's think from a different angle",
    "an alternative method would be",
    "instead of doing that",
)
_VUNCERT_EN = (
    "not sure",
    "looks like",
    "that seems",
    "hmm",
    "perhaps",
    "maybe i",
    "i'm not certain",
    "it seems",
    "i suspect",
    "my guess is",
)
_VRETRO_EN = (
    "earlier we saw",
    "from before",
    "so now we have",
    "recall that",
    "let me go back",
    "as we established previously",
    "based on our previous result",
    "remember that we found",
    "the value from step",
)

# Same four categories, Chinese localization of Appendix A (not new taxonomy).
_VCHECK_ZH = (
    "等一下",
    "让我检查",
    "稍等",
    "我搞错了",
    "让我再确认",
    "再确认一下",
    "等一会儿",
    "这样对吗",
    "让我再读",
)
_VSHIFT_ZH = (
    "换一个思路",
    "让我试试",
    "另一种方法",
    "换个角度看",
    "如果试试",
)
_VUNCERT_ZH = (
    "不太确定",
    "好像",
    "似乎",
    "也许",
    "我猜",
)
_VRETRO_ZH = (
    "回到之前",
    "前面提到",
    "回想一下",
    "让我回去",
)

_BLANK_LINE_RE = re.compile(r"\n\s*\n")
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[。！？.!?])\s+")
_SHORT_TOKEN_RE = re.compile(r"^[a-z0-9']+$")

SENTENCE_FALLBACK_CHARS = 400
HISTORY_DEFAULT_STEPS = 8
HISTORY_DEFAULT_MAX_CHARS = 6000


class AnalysisParalysisFault(str, Enum):
    NONE = "none"
    ANALYSIS_PARALYSIS = "analysis_paralysis"


class TriggerVocabConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    self_check: list[str] = Field(
        default_factory=lambda: list(_VCHECK_EN + _VCHECK_ZH),
    )
    strategy_shift: list[str] = Field(
        default_factory=lambda: list(_VSHIFT_EN + _VSHIFT_ZH),
    )
    uncertainty: list[str] = Field(
        default_factory=lambda: list(_VUNCERT_EN + _VUNCERT_ZH),
    )
    retrospective: list[str] = Field(
        default_factory=lambda: list(_VRETRO_EN + _VRETRO_ZH),
    )


class AnalysisParalysisConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    detection_start_chars: int = Field(
        default=500,
        ge=1,
        description="Cumulative chars before REFRAIN gating runs",
    )
    history_steps: int = Field(
        default=HISTORY_DEFAULT_STEPS,
        ge=1,
        description="Prior steps sent to the redundancy Skill",
    )
    history_max_chars: int = Field(
        default=HISTORY_DEFAULT_MAX_CHARS,
        ge=200,
        description="Cap on Skill payload history+current chars",
    )
    trigger_count_threshold: int = Field(
        default=10,
        ge=1,
        description="Sliding-window trigger-phrase hit count required to invoke Skill",
    )


class AnalysisParalysisVerdict(SkillVerdict):
    primary_fault: AnalysisParalysisFault = AnalysisParalysisFault.NONE

    @field_validator("primary_fault", mode="before")
    @classmethod
    def _coerce_fault(cls, value: Any) -> AnalysisParalysisFault:
        if isinstance(value, AnalysisParalysisFault):
            return value
        text = str(value or "").strip().lower()
        try:
            return AnalysisParalysisFault(text)
        except ValueError as e:
            raise ValueError(f"unknown primary_fault: {value!r}") from e

    def model_post_init(self, __context: Any) -> None:
        if self.fail_open_reason:
            return
        fault_abnormal = self.primary_fault != AnalysisParalysisFault.NONE
        if self.abnormal != fault_abnormal:
            raise ValueError(
                f"abnormal ({self.abnormal}) inconsistent with "
                f"primary_fault ({self.primary_fault})"
            )


def fail_open_ap_verdict(reason: str = "invalid_or_empty") -> AnalysisParalysisVerdict:
    return AnalysisParalysisVerdict(
        abnormal=False,
        primary_fault=AnalysisParalysisFault.NONE,
        confidence=0.0,
        rationale="",
        raw={"abnormal": False, "primary_fault": AnalysisParalysisFault.NONE.value},
        fail_open_reason=reason,
    )


def parse_analysis_paralysis_verdict(
    raw: str | dict[str, Any],
) -> AnalysisParalysisVerdict:
    payload = extract_report_payload(raw)
    if payload is None:
        return fail_open_ap_verdict("unparseable_payload")
    if not {"abnormal", "primary_fault"}.issubset(payload.keys()):
        return fail_open_ap_verdict("missing_required_fields")
    try:
        verdict = AnalysisParalysisVerdict(
            abnormal=bool(payload.get("abnormal")),
            primary_fault=payload.get("primary_fault"),
            confidence=float(payload.get("confidence") or 0.0),
            rationale=str(payload.get("rationale") or ""),
            raw=dict(payload),
        )
    except (ValueError, TypeError):
        return fail_open_ap_verdict("schema_validation_failed")
    if (
        verdict.primary_fault != AnalysisParalysisFault.NONE
        and not verdict.abnormal
    ):
        return fail_open_ap_verdict("abnormal_primary_fault_inconsistent")
    return verdict


def phrase_in_text(text: str, phrase: str) -> bool:
    """Case-insensitive containment; short ASCII tokens use word boundaries."""
    hay = str(text or "")
    needle = str(phrase or "").strip()
    if not needle:
        return False
    hay_cf = hay.casefold()
    needle_cf = needle.casefold()
    if _SHORT_TOKEN_RE.fullmatch(needle_cf) and len(needle_cf) <= 5:
        return (
            re.search(
                rf"(?<![a-z0-9]){re.escape(needle_cf)}(?![a-z0-9])",
                hay_cf,
            )
            is not None
        )
    return needle_cf in hay_cf


def first_matching_phrase(text: str, phrases: list[str] | tuple[str, ...]) -> str | None:
    for phrase in phrases:
        if phrase_in_text(text, phrase):
            return phrase
    return None


def count_phrase_in_text(text: str, phrase: str) -> int:
    """Count occurrences of *phrase* in *text* (case-insensitive).

    Short ASCII tokens use word-boundary regex; longer phrases use str.count.
    """
    hay = str(text or "")
    needle = str(phrase or "").strip()
    if not needle:
        return 0
    hay_cf = hay.casefold()
    needle_cf = needle.casefold()
    if _SHORT_TOKEN_RE.fullmatch(needle_cf) and len(needle_cf) <= 5:
        return len(
            re.findall(
                rf"(?<![a-z0-9]){re.escape(needle_cf)}(?![a-z0-9])",
                hay_cf,
            )
        )
    return hay_cf.count(needle_cf)


def count_phrase_hits(text: str, phrases: list[str] | tuple[str, ...]) -> int:
    """Count total occurrences of all *phrases* in *text*."""
    total = 0
    for phrase in phrases:
        total += count_phrase_in_text(text, phrase)
    return total


def split_complete_steps(buffer: str) -> tuple[list[str], str]:
    """Pop complete steps: blank-line first (REFRAIN), then sentence fallback."""
    steps: list[str] = []
    rest = str(buffer or "")
    while True:
        match = _BLANK_LINE_RE.search(rest)
        if match is None:
            break
        piece = rest[: match.start()].strip()
        rest = rest[match.end() :]
        if piece:
            steps.append(piece)
    if len(rest) >= SENTENCE_FALLBACK_CHARS:
        parts = _SENTENCE_SPLIT_RE.split(rest)
        if len(parts) >= 2:
            for piece in parts[:-1]:
                trimmed = piece.strip()
                if trimmed:
                    steps.append(trimmed)
            rest = parts[-1]
    return steps, rest


@dataclass(frozen=True)
class RefrainStepHit:
    text: str
    trigger_hits: dict[str, int]
    step_hit_count: int
    window_hit_count: int
    gated: bool


class RefrainGate:
    """Sliding-window trigger-phrase counter.

    Each step counts all phrase hits across the four vocabulary categories.
    The window accumulates per-step counts; when the window total reaches
    *threshold*, the step is gated (Skill invocation).
    """

    def __init__(
        self,
        vocab: TriggerVocabConfig | None = None,
        window_size: int = HISTORY_DEFAULT_STEPS,
        threshold: int = 10,
    ) -> None:
        self._vocab = vocab or TriggerVocabConfig()
        self._window_size = window_size
        self._threshold = threshold
        self._window: list[int] = []

    def reset(self) -> None:
        self._window.clear()

    def reset_count(self) -> None:
        self._window.clear()

    def _count_hits_per_category(self, text: str) -> dict[str, int]:
        return {
            name: count_phrase_hits(text, phrases)
            for name, phrases in (
                ("self_check", self._vocab.self_check),
                ("strategy_shift", self._vocab.strategy_shift),
                ("uncertainty", self._vocab.uncertainty),
                ("retrospective", self._vocab.retrospective),
            )
        }

    def observe_step(self, text: str) -> RefrainStepHit:
        step = str(text or "").strip()
        hits = self._count_hits_per_category(step)
        step_count = sum(hits.values())
        self._window.append(step_count)
        if len(self._window) > self._window_size:
            self._window.pop(0)
        window_total = sum(self._window)
        gated = window_total >= self._threshold
        return RefrainStepHit(
            text=step,
            trigger_hits=hits,
            step_hit_count=step_count,
            window_hit_count=window_total,
            gated=gated,
        )


@dataclass
class _ChannelState:
    buffer: str = ""
    pending: str = ""
    total_length: int = 0
    history: list[str] = field(default_factory=list)
    gate: RefrainGate | None = None
    eval_in_flight: bool = False
    detection_latched: bool = False


@dataclass
class _SemanticEvalJob:
    ch: _ChannelState
    excerpt: str
    current_step: str
    trigger_hits: dict[str, int]
    window_hit_count: int
    chunk_type: str
    member: str
    generation: int


class AnalysisParalysisDetector:
    def __init__(
        self,
        config: AnalysisParalysisConfig | None = None,
        agents: RASAgents | None = None,
    ) -> None:
        self._config = config or AnalysisParalysisConfig()
        self._agents = agents or RASAgents(NoOpAgentAdapter())
        self._channels: dict[str, _ChannelState] = {}
        self._async_recovery_handler: AsyncRecoveryHandler | None = None
        self._generation = 0
        self._eval_tasks: set[asyncio.Task] = set()

    @property
    def name(self) -> str:
        return FAULT_DOMAIN_ANALYSIS_PARALYSIS

    def set_async_recovery_handler(
        self,
        handler: AsyncRecoveryHandler | None,
    ) -> None:
        self._async_recovery_handler = handler

    def has_async_recovery_in_flight(self) -> bool:
        if self._eval_tasks:
            return True
        return any(ch.eval_in_flight for ch in self._channels.values())

    async def await_async_recovery(self, timeout: float) -> None:
        if timeout <= 0:
            return
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not self.has_async_recovery_in_flight():
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
                            "[AnalysisParalysisDetector] eval task failed "
                            "during await_async_recovery",
                            exc_info=True,
                        )
            else:
                await asyncio.sleep(0.05)
        if self.has_async_recovery_in_flight():
            logger.warning(
                "[AnalysisParalysisDetector] await_async_recovery timed out "
                "after %.1fs",
                timeout,
            )
            self.release_async_recovery()

    def release_async_recovery(self) -> None:
        self._cancel_eval_tasks()
        for ch in self._channels.values():
            ch.eval_in_flight = False

    def reset(self) -> None:
        self._generation += 1
        self._cancel_eval_tasks()
        self._channels.clear()

    def release_after_recovery_normal(self) -> None:
        for ch in self._channels.values():
            ch.detection_latched = False
            ch.eval_in_flight = False
            if ch.gate is not None:
                ch.gate.reset_count()

    def _cancel_eval_tasks(self) -> None:
        for task in list(self._eval_tasks):
            task.cancel()
        self._eval_tasks.clear()

    def _channel(self, chunk_type: str) -> _ChannelState:
        ch = self._channels.get(chunk_type)
        if ch is None:
            ch = _ChannelState(
                gate=RefrainGate(
                    vocab=TriggerVocabConfig(),
                    window_size=self._config.history_steps,
                    threshold=self._config.trigger_count_threshold,
                ),
            )
            self._channels[chunk_type] = ch
        return ch

    def _build_excerpt(self, ch: _ChannelState, current: str) -> str:
        hist = list(ch.history[-self._config.history_steps :])
        hist_text = "\n\n".join(hist)
        budget = self._config.history_max_chars
        if len(hist_text) + len(current) + 32 > budget:
            overflow = len(hist_text) + len(current) + 32 - budget
            hist_text = hist_text[overflow:] if overflow < len(hist_text) else ""
        return (
            "## history\n"
            f"{hist_text.strip() or '(empty)'}\n\n"
            "## current_step\n"
            f"{current}"
        )

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
                "[AnalysisParalysisDetector] observe failed member=%s kind=%s",
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

        ch = self._channel(chunk_type)
        if ch.detection_latched:
            return None

        ch.buffer += text
        ch.pending += text
        ch.total_length += len(text)

        if ch.total_length < self._config.detection_start_chars:
            return None

        steps, ch.pending = split_complete_steps(ch.pending)
        gate = ch.gate
        if gate is None:
            return None
        for step in steps:
            hit = gate.observe_step(step)
            if (
                hit.gated
                and not ch.eval_in_flight
                and not ch.detection_latched
            ):
                await self._invoke_redundancy_skill(
                    ch,
                    chunk_type,
                    signal.member_name,
                    hit,
                )
            ch.history.append(step)
            if len(ch.history) > self._config.history_steps * 2:
                ch.history = ch.history[-self._config.history_steps :]
        return None

    async def _invoke_redundancy_skill(
        self,
        ch: _ChannelState,
        chunk_type: str,
        member: str,
        hit: RefrainStepHit,
    ) -> None:
        excerpt = self._build_excerpt(ch, hit.text)
        ch.eval_in_flight = True
        generation = self._generation
        task = asyncio.create_task(
            self._run_semantic_eval(
                _SemanticEvalJob(
                    ch=ch,
                    excerpt=excerpt,
                    current_step=hit.text,
                    trigger_hits=hit.trigger_hits,
                    window_hit_count=hit.window_hit_count,
                    chunk_type=chunk_type,
                    member=member,
                    generation=generation,
                )
            ),
            context=contextvars.Context(),
        )
        self._eval_tasks.add(task)
        task.add_done_callback(self._eval_tasks.discard)

    async def _run_semantic_eval(self, job: _SemanticEvalJob) -> None:
        ch = job.ch
        generation = job.generation
        if generation != self._generation:
            return
        abnormal = False
        skill_result: dict[str, Any] = {}
        detection_skill = skill_for(FAULT_DOMAIN_ANALYSIS_PARALYSIS, "detection")
        try:
            result = await self._agents.invoke_skill(
                role="detection",
                skill_name=detection_skill,
                payload=job.excerpt,
                timeout=float(SKILL_TIMEOUT_SECONDS),
            )
            verdict = parse_analysis_paralysis_verdict(
                result if isinstance(result, dict) else {},
            )
            skill_result = verdict_to_dict(verdict)
            abnormal = verdict.abnormal
            if not abnormal:
                fail_reason = skill_result.get("fail_open_reason")
                if fail_reason:
                    logger.warning(
                        "[AnalysisParalysisDetector] skill fail-open "
                        "member=%s skill=%s reason=%s",
                        job.member,
                        detection_skill,
                        fail_reason,
                    )
        except Exception:
            logger.warning(
                "[AnalysisParalysisDetector] semantic evaluation failed "
                "member=%s",
                job.member,
                exc_info=True,
            )
            abnormal = False
        finally:
            stale = generation != self._generation
            if not stale:
                ch.eval_in_flight = False
                if ch.gate is not None:
                    ch.gate.reset_count()

        if generation != self._generation or not abnormal:
            return

        ch.detection_latched = True
        anomaly = Anomaly(
            detector=FAULT_DOMAIN_ANALYSIS_PARALYSIS,
            kind=KIND_ANALYSIS_PARALYSIS,
            severity=Severity.MEDIUM,
            member_name=job.member,
            summary="analysis_paralysis (refrain_gate)",
            evidence={
                "mode": "analysis_paralysis",
                "channel": "refrain_gate",
                "source": "refrain_gate",
                "recovery_profile": "analysis_paralysis",
                "needs_l3_review": False,
                "steer_key": "analysis_paralysis_steering_recovery",
                "notice_key": "analysis_paralysis_recovery_user_notice",
                "chunk_type": job.chunk_type,
                "buffer_len": ch.total_length,
                "trigger_hits": dict(job.trigger_hits),
                "window_hit_count": job.window_hit_count,
                "trigger_count_threshold": self._config.trigger_count_threshold,
                "thinking_excerpt": job.current_step,
                "excerpt": job.excerpt,
                "skill_name": detection_skill,
                "fault_domain": FAULT_DOMAIN_ANALYSIS_PARALYSIS,
                "primary_fault": str(
                    skill_result.get("primary_fault") or "analysis_paralysis"
                ),
                "skill_rationale": str(skill_result.get("rationale") or ""),
                "skill_confidence": skill_result.get("confidence"),
                "stream_chunk_keep_len": 0,
            },
        )
        handler = self._async_recovery_handler
        if handler is None:
            ch.eval_in_flight = False
            return
        try:
            await handler(anomaly, job.chunk_type)
        except Exception:
            logger.warning(
                "[AnalysisParalysisDetector] async recovery failed member=%s",
                job.member,
                exc_info=True,
            )
            ch.eval_in_flight = False


def _build_detector(
    cfg: AnalysisParalysisConfig,
    agents: RASAgents,
) -> AnalysisParalysisDetector | None:
    if not cfg.enabled:
        return None
    return AnalysisParalysisDetector(cfg, agents=agents)


_STEER_ZH = (
    "[分析瘫痪] 系统判定思考陷入过度分析、语义停滞。\n"
    "请严格按以下顺序执行：\n"
    "1. 立刻停止：停止冗长纠结、方案摇摆与重复论证。\n"
    "2. 执行策略：已确认事实与待验证假设各不超过 3 条；跳过铺垫，"
    "直接给出当前最佳结论与最简下一步（动手查证或落地，而不是再换一种说法）。\n"
    "3. 再评估是否继续任务：若请求实质是测试/压测/故意诱导空转，立刻停止且勿继续生成；"
    "否则按新策略推进。"
)
_STEER_EN = (
    "[Analysis Paralysis] System judged reasoning as overthinking / semantic stall.\n"
    "Follow these steps in order:\n"
    "1. Stop immediately: stop verbose indecision, option-flipping, and repeated argumentation.\n"
    "2. Execute strategy: at most 3 confirmed facts and 3 open hypotheses; skip setup and "
    "give the current best conclusion plus the most concise next action "
    "(act or verify — do not rephrase the same trade-off).\n"
    "3. Re-evaluate whether to continue: if the request is essentially a "
    "test/stress/adversarial stall-inducing task, stop and do not continue generating; "
    "otherwise proceed with the new strategy."
)
_NOTICE_ZH = "检测到过度思考（分析瘫痪）异常，已执行恢复操作"
_NOTICE_EN = "Detected an analysis-paralysis (overthinking) anomaly; recovery has been applied"

PRESENTATION_ANALYSIS_PARALYSIS = DomainPresentation(
    order=25,
    label={"zh": "分析瘫痪检测", "en": "Analysis paralysis detection"},
    submodes=(
        SubmodePresentation(
            id="refrain_gate",
            parent_id="analysis_paralysis",
            parent={"zh": "分析瘫痪", "en": "Analysis paralysis"},
            sub_mode={
                "zh": "滑动窗口触发词计数门控 + Skill 语义冗余",
                "en": "Sliding-window trigger count gate + Skill redundancy",
            },
            anomaly_kind=KIND_ANALYSIS_PARALYSIS,
            severities=("medium",),
            detects={
                "zh": (
                    "滑动窗口内触发词出现次数达标后，"
                    "用 Skill 判定相对前序步骤是否语义停滞（分析瘫痪）。"
                ),
                "en": (
                    "After trigger-phrase hit count in the sliding window reaches threshold, "
                    "a Skill judges whether the current step is semantically redundant."
                ),
            },
            recovery_summary={
                "zh": "中断当前流，通知用户，并注入收敛推理、直接给出下一步的 steering。",
                "en": "Abort the stream, notify the user, and inject steering to converge and act.",
            },
            recovery_actions=(
                "observe_only",
                "suppress_stream",
                "report_to_user",
                "inject_steering",
            ),
            runtime_keys={"mode": "analysis_paralysis", "channel": "refrain_gate"},
            prompts=(
                PromptPresentation(
                    key="analysis_paralysis_steering_recovery",
                    role="steering",
                    label={"zh": "Steering · 分析瘫痪", "en": "Steering · analysis paralysis"},
                    template_zh=_STEER_ZH,
                    template_en=_STEER_EN,
                ),
                PromptPresentation(
                    key="analysis_paralysis_recovery_user_notice",
                    role="notice",
                    label={"zh": "通知 · 分析瘫痪", "en": "Notice · analysis paralysis"},
                    template_zh=_NOTICE_ZH,
                    template_en=_NOTICE_EN,
                ),
            ),
        ),
    ),
)

DETECTOR_PLUGIN = DetectorPlugin(
    id=FAULT_DOMAIN_ANALYSIS_PARALYSIS,
    kinds=(KIND_ANALYSIS_PARALYSIS,),
    kind_to_domain={KIND_ANALYSIS_PARALYSIS: FAULT_DOMAIN_ANALYSIS_PARALYSIS},
    config_model=AnalysisParalysisConfig,
    factory=_build_detector,
    detection_skill="analysis-paralysis-detection",
    verdict_parser=parse_analysis_paralysis_verdict,
    anchor="llm",
    priority=25,
    presentation=PRESENTATION_ANALYSIS_PARALYSIS,
)
