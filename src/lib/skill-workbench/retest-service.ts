import fs from 'fs';
import path from 'path';

import { withBackgroundOpencodeSlot } from '@/lib/engine/general-agent/concurrency-limiter';
import { runGeneralAgent } from '@/lib/engine/general-agent';
import { loadServerModelForUserById } from '@/lib/engine/general-agent/server-model-config';
import { ensureSessionWorkspace } from '@/lib/engine/general-agent/workspace';
import { addEvalExperimentCase, evaluateEvalExperimentCase } from '@/lib/engine/experiment/run-experiment';
import { prismaRaw } from '@/lib/storage/prisma';
import { findAgentDataset } from '@/server/agent_datasets_storage';
import { resolveRetestableExperimentBaseline } from './experiment-baseline';
import { transitionSkillOptimizationRecord } from './optimization-service';

export class RetestError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

function parseJson<T>(value: string | null, fallback: T): T {
  try { return JSON.parse(value || '') as T; } catch { return fallback; }
}

function deployCandidate(user: string, workspaceTag: string, skillName: string, files: Record<string, string>) {
  if (!/^[A-Za-z0-9._-]+$/.test(skillName)) throw new RetestError('Skill 名称不适合部署到复测工作区', 422);
  const workspace = ensureSessionWorkspace(user, workspaceTag);
  const root = path.join(workspace, '.opencode', 'skills', skillName);
  fs.mkdirSync(root, { recursive: true });
  for (const [rawPath, content] of Object.entries(files)) {
    const relativePath = rawPath.replaceAll('\\', '/');
    if (!relativePath || relativePath.startsWith('/') || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new RetestError(`候选包含不安全路径：${rawPath}`, 422);
    }
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  return workspace;
}

function average(scores: Array<number | null>) {
  const values = scores.filter((score): score is number => typeof score === 'number' && Number.isFinite(score));
  return values.length ? values.reduce((sum, score) => sum + score, 0) / values.length : null;
}

export async function retestOptimizationCandidate(input: {
  user: string;
  skillName: string;
  recordId: string;
}) {
  const record = await prismaRaw.skillOptimizationRecord.findFirst({
    where: { id: input.recordId, user: input.user, skillName: input.skillName },
  });
  if (!record) throw new RetestError('优化候选不存在', 404);
  if (!['pending_retest', 'retest_failed', 'retest_cancelled'].includes(record.status)) {
    throw new RetestError(`候选当前状态 ${record.status} 不能复测`);
  }
  const baseline = await resolveRetestableExperimentBaseline({
    user: input.user,
    skillName: input.skillName,
    skillVersion: record.baseVersion,
    sourceExperimentId: record.sourceExperimentId,
  });
  if (!baseline) {
    throw new RetestError(record.sourceExperimentId
      ? '来源实验尚未形成可比较的有效评分'
      : '该候选没有可用来源实验，无法保证同配置复测');
  }
  const source = baseline.experiment;
  const snapshot = baseline.snapshot;
  const sourceScore = baseline.score;
  if (source.id !== record.sourceExperimentId) {
    const sourceRefs = parseJson<unknown[]>(record.sourceRefsJson, []);
    await prismaRaw.skillOptimizationRecord.update({
      where: { id: record.id },
      data: {
        sourceExperimentId: source.id,
        sourceRefsJson: JSON.stringify([
          ...sourceRefs,
          { type: 'experiment', id: source.id, name: source.name, preset: source.preset },
        ]),
      },
    });
  }
  const datasetId = snapshot.datasetId as string;
  const caseIds = snapshot.caseIds as string[];
  const dataset = await findAgentDataset(input.user, datasetId);
  if (!dataset) throw new RetestError('来源实验的数据集已不存在');
  const caseMap = new Map(dataset.cases.map((item) => [item.id, item]));
  const orderedCases = caseIds.map((id) => caseMap.get(id)).filter((item): item is NonNullable<typeof item> => Boolean(item));
  if (orderedCases.length !== caseIds.length) throw new RetestError('来源实验的部分 Case 已不存在');
  const frozenModel = snapshot.runtime?.modelConfigId
    ? await loadServerModelForUserById(input.user, snapshot.runtime.modelConfigId)
    : null;
  if (snapshot.runtime?.modelConfigId && !frozenModel) {
    throw new RetestError(`来源实验冻结的模型配置已不可用：${snapshot.runtime.modelConfigId}`);
  }

  const candidateFiles = parseJson<Record<string, string>>(record.candidateFilesJson, {});
  if (!candidateFiles['SKILL.md']) throw new RetestError('候选快照缺少 SKILL.md', 422);
  const retest = await prismaRaw.experiment.create({
    data: {
      user: input.user,
      name: `${source.name} · 候选复测`,
      type: 'single',
      agentName: input.skillName,
      evaluatorIdsJson: JSON.stringify(snapshot.evaluatorIds),
      status: 'running',
      scope: 'skill-workbench',
      skillName: input.skillName,
      skillVersion: record.baseVersion,
      preset: 'retest',
      skillContextJson: JSON.stringify({
        sessionId: record.sessionId,
        skillName: input.skillName,
        baseVersion: record.baseVersion,
        candidateHash: record.candidateContentHash,
      }),
      configSnapshotJson: JSON.stringify({ ...snapshot, candidateHash: record.candidateContentHash }),
      sourceExperimentId: source.id,
      optimizationRecordId: record.id,
    },
  });
  await transitionSkillOptimizationRecord({
    user: input.user, skillName: input.skillName, recordId: record.id, to: 'retesting',
  });
  await prismaRaw.skillOptimizationRecord.update({ where: { id: record.id }, data: { retestExperimentId: retest.id } });

  const scores: number[] = [];
  try {
    const repeatRounds = Math.max(1, Math.floor(snapshot.repeatRounds || 1));
    for (const item of orderedCases) {
      for (let round = 0; round < repeatRounds; round += 1) {
        const workspaceTag = `retest-${record.id}-${item.id}-r${round}`;
        deployCandidate(input.user, workspaceTag, input.skillName, candidateFiles);
        const run = await withBackgroundOpencodeSlot(() => runGeneralAgent({
          user: input.user,
          query: item.input,
          workspaceTag,
          tagSkill: input.skillName,
          system: `候选 Skill 已安装为 ${input.skillName}。必须先使用 load_skill 加载它，再严格按其中说明完成用户任务。`,
          model: frozenModel || undefined,
          modelOptions: snapshot.runtime?.modelOptions,
          interactionPolicy: snapshot.runtime?.interactionPolicy || 'auto-deny',
          timeoutMs: snapshot.runtime?.timeoutMs,
          chatOptions: snapshot.runtime?.idleTimeoutMs ? { idleTimeoutMs: snapshot.runtime.idleTimeoutMs } : undefined,
          ephemeralServer: true,
          recordTraceAs: 'skill-workbench-retest',
        }), {
          taskType: 'skill-workbench-retest', user: input.user,
          label: `${input.skillName}-${item.id}-r${round}`, skill: input.skillName, skillVersion: null,
        });
        const caseId = await addEvalExperimentCase(retest.id, {
          taskId: run.sessionId,
          input: item.input,
          datasetInput: item.input,
          actualOutput: run.fullOutput || run.output,
          referenceOutput: item.expectedOutput || null,
        });
        const rows = await evaluateEvalExperimentCase(retest.id, caseId, input.user);
        const score = average(rows.filter((row) => row.status === 'done').map((row) => row.score));
        if (score != null) scores.push(score);
      }
    }
    const candidateScore = average(scores);
    const passed = candidateScore != null && candidateScore >= sourceScore;
    await prismaRaw.experiment.update({ where: { id: retest.id }, data: { status: 'done' } });
    const latestRecord = await prismaRaw.skillOptimizationRecord.findUnique({
      where: { id: record.id },
      select: { sourceRefsJson: true },
    });
    const latestSourceRefs = parseJson<unknown[]>(latestRecord?.sourceRefsJson || record.sourceRefsJson, []);
    await prismaRaw.skillOptimizationRecord.update({
      where: { id: record.id },
      data: {
        sourceRefsJson: JSON.stringify([
          ...latestSourceRefs.filter((item) => !(item && typeof item === 'object' && (item as { type?: string }).type === 'retest-result')),
          { type: 'retest-result', experimentId: retest.id, sourceScore, candidateScore, passed },
        ]),
      },
    });
    await transitionSkillOptimizationRecord({
      user: input.user,
      skillName: input.skillName,
      recordId: record.id,
      to: passed ? 'retest_passed' : 'retest_failed',
      errorMessage: passed ? undefined : `复测分 ${candidateScore ?? 'N/A'}，来源实验分 ${sourceScore ?? 'N/A'}`,
    });
    return { experimentId: retest.id, sourceScore, candidateScore, passed };
  } catch (error) {
    await transitionSkillOptimizationRecord({
      user: input.user, skillName: input.skillName, recordId: record.id, to: 'retest_failed',
      errorMessage: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    await prismaRaw.experiment.updateMany({ where: { id: retest.id }, data: { status: 'failed' } }).catch(() => undefined);
    throw error;
  }
}
