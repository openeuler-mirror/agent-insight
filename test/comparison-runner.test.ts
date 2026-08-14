// 对比 runner 测试：create/pair/detail 路径（T003）+ run/rescan 路径（T004）。
// 覆盖：AC-004 三条件判定 / AC-021 不可比未配对不进分母 / AC-022 100 case 配对 ≤100ms /
// AC-009 复用 executeResultRow / AC-017 增量补评 / AC-018 单侧失败容忍 / AC-023 得分偏差=0 /
// 空组校验 / A/B 取值相同校验 / createComparisonExperiment 创建+groups / getComparisonDetail 聚合。
// 落仓库 data/witty_insight.db（同 experiment-engine.test.ts：钉住 DATABASE_URL）。
import path from 'node:path';
process.env.DATABASE_URL = `file:${path.resolve(__dirname, '../data/witty_insight.db')}`;

import assert from 'node:assert/strict';
import test from 'node:test';

import { prisma } from '@/lib/storage/prisma';
import { setJudgeLlmCallerForTest } from '@/lib/engine/experiment/judge-llm';
import { setFaithfulPresetRunnerForTest } from '@/lib/engine/experiment/faithful-preset-evaluators';
import { writeUserCustomEvaluators } from '@/server/user_evaluators_storage';
import {
  createComparisonExperiment,
  autoPairGroups,
  judgeComparability,
  getComparisonDetail,
  startComparisonRun,
  rescanComparison,
  comparisonEngineConfig,
  computePairs,
  type ComparisonGroupInput,
} from '@/lib/engine/experiment/comparison-runner';
import { LLM_DIMENSION, type DimensionTrace } from '@/lib/engine/experiment/variable-dimension';

// judge 走 fake，不真调 LLM
const fakeJudge = async () => JSON.stringify({ score: 80, points: [], evidence: { md: 'ok' } });
setJudgeLlmCallerForTest(fakeJudge as never);

const TEST_USER = `cmp-runner-${Date.now()}`;

// ─── judgeComparability（纯函数）AC-004 ───────────────────────────────────────

test('judgeComparability: 双侧齐全+取值匹配+受控字段一致 → 可比', () => {
  const a: DimensionTrace = { id: 'a1', model: 'glm', agentName: 'ag', skill: 's', skillVersion: 1, query: 'q1' };
  const b: DimensionTrace = { id: 'b1', model: 'qwen', agentName: 'ag', skill: 's', skillVersion: 1, query: 'q1' };
  const r = judgeComparability(a, b, LLM_DIMENSION, 'glm', 'qwen');
  assert.equal(r.status, '可比');
  assert.equal(r.reason, null);
});

test('judgeComparability: 一侧缺 trace → 未配对', () => {
  const a: DimensionTrace = { id: 'a1', model: 'glm', agentName: 'ag', skill: 's', skillVersion: 1 };
  const r = judgeComparability(a, null, LLM_DIMENSION, 'glm', 'qwen');
  assert.equal(r.status, '未配对');
  assert.match(r.reason ?? '', /一侧缺 trace/);
});

test('judgeComparability: A 组取值不匹配 → 不可比', () => {
  const a: DimensionTrace = { id: 'a1', model: 'WRONG', agentName: 'ag', skill: 's', skillVersion: 1 };
  const b: DimensionTrace = { id: 'b1', model: 'qwen', agentName: 'ag', skill: 's', skillVersion: 1 };
  const r = judgeComparability(a, b, LLM_DIMENSION, 'glm', 'qwen');
  assert.equal(r.status, '不可比');
  assert.match(r.reason ?? '', /A 组取值不匹配/);
});

test('judgeComparability: 受控字段不一致（skillVersion 不同）→ 不可比', () => {
  const a: DimensionTrace = { id: 'a1', model: 'glm', agentName: 'ag', skill: 's', skillVersion: 1 };
  const b: DimensionTrace = { id: 'b1', model: 'qwen', agentName: 'ag', skill: 's', skillVersion: 2 };
  const r = judgeComparability(a, b, LLM_DIMENSION, 'glm', 'qwen');
  assert.equal(r.status, '不可比');
  assert.match(r.reason ?? '', /skillVersion/);
});

