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
import fs from 'node:fs';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { deriveExecutionTiming } from '@/lib/engine/observability/execution-timing';
import { deriveOpencodeExecutionFields } from '@/lib/engine/observability/opencode-derived-metrics';
import { buildAgentCallTree, getAgentActiveDurationMs, formatDuration, resolveTraceTimelineBounds, type RawInteraction } from '@/lib/engine/observability/agent-trace';
import { toTraceStructureInteractions } from '@/lib/trace/session-payload';

const base = Date.parse('2026-10-29T01:00:00Z');
const user = (at: number) => ({ role: 'user', content: 'prompt', timeInfo: { created: base + at } });
const answer = (at: number, end: number, extra: Record<string, unknown> = {}) => ({ role: 'assistant', content: 'answer', timeInfo: { created: base + at, completed: base + end }, ...extra });
const task = (at: number, end: number, id = 'child') => ({ id: 'spawn-' + id, function: { name: 'task', arguments: JSON.stringify({ subagent_type: 'worker', session_id: id }) }, timing: { started_at: base + at, completed_at: base + end } });

function check(rows: Parameters<typeof deriveOpencodeExecutionFields>[0], active: number, elapsed: number) {
  assert.equal(deriveOpencodeExecutionFields(rows).latency, active);
  const full = buildAgentCallTree(rows as RawInteraction[])!;
  const light = buildAgentCallTree(toTraceStructureInteractions(rows))!;
  assert.equal(full.stats.activeDurationMs, active);
  assert.equal(full.stats.elapsedDurationMs, elapsed);
  assert.equal(light.stats.activeDurationMs, active);
  assert.equal(light.stats.elapsedDurationMs, elapsed);
  assert.equal(resolveTraceTimelineBounds(full)?.durationMs, elapsed);
  assert.equal(resolveTraceTimelineBounds(light)?.durationMs, elapsed);
  return full;
}

test('Trace latency excludes one hour of user idle while the real timeline retains it', () => {
  const rows = [user(0), answer(0, 20000), user(3620000), answer(3620000, 3650000)];
  const tree = check(rows, 50000, 3650000);
  assert.equal(tree.startedAt, base);
  assert.equal(tree.endedAt, base + 3650000);
});

test('Trace latency includes tools and retry waits inside a turn without an idle threshold', () => {
  check([user(0), answer(0, 1000, { tool_calls: [task(1000, 601000)] }), answer(620000, 625000)], 625000, 625000);
});

test('Concurrent child calls and parent task spans count only once', () => {
  const rows = [
    user(0), answer(0, 1000, { tool_calls: [task(1000, 10000, 'a'), task(1000, 15000, 'b')] }),
    answer(20000, 21000),
    answer(1000, 10000, { role: 'subagent', subagent_session_id: 'a', subagent_name: 'worker' }),
    answer(1000, 15000, { role: 'subagent', subagent_session_id: 'b', subagent_name: 'worker' }),
  ];
  const tree = check(rows, 21000, 21000);
  assert.equal(tree.children.length, 2);
  assert.deepEqual(tree.children.map(c => c.stats.activeDurationMs).sort((a, b) => a! - b!), [9000, 14000]);
});

test('User input while a child is still active does not remove ongoing work', () => {
  check([user(0), answer(0, 1000, { tool_calls: [task(1000, 30000)] }), user(10000), answer(10000, 12000)], 30000, 30000);
});

test('Historical raw tool part times survive the lightweight structure and effective latency', () => {
  check([user(0), answer(0, 1000, { parts: [{ type: 'tool', state: { status: 'completed', time: { start: base + 1000, end: base + 20000 } } }] })], 20000, 20000);
});

test('A pending user message and late metadata do not turn user idle into work', () => {
  check([user(0), answer(0, 20000), user(3620000), { role: 'system', content: 'metadata', timestamp: base + 4000000 }], 20000, 3620000);
});

test('Invalid times, reversed intervals and shuffled arrival order do not inflate latency', () => {
  check([answer(3620000, 3650000), user(3620000), answer(0, 20000), user(0), { role: 'system', timestamp: base - 86400000 }, answer(1000000, 999999)], 50000, 3650000);
});

