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

import { createHash } from 'node:crypto';
import { prismaRaw } from '@/lib/storage/prisma';
import { resolveFrameworkId } from '@/lib/ingest/adapters/registry';
import { canonicalExperimentAgentName } from '@/lib/engine/experiment/agent-identity';
import { serializeEvaluatorCaseContext } from '@/lib/evaluators/evaluator-case-context';
import { withExperimentDatasetCaseBinding } from '@/lib/engine/experiment/dataset-case-binding';
import { assertVersionBackend } from './service';
import { EvaluationAssetError } from './types';
import { withEvaluationAssetTransaction } from './store';
import { applyExperimentReferenceOverrides, bindVersionedExperimentCases, experimentCaseValues, type FrozenExperimentAsset, type VersionedExperimentCase } from './experiment-versions';

export interface CaseInput {
  executionId?: string;
  taskId?: string;
  input?: string;
  datasetInput?: string | null;
  actualOutput?: string;
  referenceOutput?: string | null;
  datasetId?: string;
  datasetCaseId?: string;
  referenceOverride?: unknown;
}

export function frozenAppendDataset(snapshot: Record<string, unknown>): FrozenExperimentAsset | null {
  const refs = object(snapshot.assetVersions);
  if (refs.dataset === undefined || refs.dataset === null) return null;
  const dataset = object(refs.dataset);
  if (refs.schemaVersion !== 1 || typeof dataset.businessId !== 'string' || !dataset.businessId.trim()
    || typeof dataset.versionId !== 'string' || !dataset.versionId.trim() || !Number.isInteger(dataset.version) || Number(dataset.version) < 1
    || !dataset.definition || typeof dataset.definition !== 'object' || Array.isArray(dataset.definition)) {
    throw new EvaluationAssetError('原实验缺少完整的数据集版本定义，请复用配置创建新实验', 409);
  }
  return dataset as unknown as FrozenExperimentAsset;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function parse(value: string | null): Record<string, unknown> {
  try { return object(JSON.parse(value || '{}')); } catch { return {}; }
}
const normalizedInput = (value: unknown) => String(value ?? '').trim().replace(/\s+/g, ' ');
export type AppendExperiment = { id: string; agentName: string; configSnapshotJson: string | null; evaluatorIdsJson: string; deletedAt: Date | null; status: string };
type PreparedCase = {
  executionId: string; taskId: string; input: string; datasetInput: string; actualOutput: string;
  referenceOutput: string | null; evaluatorContextJson: string | null; caseValuesJson: string; faultInjectionType: string | null;
};

async function prepareVersionedCases(user: string, experiment: AppendExperiment, cases: CaseInput[], dataset: FrozenExperimentAsset): Promise<PreparedCase[]> {
  const source = dataset.definition.cases;
  if (!Array.isArray(source) || source.some(item => typeof object(item).id !== 'string' || !String(object(item).id).trim() || typeof object(item).input !== 'string' || !normalizedInput(object(item).input))) throw new EvaluationAssetError('实验冻结的 Case 列表不完整，请复用配置创建新实验', 409);
  const sourceCases = source.map(object);
  if (new Set(sourceCases.map(item => item.id)).size !== sourceCases.length) throw new EvaluationAssetError('实验冻结的 Case 标识重复', 409);
  const snapshot = parse(experiment.configSnapshotJson), agent = object(object(snapshot.assetVersions).agent), target = object(snapshot.executionTarget);
  let declared: unknown;
  try { declared = typeof agent.businessId === 'string' ? JSON.parse(agent.businessId) : undefined; } catch { /* Invalid declarations are rejected below when no platform can be confirmed. */ }
  const pair = Array.isArray(declared) && declared.length === 2 && declared.every(value => typeof value === 'string') ? declared as string[] : null;
  let platform = resolveFrameworkId(pair?.[0] || String(target.platform || ''));
  if (!platform) {
    const current = await prismaRaw.experimentCase.findMany({ where: { experimentId: experiment.id, deletedAt: null }, select: { executionId: true, taskId: true } });
    const facts = await prismaRaw.execution.findMany({ where: { user, isSubagent: false, OR: [
      { id: { in: current.flatMap(item => item.executionId ? [item.executionId] : []) } },
      { taskId: { in: current.flatMap(item => item.taskId ? [item.taskId] : []) } },
    ] }, select: { framework: true } });
    const platforms = [...new Set(facts.map(item => resolveFrameworkId(item.framework)).filter(Boolean))];
    if (platforms.length !== 1) throw new EvaluationAssetError('无法确认原实验的执行平台，请复用配置创建新实验', 409);
    platform = platforms[0];
  }
  const name = canonicalExperimentAgentName(platform, pair?.[1] || experiment.agentName);
  const prepared: Array<VersionedExperimentCase & { executionId: string; taskId: string; input: string; actualOutput: string; datasetCaseId: string }> = [];
  for (const raw of cases) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new EvaluationAssetError('数据项格式无效');
    if (raw.datasetId !== undefined && raw.datasetId !== dataset.businessId) throw new EvaluationAssetError('数据项不属于本实验固定的数据集版本', 422);
    const id = typeof raw.executionId === 'string' ? raw.executionId.trim() : '';
    const taskId = typeof raw.taskId === 'string' ? raw.taskId.trim() : '';
    if (!id && !taskId) throw new EvaluationAssetError('请选择真实的已完成主 Trace', 422);
    const executions = await prismaRaw.execution.findMany({ where: { user, ...(id ? { id } : { taskId, isSubagent: false }) }, take: 2,
      select: { id: true, taskId: true, query: true, finalResult: true, framework: true, agentName: true, isSubagent: true } });
    if (!executions.length) throw new EvaluationAssetError('Trace 不存在或无权访问', 404);
    if (executions.length !== 1) throw new EvaluationAssetError('Trace 主记录不唯一，无法确认本次来源', 422);
    const execution = executions[0];
    if (execution.isSubagent) throw new EvaluationAssetError('只能追加已完成的主 Trace', 422);
    if (!execution.taskId || taskId && taskId !== execution.taskId) throw new EvaluationAssetError('Trace 与会话标识不一致', 422);
    const session = await prismaRaw.session.findFirst({ where: { user, taskId: execution.taskId }, select: { endTime: true, query: true } });
    if (!session?.endTime) throw new EvaluationAssetError('Trace 尚未完成或会话不可访问，请等待采集结束', 422);
    if (resolveFrameworkId(execution.framework) !== platform || canonicalExperimentAgentName(platform, execution.agentName || '') !== name) {
      throw new EvaluationAssetError('Trace 的 Agent 或执行平台与本实验不一致', 422);
    }
    const input = execution.query ?? session.query ?? '';
    if (!normalizedInput(input)) throw new EvaluationAssetError('Trace 缺少可确认的原始输入', 422);
    const matches = sourceCases.filter(item => normalizedInput(item.input) === normalizedInput(input));
    const sourceCase = raw.datasetCaseId === undefined ? matches.length === 1 ? matches[0] : null
      : typeof raw.datasetCaseId === 'string' ? sourceCases.find(item => item.id === raw.datasetCaseId) : null;
    if (!sourceCase || normalizedInput(sourceCase.input) !== normalizedInput(input)) {
      throw new EvaluationAssetError(matches.length > 1 && raw.datasetCaseId === undefined
        ? '该输入匹配多个版本 Case，请明确选择 datasetCaseId' : 'Trace 输入与本实验固定版本的 Case 不匹配；新题请先发布数据集新版本并新建实验', 422);
    }
    prepared.push({ executionId: execution.id, taskId: execution.taskId, input, actualOutput: execution.finalResult || '', datasetId: dataset.businessId,
      datasetCaseId: String(sourceCase.id), ...(raw.referenceOverride !== undefined ? { referenceOverride: raw.referenceOverride } : {}) });
  }
  const bound = await applyExperimentReferenceOverrides(user, bindVersionedExperimentCases(prepared, dataset), dataset);
  return bound.map(item => ({ executionId: item.executionId, taskId: item.taskId, input: item.input,
    actualOutput: item.actualOutput, datasetInput: String(item.datasetInput || ''), referenceOutput: item.referenceOutput ?? null,
    evaluatorContextJson: serializeEvaluatorCaseContext(item.evaluatorContext), faultInjectionType: item.faultInjectionType || null,
    caseValuesJson: JSON.stringify(withExperimentDatasetCaseBinding(experimentCaseValues(item), { datasetId: dataset.businessId, caseId: item.datasetCaseId })),
  }));
}

