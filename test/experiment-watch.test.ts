import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

let prisma: typeof import('../src/lib/storage/prisma')['prisma'];
let createWatcher: typeof import('../src/lib/engine/experiment/experiment-watch')['createExperimentWatcher'];
let engine: typeof import('../src/lib/engine/experiment/run-experiment');
let root: string;
const enabledAt = new Date('2026-09-20T03:00:00Z');
const startedAt = new Date('2026-09-20T03:01:00Z');
const endedAt = new Date('2026-09-20T03:02:00Z');

test.before(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'experiment-watch-'));
  process.env.AGENT_INSIGHT_DATA_DIR = root;
  process.env.DATABASE_URL = `file:${path.join(root, 'test.db')}`;
  process.env.DB_HOST = '';
  writeFileSync(path.join(root, 'test.db'), '');
  execFileSync(process.execPath, [
    path.resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate',
    '--schema', path.resolve('prisma/schema.prisma'),
  ], { env: process.env, stdio: 'pipe', timeout: 60_000 });
  ({ prisma } = await import('../src/lib/storage/prisma'));
  ({ createExperimentWatcher: createWatcher } = await import('../src/lib/engine/experiment/experiment-watch'));
  engine = await import('../src/lib/engine/experiment/run-experiment');
});

test.beforeEach(async () => {
  await prisma.experiment.deleteMany();
  await prisma.execution.deleteMany();
  await prisma.session.deleteMany();
});

test.after(async () => {
  await prisma?.$disconnect();
  if (root) rmSync(root, { recursive: true, force: true });
});

async function experiment(overrides: Record<string, unknown> = {}) {
  return prisma.experiment.create({ data: {
    name: 'watch test', user: 'alice', agentName: 'agent-a',
    watchMode: true, watchEnabledAt: enabledAt,
    evaluatorIdsJson: '["preset-agent-trace-quality"]', ...overrides,
  } });
}

async function trace(id: string, overrides: Record<string, unknown> = {}, session: Record<string, unknown> = {}) {
  const execution = await prisma.execution.create({ data: {
    id, taskId: id, user: 'alice', agentName: 'agent-a', framework: 'opencode',
    timestamp: startedAt, query: 'input from trace', finalResult: 'output from trace',
    ...overrides,
  } });
  await prisma.session.create({ data: {
    taskId: id, user: 'alice', startTime: startedAt, endTime: endedAt,
    interactions: '[{"role":"user","content":"input from trace"},{"role":"assistant","content":"output from trace"}]',
    ...session,
  } });
  return execution;
}

function recorder(options: Parameters<typeof createWatcher>[0] = {}) {
  const calls: { experimentId: string; caseId: string; user: string }[] = [];
  const watcher = createWatcher({
    ...options,
    evaluate: async (experimentId, caseId, user) => {
      calls.push({ experimentId, caseId, user });
      return [];
    },
  });
  return { calls, watcher };
}

test('watch: 所有框架的已完成主 Trace 走同一入口，无需下一次上传', async () => {
  await experiment();
  for (const framework of ['opencode', 'actrail', 'hermes', 'another-framework']) {
    await trace(framework, { framework });
  }
  const { watcher, calls } = recorder();
  await watcher.scan();
  await watcher.waitForIdle();
  assert.equal(calls.length, 4);
  const cases = await prisma.experimentCase.findMany();
  assert.deepEqual(cases.map((c: { executionId: string }) => c.executionId).sort(),
    ['opencode', 'actrail', 'hermes', 'another-framework'].sort());
  assert.ok(cases.every((c: { input: string; actualOutput: string }) => c.input === '' && c.actualOutput === ''));
});

test('watch: 排除旧任务、时间相等、执行中、超时、失败、其他用户/Agent 和子 Agent', async () => {
  await experiment();
  await trace('old', {}, { startTime: new Date(enabledAt.getTime() - 1) });
  await trace('equal', {}, { startTime: enabledAt });
  await trace('running', { lastIngestedAt: new Date() }, { endTime: null });
  await trace('timed-out', { lastIngestedAt: enabledAt }, { endTime: null });
  await trace('failed', { framework: 'actrail', failures: '[{"failure_type":"agent-process-exit"}]' });
  await trace('other-user', { user: 'bob' }, { user: 'bob' });
  await trace('unowned', { user: null });
  await trace('other-agent', { agentName: 'agent-b' });
  await trace('child', { isSubagent: true });
  await trace('eligible');
  const { watcher, calls } = recorder();
  await watcher.scan();
  await watcher.waitForIdle();
  assert.equal(calls.length, 1);
  assert.equal((await prisma.experimentCase.findFirst()).executionId, 'eligible');
});