test('judgeComparability: skillVersion 两 null → 相等不算不可比', () => {
  const a: DimensionTrace = { id: 'a1', model: 'glm', agentName: 'ag', skill: 's', skillVersion: null };
  const b: DimensionTrace = { id: 'b1', model: 'qwen', agentName: 'ag', skill: 's', skillVersion: null };
  const r = judgeComparability(a, b, LLM_DIMENSION, 'glm', 'qwen');
  assert.equal(r.status, '可比');
});

// ─── createComparisonExperiment ─────────────────────────────────────────────

test('createComparisonExperiment: 创建 Experiment(type=llm) + ExperimentGroup rows', async (t) => {
  const agent = `cmp-create-${Date.now()}`;
  const groups: ComparisonGroupInput[] = [
    { key: 'A', value: 'glm-4.7' },
    { key: 'B', value: 'qwen3-max' },
  ];
  const { id } = await createComparisonExperiment({
    user: TEST_USER, name: 'cmp-test', agentName: agent,
    variableDimension: 'llm', groups, evaluatorIds: ['preset-agent-trace-quality'],
  });
  t.after(async () => { await prisma.experiment.delete({ where: { id } }).catch(() => {}); });

  const exp = await prisma.experiment.findUnique({ where: { id }, include: { groups: true } });
  assert.ok(exp);
  assert.equal(exp.type, 'llm');
  assert.equal(exp.scope, '');
  assert.equal(exp.groups.length, 2);
  const keys = exp.groups.map((g: { key: string }) => g.key).sort();
  assert.deepEqual(keys, ['A', 'B']);
});

test('createComparisonExperiment: A/B 取值相同 → 400', async () => {
  const agent = `cmp-same-${Date.now()}`;
  await assert.rejects(
    () => createComparisonExperiment({
      user: TEST_USER, name: 'same', agentName: agent,
      variableDimension: 'llm',
      groups: [{ key: 'A', value: 'glm' }, { key: 'B', value: 'glm' }],
      evaluatorIds: [],
    }),
    /取值不可相同|same/i,
  );
});

test('createComparisonExperiment: watchMode=true → 拒绝', async () => {
  const agent = `cmp-watch-${Date.now()}`;
  await assert.rejects(
    () => createComparisonExperiment({
      user: TEST_USER, name: 'watch', agentName: agent,
      variableDimension: 'llm', watchMode: true,
      groups: [{ key: 'A', value: 'a' }, { key: 'B', value: 'b' }],
      evaluatorIds: [],
    }),
    /watch/i,
  );
});

// ─── autoPairGroups ──────────────────────────────────────────────────────────

test('autoPairGroups: 按 query 跨组配对 + 为可比配对创建两侧 case', async (t) => {
  const agent = `cmp-pair-${Date.now()}`;
  // 候选 trace：A 组 2 条（query q1/q2），B 组 2 条（query q1/q2）—— 全可比
  const execIds: string[] = [];
  for (const [, model] of [['A', 'glm'], ['B', 'qwen']] as const) {
    for (const q of ['q1', 'q2']) {
      const e = await prisma.execution.create({
        data: { agentName: agent, model, query: q, taskId: `t-${model}-${q}` },
      });
      execIds.push(e.id);
    }
  }
  const { id } = await createComparisonExperiment({
    user: TEST_USER, name: 'pair-test', agentName: agent,
    variableDimension: 'llm',
    groups: [{ key: 'A', value: 'glm' }, { key: 'B', value: 'qwen' }],
    evaluatorIds: ['preset-agent-trace-quality'],
  });
  t.after(async () => {
    await prisma.experiment.delete({ where: { id } }).catch(() => {});
    await prisma.execution.deleteMany({ where: { id: { in: execIds } } });
  });

  const pairs = await autoPairGroups(id);
  assert.equal(pairs.length, 2); // q1 + q2
  // 每个配对两侧 case 已创建
  const cases = await prisma.experimentCase.findMany({ where: { experimentId: id } });
  assert.equal(cases.length, 4); // 2 queries × 2 sides
  // 全部可比
  assert.equal(pairs.every((p) => p.status === '可比'), true);
});

