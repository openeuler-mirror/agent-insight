import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import otlpRoot from '@opentelemetry/otlp-transformer/build/src/generated/root';
import { POST, OPTIONS } from '@/app/api/ingest/otel/v1/traces/route';
import { POST as PUBLIC_POST } from '@/app/api/public/otel/v1/traces/route';
import { db } from '@/lib/storage/prisma';
import { OtelIngestDiagnostics } from '@/lib/ingest/otel/diagnostics';

const traceId = '0123456789abcdef0123456789abcdef';
const body = {
  resourceSpans: [{ scopeSpans: [{ spans: [{
    traceId, spanId: '0123456789abcdef', name: 'test', startTimeUnixNano: '1000000000', endTimeUnixNano: '2000000000',
    attributes: [{ key: 'langfuse.observation.type', value: { stringValue: 'span' } }],
  }] }] }],
};

function setup(t: TestContext) {
  const global = globalThis as typeof globalThis & { __otelIngestDiagnostics?: OtelIngestDiagnostics };
  const previous = global.__otelIngestDiagnostics;
  const priorSpool = process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-route-diagnostics-'));
  process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR = path.join(temp, 'spool');
  const lines: any[] = [], otherLogs: string[] = [], timers: Array<() => void> = [];
  global.__otelIngestDiagnostics = new OtelIngestDiagnostics({
    emit: (_level, line) => lines.push(JSON.parse(line.slice('[OTelIngest] '.length))),
    schedule: callback => { timers.push(callback); },
  });
  t.mock.method(console, 'log', (...args: unknown[]) => otherLogs.push(JSON.stringify(args)));
  t.mock.method(console, 'warn', (...args: unknown[]) => otherLogs.push(JSON.stringify(args)));
  t.mock.method(console, 'error', (...args: unknown[]) => otherLogs.push(JSON.stringify(args)));
  t.after(() => {
    global.__otelIngestDiagnostics = previous;
    if (priorSpool === undefined) delete process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR;
    else process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR = priorSpool;
    fs.rmSync(temp, { recursive: true, force: true });
  });
  return { lines, otherLogs, temp, summarize: () => timers.shift()?.() };
}

function request(headers: Record<string, string> = {}, data: BodyInit = JSON.stringify(body)) {
  return new Request('http://localhost/api/public/otel/v1/traces', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: data,
  });
}

test('public POST logs arrival before its database await and correlates accepted spans with spool completion', async t => {
  const f = setup(t);
  let release!: (user: any) => void;
  t.mock.method(db, 'findUserByApiKey', () => new Promise(resolve => { release = resolve; }));
  const pending = PUBLIC_POST(request({ 'x-witty-api-key': 'never-log-key' }));
  const received = f.lines.find(x => x.event === 'received');
  release({ username: 'fixture' });
  const response = await pending;
  assert.ok(received, 'request arrival must precede the database result');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).persisted, 1);
  const done = f.lines.find(x => x.event === 'completed');
  assert.equal(done.requestId, received.requestId);
  assert.deepEqual(done.traceIds, [traceId]);
  assert.equal(done.spooled, 1);
  assert.equal(done.stage, 'spool');
  assert.equal(done.authenticated, true);
  assert.equal(f.otherLogs.length, 0);
});

test('Prisma P1008 before decode produces a bounded failure with an arrival id, without secret error text', async t => {
  const f = setup(t);
  t.mock.method(db, 'findUserByApiKey', async () => { throw Object.assign(new Error('never-log-query-secret'), { code: 'P1008' }); });
  for (let i = 0; i < 100; i++) assert.equal((await POST(request({ 'x-witty-api-key': 'never-log-key' }))).status, 500);
  assert.equal(f.lines.filter(x => x.event === 'failed').length, 1);
  const failure = f.lines.find(x => x.event === 'failed');
  assert.equal(failure.stage, 'api-key-auth');
  assert.equal(failure.errorCode, 'P1008');
  assert.deepEqual(failure.traceIds, []);
  assert.equal(fs.existsSync(path.join(f.temp, 'spool')), false);
  f.summarize();
  const summary = f.lines.at(-1);
  assert.equal(summary.receivedByAuth['api-key'], 100);
  assert.equal(summary.http['500'], 100);
  assert.equal(summary.suppressedErrors, 99);
  assert.doesNotMatch(JSON.stringify([f.lines, f.otherLogs]), /never-log/);
  assert.equal(f.otherLogs.length, 0);
});

