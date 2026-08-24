import { randomUUID } from 'crypto';

import { DEFAULT_SELECTED_PRESET_IDS } from '@/lib/evaluators/preset-evaluators';
import { draftTriggerEvalSet } from '@/lib/engine/skill-generation/evaluator/runners/draftTriggerEvalSet';
import { prismaRaw } from '@/lib/storage/prisma';
import { getActiveConfig } from '@/lib/storage/server-config';
import {
  createAgentDatasetRecord,
  defaultDatasetFields,
  findAgentDataset,
  readAgentDatasetReferences,
  type AgentDatasetRecord,
} from '@/server/agent_datasets_storage';
import { createOrReuseSkillWorkbenchTask } from './task-service';
import {
  formatWorkbenchTriggerDatasetTimestamp,
  SKILL_TRIGGER_ANALYZER_EVALUATOR_ID,
} from './trigger-evaluator';
import {
  getSkillExperimentConcurrencyPolicy,
  isSkillExperimentDatasetEligible,
  isSkillExperimentEvaluatorEligible,
} from './experiment-policy';

export const WORKBENCH_EXPERIMENT_PRESETS = ['trigger', 'use-case', 'skill-ab'] as const;
export type WorkbenchExperimentPreset = (typeof WORKBENCH_EXPERIMENT_PRESETS)[number];

function parseJson<T>(value: string | null, fallback: T): T {
  try { return JSON.parse(value || '') as T; } catch { return fallback; }
}

async function resolveSkill(user: string, skillName: string) {
  return prismaRaw.skill.findFirst({
    where: { name: skillName, OR: [{ user }, { user: null }, { visibility: 'public' }] },
    include: { versions: { orderBy: { version: 'desc' } } },
  });
}

export async function listWorkbenchExperiments(user: string, skillName: string, skillVersion: number) {
  const skill = await resolveSkill(user, skillName);
  if (!skill || !skill.versions.some((version) => version.version === skillVersion)) return null;
  const [datasets, experiments] = await Promise.all([
    readAgentDatasetReferences(user),
    prismaRaw.experiment.findMany({
      where: {
        user,
        skillName,
        skillVersion,
        scope: 'skill-workbench',
        preset: { in: [...WORKBENCH_EXPERIMENT_PRESETS, 'retest'] },
      },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { cases: true } } },
    }),
  ]);
  const taskIds = experiments.map((experiment) => {
    const snapshot = parseJson<{ grayscaleTaskId?: string }>(experiment.configSnapshotJson, {});
    return snapshot.grayscaleTaskId || '';
  }).filter(Boolean);
  const tasks = taskIds.length ? await prismaRaw.grayscaleTask.findMany({ where: { id: { in: taskIds }, user } }) : [];
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  return {
    versions: skill.versions.map((version) => ({ id: version.id, version: version.version })),
    datasets,
    evaluators: [...DEFAULT_SELECTED_PRESET_IDS],
    experiments: experiments.map((experiment) => {
      const snapshot = parseJson<Record<string, unknown> & { grayscaleTaskId?: string }>(experiment.configSnapshotJson, {});
      const task = snapshot.grayscaleTaskId ? taskMap.get(snapshot.grayscaleTaskId) : null;
      return {
        ...experiment,
        status: experiment.status === 'draft' ? 'running' : experiment.status,
        caseCount: experiment._count.cases,
        _count: undefined,
        skillContext: parseJson(experiment.skillContextJson, {}),
        configSnapshot: snapshot,
        grayscaleTask: task ? {
          id: task.id,
          caseStates: parseJson(task.caseStatesJson, {}),
          config: parseJson(task.configJson, {}),
        } : null,
      };
    }),
  };
}