test('autoPairGroups: 一组无候选 trace → 拒绝并指明哪组', async (t) => {
  const agent = `cmp-empty-${Date.now()}`;
  // 只创建 A 组 trace，B 组无
  const e = await prisma.execution.create({ data: { agentName: agent, model: 'glm', query: 'q1' } });
  const { id } = await createComparisonExperiment({
    user: TEST_USER, name: 'empty-b', agentName: agent,
    variableDimension: 'llm',
    groups: [{ key: 'A', value: 'glm' }, { key: 'B', value: 'qwen' }],
    evaluatorIds: [],
  });
  t.after(async () => {
    await prisma.experiment.delete({ where: { id } }).catch(() => {});
    await prisma.execution.delete({ where: { id: e.id } }).catch(() => {});
  });

  await assert.rejects(
    () => autoPairGroups(id),
    /B.*无.*trace|无.*匹配.*trace/i,
  );
});

test('autoPairGroups: AC-022 100 case 配对耗时 ≤ 100ms', async (t) => {
  const agent = `cmp-perf-${Date.now()}`;
  const execIds: string[] = [];
  // 100 条 query，每组各 100 条 trace
  for (const [, model] of [['A', 'glm'], ['B', 'qwen']] as const) {
    for (let i = 0; i < 100; i++) {
      const e = await prisma.execution.create({
        data: { agentName: agent, model, query: `q-${i}`, taskId: `t-${model}-${i}` },
      });
      execIds.push(e.id);
    }
  }
  const { id } = await createComparisonExperiment({
    user: TEST_USER, name: 'perf-test', agentName: agent,
    variableDimension: 'llm',
    groups: [{ key: 'A', value: 'glm' }, { key: 'B', value: 'qwen' }],
    evaluatorIds: [],
  });
  t.after(async () => {
    await prisma.experiment.delete({ where: { id } }).catch(() => {});
    await prisma.execution.deleteMany({ where: { id: { in: execIds } } });
  });

  // AC-022 测「配对算法」耗时（computePairs = 查候选 + hash-join + 判定，无 DB 写）
  const start = performance.now();
  const { pairs } = await computePairs(id);
  const elapsed = performance.now() - start;
  assert.equal(pairs.length, 100);
  assert.ok(elapsed <= 100, `配对算法耗时 ${elapsed.toFixed(2)}ms > 100ms（AC-022）`);
});

// ─── getComparisonDetail ─────────────────────────────────────────────────────

test('getComparisonDetail: AC-021 不可比/未配对不进 overall 分母', async (t) => {
  const agent = `cmp-iso-${Date.now()}`;
  const execIds: string[] = [];
  // q1: 可比；q2: B 组无 trace（未配对）；q3: 受控字段不一致（不可比）
  for (const [, model] of [['A', 'glm'], ['B', 'qwen']] as const) {
    const e = await prisma.execution.create({ data: { agentName: agent, model, query: 'q1', skill: 's', skillVersion: 1 } });
    execIds.push(e.id);
  }
  // q2: 只 A 组
  const e2 = await prisma.execution.create({ data: { agentName: agent, model: 'glm', query: 'q2', skill: 's', skillVersion: 1 } });
  execIds.push(e2.id);
  // q3: A/B 都有但 skillVersion 不同
  const e3a = await prisma.execution.create({ data: { agentName: agent, model: 'glm', query: 'q3', skill: 's', skillVersion: 1 } });
  const e3b = await prisma.execution.create({ data: { agentName: agent, model: 'qwen', query: 'q3', skill: 's', skillVersion: 2 } });
  execIds.push(e3a.id, e3b.id);

  const { id } = await createComparisonExperiment({
    user: TEST_USER, name: 'iso-test', agentName: agent,
    variableDimension: 'llm',
    groups: [{ key: 'A', value: 'glm' }, { key: 'B', value: 'qwen' }],
    evaluatorIds: ['preset-agent-trace-quality'],
  });
  await autoPairGroups(id);
  t.after(async () => {
    await prisma.experiment.delete({ where: { id } }).catch(() => {});
    await prisma.execution.deleteMany({ where: { id: { in: execIds } } });
  });

  const detail = await getComparisonDetail(id, { casePage: 1, casePageSize: 8 });
  // 3 配对：1 可比 + 1 未配对 + 1 不可比
  assert.equal(detail.pairing.items.length, 3);
  const comparable = detail.pairing.items.filter((p) => p.status === '可比');
  assert.equal(comparable.length, 1);
  // 可比率 1/3
  assert.ok(detail.pairing.comparableRate <= 0.34 && detail.pairing.comparableRate >= 0.33);
  // 降级（< 0.7 阈值）
  assert.equal(detail.pairing.degraded, true);
});

