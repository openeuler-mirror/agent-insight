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
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

let prisma: typeof import('@/lib/storage/prisma')['prisma'];
let listExperimentAgents: typeof import('@/app/api/experiments/agents/route')['GET'];
let listExperimentTraces: typeof import('@/app/api/experiments/traces/route')['GET'];
let createExperimentWatcher: typeof import('@/lib/engine/experiment/experiment-watch')['createExperimentWatcher'];
let root: string;

test.before(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'experiment-agent-ownership-'));
  process.env.AGENT_INSIGHT_HOME = root;
  delete process.env.AGENT_INSIGHT_DATA_DIR;
  process.env.DATABASE_URL = `file:${path.join(root, 'test.db')}`;
  writeFileSync(path.join(root, 'test.db'), '');
  execFileSync(process.execPath, [
    path.resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate',
    '--schema', path.resolve('prisma/schema.prisma'),
  ], { env: process.env, stdio: 'pipe', timeout: 60_000 });
  ({ prisma } = await import('@/lib/storage/prisma'));
  ({ GET: listExperimentAgents } = await import('@/app/api/experiments/agents/route'));
  ({ GET: listExperimentTraces } = await import('@/app/api/experiments/traces/route'));
  ({ createExperimentWatcher } = await import('@/lib/engine/experiment/experiment-watch'));
});

test.after(async () => {
  await prisma?.$disconnect();
  if (root) rmSync(root, { recursive: true, force: true });
});

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const TEST_USER = `experiment-owner-${RUN_ID}`;
const USER_AGENT = `user-agent-${RUN_ID}`;
const SYSTEM_AGENT = `system-agent-${RUN_ID}`;
const FRAMEWORK = `test-framework-${RUN_ID}`;
const USER_TASK = `user-task-${RUN_ID}`;
const SYSTEM_TASK = `system-task-${RUN_ID}`;

test('experiment candidates, traces, and watch mode exclude system-owned agents', async (t) => {
  const userRegistration = await prisma.registeredAgent.create({
    data: {
      platform: FRAMEWORK,
      name: USER_AGENT,
      user: TEST_USER,
      agentOwnership: 'user',
    },
  });
  const systemRegistration = await prisma.registeredAgent.create({
    data: {
      platform: FRAMEWORK,
      name: SYSTEM_AGENT,
      user: null,
      agentOwnership: 'system',
    },
  });
  const userExecution = await prisma.execution.create({
    data: {
      taskId: USER_TASK,
      framework: FRAMEWORK,
      agentName: USER_AGENT,
      agentId: userRegistration.id,
      user: TEST_USER,
    },
  });
  const systemExecution = await prisma.execution.create({
    data: {
      taskId: SYSTEM_TASK,
      framework: FRAMEWORK,
      agentName: SYSTEM_AGENT,
      agentId: systemRegistration.id,
      user: TEST_USER,
    },
  });
  await prisma.session.create({
    data: {
      taskId: SYSTEM_TASK,
      user: TEST_USER,
      endTime: new Date(),
    },
  });
  const watchExperiment = await prisma.experiment.create({
    data: {
      user: TEST_USER,
      name: `watch-${RUN_ID}`,
      agentName: SYSTEM_AGENT,
      evaluatorIdsJson: '[]',
      watchMode: true,
      watchEnabledAt: new Date(0),
    },
  });

  t.after(async () => {
    await prisma.experimentCase.deleteMany({ where: { experimentId: watchExperiment.id } });
    await prisma.experiment.deleteMany({ where: { id: watchExperiment.id } });
    await prisma.session.deleteMany({ where: { taskId: SYSTEM_TASK } });
    await prisma.execution.deleteMany({ where: { id: { in: [userExecution.id, systemExecution.id] } } });
    await prisma.registeredAgent.deleteMany({
      where: { id: { in: [userRegistration.id, systemRegistration.id] } },
    });
  });

  const agentsResponse = await listExperimentAgents(
    new Request(`http://localhost/api/experiments/agents?user=${encodeURIComponent(TEST_USER)}`),
  );
  assert.equal(agentsResponse.status, 200);
  assert.deepEqual((await agentsResponse.json()).agents, [{
    name: USER_AGENT,
    traces: 1,
    frameworks: [FRAMEWORK],
    executable: false,
    targets: [],
  }]);

  const userTracesResponse = await listExperimentTraces(
    new Request(
      `http://localhost/api/experiments/traces?user=${encodeURIComponent(TEST_USER)}&agent=${encodeURIComponent(USER_AGENT)}`,
    ),
  );
  assert.equal(userTracesResponse.status, 200);
  assert.equal((await userTracesResponse.json()).total, 1);

  const systemTracesResponse = await listExperimentTraces(
    new Request(
      `http://localhost/api/experiments/traces?user=${encodeURIComponent(TEST_USER)}&agent=${encodeURIComponent(SYSTEM_AGENT)}`,
    ),
  );
  assert.equal(systemTracesResponse.status, 200);
  assert.equal((await systemTracesResponse.json()).total, 0);

  const watcher = createExperimentWatcher();
  await watcher.scan();
  await watcher.waitForIdle();
  assert.equal(
    await prisma.experimentCase.count({ where: { experimentId: watchExperiment.id } }),
    0,
  );
});


