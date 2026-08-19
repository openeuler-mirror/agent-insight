// 对比实验 API 冒烟：POST 创建（type=llm + groups）→ POST 运行（type 分流）→ POST rescan。
// 覆盖：AC-002 分组落库 / AC-008 空组校验 / AC-017 增量补评 / type 缺省走单组（AC-019）。
// 落仓库 data/witty_insight.db（同 experiments-api.test.ts：钉住 DATABASE_URL）。
import path from 'node:path';
process.env.DATABASE_URL = `file:${path.resolve(__dirname, '../data/witty_insight.db')}`;

import assert from 'node:assert/strict';
import test from 'node:test';

import { prisma } from '@/lib/storage/prisma';
import { setJudgeLlmCallerForTest } from '@/lib/engine/experiment/judge-llm';
import { writeUserCustomEvaluators } from '@/server/user_evaluators_storage';
import { POST as createExperiment } from '@/app/api/experiments/route';
import { GET as getExperiment } from '@/app/api/experiments/[id]/route';
import { POST as runExperiment } from '@/app/api/experiments/[id]/run/route';
import { POST as rescanExperiment } from '@/app/api/experiments/[id]/rescan/route';
import { GET as getTraces } from '@/app/api/experiments/traces/route';

const TEST_USER = `cmp-api-${Date.now()}`;
const CUSTOM_LLM_ID = 'custom-cmp-api-judge';

test.before(async () => {
  await writeUserCustomEvaluators(TEST_USER, [{
    id: CUSTOM_LLM_ID, name: 'cmp-api-judge', description: '', evaluatorType: 'LLM',
    source: 'custom', targetTypes: [], objectives: [], scenarios: [], runMode: '', scoreRange: '',
    popularity: 0, mappedMetrics: [], status: 'ready', category: 'res',
    llmConfig: { model: 'test', systemPrompt: '评估 {{output}}', userPrompt: '' },
  }]);
});

test.after(async () => {
  await prisma.experiment.deleteMany({ where: { user: TEST_USER } }).catch(() => {});
  await prisma.customEvaluatorList.deleteMany({ where: { user: TEST_USER } }).catch(() => {});
  setJudgeLlmCallerForTest(null);
});

