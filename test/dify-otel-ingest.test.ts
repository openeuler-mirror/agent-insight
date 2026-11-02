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
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createIsolatedDatabase } from './helpers/isolated-database';
import { difyAgentFixture, difyAgentSessionId } from './fixtures/dify-agent-trajectory';

const database = createIsolatedDatabase();
const { POST } = require('@/app/api/ingest/otel/v1/traces/route') as typeof import('@/app/api/ingest/otel/v1/traces/route');
const { listSources } = require('@/lib/ingest/otel-consumer/sources') as typeof import('@/lib/ingest/otel-consumer/sources');
const { saveExecutionRecord } = require('@/lib/storage/data-service') as typeof import('@/lib/storage/data-service');
const { startOtelSpoolConsumer, stopOtelSpoolConsumer, getOtelSpoolConsumerForTest } = require('@/lib/ingest/otel-consumer/consumer') as typeof import('@/lib/ingest/otel-consumer/consumer');
const { prismaRaw } = require('@/lib/storage/prisma') as typeof import('@/lib/storage/prisma');
process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR = path.join(database.home, 'spool');
test.after(async () => {
  const state = getOtelSpoolConsumerForTest();
  stopOtelSpoolConsumer();
  const deadline = Date.now() + 5000;
  while (state && (state.dispatching || state.ticking) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(!state?.dispatching && !state?.ticking, 'Consumer must finish outstanding writes before database cleanup');
  await prismaRaw.$disconnect();
  database.dispose();
});

test('Dify HTTP handler, spool aggregation and storage retain a single trace and node tree across late batches', async () => {
  const traceId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const sessionId = `dify:${traceId}`;
  const key = 'dify-fixture-ingest-key';
  await prismaRaw.user.upsert({ where: { username: 'admin' }, create: { username: 'admin', apiKey: key }, update: { apiKey: key } });
  const attributes = (a: Record<string, string | number>) => Object.entries(a).map(([key, value]) => ({ key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value } }));
  const span = (spanId: string, values: Record<string, string | number>, name = spanId) => ({ traceId, spanId, parentSpanId: 'root', name, startTimeUnixNano: '1000000000', endTimeUnixNano: '2000000000', status: { code: 1 }, attributes: attributes(values) });
  const llm = span('llm', { 'node.type': 'llm', 'gen_ai.framework': 'dify', 'gen_ai.request.model': 'deepseek-flash', 'gen_ai.prompt': '[{"role":"system","text":"be concise"},{"role":"user","text":"hello"}]', 'gen_ai.completion': 'answer', 'gen_ai.usage.input_tokens': 38, 'gen_ai.usage.output_tokens': 35 });
  const send = async (spans: any[], suppliedKey = key) => POST(new Request('http://localhost/api/ingest/otel/v1/traces', { method: 'POST', headers: { 'content-type': 'application/json', 'x-witty-api-key': suppliedKey }, body: JSON.stringify({ resourceSpans: [{ resource: { attributes: attributes({ 'service.name': 'langgenius/dify' }) }, scopeSpans: [{ spans }] }] }) }));
  assert.equal((await send([llm], 'invalid-key')).status, 401);
  assert.equal(fs.existsSync(process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR!), false);
  assert.equal((await send([llm])).status, 200);
  const source = listSources().find(s => s.id === 'otel-traces')!;
  startOtelSpoolConsumer({ sources: [source], startMode: 'resume', seedOnStart: false, shortMs: 5, longMs: 10, maxWaitMs: 15, tickMs: 5, aggCooldownFactor: 0, aggGlobalFactor: 0, log: () => {} });
  async function waitForSession(nodes: number, completed = false) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const session = await prismaRaw.session.findUnique({ where: { taskId: sessionId } });
      if (session && JSON.parse(session.langfuseTraceNodes || '[]').length === nodes && (!completed || session.endTime)) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Automatic consumer did not persist the expected Dify node tree');
  }
  await waitForSession(1);
  assert.equal((await prismaRaw.session.findUniqueOrThrow({ where: { taskId: sessionId } })).endTime, null);
  const root = span('root', { 'dify.app_id': 'app', 'dify.workflow_id': 'workflow' }, 'services.workflow_run_agg.WorkflowRunAgg.run');
  const start = span('start', { 'node.type': 'start', 'output.value': '{"question":"hello","sys.workflow_run_id":"run-1"}' });
  const end = span('end', { 'node.type': 'end', 'output.value': '{"answer":"answer"}' });
  assert.equal((await send([root, start, end])).status, 200);
  await waitForSession(4, true);
  await send([llm, root, start, end]);
  await saveExecutionRecord({ ...source.aggregate(sessionId).record!, skip_evaluation: true });
  const execution = await prismaRaw.execution.findFirstOrThrow({ where: { taskId: sessionId } });
  assert.equal(execution.framework, 'dify');
  assert.equal(execution.user, 'admin');
  assert.equal(Number(execution.tokens), 73);
  assert.equal(await prismaRaw.execution.count({ where: { taskId: sessionId } }), 1);
  const session = await prismaRaw.session.findUniqueOrThrow({ where: { taskId: sessionId } });
  assert.equal(session.endTime!.getTime(), 2000);
  assert.equal(JSON.parse(session.langfuseTraceNodes!).length, 4);
  const interactions = JSON.parse(session.interactions!);
  assert.equal(interactions.filter((row: any) => row.spanId === 'llm').length, 1);
  assert.deepEqual(interactions.find((row: any) => row.spanId === 'llm').requestMessages.map((m: any) => m.role), ['system', 'user']);
});

