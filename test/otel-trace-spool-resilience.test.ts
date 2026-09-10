import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendOtelTraceEvents,
  listOtelTraceSpoolFiles,
  readOtelTraceEventsForSession,
} from '@/lib/ingest/otel/spool';
import { aggregateOtelTraceEvents, aggregateOtelTraceSession } from '@/lib/ingest/otel/aggregate';
import type { OtelTraceEvent } from '@/lib/ingest/otel/types';
import { POST as postOtelTraces } from '@/app/api/ingest/otel/v1/traces/route';

function piEvent(
  sessionId: string,
  spanId: string,
  overrides: Partial<OtelTraceEvent> = {},
): OtelTraceEvent {
  return {
    receivedAt: '2026-09-10T00:00:00.000Z',
    framework: 'pi-agent',
    sessionId,
    traceId: `trace-${sessionId}`,
    spanId,
    name: 'agent.pi-agent',
    kind: 'agent',
    serviceName: 'pi-agent',
    user: 'alice',
    authenticatedUser: true,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    latencyMs: 0,
    startTimeMs: 1_000,
    attributes: {
      'agent.insight.framework': 'pi-agent',
      'agent.insight.kind': 'agent',
      'agent.insight.event_id': spanId,
      'input.value': 'run task',
      'tool.outcome': 'running',
    },
    ...overrides,
  };
}

function codexEvent(
  sessionId: string,
  output: string,
  endTimeMs: number,
  latencyMs: number,
  receivedAt: string,
): OtelTraceEvent {
  return {
    receivedAt,
    framework: 'codex',
    sessionId,
    traceId: `trace-${sessionId}`,
    spanId: 'root-agent',
    name: 'agent.codex',
    kind: 'agent',
    serviceName: 'codex',
    user: 'alice',
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    latencyMs,
    startTimeMs: 1_000,
    endTimeMs,
    attributes: {
      'agent.insight.framework': 'codex',
      'agent.insight.kind': 'agent',
      'input.value': 'run task',
      'output.value': output,
      'tool.outcome': 'success',
    },
  } as OtelTraceEvent;
}

