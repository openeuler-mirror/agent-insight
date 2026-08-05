import assert from 'node:assert/strict';
import test from 'node:test';

import { saveExecutionRecord } from '@/lib/storage/data-service';
import { prismaRaw } from '@/lib/storage/prisma';

test('Codex persists delegated work under the Codex Agent identity', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const user = `test-agent-identity-${suffix}`;
  const rootId = `test-codex-agent-identity-${suffix}`;
  const childSessionId = `${rootId}-default`;
  const timestamp = new Date().toISOString();

  try {
    await prismaRaw.registeredAgent.create({
      data: { platform: 'codex', name: 'default', user, agentType: 'subagent', agentOwnership: 'user' },
    });
    await saveExecutionRecord({
      upload_id: rootId,
      task_id: rootId,
      framework: 'codex',
      user,
      agentName: 'default',
      interactions: [
        { role: 'user', agent: 'codex', content: 'delegate', timestamp },
        {
          role: 'assistant',
          agent: 'codex',
          content: '',
          timestamp,
          tool_calls: [{
            id: `${rootId}-task`,
            type: 'function',
            function: {
              name: 'task',
              arguments: JSON.stringify({ subagent_type: 'default', session_id: childSessionId }),
            },
          }],
        },
        {
          role: 'subagent',
          agent: 'default',
          subagent_name: 'default',
          subagent_session_id: childSessionId,
          content: 'completed',
          timestamp,
        },
      ],
    });

    const root = await prismaRaw.execution.findUnique({
      where: { id: rootId },
      select: { agentName: true, observedAgents: true },
    });
    const child = await prismaRaw.execution.findFirst({
      where: { parentExecutionId: rootId },
      select: { agentName: true, observedAgents: true, subagentName: true },
    });
    const registrations = await prismaRaw.registeredAgent.findMany({
      where: { platform: 'codex', user },
      select: { name: true, agentType: true },
    });

    assert.deepEqual(root, { agentName: 'codex', observedAgents: '["codex"]' });
    assert.deepEqual(child, {
      agentName: 'codex', observedAgents: '["codex"]', subagentName: 'default',
    });
    assert.deepEqual(registrations, [{ name: 'codex', agentType: 'main' }]);
  } finally {
    await prismaRaw.execution.deleteMany({ where: { user, framework: 'codex' } });
    await prismaRaw.registeredAgent.deleteMany({ where: { user, platform: 'codex' } });
  }
});

test('Pi persists delegated work under the real child profile identity', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const user = `test-pi-agent-identity-${suffix}`;
  const rootId = `test-pi-agent-identity-${suffix}`;
  const childSessionId = `${rootId}-worker`;
  const timestamp = new Date().toISOString();

  try {
    await prismaRaw.registeredAgent.create({
      data: { platform: 'pi-agent', name: 'worker', user, agentType: 'subagent', agentOwnership: 'user' },
    });
    await saveExecutionRecord({
      upload_id: rootId,
      task_id: rootId,
      framework: 'pi-agent',
      user,
      agentName: 'pi-agent',
      interactions: [
        { role: 'user', agent: 'pi-agent', content: 'delegate', timestamp },
        {
          role: 'assistant',
          agent: 'pi-agent',
          content: '',
          timestamp,
          tool_calls: [{
            id: `${rootId}-task`,
            type: 'function',
            function: {
              name: 'task',
              arguments: JSON.stringify({ subagent_type: 'worker', session_id: childSessionId }),
            },
          }],
        },
        {
          role: 'subagent',
          agent: 'worker',
          subagent_name: 'worker',
          subagent_session_id: childSessionId,
          content: 'completed',
          timestamp,
        },
      ],
    });

    const root = await prismaRaw.execution.findUnique({
      where: { id: rootId },
      select: { agentName: true, observedAgents: true },
    });
    const child = await prismaRaw.execution.findFirst({
      where: { parentExecutionId: rootId },
      select: { agentName: true, observedAgents: true, subagentName: true },
    });
    const registrations = await prismaRaw.registeredAgent.findMany({
      where: { platform: 'pi-agent', user },
      select: { name: true, agentType: true },
    });

    assert.deepEqual(root, { agentName: 'pi-agent', observedAgents: '["pi-agent","worker"]' });
    assert.deepEqual(child, {
      agentName: 'worker', observedAgents: '["worker"]', subagentName: 'worker',
    });
    assert.deepEqual(registrations.sort((a, b) => a.name.localeCompare(b.name)), [
      { name: 'pi-agent', agentType: 'main' },
      { name: 'worker', agentType: 'subagent' },
    ]);
  } finally {
    await prismaRaw.execution.deleteMany({ where: { user, framework: 'pi-agent' } });
    await prismaRaw.registeredAgent.deleteMany({ where: { user, platform: 'pi-agent' } });
  }
});

