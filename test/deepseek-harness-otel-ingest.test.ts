import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { POST as postLogs } from '@/app/api/ingest/otel/v1/logs/route';
import { getAdapter } from '@/lib/ingest/adapters/registry';
import {
  aggregateDeepSeekHarnessOtelEvents,
} from '@/lib/ingest/deepseek-harness-otel/aggregator';
import {
  isDeepSeekHarnessResource,
  partitionDeepSeekHarnessOtlpLogs,
} from '@/lib/ingest/deepseek-harness-otel/detect';
import {
  normalizeDeepSeekHarnessOtlpLogs,
} from '@/lib/ingest/deepseek-harness-otel/otlp-json';
import {
  listDeepSeekHarnessOtelSpoolFiles,
  readDeepSeekHarnessOtelEventsForSession,
} from '@/lib/ingest/deepseek-harness-otel/spool';
import type { DeepSeekHarnessOtelEvent } from '@/lib/ingest/deepseek-harness-otel/types';
import { listClaudeOtelSpoolFiles } from '@/lib/ingest/claude-otel/spool';
import { listSources } from '@/lib/ingest/otel-consumer/sources';
import { computeOwnSkills } from '@/lib/storage/data-service';
import { db } from '@/lib/storage/prisma';

function anyValue(value: any): any {
  if (value === null || value === undefined) return { stringValue: '' };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(anyValue) } };
  }
  return {
    kvlistValue: {
      values: Object.entries(value).map(([key, item]) => ({ key, value: anyValue(item) })),
    },
  };
}

const attr = (key: string, value: any) => ({ key, value: anyValue(value) });

function harnessRecord(
  sessionId: string,
  eventType: string,
  sequence: number,
  body: any,
  extraAttributes: Record<string, any> = {},
) {
  return {
    timeUnixNano: String(BigInt(Date.UTC(2026, 7, 21, 5, 0, sequence)) * BigInt(1_000_000)),
    attributes: [
      attr('session.id', sessionId),
      attr('event.type', eventType),
      attr('event.seq', sequence),
      ...Object.entries(extraAttributes).map(([key, value]) => attr(key, value)),
    ],
    body: anyValue(body),
  };
}

function harnessPayload(sessionId: string, records: any[], resource: Record<string, any> = {}) {
  return {
    resourceLogs: [{
      resource: {
        attributes: [
          attr('service.name', 'deepseek-harness'),
          attr('service.version', '0.1.0-rc.8'),
          attr('user.id', 'anonymous-harness-user'),
          ...Object.entries(resource).map(([key, value]) => attr(key, value)),
        ],
      },
      scopeLogs: [{
        scope: {
          name: '@deepseek-ai/dsh-session-telemetry-otel',
          version: '0.1.0-rc.8',
        },
        logRecords: records,
      }],
    }],
  };
}

function baseEvents(sessionId = 'dsh-session-1'): DeepSeekHarnessOtelEvent[] {
  const payload = harnessPayload(sessionId, [
    harnessRecord(sessionId, 'request/header', 0, {
      header: { config: { provider: 'deepseek', model: 'deepseek-chat' } },
      reason: 'initial',
    }),
    harnessRecord(sessionId, 'turn/start', 1, { turn: 1 }),
    harnessRecord(sessionId, 'user/message', 2, {
      id: 'user-1',
      role: 'user',
      content: [{ type: 'text', text: '检查 Harness Skill 调用' }],
      source: { kind: 'user' },
    }),
    harnessRecord(sessionId, 'step/start', 3, { turn: 1, step: 1 }),
    harnessRecord(sessionId, 'assistant/message', 4, {
      turn: 1,
      step: 1,
      message: {
        id: 'assistant-1',
        role: 'assistant',
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
        content: [
          { type: 'reasoning', text: '先加载检查 Skill。' },
          { type: 'text', text: '我先加载 Skill。' },
        ],
      },
      usage: { inputTokens: 12, outputTokens: 4, reasoningTokens: 2, cacheReadTokens: 5 },
    }),
    harnessRecord(sessionId, 'tool/call', 5, {
      turn: 1,
      step: 1,
      callId: 'call-skill-1',
      name: 'skill',
      arguments: JSON.stringify({ name: 'harness-observer' }),
    }),
    harnessRecord(sessionId, 'tool/result', 6, {
      turn: 1,
      step: 1,
      message: {
        id: 'tool-1',
        role: 'user',
        source: { kind: 'tool', callId: 'call-skill-1' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call-skill-1',
          content: [{ type: 'text', text: 'Skill 已加载' }],
          isError: false,
        }],
      },
    }),
    harnessRecord(sessionId, 'step/end', 7, { turn: 1, step: 1 }),
    harnessRecord(sessionId, 'step/start', 8, { turn: 1, step: 2 }),
    harnessRecord(sessionId, 'assistant/message', 9, {
      turn: 1,
      step: 2,
      message: {
        id: 'assistant-2',
        role: 'assistant',
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
        content: [{ type: 'text', text: '验证完成。' }],
      },
      usage: { inputTokens: 20, outputTokens: 3 },
    }),
    harnessRecord(sessionId, 'step/end', 10, { turn: 1, step: 2 }),
    harnessRecord(sessionId, 'turn/end', 11, { turn: 1, reason: { kind: 'completed' } }),
  ]);
  return normalizeDeepSeekHarnessOtlpLogs(payload, {
    receivedAt: '2026-08-21T05:01:00.000Z',
    authenticatedUser: 'alice',
  });
}