test('watch: 分页绕回能发现延迟上传和后续完成的 Trace，启动新实例也能补扫', async () => {
  await experiment();
  await trace('a-running', {}, { endTime: null });
  await trace('b-complete');
  await trace('c-complete');
  const { watcher, calls } = recorder({ pageSize: 1 });
  await watcher.scan();
  await watcher.waitForIdle();
  await watcher.scan();
  await watcher.waitForIdle();
  assert.equal(calls.length, 2);
  await trace('a-late-upload', { timestamp: new Date() });
  await prisma.session.update({ where: { taskId: 'a-running' }, data: { endTime: endedAt } });
  await watcher.scan();
  await watcher.scan();
  await watcher.waitForIdle();
  const restarted = recorder();
  await restarted.watcher.scan();
  await restarted.watcher.waitForIdle();
  assert.equal(await prisma.experimentCase.count(), 4);
  assert.equal(calls.length + restarted.calls.length, 4);
});

test('watch: 无开始时间使用 Session 首次入库默认值，补传不刷新', async () => {
  const first = await prisma.session.create({ data: { taskId: 'fallback', user: 'alice' } });
  await experiment({ watchEnabledAt: new Date(first.startTime.getTime() - 1) });
  await prisma.execution.create({ data: {
    id: 'fallback', taskId: 'fallback', user: 'alice', agentName: 'agent-a',
    timestamp: new Date('2020-01-01'),
  } });
  const { db } = await import('../src/lib/storage/prisma');
  await db.upsertSession('fallback', { taskId: 'fallback' }, { endTime: new Date(), interactions: '[]' });
  const { watcher, calls } = recorder();
  await watcher.scan();
  await watcher.waitForIdle();
  assert.equal(calls.length, 1);
  const updated = await prisma.session.findUnique({ where: { taskId: 'fallback' } });
  assert.equal(updated.startTime.getTime(), first.startTime.getTime());
});

test('watch: 通用入库保留首次时间，显式开始时间优先于上传时间', async () => {
  const { saveExecutionRecord } = await import('../src/lib/storage/data-service');
  const base = {
    user: 'alice', agentName: 'agent-a', framework: 'opencode', skip_evaluation: true,
    interactions: [{ role: 'user', content: 'hello' }],
  };
  await saveExecutionRecord({ ...base, task_id: 'persisted-fallback' });
  const first = await prisma.session.findUnique({ where: { taskId: 'persisted-fallback' } });
  await experiment({ watchEnabledAt: new Date(first.startTime.getTime() - 1) });
  await saveExecutionRecord({ ...base, task_id: 'persisted-fallback', timestamp: new Date(), trace_completed_at: new Date() });
  await saveExecutionRecord({
    ...base, task_id: 'explicit-old', timestamp: new Date(),
    trace_started_at: enabledAt, trace_completed_at: new Date(),
  });
  const after = await prisma.session.findUnique({ where: { taskId: 'persisted-fallback' } });
  assert.equal(after.startTime.getTime(), first.startTime.getTime());
  assert.equal((await prisma.session.findUnique({ where: { taskId: 'explicit-old' } })).startTime.getTime(), enabledAt.getTime());
  const { watcher, calls } = recorder();
  await watcher.scan();
  await watcher.waitForIdle();
  assert.equal(calls.length, 1);
  assert.equal((await prisma.experimentCase.findFirst()).taskId, 'persisted-fallback');
});

test('watch: 重复/并发扫描只新增一次，同一个 Trace 可进入多个实验', async () => {
  await experiment();
  await experiment();
  await trace('shared');
  const a = recorder();
  const b = recorder();
  await Promise.all([a.watcher.scan(), b.watcher.scan(), a.watcher.scan()]);
  await Promise.all([a.watcher.waitForIdle(), b.watcher.waitForIdle()]);
  await a.watcher.scan();
  await a.watcher.waitForIdle();
  assert.equal(await prisma.experimentCase.count(), 2);
  assert.equal(a.calls.length + b.calls.length, 2);
});

test('watch: 手动已选 Trace（包括只有 executionId）不重评、不覆盖人工评分', async () => {
  const exp = await experiment();
  await trace('manual');
  const c = await prisma.experimentCase.create({ data: { experimentId: exp.id, executionId: 'manual' } });
  const result = await prisma.experimentEvalResult.create({ data: {
    experimentId: exp.id, caseId: c.id, evaluatorId: 'preset-agent-trace-quality',
    status: 'done', score: 70, humanScore: 95, humanReason: '人工修正', humanBy: 'alice',
  } });
  const { watcher, calls } = recorder();
  await watcher.scan();
  await watcher.waitForIdle();
  assert.equal(calls.length, 0);
  assert.deepEqual(await prisma.experimentEvalResult.findUnique({ where: { id: result.id } }), result);
});

