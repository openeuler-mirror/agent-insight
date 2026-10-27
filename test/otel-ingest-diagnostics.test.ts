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
import { OtelIngestDiagnostics } from '@/lib/ingest/otel/diagnostics';

function fixture(debug = false) {
  let now = 1_000;
  const lines: Array<{ level: string; data: any; text: string }> = [];
  const timers: Array<() => void> = [];
  const logger = new OtelIngestDiagnostics({
    debug: () => debug,
    now: () => now,
    emit: (level, text) => lines.push({ level, text, data: JSON.parse(text.slice('[OTelIngest] '.length)) }),
    schedule: callback => { timers.push(callback); },
  });
  return { logger, lines, timers, elapse(ms: number) { now += ms; }, advance(ms = 60_000) { now += ms; timers.shift()?.(); } };
}

function request(headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/public/otel/v1/traces?token=never-log-query', {
    method: 'POST', headers: { 'content-type': 'application/x-protobuf', ...headers },
  });
}

test('arrival is recorded before authentication finishes, including stalled requests', () => {
  const f = fixture();
  f.logger.begin(request({ 'x-witty-api-key': 'secret' })).stage('api-key-auth');
  assert.equal(f.lines[0].data.event, 'received');
  assert.equal(f.lines[0].data.authMode, 'api-key');
  f.advance();
  const summary = f.lines.at(-1)!.data;
  assert.equal(summary.event, 'summary');
  assert.equal(summary.received, 1);
  assert.equal(summary.completed, 0);
  assert.equal(summary.inFlight, 1);
  assert.equal(summary.receivedByAuth['api-key'], 1);
  assert.equal(f.timers.length, 1);
});

test('a flood shares a global budget across sources, credentials, and error identities', () => {
  const f = fixture();
  const channels: Array<Record<string, string>> = [{ 'x-witty-api-key': 'secret' }, { authorization: 'Basic secret' }, { 'x-langfuse-public-key': 'user' }, {}];
  for (let i = 0; i < 10_000; i++) {
    const span = f.logger.begin(request({ ...channels[i % 4], 'x-forwarded-for': `192.0.2.${i % 250 + 1}` }));
    span.stage('decode');
    if (i < 4 || i % 2 === 0) span.finish(200, { reason: 'accepted', spooled: 3 });
    else span.finish(400, { reason: 'decode-failed', error: new Error(`variable-secret-${i}`) });
  }
  f.advance();
  assert.ok(f.lines.length <= 13, `unbounded logs: ${f.lines.length}`);
  const summary = f.lines.at(-1)!.data;
  assert.equal(summary.received, 10_000);
  assert.equal(summary.completed, 10_000);
  assert.equal(summary.inFlight, 0);
  assert.equal(summary.http['200'], 5002);
  assert.equal(summary.http['400'], 4998);
  assert.equal(summary.suppressedErrors, 4997);
  assert.equal(summary.errorsByStage.decode, 4998);
  assert.equal(f.timers.length, 0);
});

test('error changes and late completions cannot bypass the per-window budgets', () => {
  const f = fixture();
  const pending = [];
  for (let i = 0; i < 5; i++) {
    pending.push(f.logger.begin(request()));
    f.advance();
  }
  const before = f.lines.length;
  for (const item of pending) item.finish(200, { reason: 'accepted' });
  for (let i = 0; i < 100; i++) {
    const item = f.logger.begin(request());
    item.stage(i % 2 ? 'decode' : 'spool');
    item.finish(400 + i, { reason: 'handler-error', error: { code: `P${1000 + i}` } });
  }
  f.advance();
  assert.ok(f.lines.length - before <= 13);
  const summary = f.lines.at(-1)!.data;
  assert.equal(summary.completed, 105);
  assert.equal(summary.suppressedErrors, 96);
  assert.equal(summary.inFlight, 0);
});