test('Harness detector partitions official resources before Claude normalization', () => {
  const harness = harnessPayload('dsh-partition', []);
  const body = {
    resourceLogs: [
      ...harness.resourceLogs,
      {
        resource: { attributes: [attr('service.name', 'claude-code')] },
        scopeLogs: [],
      },
    ],
  };

  assert.equal(isDeepSeekHarnessResource(harness.resourceLogs[0].resource), true);
  const partition = partitionDeepSeekHarnessOtlpLogs(body);
  assert.equal(partition.harnessResourceCount, 1);
  assert.equal(partition.harnessBody.resourceLogs.length, 1);
  assert.equal(partition.remainingBody.resourceLogs.length, 1);
});

test('Harness normalizer preserves structured body, event identity, time, scope, and authenticated owner', () => {
  const events = baseEvents('dsh-normalize');
  assert.equal(events.length, 12);
  assert.deepEqual(events[0].body, {
    header: { config: { provider: 'deepseek', model: 'deepseek-chat' } },
    reason: 'initial',
  });
  assert.equal(events[0].eventType, 'request/header');
  assert.equal(events[0].sequence, 0);
  assert.equal(events[0].sessionId, 'dsh-normalize');
  assert.equal(events[0].eventTimestamp, '2026-08-21T05:00:00.000Z');
  assert.equal(events[0].scope.name, '@deepseek-ai/dsh-session-telemetry-otel');
  assert.equal(events[0].user, 'alice');
  assert.notEqual(events[0].user, 'anonymous-harness-user');
});

