# coding: utf-8
"""Recovery strategy + user-facing copy for llm_thinking_loop."""
from __future__ import annotations

from detectors.types import RecoveryPlugin
from recovery.engine import RecoveryAction

# Domain-owned copy merged into robustness_prompt locale catalogs at load.
# Keep wording aligned with historical robustness_prompt templates (tests assert).
_MESSAGES: dict[str, dict[str, str]] = {
    "cn": {
        "thinking_loop_lock_steering_recovery": (
            "[思考循环锁定] 系统判定重复内容异常（模式={mode}，重复{count}次）。\n"
            "请严格按以下顺序执行：\n"
            "1. 立刻停止：停止复读与沿旧路径继续生成，勿沿用刚才导致卡住的措辞与思路。\n"
            "2. 执行策略：更换全新切入点，或基于已有信息直接给出最简下一步/结论；"
            "禁止再铺垫与中间空转。\n"
            "3. 再评估是否继续任务：若请求实质是测试/压测/故意诱导循环，立刻停止且勿继续生成；"
            "否则按新策略推进。"
        ),
        "plan_exec_overthinking_steering_recovery": (
            "[思考循环锁定] 系统判定思考内容异常（过度思考）。\n"
            "请严格按以下顺序执行：\n"
            "1. 立刻停止：停止冗长纠结与重复论证。\n"
            "2. 执行策略：已确认事实与待验证假设各不超过 3 条；跳过铺垫，"
            "直接输出最简下一步或阶段性结论。\n"
            "3. 再评估是否继续任务：若请求实质是测试/压测/故意诱导循环，立刻停止且勿继续生成；"
            "否则按新策略推进。"
        ),
        "plan_exec_overthinking_recovery_user_notice": (
            "检测到过度思考异常，已执行恢复操作"
        ),
        "thinking_loop_recovery_user_notice": (
            "检测到思考循环异常，已执行恢复操作"
        ),
    },
    "en": {
        "thinking_loop_lock_steering_recovery": (
            "[Thinking Loop Lock] System judged repetition abnormal "
            "(mode={mode}, count={count}).\n"
            "Follow these steps in order:\n"
            "1. Stop immediately: stop repeating and stop continuing along the old path; "
            "do not reuse the wording or reasoning that just caused you to get stuck.\n"
            "2. Execute strategy: switch to a fresh angle, or give the most concise next "
            "step/conclusion from what you already know; no more setup or idle churn.\n"
            "3. Re-evaluate whether to continue: if the request is essentially a "
            "test/stress/adversarial loop-inducing task, stop and do not continue "
            "generating; otherwise proceed with the new strategy."
        ),
        "plan_exec_overthinking_steering_recovery": (
            "[Thinking Loop Lock] System judged reasoning abnormal (overthinking).\n"
            "Follow these steps in order:\n"
            "1. Stop immediately: stop verbose indecision and repeated argumentation.\n"
            "2. Execute strategy: at most 3 confirmed facts and 3 open hypotheses; "
            "skip setup and output the most concise next step or interim conclusion.\n"
            "3. Re-evaluate whether to continue: if the request is essentially a "
            "test/stress/adversarial loop-inducing task, stop and do not continue "
            "generating; otherwise proceed with the new strategy."
        ),
        "plan_exec_overthinking_recovery_user_notice": (
            "Detected an overthinking anomaly; recovery has been applied"
        ),
        "thinking_loop_recovery_user_notice": (
            "Detected a thinking loop anomaly; recovery has been applied"
        ),
    },
}

RECOVERY_PLUGIN = RecoveryPlugin(
    id="llm_thinking_loop",
    kind_overrides={
        "llm_thinking_loop": [
            RecoveryAction.OBSERVE_ONLY,
            RecoveryAction.SUPPRESS_STREAM,
        ],
        "llm_thinking_dead_loop": [
            RecoveryAction.OBSERVE_ONLY,
            RecoveryAction.SUPPRESS_STREAM,
        ],
    },
    stream_kinds=("llm_thinking_loop", "llm_thinking_dead_loop"),
    anchor="llm",
    messages=_MESSAGES,
)

__all__ = ["RECOVERY_PLUGIN"]