test('summary runs without a following request and resets suppression for a new window', () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) f.logger.begin(request()).finish(415, { reason: 'decode-failed' });
  assert.equal(f.lines.filter(x => x.data.event === 'failed').length, 1);
  f.advance();
  assert.equal(f.lines.at(-1)!.data.suppressedErrors, 2);
  f.logger.begin(request()).finish(415, { reason: 'decode-failed' });
  assert.equal(f.lines.filter(x => x.data.event === 'failed').length, 2);
  f.advance();
  assert.equal(f.lines.at(-1)!.data.received, 1);
  assert.equal(f.lines.at(-1)!.data.suppressedErrors, 0);
});

test('errors omitted by the sample budget retain bounded reason and error-code totals', () => {
  const f = fixture();
  for (let i = 0; i < 10_000; i++) {
    const item = f.logger.begin(request());
    item.stage('api-key-auth');
    item.finish(500, { reason: 'handler-error', error: { code: `P${String(i).padStart(4, '0')}` } });
  }
  f.advance();
  const summary = f.lines.at(-1)!.data;
  assert.equal(summary.errorsByCode.P1008, 1);
  assert.equal(summary.errorsByReason['handler-error'], 10_000);
  assert.equal(Object.values(summary.errorsByCode).reduce((a: number, b: any) => a + b, 0), 10_000);
  assert.ok(Object.keys(summary.errorsByCode).length < 20);
  assert.ok(f.lines.length <= 13);
  assert.ok(f.lines.every(line => line.text.length < 4096));
  assert.ok(!f.lines.some(line => line.data.event === 'failed' && line.data.errorCode === 'P1008'));
  f.logger.begin(request()).finish(400, { reason: 'decode-failed' });
  f.advance();
  assert.deepEqual(f.lines.at(-1)!.data.errorsByCode, { NO_CODE: 1 });
  assert.deepEqual(f.lines.at(-1)!.data.errorsByReason, { 'decode-failed': 1 });
});

test('samples preserve request correlation and expose only bounded allowlisted metadata', () => {
  const f = fixture();
  const item = f.logger.begin(request({
    'x-witty-api-key': 'never-log-api-key', authorization: 'Basic never-log-basic',
    cookie: 'never-log-cookie', 'user-agent': 'never-log-agent',
    'x-forwarded-for': '192.0.2.8, never-log-forwarded-tail',
    'content-encoding': 'gzip', 'content-length': '120', 'x-request-id': 'never-log-request-id',
  }));
  item.stage('spool');
  item.authenticated();
  item.decoded({ resourceSpans: [{ scopeSpans: [{ spans: Array.from({ length: 100 }, (_, i) => ({
    traceId: i.toString(16).padStart(32, '0'), attributes: [{ key: 'input', value: 'never-log-input' }],
  })) }] }] });
  item.finish(500, { reason: 'handler-error', error: Object.assign(new Error('never-log-error'), { code: 'P1008' }) });
  const arrival = f.lines[0].data, result = f.lines[1].data;
  assert.equal(result.requestId, arrival.requestId);
  assert.equal(result.stage, 'spool');
  assert.equal(result.errorCode, 'P1008');
  assert.equal(result.forwardedFor, '192.0.2.8');
  assert.equal(result.contentEncoding, 'gzip');
  assert.equal(result.contentLength, 120);
  assert.ok(result.traceIds.length <= 3);
  assert.equal(result.traceIdsTruncated, true);
  assert.doesNotMatch(f.lines.map(x => x.text).join('\n'), /never-log/);
  assert.ok(f.lines.every(x => !x.text.includes('\n') && x.text.length < 4096));
});

test('diagnostics bound trace inspection even when a payload contains huge empty resource lists', () => {
  const f = fixture();
  const resources = Array.from({ length: 1024 }, () => ({}));
  Object.defineProperty(resources, 300, { get() { throw new Error('unbounded scan'); } });
  const item = f.logger.begin(request());
  item.decoded({ resourceSpans: resources });
  item.finish(200, { reason: 'accepted', spooled: 0 });
  assert.equal(f.lines.at(-1)!.data.traceIdsTruncated, true);
});

