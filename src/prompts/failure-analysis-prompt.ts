
export const FAILURE_EXTRACTION_PROMPT = `
你是一位专家级的日志分析师。你的任务是分析用户与 AI 助手之间的对话历史（包括工具输出），并提取任何"中间故障"或"异常过程"。

"中间故障"或"异常过程"定义如下：
1. **工具执行错误**：代理尝试运行工具（例如 bash 命令、python 脚本）但失败了（非零退出代码、堆栈跟踪、错误消息）。
2. **逻辑/推理修正**：代理意识到自己犯了错误并明确纠正自己（例如，"我犯了一个错误...","之前的方法失败了..."）。
3. **超时/卡住**：代理提到等待太久或进程卡住。
4. **无效参数**：代理尝试使用带有无效参数的工具并被系统拒绝。

你将获得包含完整对话历史的最后一次交互内容。

逐步分析历史记录。对于发现的每个故障，提取：
- failure_type: (Tool Error / Reasoning Error / Timeout / Invalid Usage)
- description: 用中文简要总结出了什么问题。
- context: 导致失败的具体命令或推理内容。
- recovery: 代理如何尝试恢复（如果有）。
- step: 明确指出故障发生在哪个步骤，格式如："第X步 - [步骤名称]"，例如："第3步 - LLM调用"、"第5步 - Tool调用(bash命令)"、"第2步 - Skill调用"。
- anchor_step_id: 如果下方提供了"执行步骤候选列表"，必须从候选列表中选择最匹配的 step_id；如果证据不足，填空字符串，不要编造。

仅以以下 JSON 格式响应：
{
  "failures": [
    {
      "failure_type": "Tool Error",
      "description": "无法安装包 'xyz'",
      "context": "pip install xyz",
      "recovery": "代理尝试改用 apt-get。",
      "step": "第5步 - Tool调用(pip install)",
      "anchor_step_id": "event:n1:4"
    },
    ...
  ]
}

如果未发现故障，请返回：
{
  "failures": []
}
`;

export function generateFailureAnalysisPrompt(
  conversationHistory: string,
  faultPathSteps?: string
): string {
  return `
${FAILURE_EXTRACTION_PROMPT}

${faultPathSteps ? `Execution Step Candidates:
${faultPathSteps}

Anchor Selection Rules:
- anchor_step_id 必须完全等于候选列表中的某个 step_id。
- 优先选择实际报错/超时/无效参数发生的步骤，不要选择后续恢复步骤。
- 如果错误内容只能说明整体失败但无法定位具体步骤，anchor_step_id 填空字符串。
` : ''}

Conversation History:
${conversationHistory}
`;
}
