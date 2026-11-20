/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { prismaRaw } from '@/lib/storage/prisma';
import { ensureTraceTagTables, TraceTagError, type TraceTagDto } from '@/lib/trace-tags';
import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {requireCoreExperimentContext} from '@/lib/storage-core/experiments';
import {requestCore} from '@/lib/storage-core/server';
import {readCoreExperimentTraces} from '@/lib/storage-core/experiment-traces';

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
  const executionIds = Array.from(new Set(executions.flatMap(execution => [cleanOptional(execution?.id),cleanOptional(execution?.coreTraceId)]).filter(Boolean))) as string[];
  const taskIds = Array.from(new Set(executions.flatMap(execution => [cleanOptional(execution?.taskId),cleanOptional(execution?.coreTraceId)]).filter(Boolean))) as string[];
  if (!executionIds.length && !taskIds.length) return buildLatestTaskCompletionScoreLookup([]);

  {
    const context=requireCoreExperimentContext();
    if(context.actor.username!==user)throw new TraceTagError(403,'version analysis actor differs');
    const view=await context.rpc('list_view') as {coverage?:string;snapshots?:Array<{source_available?:boolean;experiment:{user:string;cases:Array<{executionId:string|null;taskId:string|null;results:Array<TaskCompletionResultCandidate&{evaluatorId:string;status:string}>}>}}>};
    if(view.coverage!=='complete'||!Array.isArray(view.snapshots))throw new TraceTagError(503,'complete version score selection required');
    const owners=new Set(executions.map(execution=>execution.user));const executionSet=new Set(executionIds),taskSet=new Set(taskIds);const candidates:TaskCompletionResultCandidate[]=[];
    const executionAliases=new Map<string,string>(),taskAliases=new Map<string,string>();
    for(const execution of executions){
      for(const id of [execution.id,execution.coreTraceId])if(id)executionAliases.set(id,execution.id);
      if(execution.taskId)for(const id of [execution.taskId,execution.coreTraceId])if(id)taskAliases.set(id,execution.taskId);
    }
    for(const snapshot of view.snapshots){
      if(snapshot.source_available===false||!owners.has(snapshot.experiment.user))continue;
      for(const item of snapshot.experiment.cases){
        if(item.executionId?!executionSet.has(item.executionId):!item.taskId||!taskSet.has(item.taskId))continue;
        for(const result of item.results)if(result.evaluatorId===TASK_COMPLETION_EVALUATOR_ID&&result.status==='done')candidates.push({...result,case:{executionId:item.executionId?executionAliases.get(item.executionId)||item.executionId:null,taskId:item.taskId?taskAliases.get(item.taskId)||item.taskId:null}});
      }
    }
    return buildLatestTaskCompletionScoreLookup(candidates);
  }
}

function toTrace(
  row: any,
  sessionEndByTaskId: Map<string, string>,
  taskCompletionScores: TaskCompletionScoreLookup,
): VersionAnalysisTrace {
  const execution = row.execution;
  const taskId = execution.taskId ?? null;
  const completedAt = taskId ? sessionEndByTaskId.get(taskId) ?? null : null;
  // Execution.latency 已是毫秒（全链路统一口径），直接使用；
  // 此前误用 latencySecondsToMs 会把它再放大 1000 倍（见
  // Pi/Codex Trace 单位同步修复）。
  const latencyMs = toNumber(execution.latency);
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
  return loadCoreVersionRows(user,filters);
}

type CoreVersionRow = {
  tagId:string;
  tag:Record<string,unknown>;
  execution:Record<string,unknown>&{id:string;taskId:string|null;coreCompletedAt:string|null};
};

