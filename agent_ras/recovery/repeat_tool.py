# coding: utf-8
"""Recovery strategy + user-facing copy for repeat_tool."""
from __future__ import annotations

from detectors.types import RecoveryPlugin
from recovery.engine import RecoveryAction

_MESSAGES: dict[str, dict[str, str]] = {
    "cn": {
        "repeat_tool_generic_warning": (
            "工具 {tool_name} 已重复调用 {count} 次，请检查是否有效。"
        ),
        "repeat_tool_generic_user": (
            "[工具调用异常] 工具 {tool_name} 已重复调用 {count} 次。"
        ),
        "repeat_tool_generic_steering": (
            "你已多次使用完全相同参数重复调用同一工具，且未取得进展。\n"
            "重复工具调用检测结果：\n"
            "- 工具：{tool_name}\n"
            "- 重复次数：{count}\n"
            "- 参数：{tool_arguments}\n"
            "上述重复调用未产生有效进展。请勿再次使用完全相同的工具与参数进行调用。\n"
            "请分析导致工具重复调用的原因，并采取应对方案：立刻停止工具重复调用，"
            "调整参数、更换工具/策略，或在已有证据充分时结束任务。"
        ),
        "repeat_tool_pingpong_warning": (
            "检测到 {tool_name} 与另一工具的交替循环（{count} 轮），"
            "请合并步骤或更换策略。"
        ),
        "repeat_tool_pingpong_user": (
            "[工具调用异常] Ping-Pong 交替调用已持续 {count} 轮。"
        ),
        "repeat_tool_pingpong_steering": (
            "检测到 Ping-Pong 交替工具调用且未取得进展。\n"
            "- 交替轮次：{count}\n"
            "- 最新工具：{tool_name}\n"
            "请停止 A↔B 工具循环。合并步骤、更换策略或换路径；"
            "若已有证据充分，请结束任务。"
        ),
        "repeat_tool_unknown_tool_warning": (
            "未知工具 {tool_name} 已连续失败 {count} 次，请停止重试。"
        ),
        "repeat_tool_unknown_user": (
            "[工具调用异常] 工具 {tool_name} 已连续失败 {count} 次。"
        ),
        "repeat_tool_unknown_steering": (
            "未知或失败的工具已被连续多次调用，且未取得进展。\n"
            "重复工具调用检测结果：\n"
            "- 工具：{tool_name}\n"
            "- 重复次数：{count}\n"
            "- 参数：{tool_arguments}\n"
            "上述重复调用未产生有效进展。请勿再次使用完全相同的工具与参数进行调用。\n"
            "请分析导致工具重复调用的原因，并采取应对方案：立刻停止工具重复调用，"
            "调整参数、更换工具/策略，或在已有证据充分时结束任务。"
        ),
        "repeat_tool_global_breaker_critical": (
            "全局断路器: {tool_name} 连续 {count} 次无进展"
        ),
        "repeat_tool_pingpong_critical": (
            "Ping-Pong 循环: {count} 轮交替无进展，阻断"
        ),
        "repeat_tool_unknown_tool_critical": (
            "未知工具 {tool_name} 连续调用 {count} 次，停止重试"
        ),
        "steer_default": (
            "你已多次使用完全相同参数重复调用同一工具，且未取得进展。\n"
            "重复工具调用检测结果：\n"
            "- 工具：{tool_name}\n"
            "- 重复次数：{count}\n"
            "- 参数：{tool_arguments}\n"
            "上述重复调用未产生有效进展。请勿再次使用完全相同的工具与参数进行调用。\n"
            "请分析导致工具重复调用的原因，并采取应对方案：立刻停止工具重复调用，"
            "调整参数、更换工具/策略，或在已有证据充分时结束任务。"
        ),
        "notice_default": (
            "[工具调用异常] 工具 {tool_name} 已重复调用 {count} 次。"
        ),
        "critical_default": (
            "全局断路器: {tool_name} 连续 {count} 次无进展"
        ),
    },
    "en": {
        "repeat_tool_generic_warning": (
            "Tool {tool_name} has been repeated {count} times; please verify it is effective."
        ),
        "repeat_tool_generic_user": (
            "[Tool Call Anomaly] Tool {tool_name} has been repeated {count} times."
        ),
        "repeat_tool_generic_steering": (
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
        "repeat_tool_pingpong_warning": (
            "Detected ping-pong alternation between {tool_name} and another tool "
            "({count} rounds). Merge steps or change strategy."
        ),
        "repeat_tool_pingpong_user": (
            "[Tool Call Anomaly] Ping-pong alternating calls have continued for {count} rounds."
        ),
        "repeat_tool_pingpong_steering": (
            "Ping-pong alternating tool calls detected with no progress.\n"
            "- rounds: {count}\n"
            "- latest tool: {tool_name}\n"
            "Stop the A↔B tool loop. Merge steps, change approach, "
            "or finish the task if enough evidence has been gathered."
        ),
        "repeat_tool_unknown_tool_warning": (
            "Unknown tool {tool_name} has failed {count} times in a row; please stop retrying."
        ),
        "repeat_tool_unknown_user": (
            "[Tool Call Anomaly] Tool {tool_name} has failed {count} times in a row."
        ),
        "repeat_tool_unknown_steering": (
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
        "repeat_tool_global_breaker_critical": (
            "Circuit breaker: {tool_name} made no progress for {count} consecutive calls"
        ),
        "repeat_tool_pingpong_critical": (
            "Ping-pong loop: {count} alternating calls with no progress, blocked"
        ),
        "repeat_tool_unknown_tool_critical": (
            "Unknown tool {tool_name} called {count} times in a row, stopping retries"
        ),
        "steer_default": (
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
        "notice_default": (
            "[Tool Call Anomaly] Tool {tool_name} has been repeated {count} times."
        ),
        "critical_default": (
            "Circuit breaker: {tool_name} made no progress for {count} consecutive calls"
        ),
    },
}

_MSG_KEY_TEMPLATES: dict[str, dict[str, str]] = {
    "steer": {
        "generic_repeat": "repeat_tool_generic_steering",
        "ping_pong_warning": "repeat_tool_pingpong_steering",
        "unknown_tool_repeat_warning": "repeat_tool_unknown_steering",
    },
    "notice": {
        "generic_repeat": "repeat_tool_generic_user",
        "ping_pong_warning": "repeat_tool_pingpong_user",
        "unknown_tool_repeat_warning": "repeat_tool_unknown_user",
    },
    "critical": {
        "global_circuit_breaker": "repeat_tool_global_breaker_critical",
        "unknown_tool_repeat": "repeat_tool_unknown_tool_critical",
        "ping_pong_critical": "repeat_tool_pingpong_critical",
    },
}

RECOVERY_PLUGIN = RecoveryPlugin(
    id="repeat_tool",
    kind_overrides={},
    stream_kinds=(),
    anchor="tool",
    messages=_MESSAGES,
    terminate_kinds=("repeat_tool_call", "tool_call_loop"),
    msg_key_templates=_MSG_KEY_TEMPLATES,
)

__all__ = ["RECOVERY_PLUGIN"]
