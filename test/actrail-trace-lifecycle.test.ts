import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { aggregateOtelTraceEvents } from '@/lib/ingest/otel/aggregate';
import { normalizeOtlpTraces } from '@/lib/ingest/otel/normalize';

const traceId = '00000000000000000000000000000301';
function span(kind: string, id: string, processId = 7, extra: Record<string, string | number> = {}) {
  const attrs = {
    'actrail.action.id': id,
    'actrail.action.kind': kind,
    'actrail.action.status': 'success',
    'actrail.action.completeness': 'complete',
    'actrail.process.id': processId,
    ...extra,
  };
  return {
    traceId, spanId: id, name: kind,
    startTimeUnixNano: kind.endsWith('.exit') ? '9000000000' : '1000000000',
    endTimeUnixNano: kind.endsWith('.exit') ? '9000000000' : '2000000000',
    attributes: Object.entries(attrs).map(([key, value]) => ({
      key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value },
    })),
  };
}
function body(extra: ReturnType<typeof span>[] = []) {
  return {
    resourceSpans: [{
      resource: { attributes: [] },
      scopeSpans: [{
        scope: { name: 'actrail.semantic_actions', version: '0.7.1' },
        spans: [
          span('command.invocation', 'command', 7, { 'invocation.kind': 'agent' }),
          span('llm.request', 'request', 7, { 'llm.request.message_preview': 'check project' }),
          span('llm.call', 'call', 7, {
            'llm.call.request_action_id': 'request', 'actrail.action.status': 'in_progress',
          }),
          ...extra,
        ],
      }],
    }],
  };
}
function aggregate(extra: ReturnType<typeof span>[] = []) {
  const record = aggregateOtelTraceEvents(traceId, normalizeOtlpTraces(body(extra)));
  assert.ok(record);
  return record;
}

test('AcTrail lifecycle: a matched abnormal root process exit ends a trace without an answer', () => {
  const record = aggregate([span('process.exit', 'exit', 7, { 'process.exit_code': 130 })]);
  assert.equal(record.final_result, '');
  assert.equal(record.trace_completed_at, '1970-01-01T00:00:09.000Z');
  assert.equal(record.failures?.[0]?.failure_type, 'agent-process-exit');
  assert.match(record.failures![0].description, /130/);
});

test('AcTrail lifecycle: agent.exit with a zero exit code ends a trace without inventing an answer', () => {
  const record = aggregate([span('agent.exit', 'exit', 7, { 'process.exit_code': '0' })]);
  assert.equal(record.trace_completed_at, '1970-01-01T00:00:09.000Z');
  assert.equal(record.final_result, '');
  assert.equal(record.failures?.length ?? 0, 0);
});

test('AcTrail lifecycle: exec success, unrelated exits and unknown exit outcomes do not complete the trace', () => {
  for (const extra of [
    [],
    [span('process.exit', 'tool-exit', 8, { 'process.exit_code': 1 })],
    [span('process.exit', 'unknown-exit')],
    [span('process.exit', 'bad-exit', 7, { 'process.exit_code': 'unknown' })],
    [span('process.exit', 'partial-exit', 7, {
      'process.exit_code': 1, 'actrail.action.completeness': 'partial',
    })],
  ]) {
    assert.equal(aggregate(extra).trace_completed_at, undefined);
  }
});

test('AcTrail lifecycle: root process matching remains conservative with missing IDs or later activity', () => {
  const events = normalizeOtlpTraces(body([span('process.exit', 'exit', 7, { 'process.exit_code': 130 })]));
  for (const event of events.filter(item => item.attributes['actrail.action.kind'].startsWith('llm.'))) {
    delete event.attributes['actrail.process.id'];
  }
  assert.equal(aggregateOtelTraceEvents(traceId, events)?.trace_completed_at, undefined);
  const lateCall = span('llm.call', 'late-call', 7, { 'actrail.action.status': 'in_progress' });
  lateCall.startTimeUnixNano = '10000000000';
  lateCall.endTimeUnixNano = '10000000000';
  assert.equal(aggregate([span('process.exit', 'exit', 7, { 'process.exit_code': 130 }), lateCall]).trace_completed_at, undefined);
});

test('AcTrail lifecycle: OTLP endpoint, spool, persistence and both observe read modes retain failed completion', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'actrail-lifecycle-'));
  const oldEnv = { ...process.env };
  const databasePath = path.join(root, 'test.db');
  fs.writeFileSync(databasePath, '');
  delete process.env.DB_HOST;
  process.env.DATABASE_URL = `file:${databasePath}`;
  process.env.AGENT_INSIGHT_DATA_DIR = path.join(root, 'data');
  process.env.AGENT_INSIGHT_ACTRAIL_OTEL_SPOOL_DIR = path.join(root, 'spool');
  process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR = path.join(root, 'generic');
  process.env.AGENT_INSIGHT_OPENCODE_SPOOL_DIR = path.join(root, 'opencode');
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], {
    env: process.env, stdio: 'pipe',
  });
  const { prismaRaw } = await import('@/lib/storage/prisma');
  context.after(async () => {
    await prismaRaw.$disconnect();
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { POST } = await import('@/app/api/ingest/otel/v1/traces/route');
  const { listSources } = await import('@/lib/ingest/otel-consumer/sources');
  const { saveExecutionRecord } = await import('@/lib/storage/data-service');
  const { GET } = await import('@/app/api/observe/data/route');
  const source = listSources().find(item => item.id === 'actrail-otel-traces');
  assert.ok(source);
  const runningResponse = await POST(new Request('http://localhost/api/ingest/otel/v1/traces', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body()),
  }));
  assert.equal(runningResponse.status, 200);
  const runningRecord = source.aggregate(traceId).record;
  assert.ok(runningRecord);
  await saveExecutionRecord(runningRecord);
  const runningList = await GET(new Request(`http://localhost/api/observe/data?taskId=${traceId}&skipAutoEvalReady=1&fields=light`));
  assert.equal((await runningList.json())[0].trace_status, 'running');
  const response = await POST(new Request('http://localhost/api/ingest/otel/v1/traces', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body([span('process.exit', 'exit', 7, { 'process.exit_code': 130 })])),
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).received, 4);
  const { record } = source.aggregate(traceId);
  assert.ok(record);
  await saveExecutionRecord(record);
  const session = await prismaRaw.session.findFirst({ where: { taskId: traceId } });
  assert.equal(session?.endTime?.toISOString(), '1970-01-01T00:00:09.000Z');
  for (const query of ['skipAutoEvalReady=1&fields=light', 'skipAutoEvalReady=0', 'paginated=1&databasePagination=1&page=1&pageSize=10&skipAutoEvalReady=1&fields=light&status=failed', 'paginated=1&databasePagination=1&page=1&pageSize=10&skipAutoEvalReady=1&fields=light']) {
    const result = await GET(new Request(`http://localhost/api/observe/data?taskId=${traceId}&${query}`));
    assert.equal(result.status, 200);
    const payload = await result.json();
    const records = Array.isArray(payload) ? payload : payload.records;
    if (!Array.isArray(payload)) assert.equal(payload.stats.failedCount, 1, query);
    assert.equal(records.length, 1, query);
    assert.equal(records[0].trace_status, 'failed', query);
    assert.equal(records[0].trace_completed_at, '1970-01-01T00:00:09.000Z');
    if (query === 'skipAutoEvalReady=0') assert.equal(records[0].auto_eval_ready, false);
  }
});