async function loadCoreVersionRows(user:string,filters:VersionAnalysisFilters){
  const context=requireCoreExperimentContext();
  if(context.actor.username!==user)throw new TraceTagError(403,'version analysis actor differs');
  const from=parseDateParam(filters.from,'from'),to=parseDateParam(filters.to,'to');
  const profile=await requestCore('/v1/auth/me',{token:context.actor.token},context.options.fetcher||fetch);
  if(profile.data.principal_id!==context.actor.principal||typeof profile.data.username!=='string'||!profile.data.username)throw new TraceTagError(403,'version analysis principal differs');
  const owner=profile.data.username;
  const params=new URLSearchParams({traceUser:owner,includeCoreIdentity:'1'});
  if(cleanOptional(filters.agent))params.set('agentName',cleanOptional(filters.agent)!);
  if(cleanOptional(filters.framework))params.set('framework',cleanOptional(filters.framework)!);
  if(from)params.set('timeFrom',from.toISOString());if(to)params.set('timeTo',to.toISOString());
  const [tagResponse,traces]=await Promise.all([
    requestCore('/v1/compat/tags?'+new URLSearchParams({workspace_id:context.actor.workspace,kind:'version'}),{token:context.actor.token,responseLimit:4*1024*1024},context.options.fetcher||fetch),
    readCoreExperimentTraces(context,params),
  ]);
  if(!Array.isArray(tagResponse.data.value)||tagResponse.data.value.length>10000)throw new TraceTagError(503,'complete version tags required');
  const tags=tagResponse.data.value.filter(tag=>tag&&typeof tag==='object'&&tag.kind==='version'&&tag.createdBy===owner).sort((a,b)=>String(a.name).localeCompare(String(b.name)));
  const byId=new Map(tags.map(tag=>[tag.id,tag]));const rows:CoreVersionRow[]=[];
  for(const trace of traces){
    if(trace.user!==owner||trace.is_subagent===true)continue;
    const timestamp=toIso(trace.timestamp);const time=timestamp?Date.parse(timestamp):NaN;
    if((from&&time<from.getTime())||(to&&time>to.getTime())||(cleanOptional(filters.agent)&&trace.agentName!==cleanOptional(filters.agent))||(cleanOptional(filters.framework)&&trace.framework!==cleanOptional(filters.framework)))continue;
    const id=cleanOptional(trace.upload_id as string)||cleanOptional(trace._trace_id as string);
    if(!id||!timestamp||!Number.isFinite(time)||!Array.isArray(trace.userTags)||typeof trace.core_trace_id!=='string'||!trace.core_trace_id)throw new TraceTagError(503,'complete version Trace metadata required');
    const execution={id,user:owner,coreTraceId:trace.core_trace_id,taskId:cleanOptional(trace.task_id as string),query:trace.query??null,framework:trace.framework??null,agentName:trace.agentName??null,timestamp,tokens:trace.tokens,inputTokens:trace.input_tokens,outputTokens:trace.output_tokens,latency:trace.latency,cost:trace.cost,finalResult:trace.final_result??null,coreCompletedAt:toIso(trace.trace_completed_at)};
    for(const tagId of new Set(trace.userTags.map(tag=>(tag as {id:string}).id))){const tag=byId.get(tagId);if(tag)rows.push({tagId,tag,execution});}
  }
  return {tags,rows,meta:{user,agent:cleanOptional(filters.agent),framework:cleanOptional(filters.framework),from:from?.toISOString()??null,to:to?.toISOString()??null,questionKey:cleanOptional(filters.questionKey)}};
}

function coreSessionEndTimes(rows:CoreVersionRow[]){return new Map<string,string>(rows.filter(row=>row.execution.taskId&&row.execution.coreCompletedAt).map(row=>[row.execution.taskId!,row.execution.coreCompletedAt!]));}

async function refreshCoreVersionRows<T extends CoreVersionRow>(user:string,filters:VersionAnalysisFilters,rows:T[]):Promise<T[]>{

  const current=await loadCoreVersionRows(user,filters);const allowed=new Set(current.rows.map(row=>JSON.stringify([row.tagId,row.execution.id])));
  return rows.filter(row=>allowed.has(JSON.stringify([row.tagId,row.execution.id])));
}

export async function getVersionCompare(filters: VersionAnalysisFilters): Promise<VersionCompareResponse> {
  const user = cleanUser(filters.user);
  const { tags, rows:loadedRows, meta } = await loadVersionRows(user, filters);
  const taskCompletionScores = await loadLatestTaskCompletionScores(user, loadedRows.map(row => row.execution));
  const rows=await refreshCoreVersionRows(user,filters,loadedRows);
  const questions = summarizeQuestions(rows, taskCompletionScores);
  const selectedQuestionKey = cleanOptional(filters.questionKey);
  const rowsForMetrics = selectedQuestionKey
    ? rows.filter(row => normalizeVersionQuestionKey(row.execution?.query) === selectedQuestionKey)
    : rows;
  const sessionEndByTaskId = (coreSessionEndTimes(rows));
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

  const user = cleanUser(filters.user);
  const tagId = String(tagIdInput || '').trim();
  if (!tagId) throw new TraceTagError(400, 'tag id is required');
  const core=(await loadCoreVersionRows(user,filters));
  const tag = core?core.tags.find(row=>row.id===tagId):await (prismaRaw as any).tag.findFirst({ where: { id: tagId, user, kind: 'version' } });
  if (!tag) throw new TraceTagError(404, 'version tag not found');
  const limitRaw = Number.parseInt(String(filters.limit || ''), 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;
  const rows = core?core.rows.filter(row=>row.tagId===tagId):await (prismaRaw as any).executionTag.findMany({
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
  const taskCompletionScores = await loadLatestTaskCompletionScores(user, filteredRows.map((row: any) => row.execution));
  const visibleRows=await refreshCoreVersionRows(user,filters,filteredRows);
  const sessionEndByTaskId = (coreSessionEndTimes(visibleRows));
  const traces = visibleRows
    .map((row: any) => toTrace(row, sessionEndByTaskId, taskCompletionScores))
    .sort((a: VersionAnalysisTrace, b: VersionAnalysisTrace) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return {
    tag: toTagDto(tag, traces.length),
    traces: traces.slice(0, limit),
    total: traces.length,
  };
}
