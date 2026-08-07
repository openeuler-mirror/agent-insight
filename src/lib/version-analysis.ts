import { prismaRaw } from '@/lib/storage/prisma';
import { ensureTraceTagTables, TraceTagError, type TraceTagDto } from '@/lib/trace-tags';
import { latencySecondsToMs } from '@/lib/latency-format';

export type VersionAnalysisTrace = {
  id: string;
  taskId: string | null;
  query: string | null;
  questionKey: string;
  framework: string | null;
  agentName: string | null;
  timestamp: string;
  traceCompletedAt: string | null;
  traceStatus: 'running' | 'success';
  taskCompletionScore: number | null;
  tokens: number | null;
  latencySec: number | null;
  cost: number | null;
  finalResult: string | null;
};

export type VersionMetricSummary = {
  traceCount: number;
  taskCompletionScoreAvg: number | null;
  taskCompletionScoreCoverage: number;
  runSuccessRate: number | null;
  avgTokens: number | null;
  p95LatencySec: number | null;
  avgCost: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
};

export type VersionMetric = VersionMetricSummary & {
  tag: TraceTagDto;
};

export type VersionAnalysisSummary = VersionMetricSummary & {
  versionTagCount: number;
};

export type VersionQuestionSummary = {
  key: string;
  label: string;
  traceCount: number;
  versionCount: number;
  taskCompletionScoreAvg: number | null;
};

export type VersionCompareResponse = {
  versions: VersionMetric[];
  questions: VersionQuestionSummary[];
  summary: VersionAnalysisSummary;
  meta: {
    user: string;
    agent: string | null;
    framework: string | null;
    from: string | null;
    to: string | null;
    questionKey: string | null;
  };
};

export type VersionTracesResponse = {
  tag: TraceTagDto;
  traces: VersionAnalysisTrace[];
  total: number;
};

export type VersionAnalysisFilters = {
  user?: string | null;
  agent?: string | null;
  framework?: string | null;
  from?: string | null;
  to?: string | null;
  questionKey?: string | null;
};

const EMPTY_QUESTION_KEY = '__empty_query__';
const TASK_COMPLETION_EVALUATOR_ID = 'preset-agent-task-completion';

type TaskCompletionScoreLookup = {
  byExecutionId: Map<string, number>;
  byLegacyTaskId: Map<string, number>;
};

type TaskCompletionResultCandidate = {
  id?: string;
  score: number | null;
  humanScore: number | null;
  updatedAt?: Date | string;
  case: {
    executionId: string | null;
    taskId: string | null;
  };
};

function assertSupported() {
  if (process.env.DB_HOST) {
    throw new TraceTagError(501, 'version analysis is not available for this database adapter');
  }
}

function cleanUser(userInput?: string | null): string {
  const user = String(userInput || '').trim();
  if (!user) throw new TraceTagError(400, 'user is required');
  return user;
}

function cleanOptional(value?: string | null): string | null {
  const trimmed = String(value || '').trim();
  return trimmed ? trimmed : null;
}

function parseDateParam(value?: string | null, name = 'date'): Date | null {
  const raw = cleanOptional(value);
  if (!raw) return null;
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new TraceTagError(400, `${name} is invalid`);
  return date;
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : value;
  }
  return null;
}

function toNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function buildLatestTaskCompletionScoreLookup(
  candidates: TaskCompletionResultCandidate[],
): TaskCompletionScoreLookup {
  const lookup: TaskCompletionScoreLookup = {
    byExecutionId: new Map(),
    byLegacyTaskId: new Map(),
  };
  const newestFirst = [...candidates].sort((a, b) => {
    const timeDiff = new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime();
    return timeDiff || String(b.id || '').localeCompare(String(a.id || ''));
  });
  for (const candidate of newestFirst) {
    const effectiveScore = toNumber(candidate.humanScore) ?? toNumber(candidate.score);
    if (effectiveScore == null) continue;
    const executionId = cleanOptional(candidate.case.executionId);
    if (executionId) {
      if (!lookup.byExecutionId.has(executionId)) lookup.byExecutionId.set(executionId, effectiveScore);
      continue;
    }
    const taskId = cleanOptional(candidate.case.taskId);
    if (taskId && !lookup.byLegacyTaskId.has(taskId)) lookup.byLegacyTaskId.set(taskId, effectiveScore);
  }
  return lookup;
}

