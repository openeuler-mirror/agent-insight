/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { createHash } from 'node:crypto';
import { readExperimentDatasetCaseBinding, withoutExperimentDatasetCaseBinding } from '@/lib/engine/experiment/dataset-case-binding';
import { canonicalAssetJson } from './canonical';

export type AnalysisVariable = 'agent' | 'skill' | 'evaluator' | 'dataset';
export const ANALYSIS_VARIABLES: AnalysisVariable[] = ['agent', 'skill', 'evaluator', 'dataset'];

export interface AnalysisExperimentInput {
  id: string;
  name: string;
  status: string;
  type: string;
  agentName: string;
  skillName: string;
  skillVersion: number | null;
  scope: string;
  createdAt: Date | string;
  evaluatorIdsJson: string;
  evaluatorConfigsJson: string;
  configSnapshotJson: string | null;
  skillContextJson?: string | null;
  preset?: string | null;
  cases: Array<{
    input: string;
    executionId?: string | null;
    taskId?: string | null;
    execution?: { model: string | null; framework: string | null; clientId: string | null } | null;
    boundAttempt?: { workerId: string; platform: string; agent: string; model: string | null; timeoutSeconds: number } | null;
    datasetInput?: string | null;
    referenceOutput?: string | null;
    caseValuesJson?: string | null;
    evaluatorContextJson?: string | null;
    faultInjectionType?: string | null;
    groupId?: string | null;
    results: Array<{ evaluatorId: string; status: string; score: number | null; humanScore: number | null }>;
  }>;
}

interface AssetSelection { key: string; label: string; recorded: boolean }
export interface ExperimentAnalysisRun {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  assets: Record<AnalysisVariable, AssetSelection>;
  score: number | null;
  scoredResults: number;
  expectedResults: number;
  coverage: number;
  caseCount: number;
  comparable: boolean;
  reason?: string;
}
export interface ExperimentAnalysisGroup {
  id: string;
  variable: AnalysisVariable;
  conditions: Array<{ label: string; value: string }>;
  runIds: string[];
  versionCount: number;
  warning?: string;
}
export interface ExperimentAssetAnalysis {
  runs: ExperimentAnalysisRun[];
  groups: ExperimentAnalysisGroup[];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function parse(value: string | null | undefined): unknown {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}
function hash(value: unknown): string {
  return createHash('sha256').update(canonicalAssetJson({ value })).digest('hex');
}
function label(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, '').slice(0, 160) : fallback;
}
function asset(value: unknown, fallback: string): AssetSelection {
  const item = object(value);
  if (!item.businessId || !item.versionId || !item.contentHash || !Number.isInteger(item.version) || Number(item.version) < 1) {
    return { key: 'unrecorded', label: `${fallback} · 版本未记录`, recorded: false };
  }
  return {
    key: hash([item.businessId, item.versionId, item.version, item.contentHash]),
    label: `${label(object(item.definition).name, fallback)} · v${item.version}`,
    recorded: true,
  };
}