test('Missing timing stays unknown in the tree and is zero in persisted legacy metrics', () => {
  const rows = [{ role: 'user', content: 'prompt' }, { role: 'assistant', content: 'answer' }];
  assert.equal(deriveOpencodeExecutionFields(rows).latency, 0);
  assert.equal(buildAgentCallTree(rows as RawInteraction[])!.stats.activeDurationMs, undefined);
});


test('Failure-only execution intervals count without creating an LLM call', () => {
  check([user(0), { role: 'system', error: { code: 'MODEL_ERROR' }, timeInfo: { created: base, completed: base + 15000 } }], 15000, 15000);
});

test('Malformed optional tool arrays do not discard valid execution timing', () => {
  assert.equal(deriveExecutionTiming([user(0), answer(0, 20000, { parts: {}, tool_calls: 'invalid' })]).activeDurationMs, 20000);
});

test('Child prompts are round boundaries only for that child, not its parent', () => {
  const rows = [user(0), answer(0, 1000, { tool_calls: [task(1000, 14000)] }),
    { ...user(1000), role: 'opencode', subagent_session_id: 'child' },
    answer(1000, 3000, { role: 'subagent', subagent_session_id: 'child' }),
    { ...user(10000), role: 'opencode', subagent_session_id: 'child' },
    answer(10000, 14000, { role: 'subagent', subagent_session_id: 'child' }), answer(15000, 16000)];
  const tree = check(rows, 16000, 16000);
  assert.equal(tree.children[0].stats.activeDurationMs, 6000);
  assert.equal(deriveExecutionTiming(rows.slice(2, 6), 'child').activeDurationMs, 6000);
});


test('An independently opened child Trace uses its own input boundaries', () => {
  const rows = [
    { ...user(0), role: 'opencode', subagent_session_id: 'child' },
    answer(0, 20000, { role: 'subagent', subagent_session_id: 'child' }),
    { ...user(3620000), role: 'opencode', subagent_session_id: 'child' },
    answer(3620000, 3650000, { role: 'subagent', subagent_session_id: 'child' }),
  ];
  assert.equal(buildAgentCallTree(rows, 'child')!.stats.activeDurationMs, 50000);
  assert.equal(deriveOpencodeExecutionFields(rows, 'child').latency, 50000);
});


test('Spawned child summary displays effective time and preserves legacy timing fallback', () => {
  const source = fs.readFileSync('src/components/observe/AgentTraceView.tsx', 'utf8');
  const ast = ts.createSourceFile('AgentTraceView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ['SpawnedChildSummary', 'getStatus', 'isErrorToolStatus'];
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text || ''));
  assert.equal(functions.length, names.length);
  const code = ts.transpileModule(functions.map(node => node.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  const scope = {
    React, TraceCtx: React.createContext({}), getAgentActiveDurationMs, formatDuration,
    useLocale: () => ({ locale: 'zh' }), SLOW_MS: 60000, STATUS_DOT: { error: 'bg-error', slow: 'bg-warning' },
    cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
    KindBadge: () => null, getAgentNodeDisplayLabel: () => 'worker', exactTokens: (n: number) => String(n),
  };
  const Summary = new Function(...Object.keys(scope), code + '\nreturn SpawnedChildSummary;')(...Object.values(scope));
  const rows = [
    { ...user(0), role: 'opencode', subagent_session_id: 'child' },
    answer(0, 20000, { role: 'subagent', subagent_session_id: 'child' }),
    { ...user(3620000), role: 'opencode', subagent_session_id: 'child' },
    answer(3620000, 3650000, { role: 'subagent', subagent_session_id: 'child' }),
  ];
  const child = buildAgentCallTree(rows, 'child')!;
  assert.equal(child.stats.activeDurationMs, 50000);
  assert.equal(child.stats.durationMs, 3650000);
  const html = renderToStaticMarkup(React.createElement(Summary, { child }));
  assert.match(html, />50s<\/b>/);
  assert.ok(!html.includes(formatDuration(3650000)), 'the child card must not display user idle as execution time');
  const legacy = { ...child, stats: { ...child.stats, activeDurationMs: undefined, durationMs: 20000 } };
  assert.match(renderToStaticMarkup(React.createElement(Summary, { child: legacy })), />20s<\/b>/);
});
