import path from 'node:path';

process.env.DATABASE_URL = `file:${path.resolve(__dirname, '../data/witty_insight.db')}`;

import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateSkillIssues } from '@/lib/engine/skill-issues';
import {
  syncCompletedSkillExperimentIssues,
  syncExperimentSkillIssues,
} from '@/lib/engine/experiment/sync-skill-issues';
import { prismaRaw } from '@/lib/storage/prisma';

const USER = `experiment-skill-issues-${Date.now()}@test.local`;
const SKILL_NAME = `experiment-skill-issues-${Date.now()}`;

async function createExperiment(input: {
  preset: 'use-case' | 'trigger';
  points: Array<Record<string, unknown>>;
}) {
  const experiment = await prismaRaw.experiment.create({
    data: {
      user: USER,
      name: `${input.preset} test`,
      agentName: SKILL_NAME,
      evaluatorIdsJson: JSON.stringify([input.preset === 'trigger' ? 'skill-trigger-analyzer' : 'preset-agent-task-completion']),
      status: 'done',
      scope: 'skill-workbench',
      skillName: SKILL_NAME,
      skillVersion: 0,
      preset: input.preset,
    },
  });
  for (let index = 0; index < input.points.length; index += 1) {
    const experimentCase = await prismaRaw.experimentCase.create({
      data: { experimentId: experiment.id, input: `case ${index}` },
    });
    await prismaRaw.experimentEvalResult.create({
      data: {
        experimentId: experiment.id,
        caseId: experimentCase.id,
        evaluatorId: input.preset === 'trigger' ? 'skill-trigger-analyzer' : 'preset-agent-task-completion',
        status: 'done',
        summary: '评估发现可归因到 Skill 的问题',
        score: 50,
        pointsJson: JSON.stringify([input.points[index]]),
      },
    });
  }
  return experiment;
}

test.before(async () => {
  await prismaRaw.skill.create({
    data: {
      name: SKILL_NAME,
      user: USER,
      activeVersion: 0,
      versions: { create: { version: 0, content: '---\nname: test\ndescription: test\n---\n' } },
    },
  });
});

test.after(async () => {
  await prismaRaw.experiment.deleteMany({ where: { user: USER } });
  await prismaRaw.skill.deleteMany({ where: { user: USER } });
});

test('用例分析建议幂等写入 dynamic SkillIssue，并按相同建议累计 prevalence', async () => {
  const suggestion = '在 SKILL.md 的输出规则中增加 TOP 来源必须引用全量聚合结果。';
  const experiment = await createExperiment({
    preset: 'use-case',
    points: [0, 1].map(() => ({
      label: 'TOP 来源列表遗漏关键 IP',
      status: 'partial',
      score: 80,
      skillAttributable: true,
      evidence: { md: '实际输出漏掉了两个来源 IP。' },
      suggestion,
    })),
  });

  assert.equal((await syncExperimentSkillIssues(experiment.id)).written, 2);
  assert.equal((await syncExperimentSkillIssues(experiment.id)).written, 2);

  const skill = await prismaRaw.skill.findFirstOrThrow({ where: { name: SKILL_NAME, user: USER } });
  const rawIssues = await prismaRaw.skillIssue.findMany({ where: { skillId: skill.id, source: 'dynamic' } });
  assert.equal(rawIssues.length, 2, '重跑同一实验应替换旧结果而不是重复追加');
  const aggregated = await aggregateSkillIssues({
    prisma: prismaRaw,
    skillId: skill.id,
    version: 0,
    user: USER,
    includeResolved: false,
  });
  const issue = aggregated.issues.find((item) => item.source === 'dynamic');
  assert.equal(issue?.prevalenceCount, 2);
  assert.equal(issue?.suggestedFix, suggestion);
  assert.equal(issue?.category, '任务完成度');

  const issueIds = rawIssues.map((item) => item.id).sort();
  await prismaRaw.skillIssue.updateMany({
    where: { id: { in: issueIds } },
    data: { resolvedAt: new Date(), resolvedRunId: 'optimization-record-test' },
  });
  await syncExperimentSkillIssues(experiment.id);
  const resynced = await prismaRaw.skillIssue.findMany({
    where: { skillId: skill.id, source: 'dynamic' },
    orderBy: { id: 'asc' },
  });
  assert.deepEqual(resynced.map((item) => item.id), issueIds, '重同步必须保留稳定的 SkillIssue id');
  assert.ok(resynced.every((item) => item.resolvedAt && item.resolvedRunId === 'optimization-record-test'), '重同步不得复活已解决建议');
});

test('触发分析建议写入 trigger SkillIssue；后续全部通过会解决旧触发问题', async () => {
  const failed = await createExperiment({
    preset: 'trigger',
    points: [{
      label: '触发准确率',
      status: 'missing',
      score: 0,
      skillAttributable: true,
      evidence: { md: '不应触发但实际触发。' },
      suggestion: '在 SKILL.md 中补充排除条件和适用边界。',
    }],
  });
  await syncExperimentSkillIssues(failed.id);
  await syncExperimentSkillIssues(failed.id);

  const skill = await prismaRaw.skill.findFirstOrThrow({ where: { name: SKILL_NAME, user: USER } });
  assert.equal(await prismaRaw.skillIssue.count({
    where: { skillId: skill.id, source: 'trigger', resolvedAt: null },
  }), 1);

  const passed = await createExperiment({
    preset: 'trigger',
    points: [{
      label: '触发准确率',
      status: 'covered',
      score: 100,
      skillAttributable: false,
      evidence: { md: '触发结果与标注一致。' },
    }],
  });
  await syncExperimentSkillIssues(passed.id);
  assert.equal(await prismaRaw.skillIssue.count({
    where: { skillId: skill.id, source: 'trigger', resolvedAt: null },
  }), 0);

  const backfill = await syncCompletedSkillExperimentIssues({
    user: USER,
    skillName: SKILL_NAME,
    skillVersion: 0,
  });
  assert.equal(backfill.experiments, 3);
  assert.equal(await prismaRaw.skillIssue.count({
    where: { skillId: skill.id, source: 'trigger', resolvedAt: null },
  }), 0, '历史补录按实验更新时间执行，最终应以最新触发实验为准');
});