function prepare(row: AnalysisExperimentInput) {
  const snapshot = object(parse(row.configSnapshotJson));
  const refs = object(snapshot.assetVersions);
  const validRefs = refs.schemaVersion === 1 ? refs : {};
  const evaluatorIds = Array.isArray(parse(row.evaluatorIdsJson))
    ? [...new Set((parse(row.evaluatorIdsJson) as unknown[]).filter((id): id is string => typeof id === 'string'))].sort() : [];
  const evaluators = evaluatorIds.map(id => asset(object(validRefs.evaluators)[id], id));
  const evaluator: AssetSelection = {
    key: hash(evaluators.map((item, index) => [evaluatorIds[index], item.key])),
    label: evaluators.map(item => item.label).join('、') || '未选择评估器',
    recorded: evaluatorIds.length > 0 && evaluators.every(item => item.recorded),
  };
  const assets: Record<AnalysisVariable, AssetSelection> = {
    agent: asset(validRefs.agent, row.agentName || 'Agent'),
    dataset: asset(validRefs.dataset, '评测集'),
    evaluator,
    skill: {
      key: hash([row.skillName, row.skillVersion]),
      label: row.skillName ? `${label(row.skillName)} · ${row.skillVersion == null ? '版本未记录' : `v${row.skillVersion}`}` : '未使用 Skill',
      recorded: !row.skillName || row.skillVersion != null,
    },
  };
  const target = { ...object(snapshot.executionTarget) };
  delete target.agent;
  const runtime = { ...snapshot };
  for (const key of ['assetVersions', 'customEvaluatorSnapshots', 'schemaVersion', 'datasetId', 'caseIds', 'evaluatorIds', 'agentName', 'executionTarget', 'versionA', 'versionB']) delete runtime[key];
  const context = { ...object(parse(row.skillContextJson)) };
  for (const key of ['sessionId', 'versionA', 'versionB', 'skillName']) delete context[key];
  const actualProfiles = row.cases.map(item => {
    const actual = item.execution, attempt = item.boundAttempt;
    if (!actual?.model || !actual.framework || !(actual.clientId || attempt?.workerId)
      || snapshot.traceSource === 'generate' && !attempt) return null;
    if (actual.clientId && attempt?.workerId && actual.clientId !== attempt.workerId) return null;
    return { model: actual.model, platform: actual.framework, workerId: actual.clientId || attempt!.workerId,
      ...(attempt ? { dispatch: { workerId: attempt.workerId, platform: attempt.platform, agent: attempt.agent, model: attempt.model, timeoutSeconds: attempt.timeoutSeconds } } : {}) };
  });
  const completeActual = actualProfiles.every(profile => profile !== null);
  const uniformActual = new Set(actualProfiles.map(hash)).size <= 1;
  const actualCondition = snapshot.traceSource === 'generate' ? actualProfiles[0] : actualProfiles;
  const execution = { target, runtime, actualCondition, scope: row.scope, type: row.type, preset: row.preset || '', skillContext: context };
  const executionHash = hash(execution);
  const caseDefinitions = row.cases.map(item => {
    const values = object(parse(item.caseValuesJson));
    const binding = readExperimentDatasetCaseBinding(values);
    return {
      ...(snapshot.traceSource === 'existing' ? { sourceTrace: item.executionId || item.taskId || '' } : {}),
      caseId: binding?.caseId || '', input: item.datasetInput ?? item.input,
      expected: item.referenceOutput ?? '', values: withoutExperimentDatasetCaseBinding(values),
      evaluatorContext: parse(item.evaluatorContextJson), fault: item.faultInjectionType || '',
    };
  });
  const selectedIds = row.cases.map(item => readExperimentDatasetCaseBinding(object(parse(item.caseValuesJson)))?.caseId || '');
  const sourceCases = object(object(validRefs.dataset).definition).cases;
  const sourceIds = Array.isArray(sourceCases) ? sourceCases.map(item => String(object(item).id || '')) : [];
  const allCases = sourceIds.length > 0 && selectedIds.length === sourceIds.length && new Set(selectedIds).size === sourceIds.length && sourceIds.every(id => selectedIds.includes(id));
  const caseSelection = allCases ? { mode: 'all' } : { mode: 'subset', ids: selectedIds };
  const completed = row.status === 'done' || row.status === 'partial';
  const scores = completed ? row.cases.flatMap(item => item.results.filter(result => evaluatorIds.includes(result.evaluatorId) && result.status === 'done')
    .map(result => result.humanScore ?? result.score).filter((score): score is number => typeof score === 'number' && Number.isFinite(score))) : [];
  const expectedResults = row.cases.length * evaluatorIds.length;
  const reason = !Object.values(assets).every(item => item.recorded) ? '资产版本未记录，无法确认相同固定条件'
    : row.cases.some(item => item.groupId) ? '包含对比组，请到实验详情查看各组结果'
      : snapshot.traceSource === 'generate' && (!target.platform || !(target.workerId || target.clientId)) ? '执行目标未记录，无法确认相同固定条件'
        : snapshot.traceSource === 'existing' && row.cases.some(item => !(item.executionId || item.taskId)) ? 'Trace 执行记录未绑定，无法确认相同固定条件'
          : !completeActual ? '实际模型、平台、客户端或绑定的成功执行记录不完整，无法确认相同执行条件'
            : snapshot.traceSource === 'generate' && !uniformActual ? '各 Case 的实际模型、客户端或执行参数不一致，不归入单一配置趋势'
      : !completed ? '实验尚未完成，不计入版本趋势' : row.cases.length === 0 ? '没有 Case，不计入版本趋势' : undefined;
  const run: ExperimentAnalysisRun = {
    id: row.id, name: label(row.name), status: row.status,
    createdAt: new Date(row.createdAt).toISOString(), assets,
    score: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
    scoredResults: scores.length, expectedResults, coverage: expectedResults ? scores.length / expectedResults : 0,
    caseCount: row.cases.length, comparable: !reason, ...(reason ? { reason } : {}),
  };
  const executionSummary = [
    `平台 ${label(target.platform, '未记录')}`,
    `客户端 ${label(target.workerId ?? target.clientId, '未记录')}`,
    `模型 ${label(target.model, '未指定')}`,
    `超时 ${typeof target.timeoutSeconds === 'number' ? `${target.timeoutSeconds} 秒` : '默认/未记录'}`,
  ].join(' · ');
  const actualSummary = completeActual ? [...new Set(actualProfiles.map(profile =>
    `平台 ${label(profile!.platform)} · 客户端 ${label(profile!.workerId)} · 模型 ${label(profile!.model)}${profile!.dispatch ? ` · 超时 ${profile!.dispatch.timeoutSeconds} 秒` : ''}`))].join('；') : '未记录完整实际执行条件';
  return { run, executionHash, executionSummary, actualSummary, caseDefinitions, caseSelection, evaluatorConfigs: parse(row.evaluatorConfigsJson) };
}

