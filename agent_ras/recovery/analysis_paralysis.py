# coding: utf-8
"""Recovery strategy + user-facing copy for analysis_paralysis."""
from __future__ import annotations

from detectors.types import RecoveryPlugin
from recovery.engine import RecoveryAction

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

_MESSAGES: dict[str, dict[str, str]] = {
    "cn": {
        "analysis_paralysis_steering_recovery": _STEER_ZH,
        "analysis_paralysis_recovery_user_notice": (
            "检测到过度思考（分析瘫痪）异常，已执行恢复操作"
        ),
        "steer_default": _STEER_ZH,
        "notice_default": "检测到过度思考（分析瘫痪）异常，已执行恢复操作",
    },
    "en": {
        "analysis_paralysis_steering_recovery": _STEER_EN,
        "analysis_paralysis_recovery_user_notice": (
            "Detected an analysis-paralysis (overthinking) anomaly; recovery has been applied"
        ),
        "steer_default": _STEER_EN,
        "notice_default": (
            "Detected an analysis-paralysis (overthinking) anomaly; recovery has been applied"
        ),
    },
}

RECOVERY_PLUGIN = RecoveryPlugin(
    id="analysis_paralysis",
    kind_overrides={
        "analysis_paralysis": [
            RecoveryAction.OBSERVE_ONLY,
            RecoveryAction.SUPPRESS_STREAM,
        ],
    },
    stream_kinds=("analysis_paralysis",),
    anchor="llm",
    messages=_MESSAGES,
)

__all__ = ["RECOVERY_PLUGIN"]