test('Basic and API-key success are counted separately without per-request authentication logs', async t => {
  const f = setup(t);
  t.mock.method(db, 'findUserByUsername', async () => ({ username: 'fixture', apiKey: 'fixture-secret' }));
  t.mock.method(db, 'findUserByApiKey', async () => ({ username: 'fixture' }));
  for (let i = 0; i < 20; i++) {
    const headers: Record<string, string> = i % 2 ? { authorization: `Basic ${Buffer.from('fixture:fixture-secret').toString('base64')}` } : { 'x-witty-api-key': 'fixture-secret' };
    assert.equal((await POST(request(headers))).status, 200);
  }
  f.summarize();
  assert.equal(f.lines.at(-1).authenticatedByAuth.basic, 10);
  assert.equal(f.lines.at(-1).authenticatedByAuth['api-key'], 10);
  assert.equal(f.lines.at(-1).spooled, 20);
  assert.ok(f.lines.length <= 5);
  assert.equal(f.otherLogs.length, 0);
});

test('decode failures that previously returned silently now report 400/415 with encoding', async t => {
  const f = setup(t);
  const compressed = await POST(request({ 'content-type': 'application/x-protobuf', 'content-encoding': 'gzip' }, new Uint8Array(gzipSync('not-protobuf'))));
  assert.equal(compressed.status, 400);
  const unsupported = await POST(request({ 'content-type': 'text/plain' }));
  assert.equal(unsupported.status, 415);
  const failures = f.lines.filter(x => x.event === 'failed');
  assert.equal(failures.length, 2);
  assert.ok(failures.every(x => x.stage === 'decode'));
  assert.equal(failures[0].contentEncoding, 'gzip');
});

test('authentication rejection and filesystem failure preserve response behavior while locating the failed stage', async t => {
  const f = setup(t);
  const lookup = t.mock.method(db, 'findUserByApiKey', async () => null);
  assert.equal((await POST(request({ 'x-witty-api-key': 'never-log-invalid' }))).status, 401);
  assert.equal(f.lines.at(-1).reason, 'invalid-api-key');
  lookup.mock.mockImplementation(async () => ({ username: 'fixture' }));
  fs.writeFileSync(path.join(f.temp, 'spool'), 'blocks directory creation');
  assert.equal((await POST(request({ 'x-witty-api-key': 'never-log-key' }))).status, 500);
  assert.equal(f.lines.at(-1).stage, 'spool');
  assert.deepEqual(f.lines.at(-1).traceIds, [traceId]);
  assert.equal(f.otherLogs.length, 0);
});

test('OPTIONS no longer dumps request headers', async t => {
  const f = setup(t);
  const response = await OPTIONS(new Request('http://localhost/api/public/otel/v1/traces', {
    method: 'OPTIONS', headers: { authorization: 'Basic never-log-secret' },
  }));
  assert.equal(response.status, 204);
  assert.equal(f.otherLogs.length, 0);
});

test('real protobuf decoding retains the trace id when Basic authentication times out', async t => {
  const f = setup(t);
  t.mock.method(db, 'findUserByUsername', async () => { throw Object.assign(new Error('never-log-query'), { code: 'P1008' }); });
  const type = (otlpRoot as any).opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;
  const wire = structuredClone(body) as any;
  const span = wire.resourceSpans[0].scopeSpans[0].spans[0];
  span.traceId = Buffer.from(traceId, 'hex');
  span.spanId = Buffer.from(span.spanId, 'hex');
  const response = await POST(request({ 'content-type': 'application/x-protobuf',
    authorization: `Basic ${Buffer.from('never-log-user:never-log-secret').toString('base64')}`,
  }, type.encode(type.create(wire)).finish()));
  assert.equal(response.status, 500);
  const failure = f.lines.at(-1);
  assert.equal(failure.stage, 'langfuse-auth');
  assert.equal(failure.errorCode, 'P1008');
  assert.deepEqual(failure.traceIds, [traceId]);
  f.summarize();
  assert.equal(f.lines.at(-1).errorsByCode.P1008, 1);
  assert.doesNotMatch(JSON.stringify([f.lines, f.otherLogs]), /never-log/);
});

test('an ignored CodeAgent request reports its reason and does not claim spooled events', async t => {
  const f = setup(t);
  const response = await POST(request({}, JSON.stringify({ resourceSpans: [{
    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'codeagentoc' } }] },
  }] })));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ignored, true);
  assert.equal(f.lines.at(-1).reason, 'ignored-codeagent');
  f.summarize();
  assert.equal(f.lines.at(-1).spooled, 0);
  assert.equal(f.lines.at(-1).http['200'], 1);
});
