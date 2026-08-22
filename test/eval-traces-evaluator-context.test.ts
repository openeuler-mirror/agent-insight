/** Trace 评测 API 传递并持久化 Tool/Skill 上下文的最小集成测试。 */
import path from 'node:path';
process.env.DATABASE_URL = `file:${path.resolve(__dirname, '../data/witty_insight.db')}`;

import assert from 'node:assert/strict';
import test from 'node:test';
import { POST as evaluateTraces } from '@/app/api/experiments/eval-traces/route';
import { setJudgeLlmCallerForTest } from '@/lib/engine/experiment/judge-llm';
import { setFaithfulPresetRunnerForTest } from '@/lib/engine/experiment/faithful-preset-evaluators';
import { retryResultRow } from '@/lib/engine/experiment/run-experiment';
import { prisma } from '@/lib/storage/prisma';

const TEST_USER = `eval-traces-context-${Date.now()}`;

test.after(async () => {
  setJudgeLlmCallerForTest(null);
  setFaithfulPresetRunnerForTest(null);
  await prisma.experiment.deleteMany({ where: { user: TEST_USER } });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`condition not met within ${timeoutMs}ms`);
}

test('eval-traces 将 pair 的 Tool/Skill 目录传给评估器并写入 case', async () => {
  let seen: unknown = null;
  setJudgeLlmCallerForTest(async (_user, request) => {
    seen = JSON.parse(request.user).evaluation_input.capability_catalog;
    return JSON.stringify({
      dimensions: [
        { dimension: 'tool_necessity', verdict: 'met', reason: '调用服务于任务', suggestion: '' },
        { dimension: 'tool_match', verdict: 'met', reason: '能力与任务匹配', suggestion: '' },
        { dimension: 'parameter_validity', verdict: 'met', reason: '参数有上下文依据', suggestion: '' },
        { dimension: 'result_utilization', verdict: 'met', reason: '结果得到使用', suggestion: '' },
        { dimension: 'call_order', verdict: 'met', reason: '调用顺序满足依赖', suggestion: '' },
      ],
      issues: [],
      suggestions: [],
    });
  });
  const evaluatorContext = {
    schemaVersion: 1,
    availableTools: [{ name: 'search', inputSchema: { type: 'object' } }],
    availableSkills: [{ name: 'research_playbook', description: '检索后归纳资料' }],
  };
  const response = await evaluateTraces(new Request(
    'http://localhost/api/experiments/eval-traces',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: TEST_USER,
        evaluators: ['preset-agent-tool-selection'],
        pairs: [{ caseId: 'dataset-case-1', taskId: 'trace-task-1', evaluatorContext }],
      }),
    },
  ));

  assert.equal(response.status, 202);
  await waitFor(async () => seen !== null);
  assert.deepEqual(seen, [
    { kind: 'tool', name: 'search', description: '', inputSchema: { type: 'object' } },
    { kind: 'skill', name: 'research_playbook', description: '检索后归纳资料' },
  ]);
  const stored = await prisma.experimentCase.findFirst({
    where: { experiment: { user: TEST_USER }, taskId: 'trace-task-1' },
  });
  assert.deepEqual(JSON.parse(stored!.evaluatorContextJson!), evaluatorContext);
  await waitFor(async () => (
    await prisma.experimentEvalResult.findFirst({ where: { caseId: stored!.id } })
  )?.status === 'done');
});

test('eval-traces 批量提交立即预创建全部 case/result，后台完成前保持 running', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  setFaithfulPresetRunnerForTest(async () => {
    await gate;
    return { score: 80, points: [], evidence: { md: 'batch test' } };
  });

  const taskIds = ['batch-trace-1', 'batch-trace-2', 'batch-trace-3'];
  const responsePromise = evaluateTraces(new Request(
    'http://localhost/api/experiments/eval-traces',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: TEST_USER,
        name: '批量异步评测测试',
        evaluators: ['preset-agent-task-completion', 'preset-agent-trace-quality'],
        taskIds,
      }),
    },
  ));

  const returnedQuickly = await Promise.race([
    responsePromise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
  ]);
  const experiment = await prisma.experiment.findFirst({
    where: { user: TEST_USER, name: '批量异步评测测试' },
    include: { cases: true },
  });
  const initialRows = experiment
    ? await prisma.experimentEvalResult.findMany({ where: { experimentId: experiment.id } })
    : [];

  release();
  const response = await responsePromise;

  assert.equal(returnedQuickly, true);
  assert.equal(response.status, 202);
  assert.equal(experiment!.status, 'running');
  assert.deepEqual(
    experiment!.cases.map((item: { taskId: string | null }) => item.taskId).sort(),
    [...taskIds].sort(),
  );
  assert.equal(initialRows.length, 6);
  assert.ok(initialRows.every((row: { status: string }) => row.status === 'pending' || row.status === 'running'));

  // 行先落 done，再 settleExperimentStatus 写实验终态；两者之间有短暂窗口，不能只等行。
  await waitFor(async () => {
    const [rows, settled] = await Promise.all([
      prisma.experimentEvalResult.findMany({ where: { experimentId: experiment!.id } }),
      prisma.experiment.findUnique({ where: { id: experiment!.id }, select: { status: true } }),
    ]);
    return rows.length === 6
      && rows.every((row: { status: string }) => row.status === 'done')
      && settled?.status === 'done';
  });
  const settled = await prisma.experiment.findUnique({ where: { id: experiment!.id } });
  assert.equal(settled!.status, 'done');
  setFaithfulPresetRunnerForTest(null);
});