test('finishing is idempotent and logging failures never fail the request', () => {
  const f = fixture();
  const item = f.logger.begin(request());
  item.finish(200, { reason: 'accepted' });
  item.finish(500, { reason: 'handler-error' });
  f.advance();
  assert.equal(f.lines.at(-1)!.data.completed, 1);
  const broken = new OtelIngestDiagnostics({ emit: () => { throw new Error('logger failed'); }, schedule: () => {} });
  assert.doesNotThrow(() => broken.begin(request()).finish(500, { reason: 'handler-error' }));
});

test('debug records every request, stage and trace identity beyond the normal sample budget', () => {
  const f = fixture(true);
  const ids = Array.from({ length: 150 }, (_, i) => i.toString(16).padStart(32, '0'));
  for (let i = 0; i < 20; i++) {
    const item = f.logger.begin(request());
    item.stage('decode');
    f.elapse(7);
    item.decoded({ resourceSpans: [{ scopeSpans: [{ spans: ids.map(traceId => ({ traceId, attributes: 'SECRET_BODY' })) }] }] });
    item.stage('spool');
    f.elapse(11);
    item.finish(i % 2 ? 500 : 200, { reason: i % 2 ? 'handler-error' : 'accepted', error: { code: 'P1008' } });
  }
  assert.equal(f.lines.filter(x => x.data.event === 'received').length, 20);
  assert.equal(f.lines.filter(x => x.data.event === 'completed').length, 10);
  assert.equal(f.lines.filter(x => x.data.event === 'failed').length, 10);
  const completed = f.lines.find(x => x.data.event === 'completed')!.data;
  assert.equal(completed.stageDurationsMs.decode, 7);
  assert.equal(completed.stageDurationsMs.spool, 11);
  for (const id of ids) assert.ok(f.lines.some(x => x.data.event === 'trace-ids' && x.data.traceIds.includes(id)), id);
  assert.ok(f.lines.some(x => x.data.event === 'stage-start' && x.data.stage === 'spool'));
  assert.ok(f.lines.every(x => x.text.length < 4096));
  assert.doesNotMatch(f.lines.map(x => x.text).join('\n'), /SECRET_BODY/);
});

test('production failures and their summary use error severity', () => {
  const f = fixture();
  f.logger.begin(request()).finish(500, { reason: 'handler-error' });
  f.advance();
  assert.equal(f.lines.find(x => x.data.event === 'failed')?.level, 'error');
  assert.equal(f.lines.find(x => x.data.event === 'summary')?.level, 'error');
});

test('debug inspection tolerates malformed OTLP collections without changing request handling', () => {
  const f = fixture(true);
  for (const body of [{ resourceSpans: {} }, { resourceSpans: [null, { scopeSpans: {} }] },
    { resourceSpans: [{ scopeSpans: [null, { spans: {} }] }] }]) {
    assert.doesNotThrow(() => f.logger.begin(request()).decoded(body));
  }
});


test('debug preserves failure details and stack but excludes decoder payload excerpts', () => {
  const f = fixture(true);
  const failed = f.logger.begin(request());
  failed.stage('spool');
  failed.finish(500, { reason: 'handler-error', error: new Error('write failed apiKey=SECRET_CREDENTIAL') });
  const detail = f.lines.at(-1)!.data.errorDetails;
  assert.match(detail.message, /write failed/);
  assert.ok(detail.stack.length > 0);
  const invalid = f.logger.begin(request());
  invalid.stage('decode');
  invalid.finish(400, { reason: 'decode-failed', error: new Error('invalid JSON SECRET_BODY') });
  assert.equal(f.lines.at(-1)!.data.errorDetails.name, 'Error');
  assert.doesNotMatch(f.lines.map(x => x.text).join('\n'), /SECRET_/);
});