function lines(file: string): unknown[] {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function safeSessionPathSegment(sessionId: string): string {
  const sanitized = sessionId
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'session';
  const hash = crypto.createHash('sha1').update(sessionId).digest('hex').slice(0, 10);
  return `${sanitized}-${hash}`;
}

function otelStringAttribute(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

test('OTel trace spool persistently skips exact duplicates but retains a same-span update', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-trace-idempotent-'));
  try {
    const sessionId = 'goal-plus:pi-idempotent';
    const running = piEvent(sessionId, 'agent-root');
    const first = appendOtelTraceEvents([running], dir);
    assert.equal(first.events.length, 1);
    assert.equal(first.deduplicatedEvents, 0);
    assert.equal(first.rejectedEvents, 0);
    assert.deepEqual(first.dirtySessionIds, [sessionId]);

    const duplicate = {
      ...running,
      receivedAt: '2026-09-10T00:00:05.000Z',
    };
    const second = appendOtelTraceEvents([duplicate], dir);
    assert.equal(second.events.length, 0);
    assert.equal(second.deduplicatedEvents, 1);
    assert.deepEqual(second.dirtySessionIds, []);

    const completed = piEvent(sessionId, 'agent-root', {
      receivedAt: '2026-09-10T00:00:10.000Z',
      latencyMs: 2_000,
      attributes: {
        ...running.attributes,
        'output.value': 'task complete',
        'tool.outcome': 'success',
      },
    });
    const third = appendOtelTraceEvents([completed], dir);
    assert.equal(third.events.length, 1);
    assert.deepEqual(third.dirtySessionIds, [sessionId]);

    const file = listOtelTraceSpoolFiles(dir)[0];
    assert.equal(lines(file).length, 2);
    const result = aggregateOtelTraceSession(sessionId, dir);
    assert.equal(result.disposition, 'persisted');
    assert.equal(result.record?.final_result, 'task complete');
    assert.ok(result.record?.trace_completed_at);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OTel trace spool retains an authentication provenance upgrade', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-trace-auth-upgrade-'));
  try {
    const sessionId = 'goal-plus:pi-auth-upgrade';
    const unauthenticated = piEvent(sessionId, 'agent-root', { authenticatedUser: false });
    const first = appendOtelTraceEvents([unauthenticated], dir);
    const upgraded = appendOtelTraceEvents([{
      ...unauthenticated,
      receivedAt: '2026-09-10T00:01:00.000Z',
      authenticatedUser: true,
    }], dir);

    assert.equal(first.events.length, 1);
    assert.equal(upgraded.events.length, 1);
    assert.equal(upgraded.deduplicatedEvents, 0);
    const stored = readOtelTraceEventsForSession(sessionId, dir);
    assert.equal(stored.length, 2);
    assert.equal(stored.at(-1)?.authenticatedUser, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OTel trace dedupe index rebuilds after a shard is replaced', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-trace-index-rebuild-'));
  try {
    const sessionId = 'goal-plus:pi-replaced-shard';
    appendOtelTraceEvents([
      piEvent(sessionId, 'old-one'),
      piEvent(sessionId, 'old-two'),
    ], dir);
    const file = listOtelTraceSpoolFiles(dir)[0];
    const replacement = piEvent(sessionId, 'replacement', {
      attributes: {
        ...piEvent(sessionId, 'replacement').attributes,
        'output.value': 'replacement snapshot with a distinct file size',
        'tool.outcome': 'success',
      },
    });
    fs.writeFileSync(file, `${JSON.stringify(replacement)}\n`, 'utf8');

    const duplicate = appendOtelTraceEvents([{
      ...replacement,
      receivedAt: '2026-09-10T00:01:00.000Z',
    }], dir);
    assert.equal(duplicate.events.length, 0);
    assert.equal(lines(file).length, 1);

    const update = appendOtelTraceEvents([{
      ...replacement,
      receivedAt: '2026-09-10T00:02:00.000Z',
      attributes: { ...replacement.attributes, 'output.value': 'new result' },
    }], dir);
    assert.equal(update.events.length, 1);
    assert.equal(lines(file).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OTel trace dedupe index also recognizes events already stored in legacy spool files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-trace-legacy-dedupe-'));
  try {
    const sessionId = 'goal-plus:pi-legacy-dedupe';
    const existing = piEvent(sessionId, 'legacy-root');
    const legacyDir = path.join(dir, '2026-09-09');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'traces.jsonl'), `${JSON.stringify(existing)}\n`, 'utf8');

    const result = appendOtelTraceEvents([{
      ...existing,
      receivedAt: '2026-09-10T00:01:00.000Z',
    }], dir);
    assert.equal(result.events.length, 0);
    assert.deepEqual(result.dirtySessionIds, []);
    assert.equal(listOtelTraceSpoolFiles(dir).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OTel trace aggregation streams 200,000 duplicate Pi rows into one retained snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-trace-large-dedupe-'));
  try {
    const sessionId = 'goal-plus:pi-large-duplicate';
    const event = piEvent(sessionId, 'agent-root', {
      latencyMs: 2_000,
      attributes: {
        ...piEvent(sessionId, 'agent-root').attributes,
        'output.value': 'done',
        'tool.outcome': 'success',
      },
    });
    appendOtelTraceEvents([event], dir);
    const file = listOtelTraceSpoolFiles(dir)[0];
    const fd = fs.openSync(file, 'w');
    try {
      const batch = `${JSON.stringify(event)}\n`.repeat(1_000);
      for (let index = 0; index < 200; index += 1) fs.writeSync(fd, batch);
    } finally {
      fs.closeSync(fd);
    }

    const result = aggregateOtelTraceSession(sessionId, dir);
    assert.equal(result.disposition, 'persisted');
    assert.equal(result.eventCount, 200_000);
    assert.equal(result.record?.llm_call_count, 0);
    assert.equal(result.record?.final_result, 'done');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OTel trace aggregation discards a session that exceeds its unique-event limit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-trace-limit-'));
  const previous = process.env.AGENT_INSIGHT_OTEL_AGG_MAX_UNIQUE_EVENTS;
  try {
    process.env.AGENT_INSIGHT_OTEL_AGG_MAX_UNIQUE_EVENTS = '2';
    appendOtelTraceEvents([
      piEvent('goal-plus:pi-over-limit', 'one'),
      piEvent('goal-plus:pi-over-limit', 'two'),
      piEvent('goal-plus:pi-over-limit', 'three'),
    ], dir);
    const result = aggregateOtelTraceSession('goal-plus:pi-over-limit', dir);
    assert.equal(result.disposition, 'discard');
    assert.equal(result.record, null);
    assert.equal(result.reason, 'aggregation-limit');
  } finally {
    if (previous === undefined) delete process.env.AGENT_INSIGHT_OTEL_AGG_MAX_UNIQUE_EVENTS;
    else process.env.AGENT_INSIGHT_OTEL_AGG_MAX_UNIQUE_EVENTS = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OTel trace writer fails closed when a session exceeds the dedupe identity bound', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-trace-writer-limit-'));
  const previous = process.env.AGENT_INSIGHT_OTEL_DEDUPE_MAX_IDENTITIES;
  try {
    process.env.AGENT_INSIGHT_OTEL_DEDUPE_MAX_IDENTITIES = '1';
    const result = appendOtelTraceEvents([
      piEvent('goal-plus:pi-writer-over-limit', 'one'),
      piEvent('goal-plus:pi-writer-over-limit', 'two'),
    ], dir);
    assert.equal(result.events.length, 1);
    assert.equal(result.rejectedEvents, 1);
    assert.equal(readOtelTraceEventsForSession('goal-plus:pi-writer-over-limit', dir).length, 1);
  } finally {
    if (previous === undefined) delete process.env.AGENT_INSIGHT_OTEL_DEDUPE_MAX_IDENTITIES;
    else process.env.AGENT_INSIGHT_OTEL_DEDUPE_MAX_IDENTITIES = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OTLP route reports a Goal Plus identity-limit rejection as non-2xx', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-trace-route-limit-'));
  const previousDir = process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR;
  const previousLimit = process.env.AGENT_INSIGHT_OTEL_DEDUPE_MAX_IDENTITIES;
  try {
    process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR = dir;
    process.env.AGENT_INSIGHT_OTEL_DEDUPE_MAX_IDENTITIES = '1';
    const sessionId = 'goal-plus:pi-route-limit';
    const span = (id: string) => ({
      traceId: '00112233445566778899aabbccddeeff',
      spanId: id,
      name: 'agent.pi-agent',
      startTimeUnixNano: '1000000000',
      endTimeUnixNano: '2000000000',
      attributes: [
        otelStringAttribute('witty.session.id', sessionId),
        otelStringAttribute('agent.insight.framework', 'pi-agent'),
        otelStringAttribute('agent.insight.event_id', id),
        otelStringAttribute('agent.insight.kind', 'agent'),
      ],
    });
    const response = await postOtelTraces(new Request('http://localhost/api/ingest/otel/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        resourceSpans: [{
          resource: { attributes: [otelStringAttribute('service.name', 'pi-agent')] },
          scopeSpans: [{ spans: [span('one'), span('two')] }],
        }],
      }),
    }));
    const body = await response.json();

    assert.equal(response.status, 413);
    assert.equal(body.status, 'partial');
    assert.equal(body.received, 1);
    assert.equal(body.persisted, 1);
    assert.equal(body.rejected.spool.events, 1);
    assert.equal(body.rejected.spool.reason, 'goal-plus-session-identity-limit');
  } finally {
    if (previousDir === undefined) delete process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR;
    else process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR = previousDir;
    if (previousLimit === undefined) delete process.env.AGENT_INSIGHT_OTEL_DEDUPE_MAX_IDENTITIES;
    else process.env.AGENT_INSIGHT_OTEL_DEDUPE_MAX_IDENTITIES = previousLimit;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('standalone Pi keeps its prior append and aggregation behavior', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-standalone-pi-compat-'));
  const previousDedupe = process.env.AGENT_INSIGHT_OTEL_DEDUPE_MAX_IDENTITIES;
  const previousAggregate = process.env.AGENT_INSIGHT_OTEL_AGG_MAX_UNIQUE_EVENTS;
  try {
    process.env.AGENT_INSIGHT_OTEL_DEDUPE_MAX_IDENTITIES = '1';
    process.env.AGENT_INSIGHT_OTEL_AGG_MAX_UNIQUE_EVENTS = '1';
    const sessionId = 'ordinary-pi-session';
    const one = piEvent(sessionId, 'one');
    const two = piEvent(sessionId, 'two');
    const first = appendOtelTraceEvents([one, two], dir);
    const repeated = appendOtelTraceEvents([{ ...one, receivedAt: '2026-09-10T00:01:00.000Z' }], dir);

    assert.equal(first.events.length, 2);
    assert.equal(first.rejectedEvents, 0);
    assert.equal(first.deduplicatedEvents, 0);
    assert.equal(repeated.events.length, 1);
    assert.equal(repeated.deduplicatedEvents, 0);
    assert.equal(readOtelTraceEventsForSession(sessionId, dir).length, 3);
    assert.equal(fs.existsSync(path.join(dir, '.trace-event-index-v1')), false);
    assert.equal(aggregateOtelTraceSession(sessionId, dir).disposition, 'persisted');
  } finally {
    if (previousDedupe === undefined) delete process.env.AGENT_INSIGHT_OTEL_DEDUPE_MAX_IDENTITIES;
    else process.env.AGENT_INSIGHT_OTEL_DEDUPE_MAX_IDENTITIES = previousDedupe;
    if (previousAggregate === undefined) delete process.env.AGENT_INSIGHT_OTEL_AGG_MAX_UNIQUE_EVENTS;
    else process.env.AGENT_INSIGHT_OTEL_AGG_MAX_UNIQUE_EVENTS = previousAggregate;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('streaming aggregation preserves Codex latest-snapshot preprocessing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-codex-streaming-compat-'));
  try {
    const sessionId = 'ordinary-codex-session';
    const events = [
      codexEvent(sessionId, 'old result', 2_000, 9_000, '2026-09-10T00:00:00.000Z'),
      codexEvent(sessionId, 'latest result', 3_000, 100, '2026-09-10T00:01:00.000Z'),
    ];
    const direct = aggregateOtelTraceEvents(sessionId, events);
    appendOtelTraceEvents(events, dir);
    const streamed = aggregateOtelTraceSession(sessionId, dir);

    assert.ok(direct);
    assert.equal(streamed.disposition, 'persisted');
    assert.equal(direct.final_result, 'latest result');
    assert.equal(streamed.record?.final_result, direct.final_result);
    assert.equal(streamed.record?.latency, direct.latency);
    assert.equal(streamed.record?.tool_call_count, direct.tool_call_count);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OTel trace writer never steals an old lock owned by a live local process', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-trace-live-lock-'));
  const previousWait = process.env.AGENT_INSIGHT_OTEL_DEDUPE_LOCK_WAIT_MS;
  const previousStale = process.env.AGENT_INSIGHT_OTEL_DEDUPE_LOCK_STALE_MS;
  try {
    process.env.AGENT_INSIGHT_OTEL_DEDUPE_LOCK_WAIT_MS = '25';
    process.env.AGENT_INSIGHT_OTEL_DEDUPE_LOCK_STALE_MS = '1';
    const sessionId = 'goal-plus:pi-live-lock';
    const lockDir = path.join(dir, '.trace-event-index-v1', 'locks', `${safeSessionPathSegment(sessionId)}.lock`);
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
      pid: process.pid,
      hostname: os.hostname(),
      token: 'active-owner',
      createdAt: '2020-01-01T00:00:00.000Z',
    }), 'utf8');
    fs.utimesSync(lockDir, new Date(0), new Date(0));

    assert.throws(
      () => appendOtelTraceEvents([piEvent(sessionId, 'one')], dir),
      /Timed out waiting for OTel trace spool lock/,
    );
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8')).token, 'active-owner');
  } finally {
    if (previousWait === undefined) delete process.env.AGENT_INSIGHT_OTEL_DEDUPE_LOCK_WAIT_MS;
    else process.env.AGENT_INSIGHT_OTEL_DEDUPE_LOCK_WAIT_MS = previousWait;
    if (previousStale === undefined) delete process.env.AGENT_INSIGHT_OTEL_DEDUPE_LOCK_STALE_MS;
    else process.env.AGENT_INSIGHT_OTEL_DEDUPE_LOCK_STALE_MS = previousStale;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OTel trace writer does not steal a foreign-host lock based on age', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-trace-foreign-lock-'));
  const previousWait = process.env.AGENT_INSIGHT_OTEL_DEDUPE_LOCK_WAIT_MS;
  try {
    process.env.AGENT_INSIGHT_OTEL_DEDUPE_LOCK_WAIT_MS = '25';
    const sessionId = 'goal-plus:pi-foreign-lock';
    const lockDir = path.join(dir, '.trace-event-index-v1', 'locks', `${safeSessionPathSegment(sessionId)}.lock`);
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
      pid: 2_147_483_647,
      hostname: 'another-host',
      token: 'foreign-owner',
      createdAt: '2020-01-01T00:00:00.000Z',
    }), 'utf8');
    fs.utimesSync(lockDir, new Date(0), new Date(0));

    assert.throws(
      () => appendOtelTraceEvents([piEvent(sessionId, 'one')], dir),
      /Timed out waiting for OTel trace spool lock/,
    );
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8')).token, 'foreign-owner');
  } finally {
    if (previousWait === undefined) delete process.env.AGENT_INSIGHT_OTEL_DEDUPE_LOCK_WAIT_MS;
    else process.env.AGENT_INSIGHT_OTEL_DEDUPE_LOCK_WAIT_MS = previousWait;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OTel trace writer recovers a lock whose local owner process is gone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-trace-dead-lock-'));
  try {
    const sessionId = 'goal-plus:pi-dead-lock';
    const lockDir = path.join(dir, '.trace-event-index-v1', 'locks', `${safeSessionPathSegment(sessionId)}.lock`);
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
      pid: 2_147_483_647,
      hostname: os.hostname(),
      token: 'dead-owner',
      createdAt: new Date().toISOString(),
    }), 'utf8');

    const result = appendOtelTraceEvents([piEvent(sessionId, 'one')], dir);
    assert.equal(result.events.length, 1);
    assert.equal(fs.existsSync(lockDir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OTel trace writer recovers an abandoned dead-owner recovery claim', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-trace-dead-recovery-claim-'));
  try {
    const sessionId = 'goal-plus:pi-dead-recovery-claim';
    const lockDir = path.join(dir, '.trace-event-index-v1', 'locks', `${safeSessionPathSegment(sessionId)}.lock`);
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
      pid: 2_147_483_647,
      hostname: os.hostname(),
      token: 'dead-owner',
      createdAt: new Date().toISOString(),
    }), 'utf8');
    fs.writeFileSync(path.join(lockDir, 'recovery-claim.json'), JSON.stringify({
      pid: 2_147_483_647,
      hostname: os.hostname(),
      token: 'dead-claimant',
      expectedOwnerToken: 'dead-owner',
      createdAt: new Date().toISOString(),
    }), 'utf8');

    const result = appendOtelTraceEvents([piEvent(sessionId, 'one')], dir);
    assert.equal(result.events.length, 1);
    assert.equal(fs.existsSync(lockDir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
