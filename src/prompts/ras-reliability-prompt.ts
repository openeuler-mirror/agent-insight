/**
 * Agent RAS 可靠性评估器 Judge Prompt（设计 §7.6 五判断点）。
 * 只负责拼装 system/user；打分与 schema 在 ras-reliability-evaluator.ts。
 */

export const RAS_RELIABILITY_DIMENSIONS = [
  { key: 'fault_occurred', label: '故障发生', weight: 0.2 },
  { key: 'fault_detected', label: '故障检测', weight: 0.2 },
  { key: 'mitigation_triggered', label: '触发处置', weight: 0.2 },
  { key: 'fault_mitigated', label: '故障消解', weight: 0.2 },
  { key: 'task_outcome', label: '最终任务结果', weight: 0.2 },
] as const

export type RasReliabilityDimension = (typeof RAS_RELIABILITY_DIMENSIONS)[number]['key']

export const RAS_RELIABILITY_DIMENSION_KEYS = RAS_RELIABILITY_DIMENSIONS.map((d) => d.key) as [
  RasReliabilityDimension,
  ...RasReliabilityDimension[],
]

export const RAS_RELIABILITY_POINT_LABELS: Record<RasReliabilityDimension, string> = {
  fault_occurred: '故障发生',
  fault_detected: '故障检测',
  mitigation_triggered: '触发处置',
  fault_mitigated: '故障消解',
  task_outcome: '最终任务结果',
}

export interface RasReliabilityPromptInput {
  expectedFault: string
  submode?: string | null
  caseInput: string
  actualOutput: string
  finalResult?: string | null
  eventsText: string
  stepsText: string
}

const SYSTEM = `你是 Agent RAS 可靠性评测 Judge。根据「期望故障模式 + Trace 摘要 + RAS 故障事件」对五个判断点分别给出 met / partial / missing。

判断点含义：
1) fault_occurred（故障发生）：Trace 或故障事实中是否有与期望故障模式一致的证据。
2) fault_detected（故障检测）：RAS 是否产生检测事件，检测是否发生在合理时间内。
3) mitigation_triggered（触发处置）：是否出现恢复、熔断、重试、降级、abort、notice、steering 等 RAS 动作。
4) fault_mitigated（故障消解）：后续 Trace 是否恢复到可继续执行的状态。
5) task_outcome（最终任务结果）：Agent 最终成功、失败或部分完成。

规则：
- 只输出一个 JSON 对象，不要 Markdown。
- 五个 dimension 必须齐全、各出现一次。
- met=有充分正面证据；partial=证据不足或仅部分成立；missing=无证据或明确未发生。
- 「没有收到故障事件」不能直接等价为「没有发生故障」——此时 fault_occurred 与 fault_detected 应偏 partial/missing，并在 reason 说明证据不足。
- partial/missing 必须提供非空 suggestion。
- summary 用中文，不超过 200 字。`

export function generateRasReliabilityPrompt(input: RasReliabilityPromptInput): {
  stage: string
  system: string
  user: string
} {
  const expected = input.expectedFault.trim() || '(未指定期望故障模式)'
  const submode = String(input.submode || '').trim() || 'n/a'
  const user = `期望故障模式: ${expected}
子模式: ${submode}

任务输入:
${input.caseInput || '(空)'}

最终输出 / finalResult:
${(input.actualOutput || input.finalResult || '').trim() || '(空)'}

RAS 故障事件摘要:
${input.eventsText.trim() || '(无事件)'}

Trace 步骤摘要:
${input.stepsText.trim() || '(无步骤)'}

请返回 JSON：
{
  "summary": "<中文总评>",
  "dimensions": [
    { "dimension": "fault_occurred", "verdict": "met|partial|missing", "reason": "...", "suggestion": "..." },
    { "dimension": "fault_detected", "verdict": "met|partial|missing", "reason": "...", "suggestion": "..." },
    { "dimension": "mitigation_triggered", "verdict": "met|partial|missing", "reason": "...", "suggestion": "..." },
    { "dimension": "fault_mitigated", "verdict": "met|partial|missing", "reason": "...", "suggestion": "..." },
    { "dimension": "task_outcome", "verdict": "met|partial|missing", "reason": "...", "suggestion": "..." }
  ]
}`

  return { stage: 'ras-reliability', system: SYSTEM, user }
}