function resolveTaskCompletionScore(execution: any, lookup: TaskCompletionScoreLookup): number | null {
  const executionId = cleanOptional(execution.id);
  if (executionId && lookup.byExecutionId.has(executionId)) {
    return lookup.byExecutionId.get(executionId) ?? null;
  }
  const taskId = cleanOptional(execution.taskId);
  return taskId ? lookup.byLegacyTaskId.get(taskId) ?? null : null;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function normalizeVersionQuestionKey(query?: string | null): string {
  const normalized = String(query || '').trim().replace(/\s+/g, ' ');
  return normalized || EMPTY_QUESTION_KEY;
}

function questionLabel(query?: string | null): string {
  const normalized = String(query || '').trim().replace(/\s+/g, ' ');
  return normalized || 'Untitled question';
}

function effectiveTokens(execution: any): number | null {
  const tokens = toNumber(execution.tokens);
  if (tokens != null) return tokens;
  const input = toNumber(execution.inputTokens) ?? 0;
  const output = toNumber(execution.outputTokens) ?? 0;
  const total = input + output;
  return total > 0 ? total : null;
}

function toTagDto(row: any, usageCount = 0): TraceTagDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    kind: row.kind === 'business' ? 'business' : 'version',
    color: row.color || '#6366f1',
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt || ''),
    usageCount,
  };
}

function buildExecutionWhere(user: string, filters: VersionAnalysisFilters): Record<string, unknown> {
  const from = parseDateParam(filters.from, 'from');
  const to = parseDateParam(filters.to, 'to');
  const timestamp: Record<string, Date> = {};
  if (from) timestamp.gte = from;
  if (to) timestamp.lte = to;
  return {
    user,
    isSubagent: false,
    ...(cleanOptional(filters.agent) ? { agentName: cleanOptional(filters.agent) } : {}),
    ...(cleanOptional(filters.framework) ? { framework: cleanOptional(filters.framework) } : {}),
    ...(Object.keys(timestamp).length ? { timestamp } : {}),
  };
}

async function loadSessionEndTimes(user: string, taskIds: string[]): Promise<Map<string, string>> {
  const uniqueTaskIds = Array.from(new Set(taskIds.filter(Boolean)));
  if (!uniqueTaskIds.length) return new Map();
  const rows = await (prismaRaw as any).session.findMany({
    where: {
      taskId: { in: uniqueTaskIds },
      OR: [{ user }, { user: null }],
    },
    select: { taskId: true, endTime: true },
  });
  const out = new Map<string, string>();
  for (const row of rows) {
    const iso = toIso(row.endTime);
    if (row.taskId && iso) out.set(row.taskId, iso);
  }
  return out;
}

async function loadLatestTaskCompletionScores(user: string, executions: any[]): Promise<TaskCompletionScoreLookup> {
  const executionIds = Array.from(new Set(executions.map(execution => cleanOptional(execution?.id)).filter(Boolean))) as string[];
  const taskIds = Array.from(new Set(executions.map(execution => cleanOptional(execution?.taskId)).filter(Boolean))) as string[];
  if (!executionIds.length && !taskIds.length) return buildLatestTaskCompletionScoreLookup([]);

  const select = {
    id: true,
    score: true,
    humanScore: true,
    updatedAt: true,
    case: { select: { executionId: true, taskId: true } },
  };
  const rows: TaskCompletionResultCandidate[] = [];
  const batchSize = 400;
  for (let offset = 0; offset < executionIds.length; offset += batchSize) {
    rows.push(...await (prismaRaw as any).experimentEvalResult.findMany({
      where: {
        evaluatorId: TASK_COMPLETION_EVALUATOR_ID,
        status: 'done',
        case: {
          experiment: { user },
          executionId: { in: executionIds.slice(offset, offset + batchSize) },
        },
      },
      select,
    }));
  }
  for (let offset = 0; offset < taskIds.length; offset += batchSize) {
    rows.push(...await (prismaRaw as any).experimentEvalResult.findMany({
      where: {
        evaluatorId: TASK_COMPLETION_EVALUATOR_ID,
        status: 'done',
        case: {
          experiment: { user },
          executionId: null,
          taskId: { in: taskIds.slice(offset, offset + batchSize) },
        },
      },
      select,
    }));
  }
  return buildLatestTaskCompletionScoreLookup(rows);
}