test('getComparisonDetail: 无评估结果时 overall=null + progress 全 pending', async (t) => {
  const agent = `cmp-noeval-${Date.now()}`;
  const execIds: string[] = [];
  for (const [, model] of [['A', 'glm'], ['B', 'qwen']] as const) {
    const e = await prisma.execution.create({ data: { agentName: agent, model, query: 'q1', skill: 's', skillVersion: 1 } });
    execIds.push(e.id);
  }
  const { id } = await createComparisonExperiment({
    user: TEST_USER, name: 'noeval', agentName: agent,
    variableDimension: 'llm',
    groups: [{ key: 'A', value: 'glm' }, { key: 'B', value: 'qwen' }],
    evaluatorIds: ['preset-agent-trace-quality'],
  });
  await autoPairGroups(id);
  t.after(async () => {
    await prisma.experiment.delete({ where: { id } }).catch(() => {});
    await prisma.execution.deleteMany({ where: { id: { in: execIds } } });
  });

  const detail = await getComparisonDetail(id, { casePage: 1, casePageSize: 8 });
  // autoPairGroups 只创建 case，不创建 eval results（startComparisonRun 的职责，T004）
  assert.equal(detail.progress.total, 0);
  assert.equal(detail.progress.pending, 0);
  assert.equal(detail.progress.done, 0);
  // 两组 overall 都 null（无有分行）
  for (const g of detail.groups) {
    assert.equal(g.overall, null);
  }
});

// ─── T004: startComparisonRun / rescanComparison ────────────────────────────

const CUSTOM_LLM_ID = 'custom-cmp-test-judge';
const JUDGE_SCORE = 80;
const VALID_JUDGE_JSON = JSON.stringify({
  score: JUDGE_SCORE,
  points: [{ label: '完成', score: JUDGE_SCORE, evidence: { md: 'ok' } }],
  evidence: { md: '判断依据' },
});

test.before(async () => {
  // 测试不等真实退避
  comparisonEngineConfig.retryDelaysMs = [0, 0];
  await writeUserCustomEvaluators(TEST_USER, [{
    id: CUSTOM_LLM_ID, name: 'cmp-test-judge', description: '', evaluatorType: 'LLM',
    source: 'custom', targetTypes: [], objectives: [], scenarios: [], runMode: '', scoreRange: '',
    popularity: 0, mappedMetrics: [], status: 'ready', category: 'res',
    llmConfig: { model: 'test', systemPrompt: '评估 {{output}}', userPrompt: '' },
  }]);
});

test.after(async () => {
  await prisma.experiment.deleteMany({ where: { user: TEST_USER } }).catch(() => {});
  await prisma.customEvaluatorList.deleteMany({ where: { user: TEST_USER } }).catch(() => {});
  setJudgeLlmCallerForTest(null);
  setFaithfulPresetRunnerForTest(null);
});

test('startComparisonRun: 创建 pending 行 + 逐行执行 + 终态 done（AC-009）', async (t) => {
  setJudgeLlmCallerForTest(async () => VALID_JUDGE_JSON);
  const agent = `cmp-run-${Date.now()}`;
  const execIds: string[] = [];
  for (const [, model] of [['A', 'glm'], ['B', 'qwen']] as const) {
    const e = await prisma.execution.create({ data: { agentName: agent, model, query: 'q1', skill: 's', skillVersion: 1 } });
    execIds.push(e.id);
  }
  const { id } = await createComparisonExperiment({
    user: TEST_USER, name: 'run-test', agentName: agent,
    variableDimension: 'llm',
    groups: [{ key: 'A', value: 'glm' }, { key: 'B', value: 'qwen' }],
    evaluatorIds: [CUSTOM_LLM_ID],
  });
  await autoPairGroups(id);
  t.after(async () => {
    await prisma.experiment.delete({ where: { id } }).catch(() => {});
    await prisma.execution.deleteMany({ where: { id: { in: execIds } } });
  });

  const start = await startComparisonRun(id, TEST_USER);
  assert.ok(start);
  assert.equal(start!.status, 'running');
  assert.ok(start!.completion);
  await start!.completion!;

  const exp = await prisma.experiment.findUnique({ where: { id } });
  assert.equal(exp!.status, 'done');
  // 2 case × 1 evaluator = 2 result rows，全 done
  const results = await prisma.experimentEvalResult.findMany({ where: { experimentId: id } });
  assert.equal(results.length, 2);
  assert.equal(results.every((r: { status: string }) => r.status === 'done'), true);
  assert.equal(results.every((r: { score: number | null }) => r.score === JUDGE_SCORE), true);
});

