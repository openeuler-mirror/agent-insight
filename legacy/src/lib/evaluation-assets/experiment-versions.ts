/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { resolveUser } from '@/lib/auth/auth';
import { normalizeConversationTurns, projectConversationCase } from '@/lib/evaluation-conversation';
import type { EvaluatorCard } from '@/lib/evaluators/custom-evaluator-model';
import { getEvaluatorExecutionCapabilities } from '@/lib/evaluators/evaluator-execution-config.server';
import { resolveEvaluatorExecutionConfig, serializeExperimentEvaluatorConfigs } from '@/lib/evaluators/evaluator-execution-config';
import { EvaluatorRunConfigValidationError } from '@/lib/evaluators/evaluator-run-config';
import { contextFromAvailableCatalogFields } from '@/lib/evaluators/evaluator-case-context';
import { presetEvaluators } from '@/lib/evaluators/preset-evaluators';
import { prismaRaw } from '@/lib/storage/prisma';
import { findAgentDataset } from '@/server/agent_datasets_storage';
import { DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS } from '@/lib/engine/experiment/constants';
import { canonicalAssetJson } from './canonical';
import { agentAssetBusinessId } from './identity';
import { assertVersionBackend, assetVersionView } from './service';
import { EvaluationAssetError, type AssetKind, type AssetVersion } from './types';

export interface ExperimentAssetVersionRefs {
  agent?: string;
  dataset?: string;
  evaluators?: Record<string, string>;
}

export interface FrozenExperimentAsset {
  businessId: string;
  versionId: string;
  version: number;
  contentHash: string;
  definition: Record<string, unknown>;
}