export async function createWorkbenchExperiment(input: {
  user: string;
  sessionId?: string;
  skillName: string;
  version: number;
  preset: WorkbenchExperimentPreset;
  datasetId: string;
  compareVersion?: number;
  versionAEnabled?: boolean;
  optimizationRecordId?: string;
  name?: string;
  agentName?: string;
  evaluatorIds?: string[];
  caseIds?: string[];
  traceSource?: 'existing' | 'generate';
  modelConfigId?: string | null;
}) {
  if (input.sessionId) {
    const session = await prismaRaw.skillWorkbenchSession.findFirst({
      where: {
        id: input.sessionId,
        user: input.user,
        skillName: input.skillName,
        workVersion: input.version,
        source: 'management',
      },
      select: { id: true },
    });
    if (!session) return { kind: 'invalid_context' as const };
  }
  const skill = await resolveSkill(input.user, input.skillName);
  const currentVersion = skill?.versions.find((version) => version.version === input.version);
  if (!skill || !currentVersion) return { kind: 'not_found' as const };
  const versionA = input.preset === 'skill-ab' && input.versionAEnabled !== false ? currentVersion : null;
  const versionB = input.preset === 'skill-ab'
    ? skill.versions.find((version) => version.version === input.compareVersion)
    : currentVersion;
  if (input.preset === 'skill-ab' && (!versionB || versionB.version === versionA?.version)) {
    return { kind: 'invalid_compare' as const };
  }
  const dataset = await findAgentDataset(input.user, input.datasetId);
  if (
    !dataset
    || dataset.cases.length === 0
    || !isSkillExperimentDatasetEligible(input.preset, dataset, input.skillName)
  ) {
    return { kind: 'invalid_dataset' as const };
  }
  if (input.preset === 'trigger') {
    const labels = dataset.cases.map((item) => item.values?.should_trigger);
    if (!labels.every((value) => typeof value === 'boolean') || !labels.includes(true) || !labels.includes(false)) {
      return { kind: 'invalid_trigger_dataset' as const };
    }
  }

  const selectedCases = input.caseIds?.length
    ? input.caseIds.map((id) => dataset.cases.find((item) => item.id === id)).filter((item): item is NonNullable<typeof item> => Boolean(item))
    : dataset.cases;
  if (selectedCases.length === 0 || (input.caseIds?.length && selectedCases.length !== input.caseIds.length)) {
    return { kind: 'invalid_cases' as const };
  }
  const evaluatorIds = input.preset === 'trigger'
    ? [SKILL_TRIGGER_ANALYZER_EVALUATOR_ID]
    : Array.from(new Set((input.evaluatorIds || []).map((id) => id.trim()).filter(Boolean)));
  if (evaluatorIds.length === 0) evaluatorIds.push(...DEFAULT_SELECTED_PRESET_IDS);
  if (evaluatorIds.some((id) => !isSkillExperimentEvaluatorEligible(input.preset, id))) {
    return { kind: 'invalid_evaluators' as const };
  }
  const activeModel = input.modelConfigId
    ? await getActiveConfig(input.user).then((config) => config?.id === input.modelConfigId ? config : null)
    : await getActiveConfig(input.user);
  const concurrencyPolicy = getSkillExperimentConcurrencyPolicy(input.preset);
  const isTriggerExperiment = input.preset === 'trigger';
  const runtime = {
    agentName: 'grayscale-skill-agent',
    modelConfigId: activeModel?.id || null,
    model: activeModel ? {
      name: activeModel.name,
      provider: activeModel.provider || null,
      model: activeModel.model || null,
      baseUrl: activeModel.baseUrl || null,
    } : null,
    modelOptions: { temperature: 0.7, maxTokens: 2048 },
    interactionPolicy: 'auto-deny' as const,
    timeoutMs: isTriggerExperiment ? 30 * 1000 : 3 * 60 * 1000,
    idleTimeoutMs: 45 * 1000,
    executionConcurrency: concurrencyPolicy.executionConcurrency,
    abPairConcurrency: concurrencyPolicy.abPairConcurrency,
    evaluationConcurrency: concurrencyPolicy.evaluationConcurrency,
    triggerConcurrency: concurrencyPolicy.triggerConcurrency,
    agentMaxConcurrency: concurrencyPolicy.executionConcurrency,
    retryLimit: isTriggerExperiment ? 1 : 2,
  };
  const created = await prismaRaw.$transaction(async (tx) => {
    const experiment = await tx.experiment.create({
      data: {
        user: input.user,
        name: input.name?.trim().slice(0, 120) || `${input.skillName} · ${input.preset} · ${new Date().toLocaleDateString('zh-CN')}`,
        type: input.preset === 'skill-ab' ? 'skill' : 'single',
        agentName: input.agentName?.trim() || input.skillName,
        evaluatorIdsJson: JSON.stringify(evaluatorIds),
        status: 'draft',
        scope: 'skill-workbench',
        skillName: input.skillName,
        skillVersion: input.version,
        preset: input.preset,
        skillContextJson: JSON.stringify({
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          skillName: input.skillName,
          versionA: versionA?.version ?? null,
          versionB: versionB?.version ?? null,
        }),
      },
    });
    const task = await tx.grayscaleTask.create({
      data: {
        user: input.user,
        skillId: skill.id,
        skillName: input.skillName,
        skillVersion: currentVersion.version,
        skillVersionId: currentVersion.id,
        taskName: `${experiment.name} · ${experiment.id.slice(-6)}`,
        configJson: JSON.stringify({
          skillId: skill.id,
          versionAId: versionA?.id || '__NONE__',
          versionBId: versionB!.id,
          boundSide: input.preset === 'skill-ab' ? 'a' : 'b',
          linkedDatasetIds: [dataset.id],
          evaluators: evaluatorIds,
          runCount: selectedCases.length,
          repeatRounds: 1,
          autoEval: true,
          recordTriggerDetails: input.preset === 'trigger',
          triggerRouting: input.preset === 'trigger',
          evalExperimentId: experiment.id,
          evaluationBatchTitle: experiment.name,
          modelConfigId: runtime.modelConfigId,
          modelOptions: runtime.modelOptions,
          interactionPolicy: runtime.interactionPolicy,
          timeoutMs: runtime.timeoutMs,
          idleTimeoutMs: runtime.idleTimeoutMs,
          executionConcurrency: runtime.executionConcurrency,
          abPairConcurrency: runtime.abPairConcurrency,
          evaluationConcurrency: runtime.evaluationConcurrency,
          triggerConcurrency: runtime.triggerConcurrency,
          agentMaxConcurrency: runtime.agentMaxConcurrency,
          ...(input.preset === 'skill-ab' ? {} : { executionSides: ['b'] }),
        }),
      },
    });
    const configSnapshot = {
      schemaVersion: 1,
      preset: input.preset,
      datasetId: dataset.id,
      caseIds: selectedCases.map((item) => item.id),
      evaluatorIds,
      versionAId: versionA?.id || '__NONE__',
      versionBId: versionB!.id,
      boundSide: input.preset === 'skill-ab' ? 'a' : 'b',
      baselineSide: versionA ? 'a' : 'b',
      executionSides: input.preset === 'skill-ab' ? ['a', 'b'] : ['b'],
      traceSource: input.traceSource || 'generate',
      agentName: input.agentName?.trim() || input.skillName,
      repeatRounds: 1,
      runtime,
      grayscaleTaskId: task.id,
    };
    const updated = await tx.experiment.update({
      where: { id: experiment.id }, data: { configSnapshotJson: JSON.stringify(configSnapshot) },
    });
    if (input.optimizationRecordId && input.sessionId) {
      const record = await tx.skillOptimizationRecord.findFirst({
        where: {
          id: input.optimizationRecordId,
          sessionId: input.sessionId,
          user: input.user,
          skillName: input.skillName,
          baseVersion: input.version,
          status: { in: ['pending_retest', 'retest_failed', 'retest_cancelled'] },
        },
      });
      if (record) {
        const sourceRefs = parseJson<unknown[]>(record.sourceRefsJson, []);
        await tx.skillOptimizationRecord.update({
          where: { id: record.id },
          data: {
            sourceExperimentId: updated.id,
            sourceRefsJson: JSON.stringify([
              ...sourceRefs,
              { type: 'experiment', id: updated.id, name: updated.name, preset: updated.preset },
            ]),
          },
        });
      }
    }
    return { experiment: updated, grayscaleTask: task, configSnapshot };
  });
  if (input.sessionId) {
    await createOrReuseSkillWorkbenchTask({
      user: input.user,
      sessionId: input.sessionId,
      type: 'experiment',
      skillName: input.skillName,
      version: input.version,
      targetRef: created.experiment.id,
    });
  }
  return { kind: 'created' as const, ...created };
}

