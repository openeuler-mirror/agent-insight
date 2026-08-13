/**
 * Agent RAS 可靠性评估器：证据包（Trace + RasAnomalyEvent）→ 独立维度 Judge。
 * 无活跃评测模型或 Judge 失败时返回 warn（无总分），不静默规则满分。
 */
import { z } from 'zod'
import { prisma } from '@/lib/storage/prisma'
import {
  normalizeEvaluatorOutput,
  type EvalPoint,
  type EvaluatorOutput,
} from '@/lib/evaluators/eval-output'
import { JudgeOutputParseError } from '@/lib/evaluators/judge-assembly'
import { summarizeTrace } from '@/lib/engine/evaluation/trace-summarizer'
import {
  generateRasReliabilityPrompt,
  RAS_LEGACY_RELIABILITY_DIMENSION_KEYS,
  RAS_RELIABILITY_POINT_LABELS,
  rasReliabilityDimensionsForProfile,
  type RasReliabilityDimension,
  type RasReliabilityProfile,
} from '@/prompts/ras-reliability-prompt'
import type { FaithfulPresetContext } from './faithful-preset-evaluators'
import {
  SPECIALIZED_RUBRIC_VERSION,
  VERDICTS,
  VERDICT_SCORE,
  VERDICT_STATUS,
  indexCompleteDimensions,
  invokeSpecializedJudge,
  scoreDimensions,
  type DimensionJudgment,
} from './specialized-evaluator-common'

export const LEGACY_RAS_RELIABILITY_PRESET_ID = 'preset-ras-reliability' as const
export const RAS_FAULT_INJECTION_PRESET_ID = 'preset-ras-reliability-fault-injection' as const
export const RAS_DETECTION_RECOVERY_PRESET_ID = 'preset-ras-reliability-detection-recovery' as const
export type RasReliabilityPresetId =
  | typeof LEGACY_RAS_RELIABILITY_PRESET_ID
  | typeof RAS_FAULT_INJECTION_PRESET_ID
  | typeof RAS_DETECTION_RECOVERY_PRESET_ID

export function isRasReliabilityPresetId(id: string): id is RasReliabilityPresetId {
  return id === LEGACY_RAS_RELIABILITY_PRESET_ID
    || id === RAS_FAULT_INJECTION_PRESET_ID
    || id === RAS_DETECTION_RECOVERY_PRESET_ID
}

export function rasReliabilityProfileForPreset(id: RasReliabilityPresetId): RasReliabilityProfile {
  if (id === RAS_FAULT_INJECTION_PRESET_ID) return 'fault-injection'
  if (id === RAS_DETECTION_RECOVERY_PRESET_ID) return 'detection-recovery'
  return 'legacy'
}

export type RasEventEvidence = {
  id: string
  type: string
  anomalyKind: string | null
  summary: string | null
  actionTypes: string | null
  ts: number | Date | string
}

const dimensionSchema = z.object({
  dimension: z.enum(RAS_LEGACY_RELIABILITY_DIMENSION_KEYS),
  verdict: z.enum(VERDICTS),
  reason: z.string().trim().min(1),
  suggestion: z.string(),
}).superRefine((value, ctx) => {
  if (value.verdict !== 'met' && !value.suggestion.trim()) {
    ctx.addIssue({ code: 'custom', path: ['suggestion'], message: 'partial/missing 必须提供改进建议' })
  }
})

function rasReliabilityJudgeSchema(profile: RasReliabilityProfile) {
  const keys = rasReliabilityDimensionsForProfile(profile).map((dimension) => dimension.key)
  return z.object({
    summary: z.string().trim().min(1).max(200).optional(),
    dimensions: z.array(dimensionSchema).length(keys.length),
  }).superRefine((value, ctx) => {
    const actual = value.dimensions.map((dimension) => dimension.dimension)
    for (const key of keys) {
      if (!actual.includes(key)) {
        ctx.addIssue({ code: 'custom', path: ['dimensions'], message: `缺少维度 ${key}` })
      }
    }
    for (const key of actual) {
      if (!keys.includes(key)) {
        ctx.addIssue({ code: 'custom', path: ['dimensions'], message: `不允许维度 ${key}` })
      }
    }
    if (new Set(actual).size !== actual.length) {
      ctx.addIssue({ code: 'custom', path: ['dimensions'], message: '维度不得重复' })
    }
  })
}

export type RasReliabilityJudgeResult = {
  summary?: string
  dimensions: Array<DimensionJudgment<RasReliabilityDimension>>
}

function faultTypeFromContext(ctx: FaithfulPresetContext): string {
  if (typeof ctx.faultInjectionType === 'string' && ctx.faultInjectionType.trim()) {
    return ctx.faultInjectionType.trim()
  }
  return ''
}

function formatEventsText(events: RasEventEvidence[]): string {
  if (!events.length) return '(无事件)'
  return events
    .slice(0, 40)
    .map((event, index) => {
      const kind = event.anomalyKind || event.type || 'unknown'
      const actions = event.actionTypes || ''
      const summary = event.summary || ''
      return `${index + 1}. [${kind}] actions=${actions || '—'} summary=${summary || '—'}`
    })
    .join('\n')
}

function formatStepsText(ctx: FaithfulPresetContext): string {
  if (ctx.traceSummaryText?.trim()) return ctx.traceSummaryText.trim().slice(0, 8000)
  try {
    const summary = summarizeTrace((ctx.interactions || []) as never)
    return JSON.stringify(summary.steps || summary, null, 2).slice(0, 8000)
  } catch {
    return '(无法压缩轨迹)'
  }
}

