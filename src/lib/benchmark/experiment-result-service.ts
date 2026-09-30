import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import type {
  NormalizedBenchmarkPrimaryMetric,
  NormalizedBenchmarkResult,
} from '../../../packages/benchmark-protocol/src/evaluator-contracts'
import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'
import { resolveAgentInsightDataPath } from '@/lib/env'
import { prisma } from '@/lib/storage/prisma'
import type { ExtendedPrismaClient } from '@/lib/storage/prisma-client'
import { getBenchmarkAdapter } from './adapter-registry'

const benchmarkPrisma = prisma as ExtendedPrismaClient

const TERMINAL_CASE_STATUSES = new Set([
  'evaluated',
  'evaluation_failed',
  'submission_invalid',
  'execution_failed',
  'dispatch_failed',
  'blocked',
])
const CASE_STATUS_FILTERS = new Set([
  'pending',
  'dispatching',
  'dispatch_unknown',
  'running_agent',
  'collecting',
  'uploading',
  'cleaning',
  'submitted',
  ...TERMINAL_CASE_STATUSES,
])
const OUTCOME_FILTERS = new Set(['pass', 'warn', 'fail', 'unknown'])

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function outcomeFor(input: {
  runStatus: string
  resultStatus?: string
  verdict?: string | null
}): 'pass' | 'warn' | 'fail' | 'unknown' | null {
  if (!TERMINAL_CASE_STATUSES.has(input.runStatus)) return null
  if (input.runStatus === 'submission_invalid') return 'fail'
  if (
    input.resultStatus === 'done'
    && ['pass', 'warn', 'fail'].includes(input.verdict || '')
  ) {
    return input.verdict as 'pass' | 'warn' | 'fail'
  }
  return 'unknown'
}

function primaryMetricFrom(value: string | null): NormalizedBenchmarkPrimaryMetric | null {
  const normalized = parseJson<Partial<NormalizedBenchmarkResult> | null>(value, null)
  const metric = normalized?.primaryMetric
  if (
    !metric
    || typeof metric.key !== 'string'
    || !['boolean-rate', 'mean'].includes(metric.aggregation)
    || (metric.value !== null && typeof metric.value !== 'boolean' && typeof metric.value !== 'number')
  ) {
    return null
  }
  return metric
}