export async function generateWorkbenchTriggerDataset(input: {
  user: string;
  skillName: string;
  modelConfigId?: string;
}) {
  const skill = await resolveSkill(input.user, input.skillName);
  if (!skill) return null;
  const drafted = await draftTriggerEvalSet({
    user: input.user,
    skillName: input.skillName,
    modelConfigId: input.modelConfigId,
    replaceUserEdited: true,
  });
  const now = new Date().toISOString();
  const dataset: AgentDatasetRecord = {
    id: randomUUID(),
    user: input.user,
    name: `${input.skillName} 触发分析 ${formatWorkbenchTriggerDatasetTimestamp()}`,
    description: '由 Skill 工作台根据适用边界生成，可在创建实验前编辑并切换应触发/不应触发。',
    targetAgent: '',
    targetSkill: input.skillName,
    tags: ['skill-workbench', 'trigger'],
    fields: [
      ...defaultDatasetFields('ideal_output'),
      { id: 'should_trigger', key: 'should_trigger', label: '应触发', type: 'boolean' },
    ],
    cases: drafted.items.map((item) => ({
      id: randomUUID(),
      input: item.query,
      expectedOutput: item.shouldTrigger ? 'Skill should trigger' : 'Skill should not trigger',
      evaluationFocus: item.rationale?.trim() || 'Skill routing decision',
      tags: [item.shouldTrigger ? 'should-trigger' : 'should-not-trigger'],
      trajectory: '',
      values: {
        should_trigger: item.shouldTrigger,
        ...(item.rationale?.trim() ? { trigger_rationale: item.rationale.trim() } : {}),
      },
      source: 'skill-gen-draft',
    })),
    datasetKind: 'ideal_output',
    createdAt: now,
    updatedAt: now,
  };
  await createAgentDatasetRecord(dataset);
  return dataset;
}