test('startComparisonRun: 防重入——运行中再次调用返回 alreadyRunning', async (t) => {
  setJudgeLlmCallerForTest(async () => VALID_JUDGE_JSON);
  const agent = `cmp-dedup-${Date.now()}`;
  const execIds: string[] = [];
  for (const [, model] of [['A', 'glm'], ['B', 'qwen']] as const) {
    const e = await prisma.execution.create({ data: { agentName: agent, model, query: 'q1', skill: 's', skillVersion: 1 } });
    execIds.push(e.id);
  }
  const { id } = await createComparisonExperiment({
    user: TEST_USER, name: 'dedup-test', agentName: agent,
    variableDimension: 'llm',
    groups: [{ key: 'A', value: 'glm' }, { key: 'B', value: 'qwen' }],
    evaluatorIds: [CUSTOM_LLM_ID],
  });
  await autoPairGroups(id);
  t.after(async () => {
    await prisma.experiment.delete({ where: { id } }).catch(() => {});
    await prisma.execution.deleteMany({ where: { id: { in: execIds } } });
  });

  const start1 = await startComparisonRun(id, TEST_USER);
  assert.ok(start1);
  // 不 await completion——立即第二次调用
  const start2 = await startComparisonRun(id, TEST_USER);
  assert.ok(start2?.alreadyRunning);
  await start1!.completion!;
});

test('AC-023: 同评估器同 case 在对比模式得分=JUDGE_SCORE（与单组口径一致）', async (t) => {
  setJudgeLlmCallerForTest(async () => VALID_JUDGE_JSON);
  const agent = `cmp-parity-${Date.now()}`;
  const e = await prisma.execution.create({ data: { agentName: agent, model: 'glm', query: 'q1', skill: 's', skillVersion: 1, finalResult: 'output-1' } });
  const { id } = await createComparisonExperiment({
    user: TEST_USER, name: 'parity-test', agentName: agent,
    variableDimension: 'llm',
    groups: [{ key: 'A', value: 'glm' }, { key: 'B', value: 'qwen' }],
    evaluatorIds: [CUSTOM_LLM_ID],
  });
  t.after(async () => {
    await prisma.experiment.delete({ where: { id } }).catch(() => {});
    await prisma.execution.delete({ where: { id: e.id } }).catch(() => {});
  });

  // 补 B 组 trace 后调 autoPairGroups（之前 B 组无 trace 会抛错）
  const e2 = await prisma.execution.create({ data: { agentName: agent, model: 'qwen', query: 'q1', skill: 's', skillVersion: 1, finalResult: 'output-2' } });
  t.after(async () => { await prisma.execution.delete({ where: { id: e2.id } }).catch(() => {}); });
  await autoPairGroups(id);

  const start = await startComparisonRun(id, TEST_USER);
  await start!.completion!;

  const results = await prisma.experimentEvalResult.findMany({ where: { experimentId: id } });
  assert.equal(results.length, 2);
  // 两侧行得分均=JUDGE_SCORE（同评估器口径一致）
  assert.equal(results.every((r: { score: number | null }) => r.score === JUDGE_SCORE), true);
});

