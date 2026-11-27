import type { Experiment, SkillOptimizationRecord } from '@prisma/client';
import { prismaRaw as db } from '@/lib/storage/prisma';
import { executeSkillCaseOnClient } from '@/lib/skill-workbench/client-execution';
import type { SkillExecutionTarget } from '@/lib/skill-workbench/execution-target';
import { evaluateEvalExperimentCase } from '@/lib/engine/experiment/run-experiment';
import { findAgentDataset } from '@/server/agent_datasets_storage';
import { contentHash, parseStored, type DiagnosisSnapshot } from './contracts';
import { datasetCaseContentHash, matchesLegacyDatasetText } from '@/lib/engine/experiment/dataset-case-snapshot';

export async function retestDiagnosisCase(record: SkillOptimizationRecord, source: Experiment, files: Record<string, string>) {
  const ref = parseStored<Array<{ type: string; id: string }>>(record.sourceRefsJson, []).find(item => item.type === 'diagnosis');
  const run = ref && await db.diagnosisRun.findFirst({ where: { id: ref.id, user: record.user, experimentId: source.id, status: 'done' } });
  if (!run) throw new Error('诊断来源已失效，无法按原实验配置复测');
  const frozen = JSON.parse(run.inputSnapshotJson) as DiagnosisSnapshot;
  const config = parseStored<{ datasetId?: string; caseIds?: string[]; executionTarget?: SkillExecutionTarget & { timeoutSeconds?: number }; customEvaluatorSnapshots?: { cards?: Record<string, unknown> } }>(source.configSnapshotJson, {});
  const target = config.executionTarget;
  const evaluatorIds = parseStored<string[]>(source.evaluatorIdsJson, []);
  if (!config.datasetId || !config.caseIds?.length || !target?.workerId || !target.model || !target.timeoutSeconds || !evaluatorIds.length ||
      source.type !== 'single' || source.status !== 'done' || source.deletedAt) {
    throw new Error('来源实验缺少可复测配置或尚未完成');
  }
  if (contentHash(config) !== contentHash(frozen.experiment.config)) throw new Error('诊断后执行配置发生变化');
  if (contentHash(parseStored(source.evaluatorConfigsJson, {})) !== contentHash(frozen.experiment.evaluatorConfigs) ||
      !frozen.experiment.evaluatorIds || contentHash(evaluatorIds) !== contentHash(frozen.experiment.evaluatorIds)) throw new Error('诊断后评估器配置发生变化');
  if (evaluatorIds.some(id => id.startsWith('custom-') && !config.customEvaluatorSnapshots?.cards?.[id])) throw new Error('来源实验缺少自定义评估器快照');
  const dataset = await findAgentDataset(record.user, config.datasetId);
  if (!dataset) throw new Error('来源数据集不存在，无法复测');
  const original = await db.experimentCase.findMany({ where: { experimentId: source.id, deletedAt: null }, include: { results: true } });
  const sourceFingerprint = (experiment: Experiment, rows: typeof original) => contentHash({
    config: experiment.configSnapshotJson,
    evaluatorIds: experiment.evaluatorIdsJson,
    evaluatorConfigs: experiment.evaluatorConfigsJson,
    status: experiment.status,
    deletedAt: experiment.deletedAt?.toISOString(),
    cases: rows.map(row => ({
      id: row.id, input: row.input, referenceOutput: row.referenceOutput,
      executionId: row.executionId, datasetInput: row.datasetInput, actualOutput: row.actualOutput, caseValuesJson: row.caseValuesJson,
      results: row.results.map(r => ({ id: r.id, updatedAt: r.updatedAt.toISOString() })).sort((a, b) => a.id.localeCompare(b.id)),
    })).sort((a, b) => a.id.localeCompare(b.id)),
  });
  const baselineFingerprint = sourceFingerprint(source, original);
  const cases = config.caseIds.map(id => {
    const datasetCase = dataset?.cases.find(item => item.id === id);
    const rows = original.filter(row => parseStored<{ __agentInsightDatasetCase?: { caseId?: string } }>(row.caseValuesJson, {}).__agentInsightDatasetCase?.caseId === id);
    if (!datasetCase) throw new Error(`来源 Case 已删除：${id}`);
    if (!rows.length) throw new Error(`来源 Case 绑定缺失：${id}`);
    if (rows.length !== 1) throw new Error(`来源 Case 绑定不唯一：${id}`);
    const row = rows[0];
    if (!row.executionId) throw new Error(`原执行 Trace 缺失：${id}`);
    if (row.id === run.caseId) {
      if (row.input !== frozen.case.input) throw new Error('诊断后任务输入发生变化');
      if ((row.referenceOutput || '') !== (frozen.case.referenceOutput || '')) throw new Error('诊断后预期答案发生变化');
      if (row.executionId !== frozen.execution.id || row.actualOutput !== frozen.case.actualOutput) throw new Error('诊断后执行记录发生变化');
    }
    const binding = parseStored<{ __agentInsightDatasetCase?: { datasetId?: string; contentHash?: string } }>(row.caseValuesJson, {}).__agentInsightDatasetCase;
    if (binding?.datasetId && binding.datasetId !== config.datasetId) throw new Error(`来源数据集绑定不一致：${id}`);
    const matches = binding?.contentHash ? (a: string, b: string) => a === b : matchesLegacyDatasetText;
    if (!matches(row.datasetInput || row.input, datasetCase.input)) throw new Error(`任务输入发生变化：${id}`);
    if (!matches(row.referenceOutput || '', datasetCase.expectedOutput || '')) throw new Error(`预期答案内容发生变化：${id}`);
    if (binding?.contentHash && binding.contentHash !== datasetCaseContentHash(datasetCase)) throw new Error(`数据集 Case 内容或评估上下文发生变化：${id}`);
    const baseline = evaluatorIds.map(id => {
      const r = row.results.find(item => item.evaluatorId === id);
      if (!r || r.status !== 'done' || r.score === null || r.humanScore !== null) throw new Error('缺少同口径机器评分，或基线包含人工改分，需要人工复核');
      if (row.id === run.caseId && frozen.results.some(f => f.id === r.id && f.updatedAt !== r.updatedAt.toISOString())) throw new Error('诊断后来源评测已变化');
      return r.score;
    });
    return { datasetCase, row, baseline };
  });
  if (!cases.some(item => item.row.id === run.caseId)) throw new Error('来源 Case 未纳入复测');
  const experiment = await db.$transaction(async tx => {
    const claim = await tx.skillOptimizationRecord.updateMany({ where: { id: record.id, status: record.status, candidateContentHash: record.candidateContentHash }, data: { status: 'retesting' } });
    if (!claim.count) throw new Error('复测状态已变化');
    const experiment = await tx.experiment.create({ data: { user: record.user, name: source.name + ' · 诊断候选复测', type: source.type, agentName: source.agentName, evaluatorIdsJson: source.evaluatorIdsJson, evaluatorConfigsJson: source.evaluatorConfigsJson, status: 'running', sourceExperimentId: source.id, optimizationRecordId: record.id, skillName: record.skillName, skillVersion: record.baseVersion, preset: 'retest', configSnapshotJson: JSON.stringify({ ...config, candidateHash: record.candidateContentHash }) } });
    await tx.skillOptimizationRecord.update({ where: { id: record.id }, data: { retestExperimentId: experiment.id } });
    return experiment;
  });
  let baseSum = 0, candidateSum = 0, measured = 0, passed = true;
  try {
    for (const { datasetCase, row, baseline } of cases) {
      const result = await executeSkillCaseOnClient({ user: record.user, experimentId: experiment.id, datasetId: config.datasetId, datasetCaseId: datasetCase.id, executionTarget: target, skill: { name: record.skillName, version: record.baseVersion + 1, files }, query: row.input, referenceOutput: row.referenceOutput, timeoutMs: target.timeoutSeconds * 1000, signal: new AbortController().signal, onCaseCreated: async () => {} });
      const scores = await evaluateEvalExperimentCase(experiment.id, result.experimentCaseId, record.user, { settleExperiment: false });
      for (const [index, id] of evaluatorIds.entries()) {
        const metric = scores.find(r => r.evaluatorId === id);
        if (metric?.status !== 'done' || metric.score == null) throw new Error('候选评分不完整');
        passed &&= metric.score >= baseline[index] && metric.verdict !== 'fail';
        baseSum += baseline[index]; candidateSum += metric.score; measured++;
      }
    }
    const outcome = { type: 'retest-result', experimentId: experiment.id, sourceScore: baseSum / measured, candidateScore: candidateSum / measured, passed };
    const previousRefs = parseStored<Array<{ type?: string }>>(record.sourceRefsJson, []).filter(ref => ref.type !== 'retest-result');
    const latestDataset = await findAgentDataset(record.user, config.datasetId);
    if (cases.some(({ datasetCase }) => {
      const latest = latestDataset?.cases.find(item => item.id === datasetCase.id);
      return !latest || datasetCaseContentHash(latest) !== datasetCaseContentHash(datasetCase);
    })) throw new Error('复测期间来源数据集发生变化，请重新核验');
    await db.$transaction(async tx => {
      const currentSource = await tx.experiment.findUnique({ where: { id: source.id } });
      const currentCases = await tx.experimentCase.findMany({ where: { experimentId: source.id, deletedAt: null }, include: { results: true } });
      if (!currentSource || sourceFingerprint(currentSource, currentCases) !== baselineFingerprint) throw new Error('复测期间来源证据发生变化，请重新核验');
      await tx.experiment.update({ where: { id: experiment.id }, data: { status: 'done' } });
      const completed = await tx.skillOptimizationRecord.updateMany({ where: { id: record.id, status: 'retesting', retestExperimentId: experiment.id, candidateContentHash: record.candidateContentHash }, data: { sourceRefsJson: JSON.stringify([...previousRefs, outcome]), status: passed ? 'retest_passed' : 'retest_failed', errorMessage: passed ? null : '存在回归或失败评测项' } });
      if (!completed.count) throw new Error('候选或复测状态已变化，不能采用本轮结果');
    });
    return { experimentId: experiment.id, sourceScore: baseSum / measured, candidateScore: candidateSum / measured, passed, reused: false };
  } catch (error) {
    await db.$transaction([
      db.experiment.updateMany({ where: { id: experiment.id, status: 'running' }, data: { status: 'failed' } }),
      db.skillOptimizationRecord.updateMany({ where: { id: record.id, retestExperimentId: experiment.id, status: 'retesting' }, data: { status: 'retest_failed', errorMessage: error instanceof Error ? error.message : '复测失败' } }),
    ]);
    throw error;
  }
}
