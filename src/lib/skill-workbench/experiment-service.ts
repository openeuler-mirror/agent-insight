import { randomUUID } from 'crypto';

import { DEFAULT_SELECTED_PRESET_IDS } from '@/lib/evaluators/preset-evaluators';
import { defaultSkillExperimentName } from '@/lib/engine/experiment/experiment-name';
import {
  DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS,
  isValidExperimentAgentTimeoutSeconds,
} from '@/lib/engine/experiment/constants';
import { draftTriggerEvalSet } from '@/lib/engine/skill-generation/evaluator/runners/draftTriggerEvalSet';
import { TraceGenerationError } from '@/lib/engine/experiment/trace-generation';
import { prismaRaw } from '@/lib/storage/prisma';
import { getActiveConfig } from '@/lib/storage/server-config';
import { validateSkillExecutionTarget, type SkillExecutionTarget, type SkillExecutionSnapshot } from './execution-target';
import { resolveSkillVersionFiles } from './session-service';
import {
  createAgentDatasetRecord,
  defaultDatasetFields,
  findAgentDataset,
  readAgentDatasetReferences,
  type AgentDatasetRecord,
} from '@/server/agent_datasets_storage';
import { createOrReuseSkillWorkbenchTask } from './task-service';
import { triggerExperimentCaseData } from './trigger-execution';
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

async function freezeTriggerSkills(user: string, target: { name: string; version: number; content: string }): Promise<SkillExecutionSnapshot[]> {
  if (!target.content.trim()) throw new TraceGenerationError('skill_snapshot_missing', '当前 Skill 版本缺少 SKILL.md，不能运行触发分析', 400);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(target.name)) {
    throw new TraceGenerationError('invalid_skill_name', '当前 Skill 名称不适用于客户端触发分析', 400);
  }
  const skills = await prismaRaw.skill.findMany({
    where: { user },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  });
  const routingContent = (content: string) => {
    const frontmatter = content.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/);
    return frontmatter ? `${frontmatter[0]}\n<!-- 触发分析仅使用 Skill 元数据 -->\n` : content;
  };
  const snapshots = skills.filter((item) => item.name !== target.name && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(item.name)).flatMap((item) => {
    const version = item.versions[0];
    if (!version) return [];
    const content = resolveSkillVersionFiles(item.id, version.version, version.files, version.content)['SKILL.md'];
    return content ? [{ name: item.name, version: version.version, files: { 'SKILL.md': routingContent(content) } }] : [];
  });
  snapshots.push({ name: target.name, version: target.version, files: { 'SKILL.md': routingContent(target.content) } });
  if (snapshots.length > 100) throw new TraceGenerationError('too_many_skills', '触发分析参与路由的 Skill 超过 100 个，请先缩小范围', 400);
  return snapshots;
}

