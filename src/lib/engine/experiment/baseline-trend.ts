import { createHash } from 'node:crypto';

import { effectiveScore, overallAverage, scoredRows, type ResultRowLike } from '@/lib/engine/experiment/detail-agg';
import { getBenchmarkAdapter } from '@/lib/benchmark/adapter-registry';
import { prisma } from '@/lib/storage/prisma';

export interface ExperimentBaselineTrendPoint {
  experimentId: string;
  name: string;
  agentName: string;
  model: string | null;
  createdAt: string;
  value: number;
  summary: string;
  isCurrent: boolean;
}

export interface ExperimentBaselineTrend {
  metricKey: string;
  metricLabel: string;
  metricKind: 'score' | 'percentage';
  baselineDescription: string;
  points: ExperimentBaselineTrendPoint[];
}

export const EXPERIMENT_BASELINE_TREND_MAX_POINTS = 50;

interface BaselineCaseContract {
  input: string;
  datasetInput: string | null;
  referenceOutput: string | null;
  evaluatorContextJson: string | null;
  caseValuesJson: string | null;
  faultInjectionType: string | null;
}

export interface BaselineExperimentLike {
  id: string;
  name: string;
  type: string;
  user: string;
  agentName: string;
  status: string;
  scope: string;
  preset: string | null;
  watchMode: boolean;
  evaluatorIdsJson: string;
  configSnapshotJson: string | null;
  createdAt: Date;
  cases: BaselineCaseContract[];
  caseCount?: number;
}

export interface BenchmarkTrendMetric {
  evaluatorId: string;
  key: string;
  label: string;
  aggregation: 'boolean-rate' | 'mean';
}

function parseObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function normalizedJson(value: string | null): unknown {
  if (!value) return null;
  try { return normalizeValue(JSON.parse(value) as unknown); } catch { return value; }
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeValue(item)]),
    );
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(normalizeValue(value))).digest('hex');
}

function caseContractHash(cases: BaselineCaseContract[]): string {
  const contracts = cases.map((item) => JSON.stringify(normalizeValue({
    input: item.datasetInput || item.input,
    referenceOutput: item.referenceOutput,
    evaluatorContext: normalizedJson(item.evaluatorContextJson),
    caseValues: normalizedJson(item.caseValuesJson),
    faultInjectionType: item.faultInjectionType,
  }))).sort((left, right) => left.localeCompare(right));
  return sha256(contracts);
}

export function buildExperimentBaselineKey(experiment: BaselineExperimentLike): string | null {
  if (
    experiment.type !== 'single'
    || experiment.watchMode
    || !['', 'benchmark'].includes(experiment.scope)
  ) return null;

  const snapshot = parseObject(experiment.configSnapshotJson);
  if (!snapshot) return null;
  const caseIds = sortedUnique(stringArray(snapshot.caseIds));
  if (!caseIds.length) return null;

  if (experiment.scope === 'benchmark') {
    const adapterKey = typeof snapshot.adapterKey === 'string' ? snapshot.adapterKey.trim() : '';
    const evaluatorKey = typeof snapshot.evaluatorKey === 'string' ? snapshot.evaluatorKey.trim() : '';
    const datasetContentHash = typeof snapshot.datasetContentHash === 'string'
      ? snapshot.datasetContentHash.trim()
      : '';
    if (!adapterKey || !evaluatorKey || !datasetContentHash) return null;
    return sha256({
      scope: experiment.scope,
      adapterKey,
      datasetContentHash,
      caseIds,
      evaluatorContract: `benchmark:${evaluatorKey}`,
      evaluationProtocol: 'benchmark-evaluation/v1',
    });
  }

  const datasetId = typeof snapshot.datasetId === 'string' ? snapshot.datasetId.trim() : '';
  const evaluatorIds = sortedUnique(stringArray(experiment.evaluatorIdsJson
    ? (() => { try { return JSON.parse(experiment.evaluatorIdsJson) as unknown; } catch { return []; } })()
    : []));
  if (!datasetId || !evaluatorIds.length) return null;
  return sha256({
    scope: experiment.scope,
    preset: experiment.preset,
    schemaVersion: Number(snapshot.schemaVersion) || 1,
    datasetId,
    caseIds,
    caseContractHash: caseContractHash(experiment.cases),
    evaluatorIds,
    traceSource: typeof snapshot.traceSource === 'string' ? snapshot.traceSource : null,
  });
}

