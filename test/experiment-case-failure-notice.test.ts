import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { BenchmarkFailureNotice } from '@/components/eval/BenchmarkFailureNotice';
import { benchmarkExecutionProgress } from '@/lib/benchmark/execution-progress';

const source = fs.readFileSync(new URL('../src/components/eval/ExperimentCaseDetail.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('case-detail.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map<string, string>();
let notice: string | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer) declarations.set(node.name.getText(ast), node.initializer.getText(ast));
  if (ts.isJsxExpression(node) && node.expression?.getText(ast).includes('<BenchmarkFailureNotice')) notice = node.expression.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(notice);
const names = ['isBenchmark', 'benchmarkProgress', 'benchmarkEvaluationFailure'];
for (const name of names) assert.ok(declarations.has(name));
const js = ts.transpileModule(`${names.map(name => `const ${name} = ${declarations.get(name)};`).join('\n')}
const result = (${notice});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;
const renderNotice = new Function('React', 'BenchmarkFailureNotice', 'benchmarkExecutionProgress', 'detail', 'caseRow', `${js}\nreturn result;`);
function render(caseRow: Record<string, unknown>, scope?: string) {
  return renderToStaticMarkup(renderNotice(React, BenchmarkFailureNotice, benchmarkExecutionProgress, { scope }, caseRow));
}
function benchmark(overrides: Record<string, unknown> = {}) {
  return { runStatus: 'execution_failed', progressStage: 'agent_running', evaluationStatus: null,
    failure: { code: 'MODEL_UNAVAILABLE', message: '模型名称或鉴权配置错误' }, ...overrides };
}

test('普通实验详情直接显示执行失败原因，缺失原因时仍给出明确提示', () => {
  const html = render({ traceStatus: 'failed', traceError: '平台 opencode 无法使用所选模型' });
  assert.match(html, /role="alert"/);
  assert.match(html, /平台 opencode 无法使用所选模型/);
  assert.match(render({ traceStatus: 'failed', traceError: null }), /未收到详细失败原因/);
});

test('Benchmark 已有提交物或 Trace 时，执行失败原因仍在详情展示', () => {
  const html = render({ traceStatus: 'ready', benchmark: benchmark() }, 'benchmark');
  assert.match(html, /模型不可用/);
  assert.match(html, /模型名称或鉴权配置错误/);
});

test('Benchmark 评测失败使用最新评测原因，即使还没有评分行', () => {
  const html = render({ traceStatus: 'ready', benchmark: benchmark({ runStatus: 'evaluation_failed', evaluationStatus: 'normalization_failed',
    failure: null, progressDetails: { createdAt: new Date().toISOString(), finishedAt: null,
      execution: { startedAt: null, lastProgressAt: null, stageStartedAt: null },
      evaluation: { createdAt: new Date().toISOString(), stage: null, startedAt: null, finishedAt: null, lastProgressAt: null, failureMessage: '结果归一化失败：缺少主指标' } },
  }) }, 'benchmark');
  assert.match(html, /Benchmark 评测失败/);
  assert.match(html, /结果归一化失败：缺少主指标/);
  assert.doesNotMatch(html, /Agent 执行失败/);
});

test('无效提交显示具体原因，并使用提交物无效标题', () => {
  const html = render({ traceStatus: 'ready', benchmark: benchmark({ runStatus: 'submission_invalid', evaluationStatus: 'submission_invalid',
    failure: { code: 'SUBMISSION_INVALID', message: '提交文件为空' } }) }, 'benchmark');
  assert.match(html, /提交物无效/);
  assert.match(html, /提交文件为空/);
});

test('正常执行与重评期间不显示上一轮失败', () => {
  assert.equal(render({ traceStatus: 'pending', traceError: '旧错误' }), '');
  assert.equal(render({ traceStatus: 'ready', benchmark: benchmark({ runStatus: 'evaluation_failed', evaluationStatus: 'running_evaluator' }) }, 'benchmark'), '');
  assert.equal(render({ traceStatus: 'ready', benchmark: benchmark({ runStatus: 'evaluated', evaluationStatus: 'completed' }) }, 'benchmark'), '');
});