function toTrace(
  row: any,
  sessionEndByTaskId: Map<string, string>,
  taskCompletionScores: TaskCompletionScoreLookup,
): VersionAnalysisTrace {
  const execution = row.execution;
  const taskId = execution.taskId ?? null;
  const completedAt = taskId ? sessionEndByTaskId.get(taskId) ?? null : null;
  const latencyMs = latencySecondsToMs(toNumber(execution.latency));
  return {
    id: execution.id,
    taskId,
    query: execution.query ?? null,
    questionKey: normalizeVersionQuestionKey(execution.query),
    framework: execution.framework ?? null,
    agentName: execution.agentName ?? null,
    timestamp: toIso(execution.timestamp) || new Date(0).toISOString(),
    traceCompletedAt: completedAt,
    traceStatus: completedAt ? 'success' : 'running',
    taskCompletionScore: resolveTaskCompletionScore(execution, taskCompletionScores),
    tokens: effectiveTokens(execution),
    latencySec: latencyMs == null ? null : latencyMs / 1000,
    cost: toNumber(execution.cost),
    finalResult: execution.finalResult ?? null,
  };
}

function summarizeTraceMetrics(traces: VersionAnalysisTrace[]): VersionMetricSummary {
  const scores = traces.map(t => t.taskCompletionScore).filter((v): v is number => typeof v === 'number');
  const tokens = traces.map(t => t.tokens).filter((v): v is number => typeof v === 'number');
  const latencies = traces.map(t => t.latencySec).filter((v): v is number => typeof v === 'number');
  const costs = traces.map(t => t.cost).filter((v): v is number => typeof v === 'number');
  const terminal = traces.filter(t => t.traceStatus === 'success');
  const times = traces.map(t => new Date(t.timestamp).getTime()).filter(Number.isFinite);
  return {
    traceCount: traces.length,
    taskCompletionScoreAvg: average(scores),
    taskCompletionScoreCoverage: traces.length ? scores.length / traces.length : 0,
    runSuccessRate: traces.length ? terminal.length / traces.length : null,
    avgTokens: average(tokens),
    p95LatencySec: percentile(latencies, 95),
    avgCost: average(costs),
    firstSeen: times.length ? new Date(Math.min(...times)).toISOString() : null,
    lastSeen: times.length ? new Date(Math.max(...times)).toISOString() : null,
  };
}

function summarizeVersion(tag: any, traces: VersionAnalysisTrace[]): VersionMetric {
  return {
    tag: toTagDto(tag, traces.length),
    ...summarizeTraceMetrics(traces),
  };
}

function summarizeOverall(
  tags: any[],
  rows: any[],
  sessionEndByTaskId: Map<string, string>,
  taskCompletionScores: TaskCompletionScoreLookup,
): VersionAnalysisSummary {
  const byExecution = new Map<string, any>();
  for (const row of rows) {
    const id = row.execution?.id;
    if (id && !byExecution.has(id)) byExecution.set(id, row);
  }
  const traces = Array.from(byExecution.values()).map(row => toTrace(row, sessionEndByTaskId, taskCompletionScores));
  return {
    versionTagCount: tags.length,
    ...summarizeTraceMetrics(traces),
  };
}

function summarizeQuestions(rows: any[], taskCompletionScores: TaskCompletionScoreLookup): VersionQuestionSummary[] {
  const byQuestion = new Map<string, { label: string; executions: Map<string, any>; versions: Set<string> }>();
  for (const row of rows) {
    const execution = row.execution;
    const key = normalizeVersionQuestionKey(execution.query);
    const bucket = byQuestion.get(key) ?? { label: questionLabel(execution.query), executions: new Map<string, any>(), versions: new Set<string>() };
    bucket.executions.set(execution.id, execution);
    bucket.versions.add(row.tagId);
    byQuestion.set(key, bucket);
  }
  return Array.from(byQuestion.entries())
    .map(([key, bucket]) => {
      const executions = Array.from(bucket.executions.values());
      const scores = executions
        .map(execution => resolveTaskCompletionScore(execution, taskCompletionScores))
        .filter((v): v is number => typeof v === 'number');
      return {
        key,
        label: bucket.label,
        traceCount: executions.length,
        versionCount: bucket.versions.size,
        taskCompletionScoreAvg: average(scores),
      };
    })
    .sort((a, b) => b.traceCount - a.traceCount || a.label.localeCompare(b.label));
}

