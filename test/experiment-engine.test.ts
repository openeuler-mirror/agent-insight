// 实验执行引擎测试：不真调 LLM——通过 setJudgeLlmCallerForTest / setFaithfulPresetRunnerForTest 注入 fake。
// 覆盖：忠实版预置行 + 自建 LLM 行成功解析落库 /
// 解析失败重试用尽→failed+errorMessage / 单项 retry 成功 / 实验终态流转 / 防重入。
// 落仓库 data/witty_insight.db（同 experiments-api.test.ts：钉住 DATABASE_URL）。
import path from 'node:path';
process.env.DATABASE_URL = `file:${path.resolve(__dirname, '../data/witty_insight.db')}`;

import assert from 'node:assert/strict';
import test from 'node:test';

import { prisma } from '@/lib/storage/prisma';
import { setJudgeLlmCallerForTest } from '@/lib/engine/experiment/judge-llm';
import { setFaithfulPresetRunnerForTest } from '@/lib/engine/experiment/faithful-preset-evaluators';
import { writeUserCustomEvaluators } from '@/server/user_evaluators_storage';
import {
  experimentEngineConfig,
  startExperimentRun,
  retryResultRow,
  extractToolCallNames,
} from '@/lib/engine/experiment/run-experiment';

const TEST_USER = `exp-engine-${Date.now()}`;

// 测试不等真实退避
experimentEngineConfig.retryDelaysMs = [0, 0];

// 通用 judge 路径（parse/retry/失败）由自建 LLM 评估器承接——预置 task-completion/
// trace-quality 现走忠实版（原 opencode 逻辑），不经 judge-llm。
const CUSTOM_LLM_ID = 'custom-engine-test-judge';

const VALID_JUDGE_JSON = JSON.stringify({
  score: 88,
  points: [{ label: '目标达成', score: 90, evidence: { md: '完成了任务' } }],
  evidence: { md: '整体判断依据' },
});

async function createExecution(overrides: Record<string, unknown> = {}): Promise<string> {
  const row = await prisma.execution.create({
    data: {
      taskId: `task-${TEST_USER}-${Math.random().toString(36).slice(2)}`,
      user: TEST_USER,
      agentName: 'engine-test-agent',
      toolCallCount: 4,
      toolCallErrorCount: 1,
      llmCallCount: 3,
      inputTokens: 1000,
      outputTokens: 500,
      latency: 12.5,
      model: 'engine-test-nonexistent-model',
      ...overrides,
    },
    select: { id: true, taskId: true },
  });
  return row.id;
}

async function createExperiment(
  executionId: string,
  evaluatorIds: string[],
  referenceOutput: string | null = 'ref answer',
): Promise<{ experimentId: string; caseId: string }> {
  const exp = await prisma.experiment.create({
    data: {
      user: TEST_USER,
      name: '引擎测试实验',
      type: 'single',
      agentName: 'engine-test-agent',
      evaluatorIdsJson: JSON.stringify(evaluatorIds),
      status: 'draft',
      cases: {
        create: [{
          executionId,
          input: '请回答问题 X',
          actualOutput: '答案是 42',
          referenceOutput,
        }],
      },
    },
    include: { cases: true },
  });
  return { experimentId: exp.id, caseId: exp.cases[0].id };
}

async function cleanup() {
  await prisma.experiment.deleteMany({ where: { user: TEST_USER } });
  await prisma.execution.deleteMany({ where: { user: TEST_USER } });
  await prisma.customEvaluatorList.deleteMany({ where: { user: TEST_USER } });
}

test.before(async () => {
  await writeUserCustomEvaluators(TEST_USER, [{
    id: CUSTOM_LLM_ID, name: 'engine-test-judge', description: '', evaluatorType: 'LLM',
    source: 'custom', targetTypes: [], objectives: [], scenarios: [], runMode: '', scoreRange: '',
    popularity: 0, mappedMetrics: [], status: 'ready', category: 'res',
    llmConfig: { model: 'engine-test', systemPrompt: '评估 {{output}} 对照 {{reference_output}}' },
  }]);
});

test.after(async () => {
  await cleanup();
  setJudgeLlmCallerForTest(null);
  setFaithfulPresetRunnerForTest(null);
});

test('engine: 忠实版预置 + 自建 LLM 两行成功落库，实验终态 done', async () => {
  setJudgeLlmCallerForTest(async () => VALID_JUDGE_JSON);
  setFaithfulPresetRunnerForTest(async () => ({
    score: 73,
    points: [{ label: '目标达成', score: 73, evidence: { md: '忠实版判断' } }],
    evidence: { md: '忠实版总体判断' },
  }));
  const executionId = await createExecution();
  const { experimentId, caseId } = await createExperiment(executionId, [
    'preset-agent-task-completion',
    CUSTOM_LLM_ID,
  ]);

  const start = await startExperimentRun(experimentId, TEST_USER);
  assert.ok(start);
  assert.equal(start!.status, 'running');
  await start!.completion;

  const exp = await prisma.experiment.findUnique({ where: { id: experimentId } });
  assert.equal(exp!.status, 'done');

  const rows = await prisma.experimentEvalResult.findMany({ where: { experimentId } });
  assert.equal(rows.length, 2);

  // 忠实版预置评估器：注入 runner 的输出被落库
  const presetRow = rows.find((r: { evaluatorId: string }) => r.evaluatorId === 'preset-agent-task-completion')!;
  assert.equal(presetRow.status, 'done');
  assert.equal(presetRow.score, 73);
  assert.equal(presetRow.caseId, caseId);

  // LLM 评估器：fake judge 的合法 JSON 被解析归一化落库
  const llmRow = rows.find((r: { evaluatorId: string }) => r.evaluatorId === CUSTOM_LLM_ID)!;
  assert.equal(llmRow.status, 'done');
  assert.equal(llmRow.score, 88);
  const points = JSON.parse(llmRow.pointsJson!);
  assert.equal(points[0].label, '目标达成');
  assert.equal(points[0].score, 90);
  assert.equal(JSON.parse(llmRow.evidenceJson!).md, '整体判断依据');
  assert.equal(llmRow.attempts, 1);
  assert.ok(typeof llmRow.durationMs === 'number');
  setFaithfulPresetRunnerForTest(null);
});