test('Dify Agent native OTLP automatically persists model and tool details with authenticated ownership', async () => {
  const { body, root } = difyAgentFixture();
  const spans = body.resourceSpans[0].scopeSpans[0].spans;
  const send = async (selected: typeof spans) => {
    body.resourceSpans[0].scopeSpans[0].spans = selected;
    const response = await POST(new Request('http://localhost/api/ingest/otel/v1/traces', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-witty-api-key': 'dify-agent-fixture-key' },
      body: JSON.stringify(body),
    }));
    assert.equal(response.status, 200);
  };
  await prismaRaw.user.upsert({ where: { username: 'admin' }, create: { username: 'admin', apiKey: 'dify-agent-fixture-key' }, update: { apiKey: 'dify-agent-fixture-key' } });
  const source = listSources().find(s => s.id === 'otel-traces')!;
  startOtelSpoolConsumer({ sources: [source], startMode: 'resume', seedOnStart: false, shortMs: 5, longMs: 10, maxWaitMs: 15, tickMs: 5, aggCooldownFactor: 0, aggGlobalFactor: 0, log: () => {} });
  async function waitForNodes(count: number, completed = false) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const session = await prismaRaw.session.findUnique({ where: { taskId: difyAgentSessionId } });
      if (session && JSON.parse(session.langfuseTraceNodes || '[]').length === count && (!completed || session.endTime)) return session;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Automatic consumer did not persist the Agent trajectory');
  }
  await send(spans.filter(s => s !== root));
  assert.equal((await waitForNodes(3)).endTime, null);
  await send([root]);
  const session = await waitForNodes(4, true);
  assert.equal(session.endTime!.getTime(), 3000);
  await send(spans);
  const record = source.aggregate(difyAgentSessionId).record!;
  await saveExecutionRecord({ ...record, skip_evaluation: true });
  const execution = await prismaRaw.execution.findFirstOrThrow({ where: { taskId: difyAgentSessionId } });
  assert.equal(execution.user, 'admin');
  assert.equal(execution.framework, 'dify');
  assert.equal(Number(execution.tokens), 18);
  assert.equal(await prismaRaw.execution.count({ where: { taskId: difyAgentSessionId } }), 1);
  const saved = await prismaRaw.session.findUniqueOrThrow({ where: { taskId: difyAgentSessionId } });
  const interactions = JSON.parse(saved.interactions!);
  assert.equal(interactions.filter((i: any) => i.model).length, 2);
  assert.deepEqual(interactions.find((i: any) => i.spanId === '4444444444444444').requestMessages.map((m: any) => m.role), ['system', 'user', 'assistant', 'tool']);
  const tool = JSON.parse(saved.langfuseTraceNodes!).find((n: any) => n.kind === 'tool');
  assert.deepEqual(tool.input, { item: 'alpha' });
  assert.deepEqual(tool.output, { value: 'ok' });
  assert.equal(tool.linkedGenerationSpanId, '2222222222222222');
});