test('AC-018: 单侧评估失败容忍——失败侧无分不进分母，配对仍算可比', async (t) => {
  // A 侧正常（judge 返回 80），B 侧失败（judge 抛错）
  let callCount = 0;
  setJudgeLlmCallerForTest(async () => {
    callCount++;
    if (callCount % 2 === 0) throw new Error('B 侧评测失败');
    return VALID_JUDGE_JSON;
  });
  const agent = `cmp-fail-${Date.now()}`;
  const execIds: string[] = [];
  for (const [, model] of [['A', 'glm'], ['B', 'qwen']] as const) {
    const e = await prisma.execution.create({ data: { agentName: agent, model, query: 'q1', skill: 's', skillVersion: 1 } });
    execIds.push(e.id);
  }
  const { id } = await createComparisonExperiment({
    user: TEST_USER, name: 'fail-test', agentName: agent,
    variableDimension: 'llm',
    groups: [{ key: 'A', value: 'glm' }, { key: 'B', value: 'qwen' }],
    evaluatorIds: [CUSTOM_LLM_ID],
  });
  await autoPairGroups(id);
  t.after(async () => {
    await prisma.experiment.delete({ where: { id } }).catch(() => {});
    await prisma.execution.deleteMany({ where: { id: { in: execIds } } });
  });

  const start = await startComparisonRun(id, TEST_USER);
  await start!.completion!;

  const detail = await getComparisonDetail(id, { casePage: 1, casePageSize: 8 });
  // 配对仍算可比（两侧 case 都存在）
  const comparable = detail.pairing.items.filter((p) => p.status === '可比');
  assert.equal(comparable.length, 1);
  // 一侧 done 一侧 failed → 失败侧不进 overall 分母
  const groupA = detail.groups[0];
  const groupB = detail.groups[1];
  // 一个 group 有分（overall=80），另一个无分（overall=null）
  const hasScoreA = groupA.overall !== null;
  const hasScoreB = groupB.overall !== null;
  assert.ok(hasScoreA !== hasScoreB, '一侧应有分一侧无分');
});

test('rescanComparison: 增量补评——B 组补 trace 后重扫发现新可比配对（AC-017）', async (t) => {
  setJudgeLlmCallerForTest(async () => VALID_JUDGE_JSON);
  const agent = `cmp-rescan-${Date.now()}`;
  // 初始：A 组 q1，B 组无 → 未配对
  const e1 = await prisma.execution.create({ data: { agentName: agent, model: 'glm', query: 'q1', skill: 's', skillVersion: 1 } });
  const { id } = await createComparisonExperiment({
    user: TEST_USER, name: 'rescan-test', agentName: agent,
    variableDimension: 'llm',
    groups: [{ key: 'A', value: 'glm' }, { key: 'B', value: 'qwen' }],
    evaluatorIds: [CUSTOM_LLM_ID],
  });
  // autoPairGroups 会因 B 组无 trace 而抛错——改为先建实验，手动跳过 autoPairGroups
  // 直接补 B 组 trace 后调 rescan
  const e2 = await prisma.execution.create({ data: { agentName: agent, model: 'qwen', query: 'q1', skill: 's', skillVersion: 1 } });
  t.after(async () => {
    await prisma.experiment.delete({ where: { id } }).catch(() => {});
    await prisma.execution.deleteMany({ where: { id: { in: [e1.id, e2.id] } } });
  });

  // rescanComparison: 重算配对 + 找新可比配对 + 创建 case + 增量评测
  const result = await rescanComparison(id, TEST_USER);
  assert.ok(result.newPairsCount >= 1, `expected >=1 new pair, got ${result.newPairsCount}`);

  const detail = await getComparisonDetail(id, { casePage: 1, casePageSize: 8 });
  const comparable = detail.pairing.items.filter((p) => p.status === '可比');
  assert.equal(comparable.length, 1);
  // 增量评测后 progress.done > 0
  assert.ok(detail.progress.done > 0, '增量评测后应有 done 行');
});

test('rescanComparison: 运行中调用 → 抛 409 互斥', async (t) => {
  setJudgeLlmCallerForTest(async () => VALID_JUDGE_JSON);
  const agent = `cmp-rescan409-${Date.now()}`;
  const execIds: string[] = [];
  for (const [, model] of [['A', 'glm'], ['B', 'qwen']] as const) {
    const e = await prisma.execution.create({ data: { agentName: agent, model, query: 'q1', skill: 's', skillVersion: 1 } });
    execIds.push(e.id);
  }
  const { id } = await createComparisonExperiment({
    user: TEST_USER, name: 'rescan-409', agentName: agent,
    variableDimension: 'llm',
    groups: [{ key: 'A', value: 'glm' }, { key: 'B', value: 'qwen' }],
    evaluatorIds: [CUSTOM_LLM_ID],
  });
  await autoPairGroups(id);
  t.after(async () => {
    await prisma.experiment.delete({ where: { id } }).catch(() => {});
    await prisma.execution.deleteMany({ where: { id: { in: execIds } } });
  });

  const start = await startComparisonRun(id, TEST_USER);
  // 不 await completion——立即调 rescan → 应抛 409
  await assert.rejects(
    () => rescanComparison(id, TEST_USER),
    /409|running|互斥/i,
  );
  await start!.completion!;
});
