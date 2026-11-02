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
import { createIsolatedDatabase } from './helpers/isolated-database';
import { difyAgentFixture, difyAgentSessionId } from './fixtures/dify-agent-trajectory';
import { normalizeOtlpTraces } from '@/lib/ingest/otel/normalize';
import { aggregateOtelTraceEvents } from '@/lib/ingest/otel/aggregate';

const database = createIsolatedDatabase();
const { prismaRaw } = require('@/lib/storage/prisma') as typeof import('@/lib/storage/prisma');
const { GET } = require('@/app/api/observe/session/route') as typeof import('@/app/api/observe/session/route');
const context = { tenantId: 'tenant', appId: 'app', workflowRunId: 'run', nodeId: 'agent', nodeExecutionId: 'execution' };
const base = { traceId: 'outer', parentSpanId: null, sourceParentSpanId: null, displayParentSpanId: null, kind: 'chain', startedAt: 900, completedAt: 4000, durationMs: 3100, visibility: 'visible', status: 'success' };
const outer = [{ ...base, spanId: 'workflow', name: 'Workflow', dify: { ...context, nodeExecutionId: undefined } }, { ...base, spanId: 'agent-node', parentSpanId: 'workflow', sourceParentSpanId: 'workflow', displayParentSpanId: 'workflow', name: 'Agent node', dify: context }];
async function read(key = 'alice-key', query = '') {
  const response = await GET(new Request(`http://localhost/api/observe/session?taskId=dify:outer&view=structure${query}`, { headers: { 'x-witty-api-key': key } }));
  return { status: response.status, body: await response.json() };
}
test.after(async () => { await prismaRaw.$disconnect(); database.dispose(); });
test('Authenticated Workflow details dynamically include late Agent traces without changing source records or crossing owners', async () => {
  await prismaRaw.user.createMany({ data: [{ username: 'alice', apiKey: 'alice-key' }, { username: 'bob', apiKey: 'bob-key' }] });
  await prismaRaw.session.create({ data: { taskId: 'dify:outer', user: 'alice', interactions: '[]', langfuseTraceNodes: JSON.stringify(outer) } });
  await prismaRaw.execution.create({ data: { taskId: 'dify:outer', user: 'alice', framework: 'dify', tokens: 0 } });
  assert.equal((await read()).body.langfuseTraceNodes.length, 2);
  const record = aggregateOtelTraceEvents(difyAgentSessionId, normalizeOtlpTraces(difyAgentFixture().body))!;
  const nodes = record.langfuseTraceNodes!.map(n => ({ ...n, dify: { ...context, trajectory: true } }));
  await prismaRaw.session.create({ data: { taskId: difyAgentSessionId, user: 'alice', interactions: JSON.stringify(record.interactions), langfuseTraceNodes: JSON.stringify(nodes) } });
  await prismaRaw.execution.create({ data: { taskId: difyAgentSessionId, user: 'alice', framework: 'dify', tokens: 18 } });
  const response = await read();
  assert.equal(response.status, 200);
  assert.equal(response.body.langfuseTraceNodes.length, 6);
  assert.equal(response.body.difyProjection.linkedTraces, 1);
  assert.equal(response.body.execution.tokens, 18);
  assert.equal((await read()).body.langfuseTraceNodes.length, 6);
  assert.equal((await read('alice-key', '&source=raw')).body.langfuseTraceNodes.length, 2);
  assert.equal((await read('invalid')).body.langfuseTraceNodes.length, 2);
  assert.equal((await read('bob-key')).status, 403);
  assert.equal(Number((await prismaRaw.execution.findFirstOrThrow({ where: { taskId: 'dify:outer' } })).tokens), 0);
  assert.equal((await prismaRaw.session.findUniqueOrThrow({ where: { taskId: 'dify:outer' } })).langfuseTraceNodes, JSON.stringify(outer));
  await prismaRaw.session.update({ where: { taskId: difyAgentSessionId }, data: { user: 'bob' } });
  assert.equal((await read()).body.langfuseTraceNodes.length, 2);
});

test('Workflow session lookup bounds a large child payload before parsing and reports truncation', async () => {
  const nodes = [{ ...base, kind: 'agent', traceId: 'huge', spanId: 'huge-root', name: 'Large Agent', dify: { ...context, trajectory: true }, input: 'x'.repeat(5 * 1024 * 1024) }];
  await prismaRaw.session.create({ data: { taskId: 'dify:huge', user: 'alice', interactions: '[]', langfuseTraceNodes: JSON.stringify(nodes) } });
  await prismaRaw.execution.create({ data: { taskId: 'dify:huge', user: 'alice', framework: 'dify', tokens: 0 } });
  const response = await read();
  assert.equal(response.status, 200);
  assert.equal(response.body.difyProjection.truncated, true);
  assert.equal(response.body.langfuseTraceNodes.length, 2);
});

test('OpenGauss mode does not query local SQLite for cross-trace projection', async () => {
  const previous = process.env.DB_HOST;
  process.env.DB_HOST = 'opengauss-projection-guard';
  try {
    const response = await read();
    assert.equal(response.status, 200);
    assert.equal(response.body.difyProjection, undefined);
    assert.equal(response.body.langfuseTraceNodes.length, 2);
  } finally {
    if (previous === undefined) delete process.env.DB_HOST;
    else process.env.DB_HOST = previous;
  }
});