test('Harness route requires a valid API key, accepts gzip, and writes only the Harness spool', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-otel-route-'));
  const harnessDir = path.join(root, 'harness');
  const claudeDir = path.join(root, 'claude');
  const previousHarnessDir = process.env.AGENT_INSIGHT_DEEPSEEK_HARNESS_OTEL_SPOOL_DIR;
  const previousClaudeDir = process.env.AGENT_INSIGHT_CLAUDE_OTEL_SPOOL_DIR;
  const originalFindUserByApiKey = db.findUserByApiKey.bind(db);
  process.env.AGENT_INSIGHT_DEEPSEEK_HARNESS_OTEL_SPOOL_DIR = harnessDir;
  process.env.AGENT_INSIGHT_CLAUDE_OTEL_SPOOL_DIR = claudeDir;
  (db as any).findUserByApiKey = async (key: string) => key === 'valid-dsh-key' ? { username: 'alice' } : null;

  try {
    const payload = harnessPayload('dsh-route', [
      harnessRecord('dsh-route', 'turn/start', 1, { turn: 1 }),
    ]);

    for (const key of [undefined, 'invalid-dsh-key']) {
      const response = await postLogs(new Request('http://localhost/api/ingest/otel/v1/logs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key ? { 'x-witty-api-key': key } : {}),
        },
        body: JSON.stringify(payload),
      }));
      assert.equal(response.status, 401);
    }
    assert.equal(listDeepSeekHarnessOtelSpoolFiles(harnessDir).length, 0);

    const compressed = gzipSync(JSON.stringify(payload));
    const accepted = await postLogs(new Request('http://localhost/api/ingest/otel/v1/logs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'x-witty-api-key': 'valid-dsh-key',
      },
      body: compressed,
    }));
    const result = await accepted.json();
    assert.equal(accepted.status, 200);
    assert.equal(result.frameworks['deepseek-harness'].received, 1);
    assert.deepEqual(result.sessions, ['dsh-route']);
    assert.equal(listDeepSeekHarnessOtelSpoolFiles(harnessDir).length, 1);
    assert.equal(listClaudeOtelSpoolFiles(claudeDir).length, 0);
    assert.equal(readDeepSeekHarnessOtelEventsForSession('dsh-route', harnessDir)[0].user, 'alice');
  } finally {
    (db as any).findUserByApiKey = originalFindUserByApiKey;
    if (previousHarnessDir === undefined) delete process.env.AGENT_INSIGHT_DEEPSEEK_HARNESS_OTEL_SPOOL_DIR;
    else process.env.AGENT_INSIGHT_DEEPSEEK_HARNESS_OTEL_SPOOL_DIR = previousHarnessDir;
    if (previousClaudeDir === undefined) delete process.env.AGENT_INSIGHT_CLAUDE_OTEL_SPOOL_DIR;
    else process.env.AGENT_INSIGHT_CLAUDE_OTEL_SPOOL_DIR = previousClaudeDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Harness aggregation rebuilds messages, usage, Tool result, and Skill invocation without duplicate seq', () => {
  const events = baseEvents('dsh-aggregate');
  const duplicate = {
    ...events[9],
    receivedAt: '2026-08-21T05:02:00.000Z',
    body: {
      ...events[9].body,
      message: {
        ...events[9].body.message,
        content: [{ type: 'text', text: '验证完成（最终副本）。' }],
      },
    },
  };
  const record = aggregateDeepSeekHarnessOtelEvents('dsh-aggregate', [...events, duplicate]);

  assert.ok(record);
  assert.equal(record.framework, 'deepseek-harness');
  assert.equal(record.task_id, 'dsh-aggregate');
  assert.equal(record.query, '检查 Harness Skill 调用');
  assert.equal(record.final_result, '验证完成（最终副本）。');
  assert.equal(record.model, 'deepseek-chat');
  assert.equal(record.user, 'alice');
  assert.equal(record.input_tokens, 32);
  assert.equal(record.output_tokens, 7);
  assert.equal(record.reasoning_tokens, 2);
  assert.equal(record.cache_read_input_tokens, 5);
  assert.equal(record.tokens, 44);
  assert.equal(record.llm_call_count, 2);
  assert.equal(record.tool_call_count, 1);
  assert.deepEqual(record.invokedSkills, [{ name: 'harness-observer', version: null }]);
  assert.deepEqual(record.skills, ['harness-observer']);
  assert.deepEqual(computeOwnSkills('deepseek-harness', record.interactions), [{
    name: 'harness-observer',
    version: null,
  }]);
  assert.equal(record.interactions.length, 3);
  assert.equal(record.interactions[1].tool_calls[0].function.name, 'skill');
  assert.equal(record.interactions[1].tool_calls[0].output, 'Skill 已加载');
  assert.equal(record.interactions[1].tool_calls[0].state, 'completed');
  assert.equal(record.session_merge_strategy, 'snapshot-replace');
});

test('Harness aggregation preserves one root System Prompt from request/header', () => {
  const events = baseEvents('dsh-root-system');
  const header = {
    ...events[0],
    body: {
      ...events[0].body,
      header: {
        ...events[0].body.header,
        system: 'Root Harness system prompt',
      },
    },
  };
  const repeatedHeader = {
    ...header,
    sequence: 12,
    eventTimestamp: '2026-08-21T05:00:12.000Z',
  };

  const record = aggregateDeepSeekHarnessOtelEvents(
    'dsh-root-system',
    [header, ...events.slice(1), repeatedHeader],
  );

  assert.ok(record);
  const systemInteractions = record.interactions.filter((interaction: any) => interaction.role === 'system');
  assert.equal(systemInteractions.length, 1);
  assert.deepEqual(systemInteractions[0], {
    role: 'system',
    content: 'Root Harness system prompt',
    agent: 'DeepSeek Harness',
    system_prompt_length: 26,
    timeInfo: {
      created: '2026-08-21T05:00:00.000Z',
      completed: '2026-08-21T05:00:00.000Z',
    },
  });
});