function modelFromSnapshot(value: string | null): string | null {
  const snapshot = parseObject(value);
  if (!snapshot) return null;
  const runConfig = snapshot.runConfig && typeof snapshot.runConfig === 'object' && !Array.isArray(snapshot.runConfig)
    ? snapshot.runConfig as Record<string, unknown>
    : null;
  const executionTarget = snapshot.executionTarget
    && typeof snapshot.executionTarget === 'object'
    && !Array.isArray(snapshot.executionTarget)
    ? snapshot.executionTarget as Record<string, unknown>
    : null;
  const model = runConfig?.model ?? executionTarget?.model;
  return typeof model === 'string' && model.trim() ? model.trim() : null;
}

export function summarizeExperimentTrendPoint(input: {
  experiment: BaselineExperimentLike;
  results: ResultRowLike[];
  benchmarkMetric: BenchmarkTrendMetric | null;
  currentExperimentId: string;
}): ExperimentBaselineTrendPoint | null {
  const { experiment, results, benchmarkMetric, currentExperimentId } = input;
  const totalCases = experiment.caseCount ?? experiment.cases.length;
  if (!totalCases) return null;

  let value: number | null;
  let summary: string;
  if (experiment.scope === 'benchmark' && benchmarkMetric) {
    const officialRows = results.filter((row) => row.evaluatorId === benchmarkMetric.evaluatorId);
    if (benchmarkMetric.aggregation === 'boolean-rate') {
      const passed = officialRows.filter((row) => (
        row.status === 'done' && effectiveScore(row) === 100
      )).length;
      value = Math.round((passed / totalCases) * 1000) / 10;
      summary = `${passed}/${totalCases} ${benchmarkMetric.label}`;
    } else {
      value = overallAverage(officialRows);
      if (value === null) return null;
      const scoredCases = new Set(scoredRows(officialRows).map((row) => row.caseId)).size;
      summary = `${scoredCases}/${totalCases} Case 计入`;
    }
  } else {
    value = overallAverage(results);
    if (value === null) return null;
    const scoredCases = new Set(scoredRows(results).map((row) => row.caseId)).size;
    summary = `${scoredCases}/${totalCases} Case 计入`;
  }

  return {
    experimentId: experiment.id,
    name: experiment.name,
    agentName: experiment.agentName,
    model: modelFromSnapshot(experiment.configSnapshotJson),
    createdAt: experiment.createdAt.toISOString(),
    value,
    summary,
    isCurrent: experiment.id === currentExperimentId,
  };
}

