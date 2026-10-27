import assert from 'node:assert/strict';
import test from 'node:test';
import { createIsolatedDatabase } from './helpers/isolated-database';

const database = createIsolatedDatabase();
const { prisma } = require('@/lib/storage/prisma') as typeof import('@/lib/storage/prisma');
const { GET: listAgents } = require('@/app/api/experiments/agents/route') as typeof import('@/app/api/experiments/agents/route');
const { normalizeExecutionConfig, describeProfile } = require('../packages/benchmark-protocol/execution.cjs');

test.after(async () => { await prisma.$disconnect(); database.dispose(); });

async function fixture(t: import('node:test').TestContext, options: { ready?: boolean; generic?: boolean; offline?: boolean } = {}) {
  const clientId = `readiness-${t.name}`;
  const config = normalizeExecutionConfig({ profiles: { 'xgovernor-local-docker': {
    sourceRevision: 'a'.repeat(40),
    runtimes: { 'pi-agent': { kind: 'pi', namespace: 'runtime_pi', agents: ['pi-agent'] } },
  } } });
  await prisma.reliabilityClient.create({ data: {
    clientId, user: clientId, name: 'readiness host', hostname: 'benchmark-host',
    status: 'online', serviceHealth: 'healthy',
    lastSeenAt: new Date(options.offline ? Date.now() - 86_400_000 : Date.now()),
    capabilitiesJson: JSON.stringify({
      actions: ['RUN_BENCHMARK_CASE', ...(options.generic ? ['RUN_EXPERIMENT_CASE'] : [])],
      platforms: [{ id: 'pi-agent', agents: ['pi-agent'], models: ['provider/model'],
        runBenchmarkCase: { version: 1, returnsTraceId: true },
        ...(options.generic ? { runExperimentCase: { version: 2, returnsTraceId: true } } : {}),
      }],
      components: Object.fromEntries(['execution-backend/v1', 'git-workspace/v1', 'git-patch/v1'].map(key => [key, { ready: true }])),
      executionProfiles: [{ profile: describeProfile('xgovernor-local-docker', config.profiles['xgovernor-local-docker']),
        benchmarks: ['swe-bench'], ready: Boolean(options.ready),
        ...(!options.ready ? { note: 'Docker 或 cgroup v2 未就绪' } : {}),
      }],
    }),
  } });
  t.after(async () => { await prisma.reliabilityClient.deleteMany({ where: { clientId } }); });
  const response = await listAgents(new Request(`http://localhost/api/experiments/agents?user=${encodeURIComponent(clientId)}`));
  assert.equal(response.status, 200);
  const body = await response.json();
  const agent = body.agents.find((item: { name: string }) => item.name === 'pi-agent');
  assert.ok(agent, 'Unready Benchmark-only clients must remain visible for diagnosis');
  assert.equal(agent.targets.length, 1);
  return agent;
}

test('unready Benchmark-only host exposes cgroup reason without becoming executable', async t => {
  const agent = await fixture(t);
  assert.equal(agent.executable, false);
  const [target] = agent.targets;
  assert.equal(target.host, 'benchmark-host');
  assert.equal(target.supportsBenchmark, false);
  assert.deepEqual(target.benchmarkKeys, []);
  assert.equal(target.benchmarkEnvironments, undefined);
  assert.equal(target.benchmarkUnavailableReasons['swe-bench'], 'Docker 或 cgroup v2 未就绪');
});

test('generic Trace capability remains usable when Benchmark sandbox is unready', async t => {
  const agent = await fixture(t, { generic: true });
  assert.equal(agent.executable, true);
  assert.equal(agent.targets[0].supportsGenericTrace, true);
  assert.equal(agent.targets[0].supportsBenchmark, false);
  assert.equal(agent.targets[0].benchmarkUnavailableReasons['swe-bench'], 'Docker 或 cgroup v2 未就绪');
});

test('offline Benchmark host retains its unavailable reasons without selectable environment', async t => {
  const agent = await fixture(t, { ready: true, offline: true });
  assert.equal(agent.executable, false);
  assert.equal(agent.targets[0].supportsBenchmark, false);
  assert.match(agent.targets[0].benchmarkUnavailableReasons['swe-bench'], /客户端状态不可用：offline/);
  assert.equal(agent.targets[0].benchmarkEnvironments, undefined);
});

test('healthy Benchmark host exposes selectable environment and no unavailable reason', async t => {
  const agent = await fixture(t, { ready: true });
  assert.equal(agent.executable, true);
  const [target] = agent.targets;
  assert.equal(target.supportsBenchmark, true);
  assert.deepEqual(target.benchmarkKeys, ['swe-bench']);
  assert.equal(target.benchmarkUnavailableReasons['swe-bench'], undefined);
  assert.match(target.benchmarkUnavailableReasons['zsoft-l1'], /缺少 zsoft-tasks-workspace/);
  assert.equal(target.benchmarkUnavailableReason, null);
  assert.equal(target.benchmarkEnvironments['swe-bench'].profile.key, 'xgovernor-local-docker');
});
