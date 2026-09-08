import path from 'node:path';
process.env.DATABASE_URL ||= `file:${path.resolve(__dirname, '../data/witty_insight.db')}`;

import assert from 'node:assert/strict';
import test from 'node:test';

import { GET as listExperimentAgents } from '@/app/api/experiments/agents/route';
import { GET as listExperimentTraces } from '@/app/api/experiments/traces/route';
import { triggerExperimentWatchForTask } from '@/lib/engine/experiment/experiment-watch';
import { prisma } from '@/lib/storage/prisma';

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

  await triggerExperimentWatchForTask(TEST_USER, SYSTEM_TASK);
  assert.equal(
    await prisma.experimentCase.count({ where: { experimentId: watchExperiment.id } }),
    0,
  );
});


test('Agent 目录按本人目标定义排除 Skill-only 的 harness Trace，保留同名真实 Agent', async (t) => {
  const user = TEST_USER + '-target-kinds';
  const names = { skill: '仅声明为 Skill', native: '同名原生 Agent', dual: '同时登记 Agent 和 Skill', foreign: '其他用户的 Skill', untyped: '名字里有 Skill 的普通 Agent', unknownFramework: '未记录框架的 Agent' };
  const define = (owner: string, name: string, type: string, key: string) => prisma.evaluationAssetVersion.create({ data: { user: owner, kind: 'target', assetKey: key, name, version: 1, contentJson: JSON.stringify({ type }), contentHash: key } });
  t.after(async () => {
    await prisma.execution.deleteMany({ where: { user } });
    await prisma.evaluationAssetVersion.deleteMany({ where: { user: { in: [user, user + '-other'] } } });
  });
  for (const key of ['skill', 'native', 'dual', 'unknownFramework'] as const) await define(user, names[key], 'skill', key);
  await define(user, names.dual, 'agent', 'dual-agent');
  await define(user + '-other', names.foreign, 'skill', 'foreign-skill');
  for (const name of Object.values(names)) await prisma.execution.create({ data: { user, agentName: name, framework: 'evaluation-harness', query: 'q' } });
  await prisma.execution.create({ data: { user, agentName: names.native, framework: 'opencode', query: 'q' } });
  await prisma.execution.create({ data: { user, agentName: names.unknownFramework, framework: null, query: 'q' } });
  const response = await listExperimentAgents(new Request('http://localhost/api/experiments/agents?user=' + encodeURIComponent(user)));
  assert.equal(response.status, 200);
  const { agents } = await response.json();
  assert.equal(agents.some((agent: any) => agent.name === names.skill), false);
  assert.deepEqual(agents.find((agent: any) => agent.name === names.native), { name: names.native, traces: 1, frameworks: ['opencode'], executable: false, targets: [] });
  assert.equal(agents.find((agent: any) => agent.name === names.unknownFramework)?.traces, 1);
  for (const key of ['dual', 'foreign', 'untyped'] as const) assert.ok(agents.some((agent: any) => agent.name === names[key]), key);
});

test('与 Skill 目标同名的在线客户端 Agent 仍保留为可执行候选', async (t) => {
  const user = TEST_USER + '-online-kind';
  const name = '同名在线 Agent';
  const clientId = user + '-client';
  t.after(async () => {
    await prisma.execution.deleteMany({ where: { user } });
    await prisma.evaluationAssetVersion.deleteMany({ where: { user } });
    await prisma.reliabilityClient.deleteMany({ where: { user } });
  });
  await prisma.evaluationAssetVersion.create({ data: { user, kind: 'target', assetKey: 'skill-only', name, version: 1, contentJson: JSON.stringify({ type: 'skill' }), contentHash: 'skill-only' } });
  await prisma.execution.create({ data: { user, agentName: name, framework: 'evaluation-harness', query: 'q' } });
  await prisma.reliabilityClient.create({ data: { user, clientId, name: '测试客户端', status: 'online', lastSeenAt: new Date(), capabilitiesJson: JSON.stringify({ platforms: [{ id: 'opencode', agents: [name], actions: ['RUN_EXPERIMENT_CASE'], runExperimentCase: { version: 1, returnsTraceId: true } }] }) } });
  const response = await listExperimentAgents(new Request('http://localhost/api/experiments/agents?user=' + encodeURIComponent(user)));
  assert.equal(response.status, 200);
  const { agents } = await response.json();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].name, name);
  assert.equal(agents[0].traces, 0);
  assert.equal(agents[0].executable, true);
  assert.equal(agents[0].targets[0].workerId, clientId);
});