export async function getExperimentBaselineTrend(input: {
  experimentId: string;
  user: string;
}): Promise<ExperimentBaselineTrend | null> {
  const current = await prisma.experiment.findFirst({
    where: { id: input.experimentId, user: input.user },
    select: {
      id: true, name: true, type: true, user: true, agentName: true, status: true,
      scope: true, preset: true, watchMode: true, evaluatorIdsJson: true,
      configSnapshotJson: true, createdAt: true,
      cases: {
        select: {
          input: true, datasetInput: true, referenceOutput: true, evaluatorContextJson: true,
          caseValuesJson: true, faultInjectionType: true,
        },
      },
    },
  }) as BaselineExperimentLike | null;
  if (!current || current.status !== 'done') return null;
  const currentKey = buildExperimentBaselineKey(current);
  if (!currentKey) return null;

  const candidateWhere = {
    user: current.user,
    type: 'single',
    scope: current.scope,
    status: 'done',
    watchMode: false,
    configSnapshotJson: { not: null },
    createdAt: { lte: current.createdAt },
  };
  let candidates: BaselineExperimentLike[];
  if (current.scope === 'benchmark') {
    const rows = await prisma.experiment.findMany({
      where: candidateWhere,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
      select: {
        id: true, name: true, type: true, user: true, agentName: true, status: true,
        scope: true, preset: true, watchMode: true, evaluatorIdsJson: true,
        configSnapshotJson: true, createdAt: true,
        _count: { select: { cases: true } },
      },
    }) as Array<Omit<BaselineExperimentLike, 'cases'> & { _count: { cases: number } }>;
    candidates = rows.map(({ _count, ...row }) => ({ ...row, cases: [], caseCount: _count.cases }));
  } else {
    candidates = await prisma.experiment.findMany({
      where: candidateWhere,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
      select: {
        id: true, name: true, type: true, user: true, agentName: true, status: true,
        scope: true, preset: true, watchMode: true, evaluatorIdsJson: true,
        configSnapshotJson: true, createdAt: true,
        cases: {
          select: {
            input: true, datasetInput: true, referenceOutput: true, evaluatorContextJson: true,
            caseValuesJson: true, faultInjectionType: true,
          },
        },
      },
    }) as BaselineExperimentLike[];
  }
  const comparable = candidates
    .filter((candidate) => buildExperimentBaselineKey(candidate) === currentKey)
    .slice(0, EXPERIMENT_BASELINE_TREND_MAX_POINTS);
  if (!comparable.some((candidate) => candidate.id === current.id)) comparable.unshift(current);
  const selected = comparable.slice(0, EXPERIMENT_BASELINE_TREND_MAX_POINTS);
  const results = await prisma.experimentEvalResult.findMany({
    where: { experimentId: { in: selected.map((candidate) => candidate.id) } },
    select: { experimentId: true, caseId: true, evaluatorId: true, status: true, score: true, humanScore: true },
  });
  const resultsByExperiment = new Map<string, typeof results>();
  for (const result of results) {
    const rows = resultsByExperiment.get(result.experimentId) || [];
    rows.push(result);
    resultsByExperiment.set(result.experimentId, rows);
  }

  const snapshot = parseObject(current.configSnapshotJson);
  const adapterKey = current.scope === 'benchmark' && typeof snapshot?.adapterKey === 'string'
    ? snapshot.adapterKey
    : null;
  let benchmarkMetric: BenchmarkTrendMetric | null = null;
  if (adapterKey) {
    try {
      const manifest = getBenchmarkAdapter(adapterKey).manifest;
      const primary = manifest.result.primaryMetric;
      const presentationLabel = manifest.presentation?.result?.primaryMetric.label || primary.key;
      benchmarkMetric = {
        evaluatorId: `benchmark:${manifest.evaluation.evaluatorKey}`,
        key: primary.key,
        label: adapterKey === 'swe-bench' ? 'Resolved' : presentationLabel,
        aggregation: primary.aggregation,
      };
    } catch {
      return null;
    }
  }
  const points = selected
    .map((experiment) => summarizeExperimentTrendPoint({
      experiment,
      results: resultsByExperiment.get(experiment.id) || [],
      benchmarkMetric,
      currentExperimentId: current.id,
    }))
    .filter((point): point is ExperimentBaselineTrendPoint => Boolean(point))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  if (!points.some((point) => point.isCurrent)) return null;

  const benchmark = current.scope === 'benchmark';
  const percentage = benchmarkMetric?.aggregation === 'boolean-rate';
  const benchmarkLabel = adapterKey === 'swe-bench'
    ? 'Resolve Rate'
    : benchmarkMetric
      ? `${benchmarkMetric.label}${percentage ? ' Rate' : ''}`
      : '主指标';
  return {
    metricKey: benchmarkMetric?.key || (benchmark ? `${adapterKey || 'benchmark'}:primary` : 'overall'),
    metricLabel: benchmark ? benchmarkLabel : '综合得分',
    metricKind: percentage ? 'percentage' : 'score',
    baselineDescription: benchmark
      ? adapterKey === 'swe-bench'
        ? '只比较数据集版本、Case 集和 Official Harness 相同的实验'
        : '只比较数据集版本、Case 集和官方评测契约相同的实验'
      : '只比较数据集、Case 集和评估器配置相同的实验',
    points,
  };
}
