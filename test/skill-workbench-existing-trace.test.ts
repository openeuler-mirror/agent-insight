import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { formatWorkbenchScore, summarizeAbSide } from '@/lib/skill-workbench/ab-comparison';
import { describeExperimentOutcome } from '@/lib/skill-workbench/experiment-outcome';
import {
  categoryAverage, evaluationScoreState, existingTraceCaseRun, existingTraceRetryResults,
  type CaseEvaluationResult,
} from '@/lib/skill-workbench/use-case-results';

const traceId = 'preset-agent-trace-quality';

test('Case 明细默认展开，切换实验不继承收起状态，保留手动切换入口', () => {
  const source = readFileSync('src/components/skill-workbench/SkillExperimentResult.tsx', 'utf8');
  assert.match(source, /useState\(\{ experimentId, expanded: true \}\)/);
  assert.match(source, /const showDetail = detailVisibility\.experimentId !== experimentId \|\| detailVisibility\.expanded/);
  assert.match(source, /aria-expanded=\{showDetail\}/);
  assert.match(source, /setDetailVisibility\(\{ experimentId, expanded: !showDetail \}\)/);
  assert.match(source, /\{showDetail && \(/);
});

test('冻结配置不展示额外模型卡片，后端仍在绑定 Trace 前校验实际模型', () => {
  const source = readFileSync('src/components/skill-workbench/SkillExperimentResult.tsx', 'utf8');
  assert.match(source, /\['配置主机 \/ 运行模型', hostAndModel\]/);
  assert.doesNotMatch(source, /实际运行模型（当前明细）|实际运行主机（当前明细）|由各评估器独立配置，不等于运行模型/);
  const backend = readFileSync('src/lib/engine/experiment/trace-generation.ts', 'utf8');
  assert.match(backend, /if \(input\.req\.skillExecution\) assertSkillExecutionOutput\(execution, input\.req\.model\);[\s\S]*?await bindExecution\(/);
});

const resultId = 'preset-agent-task-completion';
const row = { id: 'case-1', taskId: 'task-1', input: '输入', actualOutput: '已有输出', referenceOutput: '参考答案' };
function result(overrides: Partial<CaseEvaluationResult> = {}): CaseEvaluationResult {
  return { id: 'eval-1', caseId: row.id, evaluatorId: traceId, status: 'done', score: 100, ...overrides };
}
function state(results: CaseEvaluationResult[], ids = [traceId], status = 'done') {
  return existingTraceCaseRun(row, results, ids, status);
}
function text(value: ReturnType<typeof evaluationScoreState>) {
  return formatWorkbenchScore(value.score, value.status);
}

test('已有 Trace 直接绑定真实 Case 和输出，不需要 grayscale 状态或 executionId', () => {
  const run = state([result(), result({ caseId: 'other-case', score: 0 })]);
  assert.equal(run.experimentCaseId, row.id);
  assert.equal(run.sessionId, row.taskId);
  assert.equal(run.output, row.actualOutput);
  assert.equal(run.evaluations?.length, 1);
  const summary = summarizeAbSide(run);
  assert.equal(formatWorkbenchScore(summary.score, summary.status), '100.0');
  assert.equal(summary.status, 'done');
  assert.equal(existingTraceCaseRun({ ...row, taskId: null }, [result()], [traceId], 'done').score, 100);
});

test('只选轨迹评估器：综合与轨迹有分数，任务结果未评测', () => {
  const summary = summarizeAbSide(state([result()]));
  assert.equal(text(evaluationScoreState([], summary.evaluations, summary.status)), '未评测');
  assert.equal(text(evaluationScoreState([traceId], summary.evaluations, summary.status)), '100.0');
  assert.equal(categoryAverage([{ evaluatorId: traceId, avg: 100, scored: 1 }], []), null);
});

test('不同评估维度独立计分，支持自建评估器且按有效评分数加权', () => {
  const results = [result(), result({ id: 'eval-2', evaluatorId: resultId, score: 60 })];
  const summary = summarizeAbSide(state(results, [traceId, resultId]));
  assert.equal(summary.score, 80);
  assert.equal(text(evaluationScoreState([traceId], summary.evaluations, summary.status)), '100.0');
  assert.equal(text(evaluationScoreState([resultId], summary.evaluations, summary.status)), '60.0');
  assert.equal(categoryAverage([
    { evaluatorId: traceId, avg: 100, scored: 1 },
    { evaluatorId: resultId, avg: 60, scored: 1 },
    { evaluatorId: 'custom-result', avg: 90, scored: 2 },
  ], [resultId, 'custom-result']), 80);
});

test('已有 Trace 区分待评测、评测中、失败和未计分，不再等待 Agent 执行', () => {
  for (const [status, score, expected] of [
    ['pending', null, '待评测'], ['running', null, '评测中'],
    ['failed', null, '失败'], ['done', null, '未计分'],
  ] as const) {
    const run = state([result({ status, score })], [traceId], status === 'done' ? 'done' : 'running');
    assert.equal(formatWorkbenchScore(run.score, run.status), expected);
  }
  assert.equal(state([], [traceId], 'running').status, 'executed');
  assert.equal(state([], [traceId], 'done').status, 'failed');
  assert.equal(state([result({ status: 'pending', score: null })], [traceId], 'cancelled').status, 'cancelled');
  assert.equal(state([result()], [traceId, resultId], 'done').status, 'failed');
});

test('失败与未计分保留评估器说明，不覆盖原 Agent 输出', () => {
  const failed = state([result({ status: 'failed', score: null, errorMessage: '评分连接失败' })]);
  assert.equal(failed.output, row.actualOutput);
  assert.equal(failed.failureType, undefined);
  assert.equal(failed.evaluations?.[0].errorMessage, '评分连接失败');
  const unscored = state([result({ score: null, summary: '证据不足' })]);
  assert.equal(unscored.evaluations?.[0].unscored, true);
  assert.equal(unscored.evaluations?.[0].summary, '证据不足');
});

test('多个评估器仍在运行时不提前发布综合分，已完成维度可独立显示', () => {
  const results = [result(), result({ id: 'eval-2', evaluatorId: resultId, status: 'running', score: null })];
  const run = state(results, [traceId, resultId], 'running');
  assert.equal(run.score, undefined);
  assert.equal(run.status, 'evaluating');
  assert.equal(text(evaluationScoreState([traceId], run.evaluations || [], run.status!)), '100.0');
  assert.deepEqual(existingTraceRetryResults(row.id, results, [traceId, resultId]), []);
});

test('重新评测只选当前 Case 的失败项，全成功时才重评所有已选评估器', () => {
  const failed = result({ id: 'eval-2', evaluatorId: resultId, status: 'failed', score: null });
  const results = [result(), failed, result({ id: 'other', caseId: 'other-case', status: 'failed' })];
  assert.deepEqual(existingTraceRetryResults(row.id, results, [traceId, resultId]).map((item) => item.id), ['eval-2']);
  assert.deepEqual(existingTraceRetryResults(row.id, [result(), { ...failed, status: 'done', score: 0 }], [traceId, resultId]).map((item) => item.id), ['eval-1', 'eval-2']);
  assert.deepEqual(existingTraceRetryResults(row.id, [result()], [traceId, resultId]), []);
  assert.deepEqual(existingTraceRetryResults(row.id, [], [traceId]), []);
});

test('生成 Trace 的 Agent 等待和执行状态保持原语义', () => {
  for (const status of ['pending', 'running', 'executed', 'evaluating']) {
    assert.equal(evaluationScoreState([traceId], [], status).status, status);
    assert.equal(evaluationScoreState([traceId], [{ evaluatorId: traceId, status: 'pending' }], status).status, status);
  }
});

test('仅轨迹质量评分不能推导整体可用，失败与无分状态优先', () => {
  const input = { status: 'done', complete: true, score: 100, trajectoryOnly: true };
  assert.equal(describeExperimentOutcome(input).conclusion, '轨迹评测完成');
  assert.match(describeExperimentOutcome(input).hint, /未评估任务结果/);
  assert.equal(describeExperimentOutcome({ ...input, trajectoryOnly: false }).conclusion, '可使用');
  assert.equal(describeExperimentOutcome({ ...input, status: 'failed' }).conclusion, '需处理');
  assert.equal(describeExperimentOutcome({ ...input, score: null }).conclusion, '暂无评分结论');
  assert.equal(describeExperimentOutcome({ ...input, evaluation: { failed: 1 } }).conclusion, '需处理');
});

test('结果页接入已有 Trace 数据与行级重评，删除不使用 dataset 前缀', () => {
  const source = readFileSync('src/components/skill-workbench/SkillExperimentResult.tsx', 'utf8');
  assert.match(source, /existingTraceCaseRun\(existingCase, detail\.results \|\| \[\], detail\.evaluatorIds, detail\.status\)/);
  assert.match(source, /const experimentCase = existingCase \|\|/);
  assert.match(source, /existingTrace \? retryExistingCase\(caseId\) : retryRun\(caseId, 'b'\)/);
  assert.match(source, /\/results\/\$\{encodeURIComponent\(target\.id\)\}\/retry/);
  assert.match(source, /caseId=\{existingTrace \? caseId : `dataset:\$\{caseId\}`\}/);
  assert.match(source, /existingTrace \? summary\.status : summaryScoreStatus\(summary\)/);
  const service = readFileSync('src/lib/skill-workbench/experiment-service.ts', 'utf8');
  assert.match(service, /caseCount: snapshot\.traceSource === 'existing' && !snapshot\.grayscaleTaskId\s*\? experiment\._count\.cases/);
});