test('Codex replaces an OTel Session fallback during precise reaggregation', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const user = `test-codex-otel-placeholder-${suffix}`;
  const taskId = `test-codex-otel-placeholder-${suffix}`;

  try {
    await saveExecutionRecord({
      upload_id: taskId,
      task_id: taskId,
      framework: 'codex',
      user,
      query: 'OTel Session',
      interactions: [],
    });
    await saveExecutionRecord({
      upload_id: taskId,
      task_id: taskId,
      framework: 'codex',
      user,
      query: 'read the current file',
      interactions: [{ role: 'user', agent: 'codex', content: 'read the current file' }],
      skip_evaluation: true,
    });

    const saved = await prismaRaw.execution.findUnique({
      where: { id: taskId },
      select: { query: true },
    });
    assert.deepEqual(saved, { query: 'read the current file' });
  } finally {
    await prismaRaw.execution.deleteMany({ where: { user, framework: 'codex' } });
  }
});

test('Codex complete spool snapshots replace stale duplicate interactions', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const user = `test-codex-snapshot-${suffix}`;
  const taskId = `test-codex-snapshot-${suffix}`;
  const timestamp = new Date().toISOString();

  try {
    await saveExecutionRecord({
      upload_id: taskId,
      task_id: taskId,
      framework: 'codex',
      user,
      interactions: [
        { role: 'user', agent: 'codex', content: 'root', timestamp },
        { role: 'assistant', agent: 'codex', content: 'stale duplicate', timestamp, usage: { total: 99 } },
        { role: 'assistant', agent: 'codex', content: 'stale duplicate', timestamp, usage: { total: 99 } },
      ],
    });
    await saveExecutionRecord({
      upload_id: taskId,
      task_id: taskId,
      framework: 'codex',
      user,
      session_merge_strategy: 'snapshot-replace',
      complete_session_snapshot: true,
      interactions: [
        { role: 'user', agent: 'codex', content: 'root', timestamp },
        { role: 'assistant', agent: 'codex', content: 'fresh task', timestamp, usage: { total: 22 } },
      ],
      skip_evaluation: true,
    });

    const session = await prismaRaw.session.findUnique({ where: { taskId } });
    const interactions = JSON.parse(session?.interactions || '[]');
    assert.deepEqual(interactions.map((item: { content?: string }) => item.content), ['root', 'fresh task']);
  } finally {
    await prismaRaw.execution.deleteMany({ where: { user, framework: 'codex' } });
  }
});

test('Codex pending automatic executions never persist as root traces', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const user = `test-codex-pending-${suffix}`;
  const taskId = `pending:test-codex-pending-${suffix}`;

  try {
    const result = await saveExecutionRecord({
      upload_id: taskId,
      task_id: taskId,
      framework: 'codex',
      user,
      query: 'OTel Session',
      tokens: 23487,
      interactions: [{ role: 'assistant', agent: 'codex', content: 'automatic unit' }],
    });
    const saved = await prismaRaw.execution.findUnique({ where: { id: taskId } });
    assert.equal(result.success, true);
    assert.equal(saved, null);
  } finally {
    await prismaRaw.execution.deleteMany({ where: { user, framework: 'codex' } });
  }
});

test('Codex removes empty legacy sessions and keeps meaningful sessions with a neutral title', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const user = `test-codex-legacy-session-${suffix}`;
  const emptyId = `test-codex-empty-session-${suffix}`;
  const meaningfulId = `test-codex-meaningful-session-${suffix}`;
  const triggerId = `test-codex-legacy-trigger-${suffix}`;

  try {
    await prismaRaw.execution.createMany({
      data: [
        {
          id: emptyId,
          taskId: emptyId,
          framework: 'codex',
          user,
          query: 'Codex Session',
          tokens: 0,
          latency: 0,
          toolCallCount: 0,
          llmCallCount: 0,
          finalResult: '',
          isSubagent: false,
        },
        {
          id: meaningfulId,
          taskId: meaningfulId,
          framework: 'codex',
          user,
          query: 'Codex Session',
          tokens: 42,
          latency: 1234,
          toolCallCount: 1,
          llmCallCount: 1,
          finalResult: '',
          isSubagent: false,
        },
      ],
    });

    await saveExecutionRecord({
      upload_id: triggerId,
      task_id: triggerId,
      framework: 'codex',
      user,
      query: 'new real Codex task',
    });

    const [empty, meaningful] = await Promise.all([
      prismaRaw.execution.findUnique({ where: { id: emptyId } }),
      prismaRaw.execution.findUnique({ where: { id: meaningfulId }, select: { query: true, tokens: true, latency: true } }),
    ]);

    assert.equal(empty, null);
    assert.deepEqual(meaningful, { query: 'Codex execution', tokens: 42, latency: 1234 });
  } finally {
    await prismaRaw.execution.deleteMany({ where: { user, framework: 'codex' } });
  }
});
