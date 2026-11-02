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

import path from 'node:path';

process.env.DATABASE_URL = process.env.AGENT_INSIGHT_TEST_DATABASE_URL || `file:${path.resolve(__dirname, '../data/witty_insight.db')}`;

import assert from 'node:assert/strict';
import test from 'node:test';

import { prismaRaw } from '@/lib/storage/prisma';
import { applyCompletedOptimizationPlan } from '@/lib/skill-workbench/optimization-plan-state';

const USER = `optimization-plan-state-${Date.now()}@test.local`;
const SKILL_NAME = `optimization-plan-state-${Date.now()}`;

test('候选应用计划不等于问题已解决；缺少验证证据时保留全部重复来源', async () => {
  const skill = await prismaRaw.skill.create({
    data: {
      name: SKILL_NAME,
      user: USER,
      activeVersion: 0,
      versions: { create: { version: 0, content: '---\nname: test\ndescription: test\n---\n' } },
    },
  });
  try {
    const evaluations = await Promise.all([0, 1, 2].map((index) => prismaRaw.evaluation.create({
      data: { type: 'dynamic', skillId: skill.id, version: 0, user: USER, runId: `run-${index}` },
    })));
    const duplicateIssues = await Promise.all(evaluations.slice(0, 2).map((evaluation) => prismaRaw.skillIssue.create({
      data: {
        evaluationId: evaluation.id,
        source: 'dynamic',
        skillId: skill.id,
        version: 0,
        user: USER,
        dedupKey: 'same-problem',
        severity: 'high',
        summary: '同一个问题在两个用例中出现',
      },
    })));
    const backlogIssue = await prismaRaw.skillIssue.create({
      data: {
        evaluationId: evaluations[2].id,
        source: 'dynamic',
        skillId: skill.id,
        version: 0,
        user: USER,
        dedupKey: 'backlog-problem',
        severity: 'low',
        summary: '本轮顺延的问题',
      },
    });
    const optSession = await prismaRaw.skillOptSession.create({
      data: { user: USER, skillName: SKILL_NAME, baseVersion: 0 },
    });
    const workbench = await prismaRaw.skillWorkbenchSession.create({
      data: {
        user: USER,
        skillName: SKILL_NAME,
        workVersion: 0,
        source: 'management',
        optSessionId: optSession.id,
      },
    });
    const plan = await prismaRaw.skillOptPlan.create({
      data: {
        sessionId: optSession.id,
        skillId: skill.id,
        baseVersion: 0,
        status: 'confirmed',
        items: {
          create: [
            {
              rank: 1,
              route: 'core',
              status: 'pending',
              title: '修复重复问题',
              rationale: '两个用例指向同一根因',
              sourceIssueIds: JSON.stringify([duplicateIssues[0].id]),
            },
            {
              rank: 2,
              route: 'backlog',
              status: 'pending',
              title: '以后再处理',
              rationale: '本轮不执行',
              sourceIssueIds: JSON.stringify([backlogIssue.id]),
            },
          ],
        },
      },
    });

    const applied = await applyCompletedOptimizationPlan({
      user: USER,
      workbenchSessionId: workbench.id,
      sourceRefs: [{ type: 'plan', id: plan.id }],
      resolvedRunId: 'optimization-record-1',
    });
    assert.equal(applied.appliedItems, 1);
    assert.equal(applied.resolvedIssues, 0);
    assert.equal((await prismaRaw.skillOptPlan.findUniqueOrThrow({ where: { id: plan.id } })).status, 'applied');
    const items = await prismaRaw.skillOptPlanItem.findMany({ where: { planId: plan.id }, orderBy: { rank: 'asc' } });
    assert.equal(items[0].status, 'applied');
    assert.equal(items[1].status, 'pending');
    assert.equal(await prismaRaw.skillIssue.count({
      where: { id: { in: duplicateIssues.map((item) => item.id) }, resolvedRunId: 'optimization-record-1' },
    }), 0);
    assert.equal((await prismaRaw.skillIssue.findUniqueOrThrow({ where: { id: backlogIssue.id } })).resolvedAt, null);

    const repeated = await applyCompletedOptimizationPlan({
      user: USER,
      workbenchSessionId: workbench.id,
      sourceRefs: [{ type: 'plan', id: plan.id }],
      resolvedRunId: 'optimization-record-1',
    });
    assert.equal(repeated.appliedItems, 0);
    assert.equal(repeated.resolvedIssues, 0);
  } finally {
    await prismaRaw.skillWorkbenchSession.deleteMany({ where: { user: USER } });
    await prismaRaw.skillOptSession.deleteMany({ where: { user: USER } });
    await prismaRaw.skill.deleteMany({ where: { id: skill.id } });
  }
});
