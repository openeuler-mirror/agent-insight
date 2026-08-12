/**
 * RAS 可靠性评估器：LLM Judge 契约 + 无模型 warn。
 * 不真调 LLM / Prisma——注入 setJudgeLlmCallerForTest，并对 loadRasEventEvidence 走空任务上下文。
 */
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { setJudgeLlmCallerForTest } from '@/lib/engine/experiment/judge-llm'
import {
  buildRasReliabilityEvaluatorOutput,
  isRasReliabilityPresetId,
  runRasReliabilityPreset,
  type RasEventEvidence,
} from '@/lib/engine/experiment/ras-reliability-evaluator'
import { RAS_RELIABILITY_DIMENSION_KEYS } from '@/prompts/ras-reliability-prompt'

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

function fullJudgmentJson(overrides?: { summary?: string }) {
  return JSON.stringify({
    summary: overrides?.summary || '故障已发生并被检测处置。',
    dimensions: RAS_RELIABILITY_DIMENSION_KEYS.map((dimension) => ({
      dimension,
      verdict: 'met',
      reason: `${dimension} 证据充分`,
      suggestion: '',
    })),
  })
}

describe('ras-reliability-evaluator', () => {
  it('识别 preset id', () => {
    assert.equal(isRasReliabilityPresetId('preset-ras-reliability'), true)
    assert.equal(isRasReliabilityPresetId('preset-other'), false)
  })

  it('有 Judge 输出时按五维聚合分数', () => {
    const events: RasEventEvidence[] = [
      {
        id: 'evt1',
        type: 'anomaly',
        anomalyKind: 'llm_thinking_loop',
        summary: 'similar_clauses',
        actionTypes: 'abort_stream,emit_notice',
        ts: Date.now(),
      },
    ]
    const judgment = JSON.parse(fullJudgmentJson()) as Parameters<
      typeof buildRasReliabilityEvaluatorOutput
    >[0]['judgment']
    const output = buildRasReliabilityEvaluatorOutput({
      expectedFault: 'thinking-dead-loop',
      events,
      judgment,
    })
    assert.equal(output.verdict, 'pass')
    assert.equal(output.score, 100)
    assert.equal(output.points?.length, 5)
    assert.equal(output.points?.[0]?.label, '故障发生')
  })

  it('注入 Judge：无事件上下文仍调用 LLM 并回填 points', async () => {
    let sawSystem = false
    let sawFault = false
    setJudgeLlmCallerForTest(async (_user, req) => {
      sawSystem = req.system.includes('可靠性评测 Judge')
      sawFault = req.user.includes('thinking-dead-loop')
      return fullJudgmentJson({ summary: 'LLM 判定通过' })
    })
    const output = await runRasReliabilityPreset('tester@example.com', baseCtx)
    assert.equal(sawSystem, true)
    assert.equal(sawFault, true)
    assert.equal(output.verdict, 'pass')
    assert.equal(output.summary, 'LLM 判定通过')
    assert.equal(output.points?.length, 5)
  })

  it('未配置评测模型时返回 warn 且无总分', async () => {
    setJudgeLlmCallerForTest(async () => {
      throw new Error('未配置可用的评测模型，请到「模型注册」页完善连接信息')
    })
    const output = await runRasReliabilityPreset('tester@example.com', baseCtx)
    assert.equal(output.verdict, 'warn')
    assert.equal(output.score, undefined)
    assert.match(String(output.summary || ''), /未配置评测模型/)
    const json = (output.evidence as { json?: { note?: string } } | undefined)?.json
    assert.equal(json?.note, 'missing_judge_model')
  })

  it('Judge JSON 非法时返回 warn 而非抛错', async () => {
    setJudgeLlmCallerForTest(async () => '这不是 JSON')
    const output = await runRasReliabilityPreset('tester@example.com', baseCtx)
    assert.equal(output.verdict, 'warn')
    assert.equal(output.score, undefined)
    assert.match(String(output.summary || ''), /Judge 未能产出有效判定/)
  })
})
