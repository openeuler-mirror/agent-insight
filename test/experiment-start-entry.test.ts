import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

const root = process.cwd();

test('全局实验详情是纯进度视图，并提供返回实验列表入口', () => {
  const detailPage = fs.readFileSync(
    path.join(root, 'src/components/eval/ExperimentDetail.tsx'),
    'utf8',
  );

  assert.match(detailPage, /<AppTopBar title=\{detail \? detail\.name : '实验详情'\} \/>/);
  assert.match(detailPage, /<PageContainer[\s\S]*!embedded && \([\s\S]*<Link href="\/experiments">[\s\S]*返回实验列表[\s\S]*<\/Link>/);
  assert.doesNotMatch(detailPage, /<AppTopBar[\s\S]*title=\{\([\s\S]*返回实验列表/);
  assert.doesNotMatch(detailPage, /开始执行/);
  assert.doesNotMatch(detailPage, /返回上一页/);
  assert.doesNotMatch(detailPage, /router\.back\(\)/);
  assert.doesNotMatch(detailPage, /\/experiments\/[^`]*\/run/);
});

test('向导仅在 run 请求成功后进入详情，启动失败回滚临时实验', () => {
  const wizardPage = fs.readFileSync(
    path.join(root, 'src/components/eval/ExperimentWizard.tsx'),
    'utf8',
  );
  const runRequest = wizardPage.indexOf('const runRes = await apiFetch');
  const runSuccessCheck = wizardPage.indexOf('if (!runRes.ok)', runRequest);
  const detailNavigation = wizardPage.indexOf('router.push(`/experiments/${experimentId}`)', runRequest);

  assert.ok(runRequest >= 0);
  assert.ok(runSuccessCheck > runRequest);
  assert.ok(detailNavigation > runSuccessCheck);
  assert.match(wizardPage, /method: 'DELETE'/);
  assert.match(wizardPage, /rollbackRes\?\.status === 409/);
  assert.doesNotMatch(wizardPage, /createdExperimentId/);
});

test('生成 Trace 先进入 running，绑定完成后显式继续调度评估', () => {
  const runRoute = fs.readFileSync(
    path.join(root, 'src/app/api/experiments/[id]/run/route.ts'),
    'utf8',
  );
  const markRunning = runRoute.indexOf("data: { status: 'running' }");
  const continueEvaluation = runRoute.indexOf('allowPersistedRunning: true', markRunning);
  const runningResponse = runRoute.indexOf("status: 'running'", continueEvaluation);

  assert.ok(markRunning >= 0);
  assert.ok(continueEvaluation > markRunning);
  assert.ok(runningResponse > continueEvaluation);
  assert.match(runRoute, /if \(!readyCaseIds\.length\)/);
  assert.match(runRoute, /caseIds: readyCaseIds/);
  assert.match(runRoute, /data: \{ status: 'failed' \}/);
});

test('实验详情展示 Trace 生成进度和失败 Case，失败 Trace 不显示为实际输出', () => {
  const detailPage = fs.readFileSync(
    path.join(root, 'src/components/eval/ExperimentDetail.tsx'),
    'utf8',
  );
  assert.match(detailPage, /Trace 生成失败/);
  assert.match(detailPage, /已跳过评估且不计入综合得分/);
  assert.match(detailPage, /正在生成 Trace/);
});

test('Benchmark Case 明细表按 Presentation 展示列', () => {
  const detailPage = fs.readFileSync(
    path.join(root, 'src/components/eval/ExperimentDetail.tsx'),
    'utf8',
  );

  assert.match(detailPage, /benchmarkPresentation\?\.caseTable\.columns/);
  assert.match(detailPage, /benchmarkCaseColumns\.map/);
  assert.match(detailPage, /benchmarkPresentationValue/);
  assert.doesNotMatch(detailPage, />Instance ID</);
});

test('Benchmark 提交物已提交但 Evaluator 未完成时展示评测中', () => {
  const detailPage = fs.readFileSync(
    path.join(root, 'src/components/eval/ExperimentDetail.tsx'),
    'utf8',
  );

  assert.match(detailPage, /isBenchmarkEvaluationInProgress\(c\.benchmark\)/);
  assert.match(detailPage, /Benchmark 评测中…/);
  assert.match(detailPage, /提交物已生成，等待执行器确认…/);
  assert.match(detailPage, /c\.benchmark\.submissions/);
  assert.doesNotMatch(detailPage, /c\.benchmark\.submission\b/);
});

test('Benchmark Case 使用 Run 状态，不被通用 Trace pending 覆盖', () => {
  const detailRoute = fs.readFileSync(
    path.join(root, 'src/app/api/experiments/[id]/route.ts'),
    'utf8',
  );

  assert.match(detailRoute, /traceStatus: benchmarkRun \? benchmarkTraceStatus : traceState\?\.status \|\| null/);
  assert.match(detailRoute, /traceError: benchmarkRun \? benchmarkRun\.failureMessage : traceState\?\.error \|\| null/);
});

test('Benchmark 文件使用完整通用列表，并按媒体类型决定是否预览', () => {
  const artifactActions = fs.readFileSync(
    path.join(root, 'src/components/eval/BenchmarkArtifactActions.tsx'),
    'utf8',
  );

  assert.match(artifactActions, /presentBenchmarkArtifacts/);
  assert.match(artifactActions, /canPreviewBenchmarkArtifact/);
  assert.match(artifactActions, /submissionArtifacts/);
  assert.match(artifactActions, /evidenceArtifacts/);
  assert.doesNotMatch(artifactActions, /report\.json|test_output\.txt|run_instance\.log/);
});