test('Harness aggregation scopes one child System Prompt to its subagent Session', () => {
  const parentSessionId = 'dsh-parent-system';
  const childSessionId = 'dsh-child-system';
  const parentEvents = baseEvents(parentSessionId);
  const childEvents = normalizeDeepSeekHarnessOtlpLogs(harnessPayload(childSessionId, [
    harnessRecord(childSessionId, 'subagent/descriptor', 0, {
      version: 1,
      mode: 'spawn',
      label: 'Researcher',
      agentPreset: 'research',
    }, { 'session.parent_id': parentSessionId, 'session.seed_length': 4 }),
    harnessRecord(childSessionId, 'request/header', 1, {
      header: {
        config: { provider: 'deepseek', model: 'deepseek-chat' },
        system: 'Child Researcher system prompt',
      },
      reason: 'subagent',
    }, { 'session.parent_id': parentSessionId, 'session.seed_length': 4 }),
    harnessRecord(childSessionId, 'request/header', 2, {
      header: {
        config: { provider: 'deepseek', model: 'deepseek-chat' },
        system: 'Child Researcher system prompt',
      },
      reason: 'subagent-retry',
    }, { 'session.parent_id': parentSessionId, 'session.seed_length': 4 }),
  ]), { authenticatedUser: 'alice' }).map((event) => ({
    ...event,
    sessionId: parentSessionId,
  }));

  const record = aggregateDeepSeekHarnessOtelEvents(parentSessionId, [...parentEvents, ...childEvents]);

  assert.ok(record);
  const childSystems = record.interactions.filter((interaction: any) => (
    interaction.role === 'system' && interaction.subagent_session_id === childSessionId
  ));
  assert.equal(childSystems.length, 1);
  assert.equal(childSystems[0].content, 'Child Researcher system prompt');
  assert.equal(childSystems[0].agent, 'Researcher');
  assert.equal(childSystems[0].subagent_name, 'Researcher');
  assert.equal(childSystems[0].system_prompt_length, 30);
});

test('Harness aggregation keeps injected runtime context out of user interactions', () => {
  const events = baseEvents('dsh-injected-context');
  const injected = {
    ...events[2],
    sequence: 99,
    eventTimestamp: '2026-08-21T05:00:59.000Z',
    body: {
      id: 'runtime-context',
      role: 'user',
      content: [{ type: 'text', text: 'internal skill catalog' }],
      source: { kind: 'skill-catalog', form: 'catalog' },
    },
  };
  const record = aggregateDeepSeekHarnessOtelEvents('dsh-injected-context', [...events, injected]);

  assert.ok(record);
  assert.deepEqual(
    record.interactions.filter((interaction: any) => interaction.role === 'user').map((interaction: any) => interaction.content),
    ['检查 Harness Skill 调用'],
  );
});

test('Harness aggregation preserves failed tools and child-session lineage', () => {
  const childSessionId = 'dsh-child';
  const events = normalizeDeepSeekHarnessOtlpLogs(harnessPayload(childSessionId, [
    harnessRecord(childSessionId, 'subagent/descriptor', 0, {
      version: 1,
      mode: 'spawn',
      label: 'Researcher',
      agentPreset: 'research',
    }, { 'session.parent_id': 'dsh-parent', 'session.seed_length': 4 }),
    harnessRecord(childSessionId, 'tool/call', 1, {
      turn: 1,
      step: 1,
      callId: 'call-failed',
      name: 'bash',
      arguments: JSON.stringify({ command: 'false' }),
    }, { 'session.parent_id': 'dsh-parent', 'session.seed_length': 4 }),
    harnessRecord(childSessionId, 'tool/result', 2, {
      turn: 1,
      step: 1,
      message: {
        role: 'user',
        source: { kind: 'tool', callId: 'call-failed' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call-failed',
          content: [{ type: 'text', text: 'exit 1' }],
          isError: true,
        }],
      },
      error: { name: 'ShellError', code: 'EXIT_1' },
    }, { 'session.parent_id': 'dsh-parent', 'session.seed_length': 4 }),
    harnessRecord(childSessionId, 'turn/end', 3, {
      turn: 1,
      reason: { kind: 'error', error: { message: 'tool failed', code: 'FAILED' } },
    }, { 'session.parent_id': 'dsh-parent', 'session.seed_length': 4 }),
  ]), { authenticatedUser: 'alice' });

  const record = aggregateDeepSeekHarnessOtelEvents(childSessionId, events);
  assert.ok(record);
  assert.equal(record.parent_session_id, 'dsh-parent');
  assert.equal(record.seed_length, 4);
  assert.equal(record.agentName, 'Researcher');
  assert.equal(record.agent, 'Researcher');
  assert.equal(record.tool_call_error_count, 1);
  assert.equal(record.failures?.[0].failure_type, 'turn_error');
  assert.equal(record.interactions[0].tool_calls[0].state, 'error');
});

test('Harness framework and consumer source declare Skill and subagent-tree support', () => {
  const adapter = getAdapter('deepseek-harness');
  assert.equal(adapter.descriptor.label, 'DeepSeek Harness');
  assert.equal(adapter.capabilities?.skills, true);
  assert.equal(adapter.capabilities?.subagentTree, true);
  assert.equal(adapter.capabilities?.skillScope, 'agent-tree');
  assert.equal(adapter.sessionMergeStrategy, 'snapshot-replace');
  assert.ok(listSources().some((source) => source.id === 'deepseek-harness-otel-logs'));
});