export async function appendVersionedCases(user: string, experiment: AppendExperiment, cases: CaseInput[], dataset: FrozenExperimentAsset, autoRun: boolean, evaluatorIds: string[], watchEnabledAt?: Date) {
  assertVersionBackend();
  const prepared = await prepareVersionedCases(user, experiment, cases, dataset);
  const outcome = await withEvaluationAssetTransaction(async tx => {
    const current = await tx.experiment.findFirst({ where: { id: experiment.id, user }, select: { deletedAt: true, status: true, configSnapshotJson: true, watchMode: true, watchEnabledAt: true } });
    const cancelled = await tx.experimentCancellation.findFirst({ where: { experimentId: experiment.id, caseKey: '' }, select: { id: true } });
    if (!current || current.deletedAt || current.status === 'cancelled' || cancelled) throw new EvaluationAssetError('实验已删除或取消，不能追加 Case', 409);
    if (watchEnabledAt && (!current.watchMode || current.watchEnabledAt?.getTime() !== watchEnabledAt.getTime())) throw new EvaluationAssetError('实验已停止监听', 409);
    if (object(object(parse(current.configSnapshotJson).assetVersions).dataset).versionId !== dataset.versionId) throw new EvaluationAssetError('实验冻结版本已变化，请刷新后重试', 409);
    const existing = await tx.experimentCase.findMany({ where: { experimentId: experiment.id, OR: [
      { executionId: { in: prepared.map(item => item.executionId) } }, { taskId: { in: prepared.map(item => item.taskId) } },
    ] }, select: { id: true, executionId: true, taskId: true } });
    const byExecution = new Map(existing.map(item => [item.executionId, item.id])), byTask = new Map(existing.map(item => [item.taskId, item.id]));
    const caseIds: string[] = [], newCaseIds: string[] = [];
    for (const item of prepared) {
      const found = byExecution.get(item.executionId) || byTask.get(item.taskId);
      if (found) { caseIds.push(found); continue; }
      if (autoRun && !evaluatorIds.length) throw new EvaluationAssetError('该实验未配置评估器，无法评测新增 Case', 409);
      const id = `trace-${createHash('sha256').update(JSON.stringify([experiment.id, item.taskId])).digest('hex')}`;
      const added = await tx.experimentCase.create({ data: { id, experimentId: experiment.id, ...item,
        ...(autoRun ? { results: { create: evaluatorIds.map(evaluatorId => ({ experimentId: experiment.id, evaluatorId, status: 'pending' })) } } : {}),
      }, select: { id: true } });
      caseIds.push(added.id); newCaseIds.push(added.id);
      byExecution.set(item.executionId, added.id); byTask.set(item.taskId, added.id);
    }
    if (autoRun && newCaseIds.length) await tx.experiment.update({ where: { id: experiment.id }, data: { status: 'running' } });
    return { added: newCaseIds.length, reused: cases.length - newCaseIds.length, caseIds: [...new Set(caseIds)], newCaseIds, evaluating: autoRun && newCaseIds.length > 0 };
  });
  return outcome;
}