test('RAS reviewer traces appear under all and system ownership while user lists and experiment selectors exclude them', async () => {
  const owner = 'ras-reviewer-owner';
  const { GET: listTraces } = await import('@/app/api/observe/data/route');
  const { shouldHideFromCaseAnalysis, classifyTraceSource } = await import('@/lib/system-agent-names');
  // 模拟旧版本已误归属为 user 的记录，无需迁移即可按用户归属过滤。
  await prisma.registeredAgent.create({ data: {
    platform: 'opencode', name: 'ras-judge', user: owner, agentOwnership: 'user',
  } });
  await prisma.execution.createMany({ data: [
    { taskId: 'ras-internal', user: owner, framework: 'opencode', agentName: 'ras-judge', query: 'judge' },
    { taskId: 'ras-business', user: owner, framework: 'opencode', agentName: 'build', query: 'business with ras-judge child',
      observedAgents: '["build","ras-judge"]' },
    { taskId: 'ras-legacy', user: owner, framework: 'opencode', agentName: null, query: 'legacy business' },
  ] });
  const base = 'http://localhost/api/observe/data?user=' + owner
    + '&paginated=1&databasePagination=1&fields=light&skipAutoEvalReady=1';
  for (const [suffix, total] of [['', 3], ['&ownership=all', 3], ['&ownership=user', 2], ['&sort=status', 3], ['&anomaly=none', 3]] as const) {
    const response = await listTraces(new Request(base + suffix + '&pageSize=1'));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.total, total, suffix);
    assert.equal(body.stats.total, total, suffix);
    assert.equal(body.records.length, 1, suffix);
    if (suffix === '&ownership=user') assert.notEqual(body.records[0].task_id, 'ras-internal');
  }
  const all = await (await listTraces(new Request(base + '&ownership=all'))).json();
  assert.equal(all.total, 3);
  assert.ok(all.records.some((record: { task_id: string }) => record.task_id === 'ras-internal'));
  const system = await (await listTraces(new Request(base + '&ownership=system'))).json();
  assert.equal(system.total, 1);
  assert.equal(system.records[0].task_id, 'ras-internal');
  const evidence = await (await listTraces(new Request(base + '&taskId=ras-internal'))).json();
  assert.equal(evidence.total, 1);
  assert.equal(evidence.records[0].task_id, 'ras-internal');
  assert.equal(await prisma.execution.count({ where: { user: owner } }), 3);
  const selection = await (await listExperimentTraces(new Request(
    'http://localhost/api/experiments/traces?user=' + owner + '&agent=ras-judge',
  ))).json();
  assert.equal(selection.total, 0);
  assert.equal(shouldHideFromCaseAnalysis('ras-judge'), true);
  assert.equal(shouldHideFromCaseAnalysis('build'), false);
  assert.equal(classifyTraceSource('ras-judge'), 'system');
});
