import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { appendCodeAgentOtelEvents } from '@/lib/ingest/codeagent-otel/spool';
import { appendClaudeOtelEvents, appendOtelTraceEvents } from '@/lib/ingest/claude-otel/spool';
import { getFileCursor, toCheckpointRelPath } from '@/lib/ingest/otel-consumer/checkpoint';
import {
  getOtelSpoolConsumerForTest,
  startOtelSpoolConsumer,
  stopOtelSpoolConsumer,
} from '@/lib/ingest/otel-consumer/consumer';
import { listSources } from '@/lib/ingest/otel-consumer/sources';
import type { ClaudeOtelEvent } from '@/lib/ingest/claude-otel/types';
import type { OtelTraceEvent } from '@/lib/ingest/otel/types';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(5);
  }
}

function source(id: string) {
  const result = listSources().find((candidate) => candidate.id === id);
  assert.ok(result, `missing source ${id}`);
  return result;
}

function traceEvent(sessionId: string, framework: string, attributes: Record<string, unknown>): OtelTraceEvent {
  return {
    receivedAt: '2026-08-16T00:00:00.000Z',
    framework,
    sessionId,
    traceId: `trace-${sessionId}`,
    spanId: `span-${sessionId}`,
    name: 'pending',
    kind: 'agent',
    // Pi's canonical spool can arrive before the dedicated adapter identifies
    // it. Keep this fixture on that replayable path rather than a full Pi OTLP span.
    serviceName: framework === 'pi-agent' ? 'opencode' : framework,
    user: 'test-user',
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    latencyMs: 0,
    startTimeMs: 1,
    attributes,
  };
}

function logEvent(sessionId: string, eventName: string, attributes: Record<string, unknown>): ClaudeOtelEvent {
  return {
    receivedAt: '2026-08-16T00:00:00.000Z',
    eventTimestamp: '2026-08-16T00:00:00.000Z',
    eventName,
    sessionId,
    resource: {},
    attributes,
  };
}

