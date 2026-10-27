/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiagnosisModuleCards, DiagnosisTaskSummary, SkillsAnalysisSection } from '../src/components/observe/AgentDebugCard';
import { getModuleActivity, getModulePresentation, getNewModuleSequences, preserveDiagnosisProgress } from '../src/components/observe/agent-debug-presentation';
import { DiagnosisModuleStatus } from '../src/components/observe/DiagnosisModuleStatus';
import type { DiagnosisProgressSnapshot } from '../src/lib/engine/agent-debug/progress-types';
import type { AgentDebugReportPayload, AgentDebugStepRecord } from '../src/lib/engine/agent-debug/types';

function report(overrides: Partial<AgentDebugReportPayload> = {}): AgentDebugReportPayload {
  return {
    schemaVersion: 3, generator: 'test', executionId: 'test', interactionHash: 'test',
    status: 'done', generatedAt: '2026-10-16T00:00:00Z', rootCause: null, issues: [], candidateWindows: [],
    stats: { stepCount: 0, candidateWindowCount: 0, issueCount: 0, llmCallCount: 0, durationMs: 0 },
    ...overrides,
  };
}

test('missing module data never implies a successful or skipped check', () => {
  for (const input of [null, report(), report({ phase1Grid: [] })]) {
    const result = getModulePresentation(input, 'memory');
    assert.equal(result.status, 'missing');
    assert.equal(result.explicitlyClear, false);
  }
});

test('an explicit normal check applies only to its own module', () => {
  const input = report({ phase1Grid: [{ step: 1, module: 'memory', errorDetected: false, errorType: 'no_error', severity: 'low', evidence: 'context matches', reasoning: '', confidence: 1 }] });
  assert.equal(getModulePresentation(input, 'memory').status, 'result');
  assert.equal(getModulePresentation(input, 'memory').explicitlyClear, true);
  assert.equal(getModulePresentation(input, 'action').status, 'missing');
});

test('early termination preserves actual module findings without inventing results for other modules', () => {
  const input = report({ triage: { category: 'early_fatal', shortCircuited: true }, issues: [{ id: 'issue', step: 1, module: 'system', errorType: 'auth_failure', severity: 'high', evidence: 'denied', reasoning: 'access rejected', confidence: 1 }] });
  assert.equal(getModulePresentation(input, 'system').status, 'result');
  assert.equal(getModulePresentation(input, 'system').hasError, true);
  assert.equal(getModulePresentation(input, 'memory').status, 'early_end');
});

test('only explicit whole-run skippedReason establishes that diagnosis did not run', () => {
  assert.equal(getModulePresentation(report({ skippedReason: 'No interactions' }), 'memory').status, 'skipped');
});

test('execution evidence alone is not a diagnosis result and is sorted by Trace position', () => {
  const record = (step: number, traceStepIndex: number, content: string) => ({
    step, traceStepIndex, sourceInteractionIndex: step, title: '', inputContext: '', agentOutput: '', environmentResponse: '',
    modules: { memory: { module: 'memory', content, confidence: 1, source: 'tag' } },
  } as AgentDebugStepRecord);
  const input = report({ stepRecords: [record(1, 8, 'later context'), record(2, 3, 'earlier context'), record(3, 9, ' ')] });
  const result = getModulePresentation(input, 'memory');
  assert.equal(result.status, 'missing');
  assert.deepEqual(result.records.map(item => item.traceStepIndex), [3, 8]);
  assert.equal(getModulePresentation(input, 'planning').records.length, 0);
});

test('running modules without content stay compact without fake progress or per-module spinners', () => {
  const markup = renderToStaticMarkup(createElement(DiagnosisModuleCards, { loading: true, failed: false, requestError: false, report: null, zh: true }));
  assert.match(markup, /尚未收到这些模块的过程内容/);
  assert.equal((markup.match(/aria-expanded="true"/g) || []).length, 0);
  assert.doesNotMatch(markup, /animate-spin|progressbar|w-2\/3|分析中/);
  assert.doesNotMatch(markup, /检查范围/);
});