test('engine: judge 输出非法 JSON → 重试用尽 → failed + errorMessage，全失败实验终态 failed', async () => {
  let calls = 0;
  setJudgeLlmCallerForTest(async () => { calls++; return '这不是 JSON，judge 抽风了'; });

  const executionId = await createExecution();
  const { experimentId } = await createExperiment(executionId, [CUSTOM_LLM_ID]);

  const start = await startExperimentRun(experimentId, TEST_USER);
  await start!.completion;

  // 初次 + 2 次重试 = 3 次尝试
  assert.equal(calls, experimentEngineConfig.retryDelaysMs.length + 1);

  const row = await prisma.experimentEvalResult.findFirst({ where: { experimentId } });
  assert.equal(row!.status, 'failed');
  assert.ok(row!.errorMessage && row!.errorMessage.includes('JSON'));
  assert.equal(row!.attempts, 3);
  assert.equal(row!.score, null);

  // 无任何 done 行 → 实验 failed
  const exp = await prisma.experiment.findUnique({ where: { id: experimentId } });
  assert.equal(exp!.status, 'failed');

  // 单项重评：换成合法 judge → done，实验终态翻转为 done
  setJudgeLlmCallerForTest(async () => VALID_JUDGE_JSON);
  const status = await retryResultRow(experimentId, row!.id, TEST_USER);
  assert.equal(status, 'done');
  const retried = await prisma.experimentEvalResult.findUnique({ where: { id: row!.id } });
  assert.equal(retried!.status, 'done');
  assert.equal(retried!.score, 88);
  assert.equal(retried!.errorMessage, null);
  const exp2 = await prisma.experiment.findUnique({ where: { id: experimentId } });
  assert.equal(exp2!.status, 'done');
});

test('engine: 非可重试异常不重试；同实验 running 时重复触发直接返回', async () => {
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  setJudgeLlmCallerForTest(async () => {
    calls++;
    await gate; // 卡住第一轮执行，给防重入断言留窗口
    throw new Error('模型配置缺失（确定性失败）');
  });

  const executionId = await createExecution();
  const { experimentId } = await createExperiment(executionId, [CUSTOM_LLM_ID]);

  const start = await startExperimentRun(experimentId, TEST_USER);
  assert.equal(start!.status, 'running');

  // 防重入：running 中重复调用不重复起跑
  const again = await startExperimentRun(experimentId, TEST_USER);
  assert.equal(again!.status, 'running');
  assert.equal(again!.alreadyRunning, true);
  assert.equal(again!.completion, undefined);

  release();
  await start!.completion;

  // 非 JudgeOutputParseError / 非超时 → 不重试，一次即失败
  assert.equal(calls, 1);
  const row = await prisma.experimentEvalResult.findFirst({ where: { experimentId } });
  assert.equal(row!.status, 'failed');
  assert.ok(row!.errorMessage!.includes('模型配置缺失'));

  // 终态后可再次触发（running 集合已清）
  setJudgeLlmCallerForTest(async () => VALID_JUDGE_JSON);
  const rerun = await startExperimentRun(experimentId, TEST_USER);
  assert.equal(rerun!.status, 'running');
  await rerun!.completion;
  const exp = await prisma.experiment.findUnique({ where: { id: experimentId } });
  assert.equal(exp!.status, 'done');
});

test('engine: interactions 工具序列提取（tool_calls 优先，parts 兜底）', () => {
  const names = extractToolCallNames([
    { role: 'assistant', tool_calls: [{ name: 'read_file' }, { name: 'read_file' }] },
    { role: 'assistant', parts: [{ type: 'tool', tool: 'bash' }, { type: 'text', text: 'x' }] },
    { role: 'user', content: 'hi' },
    null,
  ]);
  assert.deepEqual(names, ['read_file', 'read_file', 'bash']);
});

test('engine: 预置 task-completion/trace-quality 走忠实版通道，归因字段落库', async () => {
  // 忠实版注入 fake runner（真实调 opencode 在此不加载），产出带归因字段的评分点
  setFaithfulPresetRunnerForTest(async (id) => ({
    score: 82,
    points: [{
      label: id === 'preset-agent-trace-quality' ? '完整性' : '目标达成',
      score: 70, status: 'partial', skillAttributable: true,
      suggestion: '在 SKILL.md 补校验清单', anchors: ['step-3'],
      evidence: { md: '判断依据' },
    }],
    evidence: { md: '总体判断' },
  }));
  const executionId = await createExecution();
  const { experimentId } = await createExperiment(executionId, ['preset-agent-trace-quality']);
  const start = await startExperimentRun(experimentId, TEST_USER);
  await start!.completion;

  const row = (await prisma.experimentEvalResult.findMany({ where: { experimentId } }))[0];
  assert.equal(row.status, 'done');
  assert.equal(row.score, 82);
  const p = JSON.parse(row.pointsJson!)[0];
  assert.equal(p.label, '完整性');
  assert.equal(p.status, 'partial');
  assert.equal(p.skillAttributable, true);
  assert.equal(p.suggestion, '在 SKILL.md 补校验清单');
  assert.deepEqual(p.anchors, ['step-3']);
  setFaithfulPresetRunnerForTest(null);
});
