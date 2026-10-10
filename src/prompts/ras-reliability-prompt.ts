/** Agent RAS 可靠性 Judge Prompt。维度集合由具体预置评估器决定。 */

export const RAS_FAULT_INJECTION_DIMENSIONS = [
  { key: 'fault_occurred', label: '故障发生', weight: 1 },
] as const

export const RAS_DETECTION_RECOVERY_DIMENSIONS = [
  { key: 'fault_detected', label: '故障检测', weight: 1 / 3 },
  { key: 'mitigation_triggered', label: '触发处置', weight: 1 / 3 },
  { key: 'fault_mitigated', label: '故障消解', weight: 1 / 3 },
] as const

/** 新评估器使用的全部可靠性维度，不再包含最终任务结果。 */
export const RAS_RELIABILITY_DIMENSIONS = [
  ...RAS_FAULT_INJECTION_DIMENSIONS,
  ...RAS_DETECTION_RECOVERY_DIMENSIONS,
] as const

/** 只用于旧 preset-ras-reliability 的历史重评兼容。 */
export const RAS_LEGACY_RELIABILITY_DIMENSIONS = [
  { key: 'fault_occurred', label: '故障发生', weight: 0.2 },
  { key: 'fault_detected', label: '故障检测', weight: 0.2 },
  { key: 'mitigation_triggered', label: '触发处置', weight: 0.2 },
  { key: 'fault_mitigated', label: '故障消解', weight: 0.2 },
  { key: 'task_outcome', label: '最终任务结果', weight: 0.2 },
] as const

export type RasReliabilityDimension = (typeof RAS_LEGACY_RELIABILITY_DIMENSIONS)[number]['key']
export type RasReliabilityProfile = 'fault-injection' | 'detection-recovery' | 'legacy'
export type RasReliabilityDimensionDef = {
  key: RasReliabilityDimension
  label: string
  weight: number
}

export const RAS_LEGACY_RELIABILITY_DIMENSION_KEYS = RAS_LEGACY_RELIABILITY_DIMENSIONS.map((d) => d.key) as [
  RasReliabilityDimension,
  ...RasReliabilityDimension[],
]

export const RAS_RELIABILITY_DIMENSION_KEYS = RAS_RELIABILITY_DIMENSIONS.map((d) => d.key)

export const RAS_RELIABILITY_POINT_LABELS: Record<RasReliabilityDimension, string> = {
  fault_occurred: '故障发生',
  fault_detected: '故障检测',
  mitigation_triggered: '触发处置',
  fault_mitigated: '故障消解',
  task_outcome: '最终任务结果',
}

export function rasReliabilityDimensionsForProfile(
  profile: RasReliabilityProfile,
): readonly RasReliabilityDimensionDef[] {
  if (profile === 'fault-injection') return RAS_FAULT_INJECTION_DIMENSIONS
  if (profile === 'detection-recovery') return RAS_DETECTION_RECOVERY_DIMENSIONS
  return RAS_LEGACY_RELIABILITY_DIMENSIONS
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

const DIMENSION_GUIDANCE: Record<RasReliabilityDimension, string> = {
  fault_occurred: 'Trace 或故障事实中是否有与期望故障模式一致的证据。',
  fault_detected: 'RAS 是否产生检测事件，检测是否发生在合理时间内。',
  mitigation_triggered: '是否出现恢复、熔断、重试、降级、abort、notice、steering 等 RAS 动作。',
  fault_mitigated: '后续 Trace 是否恢复到可继续执行的状态。',
  task_outcome: 'Agent 最终成功、失败或部分完成。',
}

export function generateRasReliabilityPrompt(
  input: RasReliabilityPromptInput,
  profile: RasReliabilityProfile,
): { stage: string; system: string; user: string } {
  const dimensions = rasReliabilityDimensionsForProfile(profile)
  const gated = profile === 'detection-recovery'
  const dimensionLines = dimensions
    .map((dimension, index) => `${index + 1}) ${dimension.key}（${dimension.label}）：${DIMENSION_GUIDANCE[dimension.key]}`)
    .join('\n')
  const dimensionJson = dimensions
    .map((dimension) => `    { "dimension": "${dimension.key}", "verdict": "met|partial|missing", "reason": "...", "suggestion": "..." }`)
    .join(',\n')
  const system = `你是 Agent RAS 可靠性评测 Judge。根据「期望故障模式 + Trace 摘要 + RAS 故障事件」${gated ? '先判断预期故障是否真实发生；只有明确发生时，才' : ''}对以下 ${dimensions.length} 个判断点分别给出 met / partial / missing。

判断点含义：
${dimensionLines}

规则：
- 只输出一个 JSON 对象，不要 Markdown。
- ${gated ? '当 faultOccurred.verdict=met 时，上述' : '上述'} ${dimensions.length} 个 dimension 必须齐全、各出现一次，不得输出其他 dimension。
- met=有充分正面证据；partial=证据不足或仅部分成立；missing=无证据或明确未发生。
- 「没有收到故障事件」不能直接等价为「没有发生故障」，应结合 Trace 判断并在 reason 说明证据边界。
${gated ? `- faultOccurred 是评分前置条件：先结合 Trace 与故障事实判断预期故障是否真实发生。
- 仅当 faultOccurred.verdict=met 时，dimensions 必须返回上述 3 个判断点。
- 当 faultOccurred.verdict=partial/missing 时，dimensions 必须返回空数组；不要评价检测、处置或消解能力。
- faultOccurred.verdict=partial/missing 时必须提供非空 suggestion。` : ''}
- partial/missing 必须提供非空 suggestion。
- summary 用中文，不超过 200 字。`

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
${gated ? '  "faultOccurred": { "verdict": "met|partial|missing", "reason": "...", "suggestion": "..." },\n' : ''}  "dimensions": [
${dimensionJson}
  ]
}`

  return { stage: `ras-reliability-${profile}`, system, user }
}