export function analyzeExperimentAssetVersions(rows: AnalysisExperimentInput[]): ExperimentAssetAnalysis {
  const prepared = rows.map(prepare);
  const groups = new Map<string, ExperimentAnalysisGroup>();
  for (const item of prepared) {
    if (!item.run.comparable) continue;
    for (const variable of ANALYSIS_VARIABLES) {
      const fixedAssets = Object.fromEntries(ANALYSIS_VARIABLES.filter(key => key !== variable).map(key => [key, item.run.assets[key].key]));
      const caseCondition = variable === 'dataset' ? item.caseSelection : item.caseDefinitions;
      const evaluatorConfig = variable === 'evaluator' ? undefined : item.evaluatorConfigs;
      const id = hash({ variable, fixedAssets, execution: item.executionHash, cases: caseCondition, evaluatorConfig });
      let group = groups.get(id);
      if (!group) {
        const names = { agent: 'Agent', skill: 'Skill', evaluator: '评估器', dataset: '评测集' };
        group = { id, variable, runIds: [], versionCount: 0, conditions: [
          ...ANALYSIS_VARIABLES.filter(key => key !== variable).map(key => ({ label: names[key], value: item.run.assets[key].label })),
          { label: '执行条件', value: item.executionSummary },
          { label: '实际执行条件', value: item.actualSummary },
          { label: '执行参数指纹', value: item.executionHash.slice(0, 12) },
          { label: 'Case 范围', value: variable === 'dataset' && object(item.caseSelection).mode === 'all' ? '各版本全部 Case（允许定义变化）' : `${item.run.caseCount} 个 Case · 定义指纹 ${hash(caseCondition).slice(0, 12)}` },
          { label: '评估器运行参数', value: variable === 'evaluator' ? '随评估器变化' : hash(evaluatorConfig).slice(0, 12) },
        ], ...(variable === 'dataset' ? { warning: '评测集变化表示评测条件变化，分数变化不等于 Agent 能力提升。' } : {}) };
        groups.set(id, group);
      }
      group.runIds.push(item.run.id);
    }
  }
  const byId = new Map(prepared.map(item => [item.run.id, item.run]));
  for (const group of groups.values()) {
    group.runIds.sort((a, b) => byId.get(a)!.createdAt.localeCompare(byId.get(b)!.createdAt) || a.localeCompare(b));
    group.versionCount = new Set(group.runIds.map(id => byId.get(id)!.assets[group.variable].key)).size;
  }
  return { runs: prepared.map(item => item.run), groups: [...groups.values()] };
}