test('OTel spool sources classify persistability instead of overloading record=null', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-spool-disposition-'));
  const previous = {
    claude: process.env.AGENT_INSIGHT_CLAUDE_OTEL_SPOOL_DIR,
    codeAgent: process.env.AGENT_INSIGHT_CODEAGENT_OTEL_SPOOL_DIR,
    traces: process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR,
  };
  const claudeDir = path.join(root, 'claude');
  const codeAgentDir = path.join(root, 'codeagent');
  const traceDir = path.join(root, 'traces');
  process.env.AGENT_INSIGHT_CLAUDE_OTEL_SPOOL_DIR = claudeDir;
  process.env.AGENT_INSIGHT_CODEAGENT_OTEL_SPOOL_DIR = codeAgentDir;
  process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR = traceDir;

  try {
    appendClaudeOtelEvents([
      logEvent('claude-supplement', 'context_supplement', { kind: 'system_prompt', text: 'orphan context' }),
    ], claudeDir);
    appendCodeAgentOtelEvents([
      logEvent('codeagent-background', 'api_request', {
        query_source: 'auto_dream',
        'execution.agent_run_id': 'background-run',
        'execution.parent_agent_run_id': 'codeagent-background',
      }),
    ], codeAgentDir);
    appendOtelTraceEvents([
      traceEvent('pi-pending', 'pi-agent', {}),
      traceEvent('codex-pending', 'codex', { 'codex.association.pending': 'true' }),
    ], traceDir);

    assert.equal(source('claude-otel-logs').aggregate('claude-supplement').disposition, 'discard');
    assert.equal(source('codeagent-otel-logs').aggregate('codeagent-background').disposition, 'discard');
    assert.equal(source('otel-traces').aggregate('pi-pending').disposition, 'retry-later');
    assert.equal(source('otel-traces').aggregate('codex-pending').disposition, 'retry-later');
  } finally {
    if (previous.claude === undefined) delete process.env.AGENT_INSIGHT_CLAUDE_OTEL_SPOOL_DIR;
    else process.env.AGENT_INSIGHT_CLAUDE_OTEL_SPOOL_DIR = previous.claude;
    if (previous.codeAgent === undefined) delete process.env.AGENT_INSIGHT_CODEAGENT_OTEL_SPOOL_DIR;
    else process.env.AGENT_INSIGHT_CODEAGENT_OTEL_SPOOL_DIR = previous.codeAgent;
    if (previous.traces === undefined) delete process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR;
    else process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR = previous.traces;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('OTel spool consumer advances only sources whose disposition is acknowledged', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-spool-consumer-e2e-'));
  const previous = {
    claude: process.env.AGENT_INSIGHT_CLAUDE_OTEL_SPOOL_DIR,
    codeAgent: process.env.AGENT_INSIGHT_CODEAGENT_OTEL_SPOOL_DIR,
    traces: process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR,
  };
  const claudeDir = path.join(root, 'claude');
  const codeAgentDir = path.join(root, 'codeagent');
  const traceDir = path.join(root, 'traces');
  process.env.AGENT_INSIGHT_CLAUDE_OTEL_SPOOL_DIR = claudeDir;
  process.env.AGENT_INSIGHT_CODEAGENT_OTEL_SPOOL_DIR = codeAgentDir;
  process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR = traceDir;
  stopOtelSpoolConsumer();

  try {
    appendClaudeOtelEvents([
      logEvent('claude-supplement', 'context_supplement', { kind: 'hook_context', text: 'orphan context' }),
    ], claudeDir);
    appendCodeAgentOtelEvents([
      logEvent('codeagent-background', 'api_request', {
        query_source: 'extract_memories',
        'execution.agent_run_id': 'background-run',
        'execution.parent_agent_run_id': 'codeagent-background',
      }),
    ], codeAgentDir);
    appendOtelTraceEvents([
      traceEvent('pi-pending', 'pi-agent', {}),
      traceEvent('codex-pending', 'codex', { 'codex.association.pending': 'true' }),
      {
        ...traceEvent('persisted-trace', 'opencode', {
          'gen_ai.prompt': 'persist this trace',
          'gen_ai.completion': 'persisted',
        }),
        framework: undefined,
      },
    ], traceDir);

    const saved: string[] = [];
    startOtelSpoolConsumer({
      sources: listSources(),
      saveExecution: async (record) => {
        saved.push(String(record.task_id));
        return { success: true, record };
      },
      shortMs: 5,
      longMs: 10_000,
      maxWaitMs: 10_000,
      tickMs: 5,
      seedOnStart: false,
      log: () => {},
      warn: () => {},
    });

    await waitFor(() => saved.includes('persisted-trace') && getOtelSpoolConsumerForTest()?.pendingFiles.size === 2);
    const claudeFile = source('claude-otel-logs').listFiles()[0];
    const codeAgentFile = source('codeagent-otel-logs').listFiles()[0];
    const traceFiles = source('otel-traces').listFiles();
    const piFile = traceFiles.find((file) => file.includes('pi-pending'))!;
    const codexFile = traceFiles.find((file) => file.includes('codex-pending'))!;
    const persistedFile = traceFiles.find((file) => file.includes('persisted-trace'))!;

    assert.deepEqual(saved, ['persisted-trace']);
    assert.equal(getFileCursor(claudeDir, toCheckpointRelPath(claudeDir, claudeFile)).bytes, fs.statSync(claudeFile).size);
    assert.equal(getFileCursor(codeAgentDir, toCheckpointRelPath(codeAgentDir, codeAgentFile)).bytes, fs.statSync(codeAgentFile).size);
    assert.equal(getFileCursor(traceDir, toCheckpointRelPath(traceDir, persistedFile)).bytes, fs.statSync(persistedFile).size);
    assert.equal(getFileCursor(traceDir, toCheckpointRelPath(traceDir, piFile)).bytes, 0);
    assert.equal(getFileCursor(traceDir, toCheckpointRelPath(traceDir, codexFile)).bytes, 0);
  } finally {
    stopOtelSpoolConsumer();
    if (previous.claude === undefined) delete process.env.AGENT_INSIGHT_CLAUDE_OTEL_SPOOL_DIR;
    else process.env.AGENT_INSIGHT_CLAUDE_OTEL_SPOOL_DIR = previous.claude;
    if (previous.codeAgent === undefined) delete process.env.AGENT_INSIGHT_CODEAGENT_OTEL_SPOOL_DIR;
    else process.env.AGENT_INSIGHT_CODEAGENT_OTEL_SPOOL_DIR = previous.codeAgent;
    if (previous.traces === undefined) delete process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR;
    else process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR = previous.traces;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