export function visibleWorkbenchCaseIds(caseIds: unknown, deletedCases: Set<string>): string[] | null {
  if (!Array.isArray(caseIds)) return null;
  return caseIds.map(String).filter((id) => !deletedCases.has(id));
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
        deletedAt: null,
        preset: { in: [...WORKBENCH_EXPERIMENT_PRESETS, 'retest'] },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { _count: { select: { cases: { where: { deletedAt: null } } } } },
    }),
  ]);
  const taskIds = experiments.map((experiment) => {
    const snapshot = parseJson<{ grayscaleTaskId?: string }>(experiment.configSnapshotJson, {});
    return snapshot.grayscaleTaskId || '';
  }).filter(Boolean);
  const tasks = taskIds.length ? await prismaRaw.grayscaleTask.findMany({ where: { id: { in: taskIds }, user } }) : [];
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const cancellations = await prismaRaw.experimentCancellation.findMany({
    where: { experimentId: { in: experiments.map((item) => item.id) }, caseKey: { startsWith: 'dataset:' } },
    select: { experimentId: true, caseKey: true },
  });
  return {
    versions: skill.versions.map((version) => ({ id: version.id, version: version.version })),
    datasets,
    evaluators: [...DEFAULT_SELECTED_PRESET_IDS],
    experiments: experiments.map((experiment) => {
      const snapshot = parseJson<Record<string, unknown> & { grayscaleTaskId?: string }>(experiment.configSnapshotJson, {});
      const deletedCases = new Set(cancellations.filter((item) => item.experimentId === experiment.id).map((item) => item.caseKey.slice(8)));
      const visibleCaseIds = visibleWorkbenchCaseIds(snapshot.caseIds, deletedCases);
      if (visibleCaseIds) snapshot.caseIds = visibleCaseIds;
      const task = snapshot.grayscaleTaskId ? taskMap.get(snapshot.grayscaleTaskId) : null;
      return {
        ...experiment,
        status: experiment.status === 'draft' ? 'running' : experiment.status,
        caseCount: snapshot.traceSource === 'existing' && !snapshot.grayscaleTaskId
          ? experiment._count.cases
          : visibleCaseIds?.length ?? experiment._count.cases,
        _count: undefined,
        skillContext: parseJson(experiment.skillContextJson, {}),
        configSnapshot: snapshot,
        grayscaleTask: task ? {
          id: task.id,
          caseStates: Object.fromEntries(Object.entries(parseJson<Record<string, unknown>>(task.caseStatesJson, {})).filter(([id]) => !deletedCases.has(id))),
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
  traceGenerationTarget?: { host: string; platform: string; model: string | null } | null;
  executionTarget?: SkillExecutionTarget | null;
  modelConfigId?: string | null;
  agentTimeoutSeconds?: number;
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
  const executionTarget = await validateSkillExecutionTarget(input.user, input.executionTarget, input.preset === 'trigger');
  if (input.preset === 'trigger' && !executionTarget.model) return { kind: 'invalid_trigger_model' as const };
  const triggerSkills = input.preset === 'trigger'
    ? await freezeTriggerSkills(input.user, {
        name: skill.name, version: currentVersion.version,
        content: resolveSkillVersionFiles(skill.id, currentVersion.version, currentVersion.files, currentVersion.content)['SKILL.md'] || '',
      })
    : null;
  const activeModel = executionTarget ? null : input.modelConfigId
    ? await getActiveConfig(input.user).then((config) => config?.id === input.modelConfigId ? config : null)
    : await getActiveConfig(input.user);
  const concurrencyPolicy = getSkillExperimentConcurrencyPolicy(input.preset);
  const isTriggerExperiment = input.preset === 'trigger';
  const agentTimeoutSeconds = input.agentTimeoutSeconds ?? DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS;
  if (!isValidExperimentAgentTimeoutSeconds(agentTimeoutSeconds)) {
    return { kind: 'invalid_agent_timeout' as const };
  }
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
    timeoutMs: agentTimeoutSeconds * 1_000,
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
        name: input.name?.trim().slice(0, 120) || defaultSkillExperimentName(input.skillName, input.preset, input.version),
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
          executionTarget,
          requiresClientExecution: Boolean(executionTarget),
          triggerSkills,
          skillSnapshots: executionTarget ? {
            a: versionA ? { name: skill.name, version: versionA.version, files: resolveSkillVersionFiles(skill.id, versionA.version, versionA.files, versionA.content) } : null,
            b: { name: skill.name, version: versionB!.version, files: resolveSkillVersionFiles(skill.id, versionB!.version, versionB!.files, versionB!.content) },
          } : undefined,
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
    if (isTriggerExperiment) {
      await tx.experimentCase.createMany({ data: triggerExperimentCaseData(experiment.id, dataset.id, selectedCases) });
    }
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
      traceGenerationTarget: executionTarget || (input.traceSource === 'existing' ? null : input.traceGenerationTarget ?? null),
      executionTarget,
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

export async function cloneWorkbenchExperimentFromFrozenConfig(user: string, sourceExperimentId: string) {
  const source = await prismaRaw.experiment.findFirst({
    where: { id: sourceExperimentId, user, scope: 'skill-workbench', deletedAt: null },
    select: {
      id: true, skillName: true, skillVersion: true, preset: true,
      agentName: true, configSnapshotJson: true, evaluatorIdsJson: true,
    },
  });
  if (!source || !WORKBENCH_EXPERIMENT_PRESETS.includes(source.preset as WorkbenchExperimentPreset)) {
    throw new Error('原 Skill 实验不存在或不支持同配置运行');
  }
  const snapshot = parseJson<Record<string, unknown>>(source.configSnapshotJson, {});
  const datasetId = typeof snapshot.datasetId === 'string' ? snapshot.datasetId : '';
  const executionTarget = snapshot.executionTarget as SkillExecutionTarget | null;
  if (!source.skillName || source.skillVersion == null || !datasetId || !executionTarget || !snapshot.grayscaleTaskId) {
    throw new Error('原 Skill 实验缺少冻结的数据集或客户端配置，请通过复用同配置重新确认');
  }
  const sourceTask = await prismaRaw.grayscaleTask.findFirst({
    where: { id: String(snapshot.grayscaleTaskId), user }, select: { configJson: true },
  });
  const sourceTaskConfig = parseJson<Record<string, unknown>>(sourceTask?.configJson || null, {});
  if (sourceTaskConfig.evalExperimentId !== source.id || !sourceTaskConfig.executionTarget || (
    source.preset === 'trigger' ? !sourceTaskConfig.triggerSkills : !sourceTaskConfig.skillSnapshots
  )) throw new Error('原 Skill 实验缺少冻结的 Skill 文件或运行目标，请通过复用同配置重新确认');
  const cancelled = await prismaRaw.experimentCancellation.findMany({
    where: { experimentId: source.id, caseKey: { startsWith: 'dataset:' } },
    select: { caseKey: true },
  });
  const caseIds = visibleWorkbenchCaseIds(snapshot.caseIds, new Set(cancelled.map((item) => item.caseKey.slice(8))));
  if (!caseIds?.length) throw new Error('原 Skill 实验没有可复用的 Case');
  const preset = source.preset as WorkbenchExperimentPreset;
  const versionBId = typeof snapshot.versionBId === 'string' ? snapshot.versionBId : '';
  const compareVersion = preset === 'skill-ab'
    ? await prismaRaw.skillVersion.findFirst({ where: { id: versionBId }, select: { version: true } }).then((row) => row?.version)
    : undefined;
  if (preset === 'skill-ab' && compareVersion == null) throw new Error('原 A/B 实验的对照版本已失效');
  const runtime = snapshot.runtime && typeof snapshot.runtime === 'object'
    ? snapshot.runtime as Record<string, unknown> : {};
  const timeoutSeconds = Number(runtime.timeoutMs) / 1_000;
  const result = await createWorkbenchExperiment({
    user,
    skillName: source.skillName,
    version: source.skillVersion,
    preset,
    datasetId,
    caseIds,
    compareVersion,
    versionAEnabled: snapshot.versionAId !== '__NONE__',
    name: defaultSkillExperimentName(source.skillName, preset, source.skillVersion),
    agentName: source.agentName,
    evaluatorIds: parseJson<string[]>(source.evaluatorIdsJson, []),
    traceSource: snapshot.traceSource === 'existing' ? 'existing' : 'generate',
    executionTarget,
    ...(Number.isInteger(timeoutSeconds) ? { agentTimeoutSeconds: timeoutSeconds } : {}),
  });
  if (result.kind !== 'created') throw new Error('原 Skill 实验配置已失效，请通过复用同配置重新确认');
  await prismaRaw.$transaction([
    prismaRaw.grayscaleTask.update({
      where: { id: result.grayscaleTask.id },
      data: { configJson: JSON.stringify({
        ...sourceTaskConfig,
        evalExperimentId: result.experiment.id,
        evaluationBatchTitle: result.experiment.name,
        runCount: caseIds.length,
      }) },
    }),
    prismaRaw.experiment.update({
      where: { id: result.experiment.id },
      data: {
        sourceExperimentId: source.id,
        configSnapshotJson: JSON.stringify({ ...snapshot, caseIds, grayscaleTaskId: result.grayscaleTask.id }),
      },
    }),
  ]);
  return {
    id: result.experiment.id,
    scope: 'skill-workbench',
    grayscaleTaskId: result.grayscaleTask.id,
    caseIds: result.configSnapshot.caseIds,
    evaluatorIds: parseJson<string[]>(source.evaluatorIdsJson, []),
  };
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
