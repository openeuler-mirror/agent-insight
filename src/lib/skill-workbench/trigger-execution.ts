import type { DatasetCase } from '@/server/agent_datasets_storage';
import { readExperimentDatasetCaseBinding, withExperimentDatasetCaseBinding } from '@/lib/engine/experiment/dataset-case-binding';
import { prismaRaw } from '@/lib/storage/prisma';

export function triggerExperimentCaseData(experimentId: string, datasetId: string, cases: Pick<DatasetCase, 'id' | 'input' | 'values'>[]) {
  return cases.map((item) => ({
    experimentId,
    input: item.input,
    datasetInput: item.input || null,
    actualOutput: '',
    referenceOutput: item.values?.should_trigger === true ? 'Skill 应触发' : 'Skill 不应触发',
    caseValuesJson: JSON.stringify(withExperimentDatasetCaseBinding({
      ...(item.values || {}), should_trigger: item.values?.should_trigger === true,
    }, { datasetId, caseId: item.id })),
  }));
}

export function shouldStopTriggerBatch(failureCode: string | null | undefined): boolean {
  return ['MODEL_UNAVAILABLE', 'MODEL_MISMATCH', 'CLIENT_MISMATCH'].includes(failureCode || '');
}

export async function ensureTriggerExperimentCases(user: string, experimentId: string, datasetId: string, cases: Pick<DatasetCase, 'id' | 'input' | 'values'>[]) {
  return prismaRaw.$transaction(async (tx) => {
    const experiment = await tx.experiment.findFirst({ where: { id: experimentId, user, deletedAt: null, status: { not: 'cancelled' } } });
    const cancellations = await tx.experimentCancellation.findMany({ where: { experimentId }, select: { caseKey: true } });
    if (!experiment || cancellations.some((item) => item.caseKey === '')) {
      throw Object.assign(new Error('实验已取消'), { code: 'EXPERIMENT_CANCELLED' });
    }
    const rows = await tx.experimentCase.findMany({ where: { experimentId }, select: { id: true, caseValuesJson: true, deletedAt: true } });
    const bindings = new Map<string, string>();
    const excluded = new Set(cancellations.map((item) => item.caseKey));
    for (const row of rows) {
      const binding = readExperimentDatasetCaseBinding(JSON.parse(row.caseValuesJson || '{}'));
      if (binding?.datasetId !== datasetId) continue;
      if (row.deletedAt || excluded.has(row.id)) excluded.add(`dataset:${binding.caseId}`);
      else bindings.set(binding.caseId, row.id);
    }
    const active = cases.filter((item) => !excluded.has(`dataset:${item.id}`));
    const missing = active.filter((item) => !bindings.has(item.id));
    for (const data of triggerExperimentCaseData(experimentId, datasetId, missing)) {
      const row = await tx.experimentCase.create({ data, select: { id: true } });
      const binding = readExperimentDatasetCaseBinding(JSON.parse(data.caseValuesJson))!;
      bindings.set(binding.caseId, row.id);
    }
    return new Map(active.map((item) => [item.id, bindings.get(item.id)!]));
  });
}

export interface TriggerExecutionObservation {
  invokedSkills?: string | null;
  skills?: string | null;
}

function namesFromJson(value: string | null | undefined): string[] | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    return parsed.flatMap((item) => {
      const name = typeof item === 'string' ? item : item && typeof item === 'object' ? (item as { name?: unknown }).name : null;
      return typeof name === 'string' && name.trim() ? [name.trim()] : [];
    });
  } catch { return null; }
}

export function classifyTriggerExecution(execution: TriggerExecutionObservation, targetSkillName: string) {
  const invoked = namesFromJson(execution.invokedSkills) ?? namesFromJson(execution.skills);
  if (!invoked) throw new Error('Trace 未记录 Skill 调用信息，无法判断是否触发');
  return {
    triggered: invoked.includes(targetSkillName),
    competingSkill: invoked.find((name) => name !== targetSkillName) || null,
  };
}