async function loadVersionRows(user: string, filters: VersionAnalysisFilters): Promise<{ tags: any[]; rows: any[]; meta: VersionCompareResponse['meta'] }> {
  assertSupported();
  await ensureTraceTagTables();
  const clean = cleanUser(user);
  const tags = await (prismaRaw as any).tag.findMany({
    where: { user: clean, kind: 'version' },
    orderBy: [{ name: 'asc' }],
  });
  if (!tags.length) {
    return {
      tags: [],
      rows: [],
      meta: {
        user: clean,
        agent: cleanOptional(filters.agent),
        framework: cleanOptional(filters.framework),
        from: parseDateParam(filters.from, 'from')?.toISOString() ?? null,
        to: parseDateParam(filters.to, 'to')?.toISOString() ?? null,
        questionKey: cleanOptional(filters.questionKey),
      },
    };
  }
  const rows = await (prismaRaw as any).executionTag.findMany({
    where: {
      user: clean,
      tagId: { in: tags.map((tag: any) => tag.id) },
      execution: buildExecutionWhere(clean, filters),
    },
    include: {
      tag: true,
      execution: {
        select: {
          id: true,
          taskId: true,
          query: true,
          framework: true,
          agentName: true,
          timestamp: true,
          tokens: true,
          inputTokens: true,
          outputTokens: true,
          latency: true,
          cost: true,
          finalResult: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
  return {
    tags,
    rows,
    meta: {
      user: clean,
      agent: cleanOptional(filters.agent),
      framework: cleanOptional(filters.framework),
      from: parseDateParam(filters.from, 'from')?.toISOString() ?? null,
      to: parseDateParam(filters.to, 'to')?.toISOString() ?? null,
      questionKey: cleanOptional(filters.questionKey),
    },
  };
}

export async function getVersionCompare(filters: VersionAnalysisFilters): Promise<VersionCompareResponse> {
  const user = cleanUser(filters.user);
  const { tags, rows, meta } = await loadVersionRows(user, filters);
  const taskCompletionScores = await loadLatestTaskCompletionScores(user, rows.map(row => row.execution));
  const questions = summarizeQuestions(rows, taskCompletionScores);
  const selectedQuestionKey = cleanOptional(filters.questionKey);
  const rowsForMetrics = selectedQuestionKey
    ? rows.filter(row => normalizeVersionQuestionKey(row.execution?.query) === selectedQuestionKey)
    : rows;
  const sessionEndByTaskId = await loadSessionEndTimes(user, rows.map(row => row.execution?.taskId).filter(Boolean));
  const summary = summarizeOverall(tags, rows, sessionEndByTaskId, taskCompletionScores);
  const tracesByTag = new Map<string, VersionAnalysisTrace[]>();
  for (const row of rowsForMetrics) {
    const traces = tracesByTag.get(row.tagId) ?? [];
    traces.push(toTrace(row, sessionEndByTaskId, taskCompletionScores));
    tracesByTag.set(row.tagId, traces);
  }
  return {
    versions: tags.map(tag => summarizeVersion(tag, tracesByTag.get(tag.id) ?? [])),
    questions,
    summary,
    meta,
  };
}

export async function getVersionTagTraces(tagIdInput: string, filters: VersionAnalysisFilters & { limit?: string | null }): Promise<VersionTracesResponse> {
  assertSupported();
  await ensureTraceTagTables();
  const user = cleanUser(filters.user);
  const tagId = String(tagIdInput || '').trim();
  if (!tagId) throw new TraceTagError(400, 'tag id is required');
  const tag = await (prismaRaw as any).tag.findFirst({ where: { id: tagId, user, kind: 'version' } });
  if (!tag) throw new TraceTagError(404, 'version tag not found');
  const limitRaw = Number.parseInt(String(filters.limit || ''), 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;
  const rows = await (prismaRaw as any).executionTag.findMany({
    where: {
      user,
      tagId,
      execution: buildExecutionWhere(user, filters),
    },
    include: {
      execution: {
        select: {
          id: true,
          taskId: true,
          query: true,
          framework: true,
          agentName: true,
          timestamp: true,
          tokens: true,
          inputTokens: true,
          outputTokens: true,
          latency: true,
          cost: true,
          finalResult: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  const selectedQuestionKey = cleanOptional(filters.questionKey);
  const filteredRows = selectedQuestionKey
    ? rows.filter((row: any) => normalizeVersionQuestionKey(row.execution?.query) === selectedQuestionKey)
    : rows;
  const sessionEndByTaskId = await loadSessionEndTimes(user, filteredRows.map((row: any) => row.execution?.taskId).filter(Boolean));
  const taskCompletionScores = await loadLatestTaskCompletionScores(user, filteredRows.map((row: any) => row.execution));
  const traces = filteredRows
    .map((row: any) => toTrace(row, sessionEndByTaskId, taskCompletionScores))
    .sort((a: VersionAnalysisTrace, b: VersionAnalysisTrace) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return {
    tag: toTagDto(tag, traces.length),
    traces: traces.slice(0, limit),
    total: traces.length,
  };
}