function warnOutput(
  profile: RasReliabilityProfile,
  summary: string,
  evidence: Record<string, unknown>,
): EvaluatorOutput {
  const points: EvalPoint[] = rasReliabilityDimensionsForProfile(profile).map(({ key }) => ({
    label: RAS_RELIABILITY_POINT_LABELS[key],
    score: undefined,
    status: 'partial',
    evidence: { md: summary },
  }))
  return normalizeEvaluatorOutput({
    verdict: 'warn',
    summary,
    points,
    evidence: { json: evidence },
  })
}

export function buildRasReliabilityEvaluatorOutput(input: {
  evaluatorId: RasReliabilityPresetId
  expectedFault: string
  events: RasEventEvidence[]
  judgment: RasReliabilityJudgeResult
}): EvaluatorOutput {
  const profile = rasReliabilityProfileForPreset(input.evaluatorId)
  const dimensions = rasReliabilityDimensionsForProfile(profile)
  const dimensionKeys = dimensions.map((dimension) => dimension.key)
  const byDimension = indexCompleteDimensions(
    dimensionKeys,
    input.judgment.dimensions as Array<DimensionJudgment<RasReliabilityDimension>>,
  )
  const score = scoreDimensions(dimensions, byDimension)
  const points: EvalPoint[] = dimensionKeys.map((key) => {
    const judgment = byDimension.get(key)!
    return {
      label: RAS_RELIABILITY_POINT_LABELS[key],
      score: VERDICT_SCORE[judgment.verdict],
      status: VERDICT_STATUS[judgment.verdict],
      evidence: { md: judgment.reason },
      suggestion: judgment.suggestion || undefined,
    }
  })

  const verdict = score >= 80 ? 'pass' : score >= 50 ? 'warn' : 'fail'

  return normalizeEvaluatorOutput({
    verdict,
    summary: input.judgment.summary
      || `可靠性 ${dimensionKeys.length} 个维度总分 ${score}；事件 ${input.events.length} 条。`,
    score,
    points,
    evidence: {
      json: {
        rubricVersion: SPECIALIZED_RUBRIC_VERSION,
        faultType: input.expectedFault || null,
        faultEventIds: input.events.map((e) => e.id),
        anomalyKinds: input.events.map((e) => e.anomalyKind || e.type),
        dimensions: input.judgment.dimensions,
      },
    },
  })
}

export async function loadRasEventEvidence(ctx: FaithfulPresetContext): Promise<RasEventEvidence[]> {
  const taskId = String(ctx.taskId || '').trim()
  const executionId = String(ctx.executionId || '').trim()
  if (!taskId && !executionId) return []

  const rows = await prisma.rasAnomalyEvent.findMany({
    where: {
      OR: [
        ...(taskId ? [{ taskId }] : []),
        ...(executionId ? [{ executionId }] : []),
      ],
    },
    orderBy: { ts: 'asc' },
    take: 200,
    select: {
      id: true,
      type: true,
      anomalyKind: true,
      summary: true,
      actionTypes: true,
      ts: true,
    },
  })
  return rows
}

export async function runRasReliabilityPreset(
  evaluatorId: RasReliabilityPresetId,
  user: string,
  ctx: FaithfulPresetContext,
): Promise<EvaluatorOutput> {
  const profile = rasReliabilityProfileForPreset(evaluatorId)
  const expectedFault = faultTypeFromContext(ctx)
  const events = await loadRasEventEvidence(ctx)

  try {
    const { hasJudgeLlmTestInjection } = await import('./judge-llm')
    if (!hasJudgeLlmTestInjection()) {
      const [{ getActiveConfig }, { isModelConnectionReady }] = await Promise.all([
        import('@/lib/storage/server-config'),
        import('@/lib/shared/model-connection'),
      ])
      const config = await getActiveConfig(user)
      if (!config || !isModelConnectionReady(config)) {
        return warnOutput(profile, '未配置评测模型，请到「模型注册」页完善连接信息后再运行可靠性评估。', {
          faultType: expectedFault || null,
          faultEventIds: events.map((e) => e.id),
          note: 'missing_judge_model',
        })
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || '')
    if (/未配置|模型注册|active model/i.test(message)) {
      return warnOutput(profile, '未配置评测模型，请到「模型注册」页完善连接信息后再运行可靠性评估。', {
        faultType: expectedFault || null,
        faultEventIds: events.map((e) => e.id),
        note: 'missing_judge_model',
      })
    }
    throw error
  }

  const prompt = generateRasReliabilityPrompt({
    expectedFault,
    caseInput: ctx.caseInput,
    actualOutput: ctx.actualOutput,
    finalResult: ctx.execution?.finalResult,
    eventsText: formatEventsText(events),
    stepsText: formatStepsText(ctx),
  }, profile)

  try {
    const judgment = await invokeSpecializedJudge(user, prompt, rasReliabilityJudgeSchema(profile))
    return buildRasReliabilityEvaluatorOutput({ evaluatorId, expectedFault, events, judgment })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || '')
    if (
      /未配置可用的评测模型|No active model|模型注册/i.test(message)
      || message.includes('评测模型')
    ) {
      return warnOutput(profile, '未配置评测模型，请到「模型注册」页完善连接信息后再运行可靠性评估。', {
        faultType: expectedFault || null,
        faultEventIds: events.map((e) => e.id),
        note: 'missing_judge_model',
      })
    }
    if (error instanceof JudgeOutputParseError || /judge/i.test(message)) {
      return warnOutput(profile, `可靠性 Judge 未能产出有效判定：${message}`, {
        faultType: expectedFault || null,
        faultEventIds: events.map((e) => e.id),
        note: 'judge_failed',
        error: message,
      })
    }
    throw error
  }
}