export interface ExperimentAssetVersions {
  schemaVersion: 1;
  agent?: FrozenExperimentAsset;
  dataset?: FrozenExperimentAsset;
  evaluators?: Record<string, FrozenExperimentAsset>;
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function parseExperimentAssetVersionRefs(value: unknown): ExperimentAssetVersionRefs | undefined {
  if (value === undefined) return undefined;
  if (!object(value) || Object.keys(value).some(key => !['agent', 'dataset', 'evaluators'].includes(key))) {
    throw new EvaluationAssetError('assetVersions 必须是有效的版本引用');
  }
  const id = (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new EvaluationAssetError('版本 ID 无效');
    return value.trim();
  };
  const result: ExperimentAssetVersionRefs = {};
  if (Object.hasOwn(value, 'agent')) result.agent = id(value.agent);
  if (Object.hasOwn(value, 'dataset')) result.dataset = id(value.dataset);
  if (Object.hasOwn(value, 'evaluators')) {
    if (!object(value.evaluators)) throw new EvaluationAssetError('评估器版本引用无效');
    result.evaluators = Object.fromEntries(Object.entries(value.evaluators).map(([key, value]) => [key, id(value)]));
  }
  return result;
}

export async function requireExperimentVersionActor(request: Request, user: string): Promise<void> {
  const actor = await resolveUser(request);
  if (!actor.username) throw new EvaluationAssetError('请选择有效登录账号后使用资产版本', 401, 'ASSET_UNAUTHENTICATED');
  if (actor.username !== user) throw new EvaluationAssetError('资产版本只能由当前登录用户使用', 403, 'ASSET_FORBIDDEN');
}

function frozen(businessId: string, version: AssetVersion): FrozenExperimentAsset {
  return { businessId, versionId: version.id, version: version.version, contentHash: version.contentHash, definition: version.content };
}

export async function resolveExperimentAssetVersions(input: {
  request: Request;
  user: string;
  refs?: ExperimentAssetVersionRefs;
  datasetId: string;
  evaluatorIds: string[];
  executionTarget?: unknown;
  agentName: string;
}): Promise<{ assetVersions?: ExperimentAssetVersions; evaluatorRefs: Record<string, string> }> {
  if (input.refs) {
    await requireExperimentVersionActor(input.request, input.user);
    assertVersionBackend();
  } else {
    if (process.env.DB_HOST || (await resolveUser(input.request)).username !== input.user) return { evaluatorRefs: {} };
    try { assertVersionBackend(); } catch { return { evaluatorRefs: {} }; }
  }
  const refs = input.refs || {};
  if (Object.keys(refs.evaluators || {}).some(id => !input.evaluatorIds.includes(id))) {
    throw new EvaluationAssetError('评估器版本引用与所选评估器不一致');
  }
  const snapshot: ExperimentAssetVersions = { schemaVersion: 1 };
  const evaluatorRefs: Record<string, string> = Object.create(null);
  const read = async (kind: AssetKind, businessId: string, versionId?: string) => {
    try {
      const view = await assetVersionView(input.user, kind, businessId, versionId);
      if (!view.selectedVersion) throw new EvaluationAssetError('资产没有已发布版本', 404);
      if (!versionId && view.head?.archived) return undefined;
      if (kind === 'dataset' && view.selectedVersion.content.id !== businessId) throw new EvaluationAssetError('数据集版本内容与标识不一致', 409);
      return frozen(businessId, view.selectedVersion);
    } catch (error) {
      // Older callers can select legacy catalog entries without a version record.
      if (!versionId && error instanceof EvaluationAssetError && error.status === 404) return undefined;
      throw error;
    }
  };
  const target = object(input.executionTarget) ? input.executionTarget : {};
  const platform = typeof target.platform === 'string' ? target.platform.trim() : '';
  const agent = typeof target.agent === 'string' ? target.agent.trim() : input.agentName;
  if (refs.agent && (!platform || !agent)) throw new EvaluationAssetError('选择 Agent 版本前请确认执行平台和 Agent');
  if (platform && agent) snapshot.agent = await read('agent', agentAssetBusinessId(platform, agent), refs.agent);
  if (refs.dataset && !input.datasetId) throw new EvaluationAssetError('数据集版本必须关联所选数据集');
  if (input.datasetId) snapshot.dataset = await read('dataset', input.datasetId, refs.dataset);
  for (const id of input.evaluatorIds) {
    const version = await read('evaluator', id, refs.evaluators?.[id]);
    if (!version) continue;
    if (version.definition.id !== id) throw new EvaluationAssetError('评估器版本内容与标识不一致', 409);
    (snapshot.evaluators ||= {})[id] = version;
    if (id.startsWith('custom-')) evaluatorRefs[id] = version.versionId;
  }
  return { assetVersions: Object.keys(snapshot).length > 1 ? snapshot : undefined, evaluatorRefs };
}

export interface VersionedExperimentCase {
  executionId?: string;
  taskId?: string;
  input?: string;
  datasetInput?: string | null;
  referenceOutput?: string | null;
  evaluatorContext?: unknown;
  faultInjectionType?: string | null;
  values?: Record<string, unknown>;
  turns?: unknown;
  datasetId?: string;
  datasetCaseId?: string;
  referenceOverride?: unknown;
}

export function withoutExperimentReferenceOverride(values: Record<string, unknown> | undefined): Record<string, unknown> {
  const next = { ...(object(values) ? values : {}) };
  delete next.__agentInsightReferenceOverride;
  return next;
}

export function bindVersionedExperimentCases<T extends VersionedExperimentCase>(cases: T[], dataset: FrozenExperimentAsset): T[] {
  const sourceCases = dataset.definition.cases;
  if (!Array.isArray(sourceCases)) throw new EvaluationAssetError('数据集版本缺少 Case 列表', 409);
  const byId = new Map(sourceCases.filter(object).map(item => [item.id, item]));
  return cases.map(item => {
    if (item.datasetId && item.datasetId !== dataset.businessId) throw new EvaluationAssetError('数据项与所选数据集版本不一致', 422);
    const source = byId.get(item.datasetCaseId);
    if (!source) throw new EvaluationAssetError('请选择所选数据集版本中的有效数据项', 422);
    const projected = projectConversationCase({ input: String(source.input ?? ''), expectedOutput: String(source.expectedOutput ?? ''), ...(source.turns !== undefined ? { turns: source.turns } : {}) });
    const sourceValues = object(source.values) ? source.values : {};
    let evaluatorContext;
    try { evaluatorContext = contextFromAvailableCatalogFields(sourceValues.available_tools, sourceValues.available_skills); }
    catch { throw new EvaluationAssetError('所选版本的 Tool/Skill 目录无效', 422); }
    const faultInjectionType = typeof sourceValues.fault_injection_type === 'string' ? sourceValues.fault_injection_type.trim() || null : null;
    return { ...item, input: item.executionId || item.taskId ? item.input : projected.input, datasetInput: projected.input, referenceOutput: projected.expectedOutput,
      evaluatorContext, faultInjectionType, values: withoutExperimentReferenceOverride(sourceValues), turns: projected.turns,
      datasetId: dataset.businessId };
  });
}

export async function applyExperimentReferenceOverrides<T extends VersionedExperimentCase>(user: string, cases: T[], dataset: FrozenExperimentAsset): Promise<T[]> {
  const resolved: T[] = [];
  for (const item of cases) {
    if (item.referenceOverride === undefined) { resolved.push(item); continue; }
    const raw = item.referenceOverride;
    if (!object(raw) || Object.keys(raw).some(key => !['value', 'source', 'sourceDatasetId', 'sourceCaseId'].includes(key))
      || raw.value !== null && (typeof raw.value !== 'string' || raw.value.length > 20000)
      || !['manual', 'dataset-import'].includes(String(raw.source))) throw new EvaluationAssetError('本次实验答案覆盖配置无效');
    const value = raw.value as string | null;
    const source = String(raw.source);
    const provenance: Record<string, string> = {};
    if (source === 'manual') {
      if (raw.sourceDatasetId !== undefined || raw.sourceCaseId !== undefined) throw new EvaluationAssetError('手工答案不能冒用导入来源');
    } else {
      if (typeof raw.sourceDatasetId !== 'string' || !raw.sourceDatasetId.trim()) throw new EvaluationAssetError('导入答案缺少来源数据集');
      const sourceDataset = await findAgentDataset(user, raw.sourceDatasetId);
      if (!sourceDataset) throw new EvaluationAssetError('导入来源不存在或无权访问', 404);
      if (sourceDataset.generationSource === 'trace' && sourceDataset.generationStatus !== 'published') throw new EvaluationAssetError('导入来源尚未发布', 409);
      provenance.sourceDatasetId = sourceDataset.id;
      if (raw.sourceCaseId !== undefined) {
        if (typeof raw.sourceCaseId !== 'string' || !raw.sourceCaseId.trim()) throw new EvaluationAssetError('导入来源 Case 标识无效');
        const sourceCase = sourceDataset.cases.find(item => item.id === raw.sourceCaseId);
        if (!sourceCase) throw new EvaluationAssetError('导入来源 Case 不存在', 404);
        if ((value ?? '') !== sourceCase.expectedOutput) throw new EvaluationAssetError('导入答案与来源 Case 不一致，请重新导入或改为手工修改');
        provenance.sourceCaseId = sourceCase.id;
      }
    }
    const baseline = String(item.referenceOutput ?? '');
    if ((value ?? '') === baseline) { resolved.push(item); continue; }
    resolved.push({ ...item, referenceOutput: value, values: { ...item.values, __agentInsightReferenceOverride: {
      schemaVersion: 1, datasetId: dataset.businessId, caseId: item.datasetCaseId,
      baselineVersionId: dataset.versionId, baselineVersion: dataset.version,
      baseExpectedOutput: baseline, newExpectedOutput: value, source, ...provenance,
    } } });
  }
  return resolved;
}

export function experimentCaseValues(item: { input?: string; referenceOutput?: string | null; values?: Record<string, unknown>; turns?: unknown }): Record<string, unknown> {
  const values = { ...(object(item.values) ? item.values : {}) };
  const turns = item.turns === undefined ? values.turns : item.turns;
  if (turns !== undefined) {
    try { values.turns = normalizeConversationTurns({ input: item.input || '', expectedOutput: item.referenceOutput || '', turns }); }
    catch (error) { throw new EvaluationAssetError(error instanceof Error ? error.message : '逐轮配置无效', 422); }
  }
  return values;
}

export function confirmsCurrentDatasetVersion(cases: VersionedExperimentCase[], dataset: FrozenExperimentAsset): boolean {
  if (!cases.length) return false;
  try {
    const bound = bindVersionedExperimentCases(cases, dataset);
    return cases.every((item, index) => {
      const source = bound[index];
      return (item.datasetInput || item.input || '') === source.datasetInput
        && String(item.referenceOutput ?? '') === source.referenceOutput
        && canonicalAssetJson(experimentCaseValues(item)) === canonicalAssetJson(experimentCaseValues(source));
    });
  } catch { return false; }
}

export function prepareFrozenEvaluatorConfigs(ids: string[], cards: Record<string, EvaluatorCard>, textConfigs: unknown, executionConfig: unknown): string {
  if (executionConfig === undefined) return serializeExperimentEvaluatorConfigs(textConfigs, ids);
  const custom = Object.values(cards);
  const known = new Set([...presetEvaluators, ...custom].map(card => card.id));
  for (const id of ids) if (!known.has(id)) throw new EvaluatorRunConfigValidationError(`未找到冻结的评估器 ${id}`);
  return serializeExperimentEvaluatorConfigs(textConfigs, ids,
    resolveEvaluatorExecutionConfig(executionConfig, ids, getEvaluatorExecutionCapabilities(custom)));
}

export async function assertExperimentCaseTraceOwnership(user: string, cases: Array<{ executionId?: string; taskId?: string }>): Promise<void> {
  const executionIds = [...new Set(cases.map(item => item.executionId).filter((id): id is string => Boolean(id)))];
  const taskIds = [...new Set(cases.map(item => item.taskId).filter((id): id is string => Boolean(id)))];
  const [executions, sessions] = await Promise.all([
    prismaRaw.execution.findMany({ where: { user, OR: [{ id: { in: executionIds } }, { taskId: { in: taskIds } }] }, select: { id: true, taskId: true } }),
    prismaRaw.session.findMany({ where: { user, taskId: { in: taskIds } }, select: { taskId: true } }),
  ]);
  const byId = new Map(executions.map(item => [item.id, item]));
  const ownedTasks = new Set([...sessions.map(item => item.taskId), ...executions.flatMap(item => item.taskId ? [item.taskId] : [])]);
  for (const item of cases) {
    if (item.executionId) {
      const execution = byId.get(item.executionId);
      if (!execution) throw new EvaluationAssetError('Trace 不存在或无权访问', 404);
      if (item.taskId && item.taskId !== (execution.taskId || execution.id)) throw new EvaluationAssetError('Trace 与会话标识不一致', 422);
    } else if (item.taskId && !ownedTasks.has(item.taskId)) throw new EvaluationAssetError('会话不存在或无权访问', 404);
  }
}

export function assertFrozenAgentTarget(snapshot: Record<string, unknown>, platform: string, agent: string): void {
  const versions = object(snapshot.assetVersions) ? snapshot.assetVersions : null;
  if (!versions?.agent) return;
  if (!object(versions.agent) || versions.agent.businessId !== agentAssetBusinessId(platform, agent)) {
    throw new EvaluationAssetError('执行 Agent 与冻结版本不一致，请通过复用配置重新选择 Agent 版本');
  }
}

export function assertFrozenFiDispatch(snapshot: Record<string, unknown>, target: Record<string, unknown>): void {
  if (!snapshot.assetVersions) return;
  const saved = object(snapshot.executionTarget) ? snapshot.executionTarget : {};
  const conditions = (value: Record<string, unknown>) => ({
    workerId: String(value.workerId || ''),
    agent: agentAssetBusinessId(String(value.platform || 'opencode'), String(value.agent || 'default')),
    model: value.model == null ? null : String(value.model),
    workspace: value.workspace == null ? null : String(value.workspace),
    timeoutSeconds: Number(value.timeoutSeconds) || DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS,
    agentOptions: value.agentOptions ?? null,
  });
  if (canonicalAssetJson(conditions(saved)) !== canonicalAssetJson(conditions({ ...target, agentOptions: target.agentOptions ?? saved.agentOptions }))) {
    throw new EvaluationAssetError('运行参数与冻结配置不一致，请通过复用配置创建新实验');
  }
}
