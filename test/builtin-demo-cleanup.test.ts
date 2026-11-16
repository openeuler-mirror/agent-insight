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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-demo-cleanup-'));
process.env.AGENT_INSIGHT_HOME = testHome;
const testDbPath = path.join(testHome, 'witty_insight.db');
fs.closeSync(fs.openSync(testDbPath, 'w'));
process.env.DATABASE_URL = 'file:' + testDbPath;
execFileSync(
  process.execPath,
  [path.resolve(__dirname, '../node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate'],
  { cwd: path.resolve(__dirname, '..'), env: process.env, stdio: 'ignore' },
);

let prisma: typeof import('@/lib/storage/prisma').prisma;
let cleanupModule: typeof import('@/server/builtin-example/cleanup-demo');

test.before(async () => {
  const [prismaModule, cleanup] = await Promise.all([
    import('@/lib/storage/prisma'),
    import('@/server/builtin-example/cleanup-demo'),
  ]);
  prisma = prismaModule.prisma;
  cleanupModule = cleanup;
});

test.after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testHome, { recursive: true, force: true });
});

test('只删除注入时写死标识的示例数据，保留用户自己的同类记录', async () => {
  const {
    DEMO_AGENT_DESCRIPTION,
    DEMO_AGENT_NAME,
    DEMO_DATASET_NAME,
    DEMO_SKILL_NAME,
    DEMO_TASK_ID_PREFIX,
  } = cleanupModule;

  const demoSelf = await prisma.skill.create({
    data: { name: DEMO_SKILL_NAME, user: 'demo-user' },
  });
  await prisma.skillVersion.create({
    data: { skillId: demoSelf.id, version: 0, content: '# demo' },
  });
  await prisma.registeredAgent.create({
    data: {
      platform: 'opencode',
      name: DEMO_AGENT_NAME,
      description: DEMO_AGENT_DESCRIPTION,
      user: 'demo-user',
    },
  });
  await prisma.agentEvalDataset.create({
    data: { id: 'demo-dataset', user: 'demo-user', name: DEMO_DATASET_NAME },
  });
  await prisma.session.create({
    data: { taskId: `${DEMO_TASK_ID_PREFIX}a`, user: 'demo-user' },
  });
  await prisma.execution.create({
    data: { taskId: `${DEMO_TASK_ID_PREFIX}a`, user: 'demo-user' },
  });

  const realSkill = await prisma.skill.create({
    data: { name: 'user-own-skill', user: 'real-user' },
  });
  await prisma.skillVersion.create({
    data: { skillId: realSkill.id, version: 0, content: '# real' },
  });
  await prisma.registeredAgent.create({
    data: {
      platform: 'opencode',
      name: DEMO_AGENT_NAME,
      description: '用户自己创建的 Agent',
      user: 'real-user',
    },
  });
  await prisma.agentEvalDataset.create({
    data: { id: 'real-dataset', user: 'real-user', name: '用户数据集' },
  });
  await prisma.session.create({ data: { taskId: 'real_task_1', user: 'real-user' } });
  await prisma.execution.create({ data: { taskId: 'real_task_1', user: 'real-user' } });

  const removed = await cleanupModule.cleanupBuiltinDemoData();
  assert.deepEqual(removed, {
    executions: 1,
    sessions: 1,
    agents: 1,
    datasets: 1,
    skills: 1,
  });

  assert.equal(await prisma.skill.count({ where: { name: DEMO_SKILL_NAME } }), 0);
  assert.equal(await prisma.skillVersion.count({ where: { skillId: demoSelf.id } }), 0);
  assert.equal(
    await prisma.registeredAgent.count({ where: { description: DEMO_AGENT_DESCRIPTION } }),
    0,
  );
  assert.equal(await prisma.agentEvalDataset.count({ where: { id: 'demo-dataset' } }), 0);
  assert.equal(await prisma.session.count({ where: { user: 'demo-user' } }), 0);
  assert.equal(await prisma.execution.count({ where: { user: 'demo-user' } }), 0);

  assert.equal(await prisma.skill.count({ where: { name: 'user-own-skill' } }), 1);
  assert.equal(
    await prisma.registeredAgent.count({ where: { description: '用户自己创建的 Agent' } }),
    1,
  );
  assert.equal(await prisma.agentEvalDataset.count({ where: { id: 'real-dataset' } }), 1);
  assert.equal(await prisma.session.count({ where: { taskId: 'real_task_1' } }), 1);
  assert.equal(await prisma.execution.count({ where: { taskId: 'real_task_1' } }), 1);
});

test('重复执行是 no-op', async () => {
  const removed = await cleanupModule.cleanupBuiltinDemoData();
  assert.deepEqual(removed, {
    executions: 0,
    sessions: 0,
    agents: 0,
    datasets: 0,
    skills: 0,
  });
});
