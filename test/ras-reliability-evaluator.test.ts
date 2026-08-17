/** RAS 可靠性拆分评估器：维度契约、等权总分与旧 ID 兼容。 */
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { setJudgeLlmCallerForTest } from '@/lib/engine/experiment/judge-llm'
import {
  buildRasReliabilityEvaluatorOutput,
  isRasReliabilityPresetId,
  LEGACY_RAS_RELIABILITY_PRESET_ID,
  RAS_DETECTION_RECOVERY_PRESET_ID,
  RAS_FAULT_INJECTION_PRESET_ID,
  runRasReliabilityPreset,
  type RasEventEvidence,
  type RasReliabilityPresetId,
} from '@/lib/engine/experiment/ras-reliability-evaluator'
import {
  rasReliabilityDimensionsForProfile,
  type RasReliabilityDimension,
  type RasReliabilityProfile,
} from '@/prompts/ras-reliability-prompt'
import { legacyPresetEvaluators, presetEvaluators } from '@/lib/evaluators/preset-evaluators'

afterEach(() => setJudgeLlmCallerForTest(null))

const baseCtx = {
  caseInput: '使用 thinking-dead-loop 技能',
  actualOutput: '已恢复并给出结论',
  referenceOutput: null,
  traceSummaryText: '1. user\n2. llm loop\n3. ras abort',
  interactions: [],
  faultInjectionType: 'thinking-dead-loop',
  taskId: null as string | null,
  executionId: null as string | null,
}

function judgmentJson(
  profile: RasReliabilityProfile,
  verdicts: Partial<Record<RasReliabilityDimension, 'met' | 'partial' | 'missing'>> = {},
  summary = '可靠性判断完成。',
  faultOccurred: 'met' | 'partial' | 'missing' = 'met',
) {
  return JSON.stringify({
    summary,
    ...(profile === 'detection-recovery' ? {
      faultOccurred: {
        verdict: faultOccurred,
        reason: '故障发生前置判断',
        suggestion: faultOccurred === 'met' ? '' : '先确认故障注入链路',
      },
    } : {}),
    dimensions: (profile === 'detection-recovery' && faultOccurred !== 'met'
      ? []
      : rasReliabilityDimensionsForProfile(profile)).map(({ key }) => {
      const verdict = verdicts[key] || 'met'
      return {
        dimension: key,
        verdict,
        reason: `${key} 证据`,
        suggestion: verdict === 'met' ? '' : `改进 ${key}`,
      }
    }),
  })
}

function build(evaluatorId: RasReliabilityPresetId, profile: RasReliabilityProfile) {
  return buildRasReliabilityEvaluatorOutput({
    evaluatorId,
    expectedFault: 'thinking-dead-loop',
    events: [] satisfies RasEventEvidence[],
    judgment: JSON.parse(judgmentJson(profile)),
  })
}

