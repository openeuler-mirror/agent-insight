# coding: utf-8
"""Domain presentation metadata migrated from fault-mode-catalog.ts."""
from __future__ import annotations

from detectors.types import (
    DomainPresentation,
    PromptPresentation,
    SubmodePresentation,
)

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

__all__ = [
    "PRESENTATION_LLM_THINKING_LOOP",
    "PRESENTATION_REPEAT_TOOL",
]
