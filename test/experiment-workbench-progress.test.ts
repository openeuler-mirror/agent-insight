import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';

let prisma: typeof import('@/lib/storage/prisma')['prisma'];
let getExperiment: typeof import('@/app/api/experiments/[id]/route')['GET'];
test.before(async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-progress-'));
  writeFileSync(path.join(root, 'test.db'), '');
  process.env.AGENT_INSIGHT_HOME = root;
  delete process.env.AGENT_INSIGHT_DATA_DIR;
  process.env.DATABASE_URL = `file:${path.join(root, 'test.db')}`;
  execFileSync(process.execPath, [path.resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', path.resolve('prisma/schema.prisma')], { env: process.env, stdio: 'pipe', timeout: 60_000 });
  ({ prisma } = await import('@/lib/storage/prisma'));
  ({ GET: getExperiment } = await import('@/app/api/experiments/[id]/route'));
});
test.after(async () => { await prisma?.$disconnect(); });

test('触发路由结果直接校验客户端证据，失败和模型不一致不算未触发', async () => {
  const { readTriggerDecision } = await import('@/lib/engine/experiment/trace-generation');
  const facts = {
    state: 'AGENT_EXITED', eventMonitorReady: true, modelActivityObserved: true,
    timedOut: false, exitCode: 0,
    triggerDecision: {
      triggered: false, targetSkillName: 'target-skill', competingSkill: null,
      sessionId: 'ses-route', actualModel: 'csi-provider/GLM-5.2', endReason: 'completed',
    },
  };
  const read = (changes: Record<string, unknown> = {}) => readTriggerDecision(JSON.stringify({ ...facts, ...changes }), 'target-skill', 'csi-provider/GLM-5.2');
  assert.equal(read().triggered, false);
  assert.equal(read({ exitCode: 143, signal: 'SIGTERM', triggerDecision: { ...facts.triggerDecision, triggered: true, endReason: 'skill_loaded' } }).triggered, true);
  for (const changes of [
    { eventMonitorReady: false }, { modelActivityObserved: false }, { timedOut: true },
    { exitCode: 1 }, { signal: 'SIGTERM' }, { failureDetectedAt: 'now' },
  ]) assert.throws(() => read(changes), { code: 'TRIGGER_EVIDENCE_MISSING' });
  assert.throws(() => read({ triggerDecision: { ...facts.triggerDecision, actualModel: 'other/model' } }), { code: 'MODEL_MISMATCH' });
});

test('触发分析开始执行前显示全部 Case，重复准备和删除不会增加或复活 Case', async () => {
  const { triggerExperimentCaseData, ensureTriggerExperimentCases } = await import('@/lib/skill-workbench/trigger-execution');
  const user = 'trigger-prepared-cases';
  const datasetId = 'trigger-dataset';
  const cases = Array.from({ length: 18 }, (_, index) => ({ id: `trigger-case-${index}`, input: `input ${index}`, values: { should_trigger: index < 12 } }));
  const experiment = await prisma.experiment.create({ data: {
    user, name: 'prepare all trigger cases', scope: 'skill-workbench', preset: 'trigger', status: 'running',
    evaluatorIdsJson: '["skill-trigger-analyzer"]',
    configSnapshotJson: JSON.stringify({ caseIds: cases.map((item) => item.id), datasetId, executionSides: ['b'], repeatRounds: 1 }),
  } });
  await prisma.experimentCase.createMany({ data: triggerExperimentCaseData(experiment.id, datasetId, cases) });
  const prepared = await ensureTriggerExperimentCases(user, experiment.id, datasetId, cases);
  assert.equal(prepared.size, 18);
  const load = async () => (await getExperiment(new Request(`http://localhost/api/experiments/${experiment.id}?user=${user}`), { params: Promise.resolve({ id: experiment.id }) })).json();
  const initial = await load();
  assert.equal(initial.caseTotal, 18);
  assert.equal(initial.cases.length, 18);
  assert.ok(initial.cases.every((row: { traceStatus: string; traceAttemptNo: number | null }) => row.traceStatus === 'pending' && row.traceAttemptNo === null));
  assert.equal(await prisma.experimentTraceAttempt.count({ where: { experimentId: experiment.id } }), 0);
  const decidedId = prepared.get(cases[4].id)!;
  const decidedCase = await prisma.experimentCase.findUniqueOrThrow({ where: { id: decidedId } });
  await prisma.experimentCase.update({ where: { id: decidedId }, data: {
    actualOutput: 'Skill 未触发',
    caseValuesJson: JSON.stringify({ ...JSON.parse(decidedCase.caseValuesJson || '{}'), skill_triggered: false, routing_model: 'csi-provider/GLM-5.2' }),
  } });
  await prisma.experimentTraceAttempt.create({ data: {
    experimentId: experiment.id, caseId: decidedId, attemptNo: 1, workerId: 'worker',
    platform: 'opencode', agent: 'build', model: 'csi-provider/GLM-5.2', timeoutSeconds: 30,
    status: 'ready', finishedAt: new Date(),
  } });
  const decided = await load();
  assert.equal(decided.cases.find((row: { id: string }) => row.id === decidedId).traceStatus, 'ready');
  assert.equal(decided.cases.find((row: { id: string }) => row.id === decidedId).actualModel, 'csi-provider/GLM-5.2');
  await prisma.experimentCase.update({ where: { id: prepared.get(cases[2].id)! }, data: {
    actualOutput: '执行失败：客户端连接中断', traceGenerationError: '客户端连接中断',
  } });
  const failed = await load();
  const failedCase = failed.cases.find((row: { id: string }) => row.id === prepared.get(cases[2].id));
  assert.equal(failedCase.traceStatus, 'failed');
  assert.equal(failedCase.traceError, '客户端连接中断');
  assert.equal(failedCase.actualOutput, '执行失败：客户端连接中断');
  assert.equal(failed.cases.find((row: { id: string }) => row.id === prepared.get(cases[3].id)).traceStatus, 'pending');
  assert.deepEqual(await ensureTriggerExperimentCases(user, experiment.id, datasetId, cases), prepared);
  const deletedId = prepared.get(cases[0].id)!;
  await prisma.experimentCase.update({ where: { id: deletedId }, data: { deletedAt: new Date() } });
  await prisma.experimentCancellation.create({ data: {
    id: 'cancel-queued-trigger-case', user, experimentId: experiment.id, caseKey: `dataset:${cases[1].id}`,
  } });
  const afterDelete = await ensureTriggerExperimentCases(user, experiment.id, datasetId, cases);
  assert.equal(afterDelete.size, 16);
  assert.equal(afterDelete.has(cases[0].id), false);
  assert.equal(afterDelete.has(cases[1].id), false);
  assert.equal(await prisma.experimentCase.count({ where: { experimentId: experiment.id } }), 18);
});

test('触发分析已成功退出且有完整输出时不因 Session.endTime 缺失误报入库超时', async () => {
  const { findExecutionByTraceId, assertSkillExecutionOutput, assertTriggerExecutionEvidence } = await import('@/lib/engine/experiment/trace-generation');
  const user = `completed-trigger-${Date.now()}`;
  const traceId = `${user}-trace`;
  const workerId = 'trigger-client';
  await prisma.session.create({ data: {
    user, taskId: traceId, interactions: JSON.stringify([{ role: 'assistant', content: '已完成路由判断' }]),
  } });
  await prisma.execution.create({ data: {
    user, id: traceId, taskId: traceId, finalResult: '已完成路由判断', model: 'GLM-5.2',
    clientId: workerId, llmCallCount: 1, invokedSkills: '[]', isSubagent: false,
  } });
  const facts = { state: 'AGENT_EXITED', traceId, exitCode: 0, timedOut: false, modelActivityObserved: true };
  const command = (changes: Record<string, unknown> = {}, status = 'SUCCEEDED') => ({ status, resultJson: JSON.stringify({ ...facts, ...changes }) });
  assert.equal(await findExecutionByTraceId({ user, traceId }), null);
  const execution = await findExecutionByTraceId({ user, traceId, completedTriggerCommand: command() });
  assert.equal(execution?.id, traceId);
  assertSkillExecutionOutput(execution!, 'csi-provider/GLM-5.2');
  assertTriggerExecutionEvidence(execution!, workerId);
  for (const changes of [
    { state: 'TRACE_STARTED' }, { traceId: 'another-trace' }, { exitCode: 1 },
    { timedOut: true }, { signal: 'SIGKILL' }, { modelActivityObserved: false }, { failureDetectedAt: 'now' },
  ]) {
    assert.equal(await findExecutionByTraceId({ user, traceId, completedTriggerCommand: command(changes) }), null);
  }
  assert.equal(await findExecutionByTraceId({ user, traceId, completedTriggerCommand: command({}, 'FAILED') }), null);
  await prisma.execution.update({ where: { id: traceId }, data: { finalResult: '' } });
  assert.equal(await findExecutionByTraceId({ user, traceId, completedTriggerCommand: command() }), null);
  await prisma.session.update({ where: { taskId: traceId }, data: { endTime: new Date() } });
  assert.equal((await findExecutionByTraceId({ user, traceId }))?.id, traceId);
});

test('Skill 工作台实验使用冻结工作量，done 与 pending 不会同时出现', async (t) => {
  const stamp = Date.now();
  const user = `workbench-progress-${stamp}`;
  const task = await prisma.grayscaleTask.create({
    data: {
      user,
      skillId: `skill-${stamp}`,
      skillName: 'progress-skill',
      skillVersion: 1,
      skillVersionId: `version-${stamp}`,
      taskName: '固定进度测试',
      caseStatesJson: JSON.stringify({
        'dataset-case-1': { b: { runs: [{ status: 'pass', sessionId: 'session-1' }] } },
        'dataset-case-2': { b: { runs: [{ status: 'evaluating', sessionId: 'session-2' }] } },
      }),
    },
  });
  t.after(async () => {
    await prisma.experiment.deleteMany({ where: { user } });
    await prisma.grayscaleTask.deleteMany({ where: { id: task.id } });
  });
  const experiment = await prisma.experiment.create({
    data: {
      user,
      name: '固定进度测试',
      status: 'done',
      scope: 'skill-workbench',
      preset: 'use-case',
      evaluatorIdsJson: JSON.stringify(['preset-agent-task-completion', 'preset-agent-trace-quality']),
      configSnapshotJson: JSON.stringify({
        caseIds: ['dataset-case-1', 'dataset-case-2'],
        executionSides: ['b'],
        repeatRounds: 1,
        grayscaleTaskId: task.id,
      }),
    },
  });
  const experimentCase = await prisma.experimentCase.create({
    data: { experimentId: experiment.id, taskId: 'session-1' },
  });
  await prisma.experimentEvalResult.createMany({
    data: [
      { experimentId: experiment.id, caseId: experimentCase.id, evaluatorId: 'preset-agent-task-completion', status: 'done', score: 78 },
      { experimentId: experiment.id, caseId: experimentCase.id, evaluatorId: 'preset-agent-trace-quality', status: 'done', score: 86 },
    ],
  });

  const load = async () => {
    const response = await getExperiment(
      new Request(`http://localhost/api/experiments/${experiment.id}?user=${user}`),
      { params: Promise.resolve({ id: experiment.id }) },
    );
    return response.json();
  };
  const running = await load();
  assert.equal(running.status, 'running');
  assert.deepEqual(running.progress, { total: 4, done: 2, failed: 0, pending: 2 });
  assert.deepEqual(running.executionProgress, { total: 2, succeeded: 2, failed: 0, pending: 0 });
  assert.deepEqual(running.evaluationProgress, { total: 2, succeeded: 1, failed: 0, pending: 1, skipped: 0, unscored: 0 });

  await prisma.grayscaleTask.update({
    where: { id: task.id },
    data: {
      caseStatesJson: JSON.stringify({
        'dataset-case-1': { b: { runs: [{ status: 'pass', sessionId: 'session-1' }] } },
        'dataset-case-2': { b: { runs: [{ status: 'fail', failureType: 'agent_error' }] } },
      }),
    },
  });
  const completed = await load();
  assert.equal(completed.status, 'partial');
  assert.deepEqual(completed.progress, { total: 4, done: 2, failed: 2, pending: 0 });
  assert.deepEqual(completed.executionProgress, { total: 2, succeeded: 1, failed: 1, pending: 0 });
  assert.deepEqual(completed.evaluationProgress, { total: 2, succeeded: 1, failed: 0, pending: 0, skipped: 1, unscored: 0 });
});


test('触发分析返回独立的执行与判定进度', async (t) => {
  const user = `trigger-progress-${Date.now()}`;
  const evaluatorId = 'skill-trigger-analyzer';
  const task = await prisma.grayscaleTask.create({ data: {
    user, skillId: 'trigger-progress', skillName: 'trigger-progress', skillVersion: 1,
    skillVersionId: 'trigger-progress-v1', taskName: '触发进度',
    caseStatesJson: JSON.stringify({
      first: { b: { status: 'pass', evaluations: [{ evaluatorId, status: 'done', score: 100 }] } },
      second: { b: { status: 'executed' } },
    }),
  } });
  const experiment = await prisma.experiment.create({ data: {
    user, name: '触发进度', status: 'running', scope: 'skill-workbench', preset: 'trigger',
    evaluatorIdsJson: JSON.stringify([evaluatorId]),
    configSnapshotJson: JSON.stringify({ caseIds: ['first', 'second'], executionSides: ['b'], repeatRounds: 1, grayscaleTaskId: task.id }),
  } });
  t.after(async () => {
    await prisma.experiment.deleteMany({ where: { id: experiment.id } });
    await prisma.grayscaleTask.deleteMany({ where: { id: task.id } });
  });
  const response = await getExperiment(new Request(`http://localhost/api/experiments/${experiment.id}?user=${user}`), { params: Promise.resolve({ id: experiment.id }) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.executionProgress, { total: 2, succeeded: 2, failed: 0, pending: 0 });
  assert.deepEqual(result.evaluationProgress, { total: 2, succeeded: 1, failed: 0, pending: 1, skipped: 0, unscored: 0 });
  assert.equal(result.sideProgress, null);
});

test('A/B 两侧进度与汇总一致，失败评估器旁仍有运行项时保持运行中', async (t) => {
  const user = `ab-progress-${Date.now()}`;
  const task = await prisma.grayscaleTask.create({ data: {
    user, skillId: 'ab-progress', skillName: 'ab-progress', skillVersion: 1,
    skillVersionId: 'ab-progress-v1', taskName: '双侧进度',
    caseStatesJson: JSON.stringify({ case: {
      a: { runs: [{ runIndex: 1, status: 'pass' }, { runIndex: 2, status: 'evaluating', evaluations: [
        { evaluatorId: 'result', status: 'failed' }, { evaluatorId: 'trajectory', status: 'running' },
      ] }] },
      b: { runs: [{ runIndex: 1, status: 'pass' }, { runIndex: 2, status: 'fail', failureType: 'agent_error' }] },
    } }),
  } });
  const experiment = await prisma.experiment.create({ data: {
    user, name: '双侧进度', status: 'done', scope: 'skill-workbench', preset: 'skill-ab',
    evaluatorIdsJson: JSON.stringify(['result', 'trajectory']),
    configSnapshotJson: JSON.stringify({ caseIds: ['case'], executionSides: ['a', 'b'], repeatRounds: 2, grayscaleTaskId: task.id }),
  } });
  t.after(async () => {
    await prisma.experiment.deleteMany({ where: { id: experiment.id } });
    await prisma.grayscaleTask.deleteMany({ where: { id: task.id } });
  });
  const response = await getExperiment(new Request(`http://localhost/api/experiments/${experiment.id}?user=${user}`), { params: Promise.resolve({ id: experiment.id }) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, 'running');
  assert.equal(result.sideProgress.a.evaluationProgress.pending, 1);
  assert.equal(result.sideProgress.b.evaluationProgress.skipped, 1);
  for (const stage of ['executionProgress', 'evaluationProgress']) {
    for (const key of Object.keys(result[stage])) {
      assert.equal(result[stage][key], result.sideProgress.a[stage][key] + result.sideProgress.b[stage][key], `${stage}.${key}`);
    }
  }
});

test('无法读取会话消息时仍保存失败 Trace，保留真实结束时间与毫秒耗时', async () => {
  const { recordEvaluatorExecution } = await import('@/lib/engine/evaluation/evaluator-execution-recorder');
  const { getTraceLifecycle } = await import('@/lib/observe/trace-lifecycle');
  const taskId = `failed-trace-${Date.now()}`;
  await recordEvaluatorExecution({ listMessages: async () => { throw new Error('server closed'); } }, {
    taskId, agentName: 'build', user: 'failure-regression', query: '分析日志',
    failure: { code: 'MODEL_ERROR', message: 'Connection error.' },
    startedAt: '2026-09-25T06:41:14.000Z', completedAt: '2026-09-25T06:42:50.130Z',
  });
  const execution = await prisma.execution.findUniqueOrThrow({ where: { id: taskId } });
  const session = await prisma.session.findUniqueOrThrow({ where: { taskId } });
  assert.equal(execution.latency, 96130);
  assert.equal(execution.finalResult, null);
  assert.equal(session.endTime?.toISOString(), '2026-09-25T06:42:50.130Z');
  assert.equal(getTraceLifecycle(session.endTime, execution).traceStatus, 'failed');
  assert.match(execution.failures || '', /Connection error/);
});