test('completed cards render report evidence while leaving absent module conclusions unknown', () => {
  const input = report({ phase1Grid: [{ step: 2, traceStepIndex: 7, anchorId: 'node-7', module: 'memory', errorDetected: true, errorType: 'forgot_user_constraint', severity: 'high', evidence: '用户要求仅查询，后续却修改了文件。', reasoning: '遗漏用户约束。', confidence: 1 }] });
  const markup = renderToStaticMarkup(createElement(DiagnosisModuleCards, { loading: false, failed: false, requestError: false, report: input, zh: true, onNodeRefClick: () => {} }));
  assert.equal((markup.match(/>已有结果</g) || []).length, 1);
  assert.match(markup, /这些维度未提供独立分析结论/);
  assert.match(markup, /Trace #7/);
  assert.match(markup, /遗漏用户约束/);
  assert.match(markup, /发现异常/);
  assert.match(markup, /并非诊断模型的实时处理日志/);
});

test('request failure is not presented as a background diagnosis failure', () => {
  const common = { loading: false, status: 'running', error: 'network unavailable', report: null, startedAt: null, lastSyncedAt: null, zh: true, onRetry: () => {} };
  const unknown = renderToStaticMarkup(createElement(DiagnosisTaskSummary, { ...common, requestError: true }));
  assert.match(unknown, /状态获取失败/);
  assert.doesNotMatch(unknown, /诊断失败|重新诊断/);
  const failed = renderToStaticMarkup(createElement(DiagnosisTaskSummary, { ...common, status: 'failed', requestError: false }));
  assert.match(failed, /诊断失败/);
  assert.match(failed, /重新诊断/);
});

test('cached reports use report duration and skipped reports expose their explicit reason', () => {
  const common = { loading: false, status: 'done', requestError: false, error: '', startedAt: null, lastSyncedAt: null, zh: true, onRetry: () => {} };
  const cached = renderToStaticMarkup(createElement(DiagnosisTaskSummary, { ...common, report: report() }));
  assert.match(cached, /报告已返回/);
  assert.match(cached, /诊断耗时/);
  const skipped = renderToStaticMarkup(createElement(DiagnosisTaskSummary, { ...common, report: report({ skippedReason: '没有可分析的交互记录' }) }));
  assert.match(skipped, /未运行/);
  assert.match(skipped, /没有可分析的交互记录/);
  assert.doesNotMatch(skipped, /诊断耗时/);
});

const partialProgress: DiagnosisProgressSnapshot = {
  runId: 'partial', lastProgressAt: '2026-10-16T01:00:00Z', unavailable: false, truncated: false,
  events: [
    { seq: 1, key: 'action-first', at: '2026-10-16T01:00:00Z', module: 'action', kind: 'evidence', state: 'update', title: '已核验调用', summary: '调用返回路径不存在', refs: [{ traceStepIndex: 7, anchorId: 'node-7' }] },
    { seq: 2, key: 'planning-next', at: '2026-10-16T01:00:01Z', module: 'planning', kind: 'analysis', state: 'update', title: '核对计划约束', summary: '计划中的目标位置仍待核对' },
  ],
};

test('partial modules appear in first-arrival order with content before final report', () => {
  const markup = renderToStaticMarkup(createElement(DiagnosisModuleCards, { loading: true, failed: false, requestError: false, report: null, progress: partialProgress, zh: true }));
  assert.equal((markup.match(/aria-expanded="true"/g) || []).length, 2);
  assert.ok(markup.indexOf('Action') < markup.indexOf('Planning'));
  assert.match(markup, /调用返回路径不存在/);
  assert.match(markup, /计划中的目标位置仍待核对/);
  assert.match(markup, /Trace #7/);
  assert.match(markup, /待最终报告确认/);
  assert.doesNotMatch(markup, />已有结果</);
});

test('failure preserves partial module evidence without inventing final conclusions', () => {
  const markup = renderToStaticMarkup(createElement(DiagnosisModuleCards, { loading: false, failed: true, requestError: false, report: null, progress: partialProgress, zh: true }));
  assert.match(markup, /调用返回路径不存在/);
  assert.match(markup, /任务中断，已保留阶段内容/);
  assert.match(markup, /以上模块没有返回内容/);
});

test('same-run progress never regresses and retries never inherit old events', () => {
  const old = { ...partialProgress, events: partialProgress.events.slice(0, 1) };
  assert.equal(preserveDiagnosisProgress(partialProgress, old, 'partial')?.events.length, 2);
  assert.equal(preserveDiagnosisProgress(partialProgress, null, 'partial')?.unavailable, true);
  assert.equal(preserveDiagnosisProgress(partialProgress, null, 'new-run'), null);
  assert.equal(preserveDiagnosisProgress(partialProgress, old, 'new-run'), null);
});

test('a failed status request keeps received content without claiming that the task stopped', () => {
  const markup = renderToStaticMarkup(createElement(DiagnosisModuleCards, { loading: true, failed: false, requestError: true, report: null, progress: partialProgress, zh: true }));
  assert.match(markup, /调用返回路径不存在/);
  assert.match(markup, /状态暂不可用/);
  assert.doesNotMatch(markup, /任务中断|任务已中断/);
});

const activityTime = Date.parse('2026-10-16T01:00:30Z');
const started = { ...partialProgress.events[1], state: 'started' as const };
const activityInput = { events: [started], loading: true, failed: false, unavailable: false, now: activityTime };

test('only a confirmed module start enables continuous motion; evidence and other modules do not', () => {
  assert.equal(getModuleActivity(activityInput), 'checking');
  assert.equal(getModuleActivity({ ...activityInput, events: [partialProgress.events[0]] }), 'evidence');
  assert.equal(getModuleActivity({ ...activityInput, events: [partialProgress.events[1]] }), 'updates');
  const markup = renderToStaticMarkup(createElement(DiagnosisModuleCards, { loading: true, failed: false, requestError: false, report: null, progress: { ...partialProgress, events: [{ ...partialProgress.events[0], at: new Date().toISOString() }, { ...started, at: new Date().toISOString() }] }, zh: true }));
  assert.equal((markup.match(/diagnosis-status-spin/g) || []).length, 1);
  assert.match(markup, /证据已返回/);
  assert.match(markup, /检查中/);
});

test('a quiet module stops rotating after sixty seconds and resumes only on its own progress', () => {
  const now = Date.parse(started.at) + 60_000;
  assert.equal(getModuleActivity({ ...activityInput, now: now - 1 }), 'checking');
  assert.equal(getModuleActivity({ ...activityInput, now }), 'waiting');
  assert.equal(getModuleActivity({ ...activityInput, now, events: [started, { ...started, seq: 3, state: 'update', at: new Date(now).toISOString() }] }), 'checking');
});

test('stage completion, skip and failure stop motion; a new round can start again', () => {
  for (const [state, activity] of [['completed', 'stage_done'], ['skipped', 'skipped'], ['failed', 'failed']] as const) {
    const end = { ...started, seq: 3, state };
    assert.equal(getModuleActivity({ ...activityInput, events: [started, end, { ...partialProgress.events[0], seq: 4 }] }), activity);
    assert.equal(getModuleActivity({ ...activityInput, events: [started, end, { ...started, seq: 5 }] }), 'checking');
  }
});

test('interruption, unavailable progress and final report override an unfinished start', () => {
  assert.equal(getModuleActivity({ ...activityInput, failed: true }), 'interrupted');
  assert.equal(getModuleActivity({ ...activityInput, unavailable: true }), 'unknown');
  assert.notEqual(getModuleActivity({ ...activityInput, loading: false }), 'checking');
  assert.equal(getModuleActivity({ ...activityInput, reportStatus: 'result' }), 'result');
  assert.equal(getModuleActivity({ ...activityInput, reportStatus: 'missing' }), 'missing');
});

test('new-content motion is deduplicated by run and sequence and never replays restored history', () => {
  const empty = { ...partialProgress, events: [] };
  assert.deepEqual(getNewModuleSequences(empty, partialProgress), { action: 1, planning: 2 });
  assert.deepEqual(getNewModuleSequences(null, partialProgress), {});
  assert.deepEqual(getNewModuleSequences(partialProgress, { ...partialProgress }), {});
  assert.deepEqual(getNewModuleSequences(partialProgress, empty), {});
  assert.deepEqual(getNewModuleSequences(empty, { ...partialProgress, runId: 'retry' }), {});
  assert.deepEqual(getNewModuleSequences(empty, { ...partialProgress, unavailable: true }), {});
});

test('only received content gets a one-shot cue; terminal and unknown badges stay static', () => {
  const badge = (activity: Parameters<typeof DiagnosisModuleStatus>[0]['activity'], arrivalSeq?: number) => renderToStaticMarkup(createElement(DiagnosisModuleStatus, { activity, arrivalSeq, zh: true }));
  assert.match(badge('updates', 2), /diagnosis-status-arrival/);
  assert.doesNotMatch(badge('updates'), /diagnosis-status-arrival|diagnosis-status-spin/);
  for (const activity of ['failed', 'interrupted', 'unknown', 'result', 'skipped'] as const) {
    assert.doesNotMatch(badge(activity, 2), /diagnosis-status-arrival|diagnosis-status-spin/);
  }
  assert.match(badge('stage_done'), /text-success/);
  assert.doesNotMatch(badge('stage_done'), /diagnosis-status-spin/);
});

test('evidence and updates without a start enter waiting without inventing module execution', () => {
  for (const event of partialProgress.events) {
    const at = Date.parse(event.at);
    assert.equal(getModuleActivity({ ...activityInput, events: [event], now: at + 60_000 }), 'awaiting_analysis');
    assert.equal(getModuleActivity({ ...activityInput, events: [event], now: at + 59_999 }), event.kind === 'evidence' ? 'evidence' : 'updates');
    assert.equal(getModuleActivity({ ...activityInput, events: [event, { ...event, seq: 3, at: new Date(at + 61_000).toISOString() }], now: at + 61_000 }), event.kind === 'evidence' ? 'evidence' : 'updates');
  }
  const markup = renderToStaticMarkup(createElement(DiagnosisModuleCards, { loading: true, failed: false, requestError: false, report: null, progress: partialProgress, zh: true }));
  assert.match(markup, /等待分析进展/);
  assert.match(markup, /模块最近更新/);
  assert.match(markup, /调用返回路径不存在/);
  assert.match(markup, /diagnosis-status-spin-slow/);
  assert.doesNotMatch(markup, /data-module-activity="checking"/);
});

test('colored badges distinguish checking, waiting, completion and unavailable status without a legend', () => {
  const badge = (activity: Parameters<typeof DiagnosisModuleStatus>[0]['activity']) => renderToStaticMarkup(createElement(DiagnosisModuleStatus, { activity, zh: true }));
  assert.match(badge('checking'), /bg-blue-50/);
  assert.match(badge('checking'), /diagnosis-status-spin"/);
  for (const activity of ['waiting', 'awaiting_analysis'] as const) {
    assert.match(badge(activity), /bg-warning-subtle/);
    assert.match(badge(activity), /diagnosis-status-spin-slow/);
  }
  for (const activity of ['stage_done', 'result'] as const) {
    assert.match(badge(activity), /bg-success-subtle/);
    assert.doesNotMatch(badge(activity), /diagnosis-status-spin/);
  }
  for (const activity of ['unknown', 'interrupted', 'failed'] as const) {
    assert.match(badge(activity), /bg-error-subtle/);
    assert.doesNotMatch(badge(activity), /diagnosis-status-spin/);
  }
  assert.doesNotMatch(badge('awaiting_analysis'), /蓝色|琥珀色|绿色/);
});

test('completed Skills report is visible ahead of its collapsed process history', () => {
  const markup = renderToStaticMarkup(createElement(SkillsAnalysisSection, {
    executionId: 'fixture', user: 'fixture', zh: true, submitting: false, onAnalysisUpdate: () => {},
    analysis: { status: 'done', source: 'agent-debug', generatedAt: '2026-10-16T01:00:00Z',
      reasonText: '核验报告总结', keyActionResults: [{ actionId: 'one', actionContent: '核对要求', coverage: 'covered', severity: 'low', traceComparisonAnalysis: '已覆盖要求', skillImprovementSuggestion: '' }],
      skillSuggestions: [], progress: partialProgress },
  }));
  assert.match(markup, /aria-controls=/);
  assert.match(markup, /1 个 Skill 步骤 · 0 条建议/);
  assert.ok(markup.indexOf('核验报告总结') < markup.indexOf('核验过程（共 2 段）'));
  assert.doesNotMatch(markup, /<details[^>]*open/);
});