export async function getBenchmarkExperimentResult(input: {
  experimentId: string
  user: string
  page: number
  pageSize: number
  status?: string
  verdict?: string
}) {
  if (input.status && !CASE_STATUS_FILTERS.has(input.status)) {
    throw new BenchmarkProtocolError('CASE_STATUS_FILTER_INVALID', 'Case 状态筛选值不合法', 400)
  }
  if (input.verdict && !OUTCOME_FILTERS.has(input.verdict)) {
    throw new BenchmarkProtocolError('CASE_VERDICT_FILTER_INVALID', 'Case 判定筛选值不合法', 400)
  }
  const experiment = await benchmarkPrisma.experiment.findFirst({
    where: { id: input.experimentId, user: input.user, scope: 'benchmark', deletedAt: null },
    select: {
      id: true,
      status: true,
      benchmarkBinding: { select: { adapterKey: true, expectedCaseCount: true } },
    },
  })
  if (!experiment?.benchmarkBinding) {
    throw new BenchmarkProtocolError('BENCHMARK_EXPERIMENT_NOT_FOUND', 'Benchmark 实验不存在', 404)
  }
  const manifest = getBenchmarkAdapter(experiment.benchmarkBinding.adapterKey).manifest
  const evaluatorKey = manifest.evaluation.evaluatorKey
  const evaluatorId = `benchmark:${evaluatorKey}`
  const runs = await benchmarkPrisma.benchmarkCaseRun.findMany({
    where: { experimentId: input.experimentId, experimentCase: { deletedAt: null } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      retryOfRunId: true,
      ordinal: true,
      status: true,
      runFactsJson: true,
      failureCode: true,
      failureMessage: true,
      datasetCase: { select: { externalCaseId: true } },
      artifacts: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          name: true,
          mediaType: true,
          sha256: true,
          sizeBytes: true,
        },
      },
      experimentCase: {
        select: {
          id: true,
          results: {
            where: { evaluatorId },
            take: 1,
            select: {
              status: true,
              verdict: true,
              summary: true,
              score: true,
              errorMessage: true,
            },
          },
        },
      },
      evaluations: {
        orderBy: { attemptNo: 'desc' },
        take: 1,
        select: {
          id: true,
          status: true,
          normalizedResultJson: true,
          artifacts: {
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              name: true,
              kind: true,
              mediaType: true,
              sha256: true,
              sizeBytes: true,
            },
          },
        },
      },
    },
  })

  const supersededRunIds = new Set(
    runs.map((run) => run.retryOfRunId).filter((id): id is string => Boolean(id)),
  )
  const latestRunByCase = new Map<string, (typeof runs)[number]>()
  for (const run of runs) {
    if (supersededRunIds.has(run.id)) continue
    if (!latestRunByCase.has(run.experimentCase.id)) {
      latestRunByCase.set(run.experimentCase.id, run)
    }
  }
  for (const run of runs) {
    if (!latestRunByCase.has(run.experimentCase.id)) {
      latestRunByCase.set(run.experimentCase.id, run)
    }
  }
  const latestRuns = Array.from(latestRunByCase.values())
    .sort((left, right) => left.ordinal - right.ordinal)

  const rows = latestRuns.map((run) => {
    const result = run.experimentCase.results[0]
    const evaluation = run.evaluations[0]
    const normalized = parseJson<Partial<NormalizedBenchmarkResult> | null>(
      evaluation?.normalizedResultJson,
      null,
    )
    const outcome = outcomeFor({
      runStatus: run.status,
      resultStatus: result?.status,
      verdict: result?.verdict,
    })
    const runFacts = parseJson<Record<string, unknown>>(run.runFactsJson, {})
    return {
      caseId: run.experimentCase.id,
      externalCaseId: run.datasetCase?.externalCaseId || null,
      runStatus: run.status,
      outcome,
      score: result?.score ?? null,
      summary: result?.summary || result?.errorMessage || run.failureMessage || null,
      primaryMetric: normalized?.primaryMetric
        ? { key: normalized.primaryMetric.key, value: normalized.primaryMetric.value }
        : null,
      nativeMetrics: normalized?.nativeMetrics || {},
      execution: {
        runId: run.id,
        traceId: typeof runFacts.traceId === 'string' ? runFacts.traceId : null,
      },
      submissions: run.artifacts.map((artifact) => ({
        artifactId: artifact.id,
        name: artifact.name,
        mediaType: artifact.mediaType,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
        contentUrl: `/api/benchmark/v1/artifacts/${encodeURIComponent(artifact.id)}/content`,
      })),
      evaluation: evaluation
        ? { evaluationId: evaluation.id, status: evaluation.status }
        : null,
      evidenceArtifacts: (evaluation?.artifacts || []).map((artifact) => ({
        artifactId: artifact.id,
        name: artifact.name,
        kind: artifact.kind,
        mediaType: artifact.mediaType,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
        contentUrl: `/api/benchmark/v1/evaluations/${encodeURIComponent(evaluation!.id)}/artifacts/${encodeURIComponent(artifact.id)}/content`,
      })),
      failure: run.failureCode
        ? { code: run.failureCode, message: run.failureMessage }
        : null,
      _primaryMetric: primaryMetricFrom(evaluation?.normalizedResultJson || null),
    }
  })

  const expectedTotal = await benchmarkPrisma.experimentCase.count({ where: { experimentId: input.experimentId, deletedAt: null } });
  const terminalRows = rows.filter((row) => TERMINAL_CASE_STATUSES.has(row.runStatus))
  const outcomes = { pass: 0, warn: 0, fail: 0, unknown: 0 }
  for (const row of terminalRows) {
    outcomes[row.outcome || 'unknown'] += 1
  }
  const completed = terminalRows.length
  const scored = rows.map((row) => row.score).filter((score): score is number => score !== null)
  const metricRows = rows
    .map((row) => row._primaryMetric)
    .filter((metric): metric is NormalizedBenchmarkPrimaryMetric => metric !== null)
  const metric = metricRows[0]
  let primary: {
    key: string
    value: number | null
    numerator?: number
    denominator: number
  } | null = null
  if (metric?.aggregation === 'boolean-rate') {
    const numerator = metricRows.filter((item) => (
      item.key === metric.key && item.aggregation === metric.aggregation && item.value === true
    )).length
    primary = {
      key: `${metric.key}Rate`,
      value: expectedTotal > 0 ? round((numerator / expectedTotal) * 100) : null,
      numerator,
      denominator: expectedTotal,
    }
  } else if (metric?.aggregation === 'mean') {
    const values = metricRows
      .filter((item) => item.key === metric.key && item.aggregation === metric.aggregation)
      .map((item) => item.value)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    primary = {
      key: metric.key,
      value: values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null,
      denominator: values.length,
    }
  }

  const filtered = rows.filter((row) => (
    (!input.status || row.runStatus === input.status)
    && (!input.verdict || row.outcome === input.verdict)
  ))
  const page = Math.min(input.page, Math.max(1, Math.ceil(filtered.length / input.pageSize)))
  const start = (page - 1) * input.pageSize
  const cases = filtered.slice(start, start + input.pageSize).map((row) => {
    const publicRow = { ...row }
    Reflect.deleteProperty(publicRow, '_primaryMetric')
    return publicRow as Omit<typeof row, '_primaryMetric'>
  })
  return {
    experimentId: experiment.id,
    status: ['done', 'partial'].includes(experiment.status) ? 'completed' : experiment.status,
    benchmark: {
      key: manifest.adapterKey,
      evaluatorKey: manifest.evaluation.evaluatorKey,
      displayName: manifest.displayName,
      presentation: manifest.presentation || null,
    },
    progress: {
      total: expectedTotal,
      completed,
      pending: Math.max(0, expectedTotal - completed),
      coverageRate: expectedTotal > 0 ? round((completed / expectedTotal) * 100) : 0,
    },
    outcomes,
    metrics: {
      primary,
      averageScore: {
        value: scored.length ? round(scored.reduce((sum, score) => sum + score, 0) / scored.length) : null,
        count: scored.length,
      },
    },
    cases,
    pagination: {
      page,
      pageSize: input.pageSize,
      total: filtered.length,
    },
  }
}

