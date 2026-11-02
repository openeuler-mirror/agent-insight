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
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '@/lib/storage/prisma';
import { withEvaluatorExecution } from '@/lib/engine/experiment/evaluator-execution-policy';
import { evaluateTaskCompletionViaOpencode } from '@/lib/engine/evaluation/opencode-task-completion-evaluator';
import { evaluateTrajectoryViaOpencode } from '@/lib/engine/evaluation/opencode-trajectory-evaluator';

process.env.DATABASE_URL = process.env.AGENT_INSIGHT_TEST_DATABASE_URL || process.env.DATABASE_URL;

test('real HTTP task scoring reuses extracted key points across retries and disables SDK retries/fallback', async () => {
  let extracts = 0;
  const stages: string[] = [];
  let scores = 0;
  const messages: string[] = [];
  const user = `scoring-http-${Date.now()}`;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    const extracting = data.messages.length === 1;
    if (extracting) { extracts++; stages.push('extract'); } else { scores++; stages.push(`score-${scores}`); messages.push(data.messages[1].content); }
    if (!extracting && scores === 1) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":{"message":"temporary failure"}}'); return; }
    const content = extracting ? { root_causes: [{ content: 'target point', weight: 1 }] }
      : { reason: '完成', key_point_findings: [{ content: 'target point', score: 1, covered: true, coverage_status: 'covered', coverage_reason: '已覆盖' }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'synthetic', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await prisma.userSettings.create({ data: { user, settingsJson: JSON.stringify({ activeConfigId: 'local', configs: [{ id: 'local', name: 'local', provider: 'openai', model: 'fixture', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKey: 'synthetic' }] }) } });
    const attempts: number[] = [];
    const result = await withEvaluatorExecution({ attemptTimeoutSeconds: 30, maxRetries: 1 }, new AbortController().signal,
      () => evaluateTaskCompletionViaOpencode({ caseInput: 'task', expectedOutput: 'target', actualOutput: 'target', skillAttributionMode: 'no-skill' }, user),
      { retryDelaysMs: [0], onAttempt: n => { attempts.push(n); stages.push(`attempt-${n}`); } });
    assert.equal(result.score, 1);
    assert.equal(extracts, 1);
    assert.equal(scores, 2);
    assert.equal(messages[0], messages[1]);
    assert.deepEqual(attempts, [1, 2]);
    assert.deepEqual(stages, ['extract', 'attempt-1', 'score-1', 'attempt-2', 'score-2']);
  } finally {
    await prisma.userSettings.deleteMany({ where: { user } });
    await prisma.session.deleteMany({ where: { user } });
    await prisma.execution.deleteMany({ where: { user } });
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('real HTTP trajectory scoring retries invalid output within one shared score budget policy', async () => {
  let requests = 0;
  const user = `trajectory-http-${Date.now()}`;
  const server = createServer((_req, res) => {
    requests++;
    const content = requests === 1 ? 'invalid-json' : JSON.stringify({ conclusion: '通过', dimension_scores: { tool_choice: 1, redundancy: 1 }, dimension_details: {} });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'synthetic', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await prisma.userSettings.create({ data: { user, settingsJson: JSON.stringify({ activeConfigId: 'local', configs: [{ id: 'local', name: 'local', provider: 'openai', model: 'fixture', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKey: 'synthetic' }] }) } });
    const result = await withEvaluatorExecution({ attemptTimeoutSeconds: 30, maxRetries: 1 }, new AbortController().signal,
      () => evaluateTrajectoryViaOpencode({ caseId: 'fixture', caseInput: 'task', comparisonMode: 'trace_only', actualInteractions: [], actualExtractedSteps: [] }, user), { retryDelaysMs: [0] });
    assert.equal(requests, 2);
    assert.equal(result.trajectoryScore, 1);
  } finally {
    await prisma.userSettings.deleteMany({ where: { user } });
    await prisma.session.deleteMany({ where: { user } });
    await prisma.execution.deleteMany({ where: { user } });
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
