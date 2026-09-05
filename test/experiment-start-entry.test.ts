import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

const root = process.cwd();

test('全局实验详情是纯进度视图，并提供返回实验列表入口', () => {
  const detailPage = fs.readFileSync(
    path.join(root, 'src/app/(main)/experiments/[id]/page.tsx'),
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
    path.join(root, 'src/app/(main)/experiments/new/page.tsx'),
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
    path.join(root, 'src/app/(main)/experiments/[id]/page.tsx'),
    'utf8',
  );
  assert.match(detailPage, /Trace 生成失败/);
  assert.match(detailPage, /已跳过评估且不计入综合得分/);
  assert.match(detailPage, /正在生成 Trace/);
});