export async function readBenchmarkEvaluationArtifact(input: {
  evaluationId: string
  artifactId: string
  user: string
}) {
  const artifact = await benchmarkPrisma.benchmarkEvaluationArtifact.findFirst({
    where: {
      id: input.artifactId,
      evaluationId: input.evaluationId,
      evaluation: {
        caseRun: {
          experiment: { user: input.user, scope: 'benchmark' },
        },
      },
    },
    select: {
      name: true,
      mediaType: true,
      sha256: true,
      sizeBytes: true,
      storagePath: true,
    },
  })
  if (!artifact) {
    throw new BenchmarkProtocolError('EVALUATION_ARTIFACT_NOT_FOUND', '评测证据不存在', 404)
  }
  const root = path.resolve(resolveAgentInsightDataPath())
  const absolutePath = path.resolve(root, artifact.storagePath)
  if (!absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new BenchmarkProtocolError('EVALUATION_ARTIFACT_PATH_INVALID', '评测证据存储路径不合法', 500)
  }
  let bytes: Buffer
  try {
    bytes = await fs.readFile(absolutePath)
  } catch {
    throw new BenchmarkProtocolError('EVALUATION_ARTIFACT_CONTENT_MISSING', '评测证据文件不存在', 404)
  }
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  if (bytes.byteLength !== artifact.sizeBytes || digest !== artifact.sha256) {
    throw new BenchmarkProtocolError('EVALUATION_ARTIFACT_CONTENT_MISMATCH', '评测证据完整性校验失败', 409)
  }
  return { ...artifact, bytes }
}

export async function readBenchmarkRunArtifact(input: {
  artifactId: string
  user: string
}) {
  const artifact = await benchmarkPrisma.benchmarkArtifact.findFirst({
    where: {
      id: input.artifactId,
      run: {
        experiment: { user: input.user, scope: 'benchmark' },
      },
    },
    select: {
      name: true,
      mediaType: true,
      sha256: true,
      sizeBytes: true,
      storagePath: true,
    },
  })
  if (!artifact) {
    throw new BenchmarkProtocolError('ARTIFACT_NOT_FOUND', 'Artifact 不存在', 404)
  }
  const root = path.resolve(resolveAgentInsightDataPath())
  const absolutePath = path.resolve(root, artifact.storagePath)
  if (!absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new BenchmarkProtocolError('ARTIFACT_PATH_INVALID', 'Artifact 存储路径不合法', 500)
  }
  const bytes = await fs.readFile(absolutePath).catch(() => null)
  if (!bytes) {
    throw new BenchmarkProtocolError('ARTIFACT_CONTENT_MISSING', 'Artifact 文件不存在', 404)
  }
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  if (bytes.byteLength !== artifact.sizeBytes || digest !== artifact.sha256) {
    throw new BenchmarkProtocolError('ARTIFACT_CONTENT_MISMATCH', 'Artifact 内容完整性校验失败', 409)
  }
  return { ...artifact, bytes }
}
