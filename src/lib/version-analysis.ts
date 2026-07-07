import { prismaRaw } from '@/lib/storage/prisma';
import { ensureTraceTagTables, TraceTagError, type TraceTagDto } from '@/lib/trace-tags';

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
  answerScore: number | null;
  isAnswerCorrect: boolean | null;
  tokens: number | null;
  latencySec: number | null;
  cost: number | null;
  finalResult: string | null;
};

export type VersionMetricSummary = {
  traceCount: number;
  answerScoreAvg: number | null;
  answerScoreCoverage: number;
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
  answerScoreAvg: number | null;
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

function toDisplayLatencyMs(latency: number | null, framework?: string | null): number | null {
  if (latency == null || !Number.isFinite(latency)) return null;
  const fw = String(framework || '').toLowerCase();
  if ((fw === 'opencode' || fw === 'openhands' || fw === 'claude' || fw === 'claudecode') && latency > 0 && latency < 1000) return latency * 1000;
  return latency;
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

function toTrace(row: any, sessionEndByTaskId: Map<string, string>): VersionAnalysisTrace {
  const execution = row.execution;
  const taskId = execution.taskId ?? null;
  const completedAt = taskId ? sessionEndByTaskId.get(taskId) ?? null : null;
  const latencyMs = toDisplayLatencyMs(toNumber(execution.latency), execution.framework);
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
    answerScore: toNumber(execution.answerScore),
    isAnswerCorrect: typeof execution.isAnswerCorrect === 'boolean' ? execution.isAnswerCorrect : null,
    tokens: effectiveTokens(execution),
    latencySec: latencyMs == null ? null : latencyMs / 1000,
    cost: toNumber(execution.cost),
    finalResult: execution.finalResult ?? null,
  };
}

function summarizeTraceMetrics(traces: VersionAnalysisTrace[]): VersionMetricSummary {
  const scores = traces.map(t => t.answerScore).filter((v): v is number => typeof v === 'number');
  const tokens = traces.map(t => t.tokens).filter((v): v is number => typeof v === 'number');
  const latencies = traces.map(t => t.latencySec).filter((v): v is number => typeof v === 'number');
  const costs = traces.map(t => t.cost).filter((v): v is number => typeof v === 'number');
  const terminal = traces.filter(t => t.traceStatus === 'success');
  const times = traces.map(t => new Date(t.timestamp).getTime()).filter(Number.isFinite);
  return {
    traceCount: traces.length,
    answerScoreAvg: average(scores),
    answerScoreCoverage: traces.length ? scores.length / traces.length : 0,
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

function summarizeOverall(tags: any[], rows: any[], sessionEndByTaskId: Map<string, string>): VersionAnalysisSummary {
  const byExecution = new Map<string, any>();
  for (const row of rows) {
    const id = row.execution?.id;
    if (id && !byExecution.has(id)) byExecution.set(id, row);
  }
  const traces = Array.from(byExecution.values()).map(row => toTrace(row, sessionEndByTaskId));
  return {
    versionTagCount: tags.length,
    ...summarizeTraceMetrics(traces),
  };
}

function summarizeQuestions(rows: any[]): VersionQuestionSummary[] {
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
      const scores = executions.map(e => toNumber(e.answerScore)).filter((v): v is number => typeof v === 'number');
      return {
        key,
        label: bucket.label,
        traceCount: executions.length,
        versionCount: bucket.versions.size,
        answerScoreAvg: average(scores),
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
          answerScore: true,
          isAnswerCorrect: true,
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
  const questions = summarizeQuestions(rows);
  const selectedQuestionKey = cleanOptional(filters.questionKey);
  const rowsForMetrics = selectedQuestionKey
    ? rows.filter(row => normalizeVersionQuestionKey(row.execution?.query) === selectedQuestionKey)
    : rows;
  const sessionEndByTaskId = await loadSessionEndTimes(user, rows.map(row => row.execution?.taskId).filter(Boolean));
  const summary = summarizeOverall(tags, rows, sessionEndByTaskId);
  const tracesByTag = new Map<string, VersionAnalysisTrace[]>();
  for (const row of rowsForMetrics) {
    const traces = tracesByTag.get(row.tagId) ?? [];
    traces.push(toTrace(row, sessionEndByTaskId));
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
          answerScore: true,
          isAnswerCorrect: true,
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
  const traces = filteredRows
    .map((row: any) => toTrace(row, sessionEndByTaskId))
    .sort((a: VersionAnalysisTrace, b: VersionAnalysisTrace) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return {
    tag: toTagDto(tag, traces.length),
    traces: traces.slice(0, limit),
    total: traces.length,
  };
}