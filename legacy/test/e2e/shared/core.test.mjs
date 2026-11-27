import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requiredStages, scenarioResult, redact, renderReport, assertRunRoot } from './core.mjs';

test('one missing required stage cannot turn preparation green', () => {
  const stages = requiredStages.map(id => ({ id, status: 'PASS' }));
  assert.equal(scenarioResult(stages).status, 'PASS');
  assert.equal(scenarioResult(stages.slice(0, -1)).status, 'PARTIAL');
  assert.equal(scenarioResult([{ id: 'login', status: 'FAIL' }]).status, 'FAIL');
  assert.equal(scenarioResult([{ id: 'login', status: 'BLOCKED' }]).status, 'BLOCKED');
});

test('reports redact exact credentials, URL credentials, and HTML markup', () => {
  const key = 'sk-example-private-key';
  const raw = { message: key, command: `curl http://localhost/?key=${key}`, detail: '<script>bad()</script>' };
  const safe = redact(JSON.stringify(raw), [key]);
  assert.ok(!safe.includes(key));
  const html = renderReport({ runId: 'test', mode: 'real', scenarios: [{ id: '001', title: '准备', status: 'FAIL', stages: [{ id: 'model', status: 'FAIL', actual: raw.detail }] }] });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('runtime root stays within this checkout exclude tree', () => {
  assert.doesNotThrow(() => assertRunRoot('/work/repo', '/work/repo/exclude/core-e2e/run-1'));
  for (const unsafe of ['/Users/test/.agent-insight', '/work/repo', '/work/repo/exclude/../src', '/work/repo/exclude-other/run']) {
    assert.throws(() => assertRunRoot('/work/repo', unsafe), /isolated/);
  }
});

test('interrupted npm results remain visibly incomplete and separate from E2E', () => {
  const html = renderReport({ runId: 'test', mode: 'real', scenarios: [], npmTest: { interrupted: true, fullSuiteComplete: false, observedSummary: { tests: 4, pass: 2, fail: 1, skipped: 1 } } });
  assert.ok(html.includes('中断'));
  assert.ok(html.includes('非完整结果'));
  assert.ok(html.includes('npm test'));
});

test('credential redaction preserves evaluator task identifiers', () => {
  assert.equal(redact('preset-agent-task-completion'), 'preset-agent-task-completion');
  assert.ok(!redact('key=sk-example-private-value').includes('sk-example-private-value'));
});

test('npm execution without a final summary is not presented as unexecuted or zero tests', () => {
  const html = renderReport({ runId: 'test', mode: 'real', scenarios: [], npmTest: { interrupted: true, fullSuiteComplete: false, observedSummary: null, reason: 'deadline exceeded' } });
  assert.ok(html.includes('未取得完整汇总'));
  assert.ok(html.includes('已中断'));
  assert.ok(html.includes('deadline exceeded'));
  assert.ok(!html.includes('尚未附加'));
  assert.ok(!html.includes('总数 0'));
});

test('coverage boundaries remain visible even when the selected scenario passes', () => {
  const html=renderReport({runId:'test',mode:'real',scenarios:[{id:'004',title:'Trace',status:'PASS',stages:[]}],coverageNotes:['Skills step analysis unavailable <detail>']});
  assert.ok(html.includes('未覆盖与边界'));
  assert.ok(html.includes('Skills step analysis unavailable &lt;detail&gt;'));
});