test('eval-traces 重复提交同一实验和 Trace 时不重复执行结果行', async () => {
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  setFaithfulPresetRunnerForTest(async () => {
    calls += 1;
    await gate;
    return { score: 90, points: [], evidence: { md: 'deduplicated' } };
  });

  const createResponse = await evaluateTraces(new Request(
    'http://localhost/api/experiments/eval-traces',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: TEST_USER,
        name: '重复提交防重测试',
        evaluators: ['preset-agent-task-completion'],
        createOnly: true,
      }),
    },
  ));
  const created = await createResponse.json();
  assert.equal(createResponse.status, 200);

  const submit = () => evaluateTraces(new Request(
    'http://localhost/api/experiments/eval-traces',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: TEST_USER,
        experimentId: created.experimentId,
        evaluators: ['preset-agent-task-completion'],
        taskIds: ['duplicate-trace-1'],
      }),
    },
  ));

  const first = await submit();
  assert.equal(first.status, 202);
  await waitFor(async () => calls >= 1);
  const second = await submit();
  assert.equal(second.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const callsBeforeRelease = calls;
  release();

  const experiment = await prisma.experiment.findUnique({
    where: { id: created.experimentId },
    include: { cases: true },
  });
  await waitFor(async () => (
    await prisma.experimentEvalResult.findFirst({ where: { experimentId: created.experimentId } })
  )?.status === 'done');
  const rows = await prisma.experimentEvalResult.findMany({
    where: { experimentId: created.experimentId },
  });

  assert.equal(callsBeforeRelease, 1);
  assert.equal(experiment!.cases.length, 1);
  assert.equal(rows.length, 1);
  setFaithfulPresetRunnerForTest(null);
});

test('并行提交多个评测任务时共用同一个行级并发上限', async () => {
  let active = 0;
  let maxActive = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  setFaithfulPresetRunnerForTest(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await gate;
    active -= 1;
    return { score: 85, points: [], evidence: { md: 'shared limiter' } };
  });

  const createExperiment = async (name: string) => {
    const response = await evaluateTraces(new Request(
      'http://localhost/api/experiments/eval-traces',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user: TEST_USER,
          name,
          evaluators: ['preset-agent-task-completion'],
          createOnly: true,
        }),
      },
    ));
    return response.json();
  };
  const [firstExperiment, secondExperiment] = await Promise.all([
    createExperiment('共享并发上限 A'),
    createExperiment('共享并发上限 B'),
  ]);
  const submit = (experimentId: string, prefix: string) => evaluateTraces(new Request(
    'http://localhost/api/experiments/eval-traces',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: TEST_USER,
        experimentId,
        evaluators: ['preset-agent-task-completion'],
        taskIds: [`${prefix}-1`, `${prefix}-2`, `${prefix}-3`],
      }),
    },
  ));

  const [firstResponse, secondResponse] = await Promise.all([
    submit(firstExperiment.experimentId, 'shared-a'),
    submit(secondExperiment.experimentId, 'shared-b'),
  ]);
  assert.equal(firstResponse.status, 202);
  assert.equal(secondResponse.status, 202);
  await waitFor(async () => active === 4);
  const observedMax = maxActive;
  release();

  await waitFor(async () => {
    const rows = await prisma.experimentEvalResult.findMany({
      where: { experimentId: { in: [firstExperiment.experimentId, secondExperiment.experimentId] } },
    });
    return rows.length === 6 && rows.every((row) => row.status === 'done');
  });
  assert.equal(observedMax, 4);
  assert.equal(maxActive, 4);
  setFaithfulPresetRunnerForTest(null);
});

test('运行中单项重评复用已有执行，不会绕过防重护栏', async () => {
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  setFaithfulPresetRunnerForTest(async () => {
    calls += 1;
    await gate;
    return { score: 88, points: [], evidence: { md: 'retry reuse' } };
  });

  const response = await evaluateTraces(new Request(
    'http://localhost/api/experiments/eval-traces',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: TEST_USER,
        name: '运行中重评防重测试',
        evaluators: ['preset-agent-task-completion'],
        taskIds: ['retry-running-trace'],
      }),
    },
  ));
  const data = await response.json();
  await waitFor(async () => calls === 1);
  const row = await prisma.experimentEvalResult.findFirst({
    where: { experimentId: data.experimentId },
    select: { id: true },
  });
  const retryPromise = retryResultRow(data.experimentId, row!.id, TEST_USER);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const callsBeforeRelease = calls;
  release();

  assert.equal(await retryPromise, 'done');
  assert.equal(callsBeforeRelease, 1);
  assert.equal(calls, 1);
  setFaithfulPresetRunnerForTest(null);
});