function postReq(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('AC-002: POST /api/experiments type=llm + groups → 创建实验+分组记录落库', async (t) => {
  const agent = `cmp-api-create-${Date.now()}`;
  // 为两组各建一条 trace（autoPairGroups 会查候选）
  const execIds: string[] = [];
  for (const [, model] of [['A', 'glm'], ['B', 'qwen']] as const) {
    const e = await prisma.execution.create({ data: { agentName: agent, model, query: 'q1', skill: 's', skillVersion: 1 } });
    execIds.push(e.id);
  }
  const res = await createExperiment(postReq('http://localhost/api/experiments', {
    user: TEST_USER, name: '对比实验冒烟', agentName: agent,
    type: 'llm', variableDimension: 'llm',
    groups: [{ key: 'A', value: 'glm' }, { key: 'B', value: 'qwen' }],
    evaluatorIds: [CUSTOM_LLM_ID],
  }));
  assert.equal(res.status, 200);
  const { id } = await res.json();
  t.after(async () => {
    await prisma.experiment.delete({ where: { id } }).catch(() => {});
    await prisma.execution.deleteMany({ where: { id: { in: execIds } } });
  });

  // 验证落库
  const exp = await prisma.experiment.findUnique({ where: { id }, include: { groups: true, cases: true } });
  assert.ok(exp);
  assert.equal(exp.type, 'llm');
  assert.equal(exp.groups.length, 2);
  // autoPairGroups 已为可比配对创建 case（1 query × 2 sides = 2 cases）
  assert.equal(exp.cases.length, 2);
});

test('AC-008: POST /api/experiments 某组无候选 trace → 400 + 指明哪组', async (t) => {
  const agent = `cmp-api-empty-${Date.now()}`;
  // 只建 A 组 trace，B 组无
  const e = await prisma.execution.create({ data: { agentName: agent, model: 'glm', query: 'q1' } });
  const res = await createExperiment(postReq('http://localhost/api/experiments', {
    user: TEST_USER, name: '空组实验', agentName: agent,
    type: 'llm', variableDimension: 'llm',
    groups: [{ key: 'A', value: 'glm' }, { key: 'B', value: 'qwen' }],
    evaluatorIds: [CUSTOM_LLM_ID],
  }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /B.*无.*trace|无.*匹配.*trace/i);
  t.after(async () => { await prisma.execution.delete({ where: { id: e.id } }).catch(() => {}); });
});

test('AC-019: POST /api/experiments 不带 type → 走单组路径（type=single）', async (t) => {
  const res = await createExperiment(postReq('http://localhost/api/experiments', {
    user: TEST_USER, name: '单组回归', agentName: 'single-agent',
    cases: [{ executionId: 'exec-1', taskId: 'task-1', input: 'q1', actualOutput: 'a1' }],
    evaluatorIds: ['preset-agent-trace-quality'],
  }));
  assert.equal(res.status, 200);
  const { id } = await res.json();
  t.after(async () => { await prisma.experiment.delete({ where: { id } }).catch(() => {}); });

  const exp = await prisma.experiment.findUnique({ where: { id } });
  assert.equal(exp!.type, 'single');
});

test('POST /api/experiments A/B 取值相同 → 400', async () => {
  const res = await createExperiment(postReq('http://localhost/api/experiments', {
    user: TEST_USER, name: '同值', agentName: 'same-agent',
    type: 'llm', variableDimension: 'llm',
    groups: [{ key: 'A', value: 'glm' }, { key: 'B', value: 'glm' }],
    evaluatorIds: [CUSTOM_LLM_ID],
  }));
  assert.equal(res.status, 400);
});

test('POST /api/experiments/[id]/run type=llm → 分流 startComparisonRun', async (t) => {
  setJudgeLlmCallerForTest(async () => JSON.stringify({ score: 80, points: [], evidence: { md: 'ok' } }));
  const agent = `cmp-api-run-${Date.now()}`;
  const execIds: string[] = [];
  for (const [, model] of [['A', 'glm'], ['B', 'qwen']] as const) {
    const e = await prisma.execution.create({ data: { agentName: agent, model, query: 'q1', skill: 's', skillVersion: 1 } });
    execIds.push(e.id);
  }
  const createRes = await createExperiment(postReq('http://localhost/api/experiments', {
    user: TEST_USER, name: '运行分流', agentName: agent,
    type: 'llm', variableDimension: 'llm',
    groups: [{ key: 'A', value: 'glm' }, { key: 'B', value: 'qwen' }],
    evaluatorIds: [CUSTOM_LLM_ID],
  }));
  const { id } = await createRes.json();
  t.after(async () => {
    await prisma.experiment.delete({ where: { id } }).catch(() => {});
    await prisma.execution.deleteMany({ where: { id: { in: execIds } } });
  });

  const runRes = await runExperiment(
    new Request(`http://localhost/api/experiments/${id}/run?user=${TEST_USER}`, { method: 'POST' }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(runRes.status, 200);
  const runBody = await runRes.json();
  assert.equal(runBody.status, 'running');
  // 等待后台完成（轮询 experiment.status）
  for (let i = 0; i < 30; i++) {
    const exp = await prisma.experiment.findUnique({ where: { id }, select: { status: true } });
    if (exp!.status === 'done' || exp!.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const finalExp = await prisma.experiment.findUnique({ where: { id }, select: { status: true } });
  assert.equal(finalExp!.status, 'done');
});

test('AC-017: POST /api/experiments/[id]/rescan 增量补评', async (t) => {
  setJudgeLlmCallerForTest(async () => JSON.stringify({ score: 80, points: [], evidence: { md: 'ok' } }));
  const agent = `cmp-api-rescan-${Date.now()}`;
  // 初始只有 A 组 trace
  const e1 = await prisma.execution.create({ data: { agentName: agent, model: 'glm', query: 'q1', skill: 's', skillVersion: 1 } });
  // create 会因 B 组无 trace 而抛 400 —— 改为先 create（用单组绕过），再手动改 type？
  // 实际流程：先建对比实验（需要两组 trace），所以这里先建两组
  const e2 = await prisma.execution.create({ data: { agentName: agent, model: 'qwen', query: 'q1', skill: 's', skillVersion: 1 } });
  const createRes = await createExperiment(postReq('http://localhost/api/experiments', {
    user: TEST_USER, name: '重扫测试', agentName: agent,
    type: 'llm', variableDimension: 'llm',
    groups: [{ key: 'A', value: 'glm' }, { key: 'B', value: 'qwen' }],
    evaluatorIds: [CUSTOM_LLM_ID],
  }));
  const { id } = await createRes.json();
  t.after(async () => {
    await prisma.experiment.delete({ where: { id } }).catch(() => {});
    await prisma.execution.deleteMany({ where: { id: { in: [e1.id, e2.id] } } });
  });

  // 补一条新 query 的 trace（两组都补）→ rescan 应发现新可比配对
  const e3 = await prisma.execution.create({ data: { agentName: agent, model: 'glm', query: 'q2', skill: 's', skillVersion: 1 } });
  const e4 = await prisma.execution.create({ data: { agentName: agent, model: 'qwen', query: 'q2', skill: 's', skillVersion: 1 } });
  t.after(async () => { await prisma.execution.deleteMany({ where: { id: { in: [e3.id, e4.id] } } }); });

  const rescanRes = await rescanExperiment(
    postReq(`http://localhost/api/experiments/${id}/rescan`, { user: TEST_USER }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(rescanRes.status, 200);
  const body = await rescanRes.json();
  assert.ok(body.newPairsCount >= 1, `expected >=1 new pair, got ${body.newPairsCount}`);
});

test('POST /api/experiments/[id]/rescan 运行中 → 409', async (t) => {
  setJudgeLlmCallerForTest(async () => JSON.stringify({ score: 80, points: [], evidence: { md: 'ok' } }));
  const agent = `cmp-api-rescan409-${Date.now()}`;
  const execIds: string[] = [];
  for (const [, model] of [['A', 'glm'], ['B', 'qwen']] as const) {
    const e = await prisma.execution.create({ data: { agentName: agent, model, query: 'q1', skill: 's', skillVersion: 1 } });
    execIds.push(e.id);
  }
  const createRes = await createExperiment(postReq('http://localhost/api/experiments', {
    user: TEST_USER, name: '重扫409', agentName: agent,
    type: 'llm', variableDimension: 'llm',
    groups: [{ key: 'A', value: 'glm' }, { key: 'B', value: 'qwen' }],
    evaluatorIds: [CUSTOM_LLM_ID],
  }));
  const { id } = await createRes.json();
  t.after(async () => {
    await prisma.experiment.delete({ where: { id } }).catch(() => {});
    await prisma.execution.deleteMany({ where: { id: { in: execIds } } });
  });

  // 先启动运行（不 await completion）
  await runExperiment(
    new Request(`http://localhost/api/experiments/${id}/run?user=${TEST_USER}`, { method: 'POST' }),
    { params: Promise.resolve({ id }) },
  );
  // 立即 rescan → 409
  const rescanRes = await rescanExperiment(
    postReq(`http://localhost/api/experiments/${id}/rescan`, { user: TEST_USER }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(rescanRes.status, 409);
  // 等运行完成
  for (let i = 0; i < 30; i++) {
    const exp = await prisma.experiment.findUnique({ where: { id }, select: { status: true } });
    if (exp!.status === 'done' || exp!.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 100));
  }
});

// ─── T006: GET /experiments/[id] extend + GET /traces model filter ───────────

test('AC-003: GET /api/experiments/[id] type=llm → 响应含 groups + pairing', async (t) => {
  const agent = `cmp-api-detail-${Date.now()}`;
  const execIds: string[] = [];
  for (const [, model] of [['A', 'glm'], ['B', 'qwen']] as const) {
    const e = await prisma.execution.create({ data: { agentName: agent, model, query: 'q1', skill: 's', skillVersion: 1 } });
    execIds.push(e.id);
  }
  const createRes = await createExperiment(postReq('http://localhost/api/experiments', {
    user: TEST_USER, name: '详情扩展', agentName: agent,
    type: 'llm', variableDimension: 'llm',
    groups: [{ key: 'A', value: 'glm' }, { key: 'B', value: 'qwen' }],
    evaluatorIds: [CUSTOM_LLM_ID],
  }));
  const { id } = await createRes.json();
  t.after(async () => {
    await prisma.experiment.delete({ where: { id } }).catch(() => {});
    await prisma.execution.deleteMany({ where: { id: { in: execIds } } });
  });

  const detailRes = await getExperiment(
    new Request(`http://localhost/api/experiments/${id}?user=${TEST_USER}`),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();
  assert.equal(detail.type, 'llm');
  assert.ok(Array.isArray(detail.groups));
  assert.equal(detail.groups.length, 2);
  assert.ok(Array.isArray(detail.pairing?.items));
  assert.ok(typeof detail.pairing?.comparableRate === 'number');
});

test('GET /api/experiments/[id] type=single → 响应不含 groups/pairing（AC-019）', async (t) => {
  const createRes = await createExperiment(postReq('http://localhost/api/experiments', {
    user: TEST_USER, name: '单组详情', agentName: 'single-detail-agent',
    cases: [{ executionId: 'exec-s1', taskId: 'task-s1', input: 'q1', actualOutput: 'a1' }],
    evaluatorIds: ['preset-agent-trace-quality'],
  }));
  const { id } = await createRes.json();
  t.after(async () => { await prisma.experiment.delete({ where: { id } }).catch(() => {}); });

  const detailRes = await getExperiment(
    new Request(`http://localhost/api/experiments/${id}?user=${TEST_USER}`),
    { params: Promise.resolve({ id }) },
  );
  const detail = await detailRes.json();
  assert.equal(detail.type, 'single');
  assert.equal(detail.groups, undefined);
  assert.equal(detail.pairing, undefined);
});

test('GET /api/experiments/traces 加 model 过滤 + 返回 model/skill/skillVersion', async (t) => {
  const agent = `cmp-api-traces-${Date.now()}`;
  const e1 = await prisma.execution.create({ data: { user: TEST_USER, agentName: agent, model: 'glm-4.7', query: 'q1', skill: 's1', skillVersion: 1 } });
  const e2 = await prisma.execution.create({ data: { user: TEST_USER, agentName: agent, model: 'qwen3-max', query: 'q2', skill: 's2', skillVersion: 2 } });
  t.after(async () => { await prisma.execution.deleteMany({ where: { id: { in: [e1.id, e2.id] } } }); });

  // 不带 model 过滤：返回全部 + model/skill/skillVersion 字段
  const allRes = await getTraces(
    new Request(`http://localhost/api/experiments/traces?agent=${agent}&user=${TEST_USER}`),
  );
  const allBody = await allRes.json();
  assert.ok(allBody.items.length >= 2);
  const first = allBody.items[0];
  assert.ok(typeof first.model === 'string' || first.model === null);
  assert.ok('skillName' in first || 'skill' in first);
  assert.ok('skillVersion' in first);

  // 带 model 过滤：只返回匹配的
  const filteredRes = await getTraces(
    new Request(`http://localhost/api/experiments/traces?agent=${agent}&model=glm-4.7&user=${TEST_USER}`),
  );
  const filteredBody = await filteredRes.json();
  assert.ok(filteredBody.items.length >= 1);
  assert.equal(filteredBody.items.every((i: { model?: string }) => i.model === 'glm-4.7'), true);
});