test('watch: 慢评估器不阻塞扫描，限制并发且停止监听后不接纳新 Trace', async () => {
  const exp = await experiment();
  for (let i = 0; i < 4; i++) await trace(`slow-${i}`);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const watcher = createWatcher({ concurrency: 2, evaluate: async () => {
    calls++;
    await held;
    return [];
  } });
  await watcher.scan();
  assert.equal(calls, 2);
  await watcher.scan();
  assert.equal(calls, 2);
  await prisma.experiment.update({ where: { id: exp.id }, data: { watchMode: false, watchEnabledAt: null } });
  release();
  await watcher.waitForIdle();
  await watcher.scan();
  assert.equal(calls, 2);
  assert.equal(await prisma.experimentCase.count(), 2);
});

test('watch: 实际复用评测引擎读取 Trace 和正常重试，不改原始执行状态', async () => {
  await experiment();
  await trace('retry');
  const before = await prisma.session.findUnique({ where: { taskId: 'retry' } });
  const executionBefore = await prisma.execution.findUnique({ where: { id: 'retry' } });
  const { setFaithfulPresetRunnerForTest } = await import('../src/lib/engine/experiment/faithful-preset-evaluators');
  const delays = engine.experimentEngineConfig.retryDelaysMs;
  engine.experimentEngineConfig.retryDelaysMs = [0, 0];
  let calls = 0;
  setFaithfulPresetRunnerForTest(async (_id, _user, context) => {
    calls++;
    assert.equal(context.caseInput, 'input from trace');
    assert.equal(context.actualOutput, 'output from trace');
    assert.equal(context.interactions.length, 2);
    if (calls === 1) throw new Error('timeout');
    return { score: 90, evidence: { md: 'ok' } };
  });
  try {
    const watcher = createWatcher();
    await watcher.scan();
    await watcher.waitForIdle();
    const result = await prisma.experimentEvalResult.findFirst();
    assert.equal(result.status, 'done');
    assert.equal(result.attempts, 2);
    await watcher.scan();
    await watcher.waitForIdle();
    assert.equal(calls, 2);
    assert.deepEqual(await prisma.session.findUnique({ where: { taskId: 'retry' } }), before);
    assert.equal(JSON.stringify(await prisma.execution.findUnique({ where: { id: 'retry' } })), JSON.stringify(executionBefore));
  } finally {
    setFaithfulPresetRunnerForTest(null);
    engine.experimentEngineConfig.retryDelaysMs = delays;
  }
});

test('watch: 评估器失败保持现有失败结果，扫描不会额外重试', async () => {
  await experiment();
  await trace('eval-failure');
  const { setFaithfulPresetRunnerForTest } = await import('../src/lib/engine/experiment/faithful-preset-evaluators');
  let calls = 0;
  setFaithfulPresetRunnerForTest(async () => { calls++; throw new Error('invalid evaluator configuration'); });
  try {
    const watcher = createWatcher();
    await watcher.scan();
    await watcher.waitForIdle();
    assert.equal((await prisma.experimentEvalResult.findFirst()).status, 'failed');
    await watcher.scan();
    await watcher.waitForIdle();
    assert.equal(calls, 1);
  } finally {
    setFaithfulPresetRunnerForTest(null);
  }
});

test('watch: 并发追加通过数据库主键只产生一个新增结果，手动追加仍可复用并回填', async () => {
  const exp = await experiment();
  const input = { taskId: 'same-task', input: 'q', actualOutput: 'a' };
  const ids = await Promise.all(Array.from({ length: 12 }, () =>
    engine.addEvalExperimentCase(exp.id, input, { onlyIfNew: true })));
  assert.equal(ids.filter(Boolean).length, 1);
  assert.equal(await prisma.experimentCase.count(), 1);
  const manualId = await engine.addEvalExperimentCase(exp.id, { ...input, referenceOutput: 'reference' });
  assert.equal(manualId, ids.find(Boolean));
  assert.equal((await prisma.experimentCase.findUnique({ where: { id: manualId } })).referenceOutput, 'reference');
});

test('watch: 定时器重复启动只注册一次，无请求也会发现新 Trace', async () => {
  await experiment();
  let resolve!: () => void;
  const found = new Promise<void>(done => { resolve = done; });
  let calls = 0;
  const watcher = createWatcher({ intervalMs: 10, evaluate: async () => {
    calls++;
    resolve();
    return [];
  } });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    watcher.start();
    watcher.start();
    await trace('background');
    await Promise.race([
      found,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('watcher did not poll')), 2_000); }),
    ]);
    await watcher.waitForIdle();
    assert.equal(calls, 1);
  } finally {
    watcher.stop();
    if (timeout) clearTimeout(timeout);
  }
});
