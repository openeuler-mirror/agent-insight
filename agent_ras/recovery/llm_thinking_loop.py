# coding: utf-8
"""Recovery strategy + user-facing copy for llm_thinking_loop."""
from __future__ import annotations

from detectors.types import RecoveryPlugin
from recovery.engine import RecoveryAction

_MESSAGES: dict[str, dict[str, str]] = {
    "cn": {
        "llm_loop_literal_low": (
            "检测到 LLM 输出末尾的严格周期重复 {repeats} 次。"
        ),
        "llm_loop_progressive_medium": (
            "检测到 LLM 输出中出现 {repeats} 个高度相似的子句，疑似模板循环。"
        ),
        "llm_loop_literal_high": (
            "检测到 LLM 输出长时间循环（{repeats} 次），"
            "请立即更换策略或结束任务。"
        ),
        "llm_loop_global_critical": (
            "全局 LLM 循环：增量输出已超过阈值且无进展，强制中断。"
        ),
        "llm_dead_loop_agent_high": (
            "LLM 思考流可能陷入语义死循环（重复 {repeats} 次），请更换思路。"
        ),
        "llm_dead_loop_agent_critical": (
            "LLM 思考流被判定为语义死循环，已自动中断并执行恢复。"
        ),
        "thinking_loop_lock_judge_intro": (
            "检测到思考/输出陷入重复循环（检测模式={mode}，重复 **{count}** 次）。"
            "请阅读下方重复片段并判断是否属于正常表达："
        ),
        "thinking_loop_lock_repeat_block_header": "问题输出原文（自重复起点起）",
        "thinking_loop_lock_judge_question": "上述重复内容是否正常？",
        "thinking_loop_lock_judge_yes": "是，正常继续",
        "thinking_loop_lock_judge_yes_desc": "重复符合预期，按当前思路继续",
        "thinking_loop_lock_judge_no": "否，需要恢复",
        "thinking_loop_lock_judge_no_desc": "重复异常，触发恢复策略",
        "thinking_loop_lock_steering_recovery": (
            "[思考循环锁定] 系统判定重复内容异常（模式={mode}，重复{count}次）。\n"
            "请严格按以下顺序执行：\n"
            "1. 立刻停止：停止复读与沿旧路径继续生成，勿沿用刚才导致卡住的措辞与思路。\n"
            "2. 执行策略：更换全新切入点，或基于已有信息直接给出最简下一步/结论；"
            "禁止再铺垫与中间空转。\n"
            "3. 再评估是否继续任务：若请求实质是测试/压测/故意诱导循环，立刻停止且勿继续生成；"
            "否则按新策略推进。"
        ),
        "thinking_loop_lock_steering_continue_normal": (
            "[思考循环锁定-继续] 用户确认刚才的输出属于正常表达。"
            "请从中断处继续原任务，不要再次询问用户是否正常，也不要复述上述判定过程。"
        ),
        "thinking_loop_lock_no_user_input": "思考循环锁定：请选择「是」或「否」。",
        "thinking_loop_lock_ask_failed": "思考循环锁定：无法获取用户判断（{detail}）。",
        "plan_exec_judge_intro": (
            "检测到思考过程可能陷入混乱或重复循环（LLM 语义判定异常）。"
            "请阅读下方思考片段并判断是否属于正常表达："
        ),
        "plan_exec_thinking_block_header": "思考过程片段（待判定）",
        "plan_exec_judge_question": "上述思考内容是否正常？",
        "plan_exec_steering_recovery": (
            "[思考循环锁定] 系统判定思考内容异常。\n"
            "请严格按以下顺序执行：\n"
            "1. 立刻停止：停止沿当前路径继续生成，勿沿用刚才导致卡住的措辞与思路。\n"
            "2. 执行策略：更换全新切入点，或基于已有信息直接给出最简下一步/结论；"
            "禁止再铺垫与中间空转。\n"
            "3. 再评估是否继续任务：若请求实质是测试/压测/故意诱导循环，立刻停止且勿继续生成；"
            "否则按新策略推进。"
        ),
        "plan_exec_semantic_deadlock_judge_intro": (
            "检测到思考过程可能在同一组条件/对象上反复权衡、结论无法前进（**语义死锁**）。"
            "请阅读下方思考片段并判断是否属于正常表达："
        ),
        "plan_exec_semantic_deadlock_steering_recovery": (
            "[思考循环锁定] 系统判定思考内容异常（语义死锁）。\n"
            "请严格按以下顺序执行：\n"
            "1. 立刻停止：停止在同一前提下反复比较与空转权衡。\n"
            "2. 执行策略：明确做出取舍或临时假设并标注；已多次无法得出结论的方向视为死路，"
            "直接给出最简下一步行动或结论。\n"
            "3. 再评估是否继续任务：若请求实质是测试/压测/故意诱导循环，立刻停止且勿继续生成；"
            "否则按新策略推进。"
        ),
        "plan_exec_semantic_deadlock_recovery_user_notice": (
            "检测到思考语义死锁异常，已执行恢复操作"
        ),
        "plan_exec_text_degradation_judge_intro": (
            "检测到思考/输出出现断裂、粘连、乱码或词语/URL 被撕碎拼接（**文本崩坏**）。"
            "请阅读下方片段并判断是否属于正常表达："
        ),
        "plan_exec_text_degradation_steering_recovery": (
            "[思考循环锁定] 系统判定思考内容异常（文本崩坏）。\n"
            "请严格按以下顺序执行：\n"
            "1. 立刻停止：停止继续生成混乱、断裂或碎片化内容。\n"
            "2. 执行策略：用完整、可读句子重写当前要点；信息不足时直接说明缺口，勿拼接碎片。\n"
            "3. 再评估是否继续任务：若请求实质是测试/压测/故意诱导循环，立刻停止且勿继续生成；"
            "否则按新策略推进。"
        ),
        "plan_exec_text_degradation_recovery_user_notice": (
            "检测到思考文本崩坏异常，已执行恢复操作"
        ),
        "plan_exec_overthinking_judge_intro": (
            "检测到思考过程冗长纠结、迟迟不收敛（**过度思考**）。"
            "请阅读下方片段并判断是否属于正常表达："
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
        "plan_exec_loop_recovery_user_notice": (
            "检测到计划执行循环异常，已执行恢复操作"
        ),
        "steer_default": (
            "[思考循环锁定] 系统判定重复内容异常（模式={mode}，重复{count}次）。\n"
            "请严格按以下顺序执行：\n"
            "1. 立刻停止：停止复读与沿旧路径继续生成，勿沿用刚才导致卡住的措辞与思路。\n"
            "2. 执行策略：更换全新切入点，或基于已有信息直接给出最简下一步/结论；"
            "禁止再铺垫与中间空转。\n"
            "3. 再评估是否继续任务：若请求实质是测试/压测/故意诱导循环，立刻停止且勿继续生成；"
            "否则按新策略推进。"
        ),
        "notice_default": "检测到思考循环异常，已执行恢复操作",
    },
    "en": {
        "llm_loop_literal_low": (
            "Detected a strict suffix cycle of {repeats} repeats in the LLM output."
        ),
        "llm_loop_progressive_medium": (
            "Detected {repeats} highly similar clauses in the LLM output; possible template loop."
        ),
        "llm_loop_literal_high": (
            "Detected a sustained literal loop in the LLM output "
            "({repeats} repeats). Change strategy or end the task."
        ),
        "llm_loop_global_critical": (
            "Global LLM loop: incremental output exceeded the threshold with no progress; terminating."
        ),
        "llm_dead_loop_agent_high": (
            "The LLM reasoning stream may be in a semantic dead loop "
            "({repeats} repeats). Try a new angle."
        ),
        "llm_dead_loop_agent_critical": (
            "The LLM reasoning stream was judged a semantic dead loop; "
            "stream aborted and automatic recovery applied."
        ),
        "thinking_loop_lock_judge_intro": (
            "Thinking/output stuck in a repeat loop (mode={mode}, **{count}** repeats). "
            "Review the repeated excerpt below and judge whether it is expected:"
        ),
        "thinking_loop_lock_repeat_block_header": "Original output (from repeat start)",
        "thinking_loop_lock_judge_question": "Is this repetition normal?",
        "thinking_loop_lock_judge_yes": "Yes, continue",
        "thinking_loop_lock_judge_yes_desc": "Expected repetition; continue as-is",
        "thinking_loop_lock_judge_no": "No, recover",
        "thinking_loop_lock_judge_no_desc": "Abnormal repetition; apply recovery",
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
        "thinking_loop_lock_steering_continue_normal": (
            "[Thinking Loop Lock Continue] The user confirmed the recent output "
            "is expected/normal. Resume the original task from the interruption "
            "point. Do not ask again whether it is normal, and do not restate "
            "this confirmation."
        ),
        "thinking_loop_lock_no_user_input": (
            "Thinking loop lock: please choose Yes or No."
        ),
        "thinking_loop_lock_ask_failed": (
            "Thinking loop lock: could not obtain user judgment ({detail})."
        ),
        "plan_exec_judge_intro": (
            "Thinking may be confused or stuck in a loop (LLM semantic judge: abnormal). "
            "Review the excerpt below and judge whether it is expected:"
        ),
        "plan_exec_thinking_block_header": "Reasoning excerpt (for review)",
        "plan_exec_judge_question": "Is this reasoning normal?",
        "plan_exec_steering_recovery": (
            "[Thinking Loop Lock] System judged reasoning abnormal.\n"
            "Follow these steps in order:\n"
            "1. Stop immediately: stop continuing along the current path; do not reuse "
            "the wording or reasoning that just caused you to get stuck.\n"
            "2. Execute strategy: switch to a fresh angle, or give the most concise next "
            "step/conclusion from what you already know; no more setup or idle churn.\n"
            "3. Re-evaluate whether to continue: if the request is essentially a "
            "test/stress/adversarial loop-inducing task, stop and do not continue "
            "generating; otherwise proceed with the new strategy."
        ),
        "plan_exec_semantic_deadlock_judge_intro": (
            "Thinking may be stuck weighing the same objects/conditions without "
            "progress (**semantic deadlock**). Review the excerpt below and judge "
            "whether it is expected:"
        ),
        "plan_exec_semantic_deadlock_steering_recovery": (
            "[Thinking Loop Lock] System judged reasoning abnormal (semantic deadlock).\n"
            "Follow these steps in order:\n"
            "1. Stop immediately: stop comparing under the same premises and idle "
            "weighing loops.\n"
            "2. Execute strategy: make a clear trade-off or state a temporary "
            "assumption; treat repeatedly dead-end directions as closed, and output "
            "only the most concise next action or conclusion.\n"
            "3. Re-evaluate whether to continue: if the request is essentially a "
            "test/stress/adversarial loop-inducing task, stop and do not continue "
            "generating; otherwise proceed with the new strategy."
        ),
        "plan_exec_semantic_deadlock_recovery_user_notice": (
            "Detected a semantic deadlock anomaly; recovery has been applied"
        ),
        "plan_exec_text_degradation_judge_intro": (
            "Thinking/output may show breaks, garbling, or shredded URL/word "
            "fragments (**text degradation**). Review the excerpt below and judge "
            "whether it is expected:"
        ),
        "plan_exec_text_degradation_steering_recovery": (
            "[Thinking Loop Lock] System judged reasoning abnormal (text degradation).\n"
            "Follow these steps in order:\n"
            "1. Stop immediately: stop generating garbled, broken, or fragmented text.\n"
            "2. Execute strategy: rewrite the current point in complete, readable "
            "sentences; if information is missing, state the gap—do not stitch "
            "fragments together.\n"
            "3. Re-evaluate whether to continue: if the request is essentially a "
            "test/stress/adversarial loop-inducing task, stop and do not continue "
            "generating; otherwise proceed with the new strategy."
        ),
        "plan_exec_text_degradation_recovery_user_notice": (
            "Detected a text degradation anomaly; recovery has been applied"
        ),
        "plan_exec_overthinking_judge_intro": (
            "Thinking may be verbose and indecisive without converging "
            "(**overthinking**). Review the excerpt below and judge whether it is "
            "expected:"
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
        "plan_exec_loop_recovery_user_notice": (
            "Detected a plan-execution loop anomaly; recovery has been applied"
        ),
        "steer_default": (
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
        "notice_default": "Detected a thinking loop anomaly; recovery has been applied",
    },
}

_PLAN_EXEC_KEYS: dict[str, tuple[str, str]] = {
    "semantic_deadlock": (
        "plan_exec_semantic_deadlock_steering_recovery",
        "plan_exec_semantic_deadlock_recovery_user_notice",
    ),
    "text_degradation": (
        "plan_exec_text_degradation_steering_recovery",
        "plan_exec_text_degradation_recovery_user_notice",
    ),
    "overthinking": (
        "plan_exec_overthinking_steering_recovery",
        "plan_exec_overthinking_recovery_user_notice",
    ),
}


def plan_exec_message_keys(primary_fault: str) -> tuple[str, str]:
    """Return (steer_key, notice_key) for an L3 primary_fault."""
    hit = _PLAN_EXEC_KEYS.get(str(primary_fault or "").strip())
    if hit is not None:
        return hit
    return ("plan_exec_steering_recovery", "plan_exec_loop_recovery_user_notice")


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

__all__ = ["RECOVERY_PLUGIN", "plan_exec_message_keys"]