describe('ras-reliability-evaluator', () => {
  it('识别两个新 ID，并保留旧 ID 运行兼容', () => {
    assert.equal(isRasReliabilityPresetId(RAS_FAULT_INJECTION_PRESET_ID), true)
    assert.equal(isRasReliabilityPresetId(RAS_DETECTION_RECOVERY_PRESET_ID), true)
    assert.equal(isRasReliabilityPresetId(LEGACY_RAS_RELIABILITY_PRESET_ID), true)
    assert.equal(isRasReliabilityPresetId('preset-other'), false)
  })

  it('新目录只暴露检测恢复评估器，故障注入与旧五维评估器仅留在兼容目录', () => {
    const selectable = new Set(presetEvaluators.map((card) => card.id))
    assert.equal(selectable.has(RAS_FAULT_INJECTION_PRESET_ID), false)
    assert.equal(selectable.has(RAS_DETECTION_RECOVERY_PRESET_ID), true)
    assert.equal(selectable.has(LEGACY_RAS_RELIABILITY_PRESET_ID), false)
    assert.equal(legacyPresetEvaluators.some((card) => card.id === RAS_FAULT_INJECTION_PRESET_ID), true)
    assert.equal(legacyPresetEvaluators.some((card) => card.id === LEGACY_RAS_RELIABILITY_PRESET_ID), true)
  })

  it('故障注入评估器只输出故障发生，总分等于该维度分', () => {
    const output = buildRasReliabilityEvaluatorOutput({
      evaluatorId: RAS_FAULT_INJECTION_PRESET_ID,
      expectedFault: 'thinking-dead-loop',
      events: [],
      judgment: JSON.parse(judgmentJson('fault-injection', { fault_occurred: 'partial' })),
    })
    assert.equal(output.score, 50)
    assert.deepEqual(output.points?.map((point) => point.label), ['故障发生'])
  })

  it('明确检测到故障发生时，检测恢复评估器按三个维度等权平均', () => {
    const output = buildRasReliabilityEvaluatorOutput({
      evaluatorId: RAS_DETECTION_RECOVERY_PRESET_ID,
      expectedFault: 'thinking-dead-loop',
      events: [],
      judgment: JSON.parse(judgmentJson('detection-recovery', {
        fault_detected: 'met',
        mitigation_triggered: 'partial',
        fault_mitigated: 'missing',
      })),
    })
    assert.equal(output.score, 50)
    assert.deepEqual(output.points?.map((point) => point.label), ['故障检测', '触发处置', '故障消解'])
    assert.equal(output.points?.some((point) => point.label === '最终任务结果'), false)
  })

  it('未检测到故障发生时，检测恢复评估器保留三个维度理由但不产生分数', () => {
    const output = buildRasReliabilityEvaluatorOutput({
      evaluatorId: RAS_DETECTION_RECOVERY_PRESET_ID,
      expectedFault: 'thinking-dead-loop',
      events: [],
      judgment: JSON.parse(judgmentJson('detection-recovery', {}, '无法确认故障。', 'missing')),
    })
    assert.equal(output.verdict, 'warn')
    assert.equal(output.score, undefined)
    assert.deepEqual(output.points?.map((point) => point.label), ['故障检测', '触发处置', '故障消解'])
    assert.equal(output.points?.every((point) => point.score === undefined), true)
    assert.equal(output.points?.every((point) => point.status === undefined), true)
    assert.equal(output.points?.every((point) => (
      point.evidence && 'md' in point.evidence && point.evidence.md.includes('未检测到故障发生')
    )), true)
    assert.match(String(output.summary || ''), /未检测到故障发生/)
  })

  it('旧评估器仍按历史五维契约构建结果', () => {
    const output = build(LEGACY_RAS_RELIABILITY_PRESET_ID, 'legacy')
    assert.equal(output.score, 100)
    assert.equal(output.points?.length, 5)
    assert.equal(output.points?.at(-1)?.label, '最终任务结果')
  })

  it('只调用并解析用户选择的故障检测恢复维度', async () => {
    let sawDetection = false
    let sawTaskOutcome = false
    let sawFaultGate = false
    setJudgeLlmCallerForTest(async (_user, req) => {
      sawDetection = req.system.includes('fault_detected')
      sawTaskOutcome = req.system.includes('task_outcome')
      sawFaultGate = req.system.includes('faultOccurred')
      return judgmentJson('detection-recovery', {}, 'LLM 判定通过')
    })
    const output = await runRasReliabilityPreset(
      RAS_DETECTION_RECOVERY_PRESET_ID,
      'tester@example.com',
      baseCtx,
    )
    assert.equal(sawDetection, true)
    assert.equal(sawTaskOutcome, false)
    assert.equal(sawFaultGate, true)
    assert.equal(output.summary, 'LLM 判定通过')
    assert.equal(output.points?.length, 3)
  })

  it('Judge 未确认故障时允许省略三个恢复维度并返回无分结果', async () => {
    setJudgeLlmCallerForTest(async () => (
      judgmentJson('detection-recovery', {}, '故障证据不足。', 'partial')
    ))
    const output = await runRasReliabilityPreset(
      RAS_DETECTION_RECOVERY_PRESET_ID,
      'tester@example.com',
      baseCtx,
    )
    assert.equal(output.score, undefined)
    assert.equal(output.points?.length, 3)
    assert.match(String(output.summary || ''), /未检测到故障发生/)
  })

  it('未配置评测模型时返回对应评估器的无分 warn', async () => {
    setJudgeLlmCallerForTest(async () => {
      throw new Error('未配置可用的评测模型，请到「模型注册」页完善连接信息')
    })
    const output = await runRasReliabilityPreset(
      RAS_FAULT_INJECTION_PRESET_ID,
      'tester@example.com',
      baseCtx,
    )
    assert.equal(output.verdict, 'warn')
    assert.equal(output.score, undefined)
    assert.equal(output.points?.length, 1)
    assert.match(String(output.summary || ''), /未配置评测模型/)
  })

  it('Judge 返回其他评估器维度时拒绝结果', async () => {
    setJudgeLlmCallerForTest(async () => judgmentJson('legacy'))
    const output = await runRasReliabilityPreset(
      RAS_FAULT_INJECTION_PRESET_ID,
      'tester@example.com',
      baseCtx,
    )
    assert.equal(output.verdict, 'warn')
    assert.equal(output.score, undefined)
    assert.match(String(output.summary || ''), /Judge 未能产出有效判定/)
  })
})
