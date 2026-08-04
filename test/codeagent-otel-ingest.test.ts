import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { POST as postLogs } from '@/app/api/ingest/otel/v1/logs/route';
import { POST as postMetrics } from '@/app/api/ingest/otel/v1/metrics/route';
import { POST as postTraces } from '@/app/api/ingest/otel/v1/traces/route';
import { buildAgentCallTree, walkTree, type AgentNode } from '@/lib/engine/observability/agent-trace';
import { aggregateCodeAgentOtelEvents } from '@/lib/ingest/codeagent-otel/aggregator';
import {
  isCodeAgentResource,
  partitionCodeAgentOtlpPayload,
} from '@/lib/ingest/codeagent-otel/detect';
import { listCodeAgentOtelSpoolFiles } from '@/lib/ingest/codeagent-otel/spool';
import type { ClaudeOtelEvent } from '@/lib/ingest/claude-otel/types';
import { listSources } from '@/lib/ingest/otel-consumer/sources';
import { computeOwnSkills, extractExplicitSkillsFromNode } from '@/lib/storage/data-service';

const attr = (key: string, value: any) => ({
  key,
  value: typeof value === 'number'
    ? Number.isInteger(value) ? { intValue: value } : { doubleValue: value }
    : typeof value === 'boolean'
      ? { boolValue: value }
      : { stringValue: String(value) },
});

function resourceGroup(serviceName: string, childrenKey: string, children: any[] = []) {
  return {
    resource: { attributes: [attr('service.name', serviceName)] },
    [childrenKey]: children,
  };
}

function logRecord(eventName: string, sessionId: string, sequence: number, attributes: Record<string, any>) {
  return {
    body: { stringValue: eventName },
    attributes: [
      attr('event.name', eventName),
      attr('session.id', sessionId),
      attr('event.timestamp', `2026-07-24T01:00:${String(sequence).padStart(2, '0')}.000Z`),
      attr('event.sequence', sequence),
      ...Object.entries(attributes).map(([key, value]) => attr(key, value)),
    ],
  };
}

function event(
  sessionId: string,
  eventName: string,
  sequence: number,
  attributes: Record<string, any> = {},
): ClaudeOtelEvent {
  return {
    receivedAt: '2026-07-24T01:00:00.000Z',
    eventName,
    eventTimestamp: `2026-07-24T01:00:${String(sequence).padStart(2, '0')}.000Z`,
    sequence,
    sessionId,
    resource: { 'service.name': 'CodeAgentOC', 'service.component': 'cli3.0' },
    attributes: { 'session.id': sessionId, ...attributes },
    traceId: `trace-${sessionId}`,
    spanId: `span-${sequence}`,
  };
}

function findNode(tree: AgentNode, sessionId: string): AgentNode | null {
  let found: AgentNode | null = null;
  walkTree(tree, (node) => {
    if (node.sessionId === sessionId) found = node;
  });
  return found;
}

test('CodeAgent detector identifies CodeAgentOC and partitions every OTLP signal', () => {
  assert.equal(isCodeAgentResource(resourceGroup('CodeAgentOC', 'scopeLogs').resource), true);
  assert.equal(isCodeAgentResource(resourceGroup('claude-code', 'scopeLogs').resource), false);

  for (const [signal, topLevelKey, childrenKey] of [
    ['logs', 'resourceLogs', 'scopeLogs'],
    ['traces', 'resourceSpans', 'scopeSpans'],
    ['metrics', 'resourceMetrics', 'scopeMetrics'],
  ] as const) {
    const body = {
      [topLevelKey]: [
        resourceGroup('CodeAgentOC', childrenKey),
        resourceGroup('another-service', childrenKey),
      ],
    };
    const partition = partitionCodeAgentOtlpPayload(body, signal);
    assert.equal(partition.codeAgentResourceCount, 1);
    assert.equal(partition.hasRemainingResources, true);
    assert.equal(partition.remainingBody[topLevelKey].length, 1);
    assert.equal(
      partition.remainingBody[topLevelKey][0].resource.attributes[0].value.stringValue,
      'another-service',
    );
  }
});

test('CodeAgent logs are written only to the independent codeagent spool', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-log-route-'));
  const codeAgentDir = path.join(root, 'codeagent');
  const claudeDir = path.join(root, 'claude');
  const previousCodeAgentDir = process.env.AGENT_INSIGHT_CODEAGENT_OTEL_SPOOL_DIR;
  const previousClaudeDir = process.env.AGENT_INSIGHT_CLAUDE_OTEL_SPOOL_DIR;
  process.env.AGENT_INSIGHT_CODEAGENT_OTEL_SPOOL_DIR = codeAgentDir;
  process.env.AGENT_INSIGHT_CLAUDE_OTEL_SPOOL_DIR = claudeDir;

  try {
    const sessionId = 'codeagent-route-session';
    const body = {
      resourceLogs: [resourceGroup('CodeAgentOC', 'scopeLogs', [{
        logRecords: [logRecord('user_prompt', sessionId, 1, { prompt: 'hello codeagent' })],
      }])],
    };
    const response = await postLogs(new Request('http://localhost/api/ingest/otel/v1/logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(result.frameworks.codeagent.received, 1);
    assert.equal(result.frameworks.other.received, 0);
    assert.deepEqual(result.sessions, [sessionId]);
    assert.equal(listCodeAgentOtelSpoolFiles(codeAgentDir).length, 1);
    assert.equal(fs.existsSync(claudeDir), false);
  } finally {
    if (previousCodeAgentDir === undefined) delete process.env.AGENT_INSIGHT_CODEAGENT_OTEL_SPOOL_DIR;
    else process.env.AGENT_INSIGHT_CODEAGENT_OTEL_SPOOL_DIR = previousCodeAgentDir;
    if (previousClaudeDir === undefined) delete process.env.AGENT_INSIGHT_CLAUDE_OTEL_SPOOL_DIR;
    else process.env.AGENT_INSIGHT_CLAUDE_OTEL_SPOOL_DIR = previousClaudeDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CodeAgent traces and metrics are accepted then discarded before persistence', async () => {
  const tracesResponse = await postTraces(new Request('http://localhost/api/ingest/otel/v1/traces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      resourceSpans: [resourceGroup('CodeAgentOC', 'scopeSpans')],
    }),
  }));
  const tracesResult = await tracesResponse.json();
  assert.equal(tracesResponse.status, 200);
  assert.equal(tracesResult.framework, 'codeagent');
  assert.equal(tracesResult.ignored, true);
  assert.equal(tracesResult.ignoredResourceSpans, 1);
  assert.equal(tracesResult.received, 0);

  const metricsResponse = await postMetrics(new Request('http://localhost/api/ingest/otel/v1/metrics', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      resourceMetrics: [resourceGroup('CodeAgentOC', 'scopeMetrics')],
    }),
  }));
  const metricsResult = await metricsResponse.json();
  assert.equal(metricsResponse.status, 200);
  assert.equal(metricsResult.framework, 'codeagent');
  assert.equal(metricsResult.ignored, true);
  assert.equal(metricsResult.ignoredResourceMetrics, 1);
});

test('CodeAgent aggregation restores query, response, tokens, and tool output', () => {
  const sessionId = 'codeagent-basic';
  const events = [
    event(sessionId, 'api_request', 1, {
      inference_id: 'inference-1',
      request_text: JSON.stringify([{ role: 'user', content: 'read the fixture' }]),
      model: 'test-model',
    }),
    event(sessionId, 'api_response', 2, {
      inference_id: 'inference-1',
      response_text: '',
      model: 'test-model',
      input_token_count: 100,
      output_token_count: 5,
      cached_content_token_count: 10,
      total_token_count: 115,
    }),
    event(sessionId, 'tool_request', 3, {
      inference_id: 'inference-1',
      tool_call_id: 'read-1',
      function_name: 'Read',
      function_args: JSON.stringify({ file_path: 'fixture.txt' }),
    }),
    event(sessionId, 'tool_response', 4, {
      tool_call_id: 'read-1',
      response_body: JSON.stringify({ content: 'fixture content' }),
      result_status: 'completed',
    }),
    event(sessionId, 'api_request', 5, {
      inference_id: 'inference-2',
      model: 'test-model',
    }),
    event(sessionId, 'api_response', 6, {
      inference_id: 'inference-2',
      response_text: 'The fixture contains: fixture content',
      model: 'test-model',
      input_token_count: 4,
      output_token_count: 1,
      total_token_count: 5,
    }),
  ];

  const record = aggregateCodeAgentOtelEvents(sessionId, events);
  assert.ok(record);
  assert.equal(record.framework, 'codeagent');
  assert.equal(record.query, 'read the fixture');
  assert.equal(record.final_result, 'The fixture contains: fixture content');
  assert.equal(record.input_tokens, 104);
  assert.equal(record.output_tokens, 6);
  assert.equal(record.cache_read_input_tokens, 10);
  assert.equal(record.tokens, 120);
  assert.equal(record.llm_call_count, 2);
  assert.equal(record.tool_call_count, 1);
  assert.equal(record.interactions?.[0]?.role, 'user');
  assert.equal(record.interactions?.[0]?.content, 'read the fixture');
  const readCall = record.interactions
    ?.flatMap((interaction: any) => interaction.tool_calls || [])
    .find((call: any) => call.function?.name === 'Read');
  assert.deepEqual(readCall?.output, { content: 'fixture content' });
});

test('CodeAgent Skill and Agent fields map to skill ownership and a child trace', () => {
  const sessionId = 'codeagent-root';
  const childId = 'codeagent-child';
  const root = {
    'execution.agent_run_id': sessionId,
    'execution.agent_id': 'main',
    agent_name: 'main',
  };
  const child = {
    'execution.agent_run_id': childId,
    'execution.parent_agent_run_id': sessionId,
    'execution.agent_id': 'explore',
    agent_name: 'Explore',
  };
  const events = [
    event(sessionId, 'user_prompt', 1, { ...root, prompt: 'delegate and inspect' }),
    event(sessionId, 'api_request', 2, { ...root, inference_id: 'root-1' }),
    event(sessionId, 'api_response', 3, {
      ...root,
      inference_id: 'root-1',
      response_text: '',
      input_token_count: 10,
      output_token_count: 2,
    }),
    event(sessionId, 'tool_request', 4, {
      ...root,
      inference_id: 'root-1',
      tool_call_id: 'agent-1',
      function_name: 'Agent',
      function_args: JSON.stringify({ subagent_type: 'Explore', prompt: 'inspect' }),
    }),
    event(sessionId, 'agent.start', 5, child),
    event(sessionId, 'api_request', 6, { ...child, inference_id: 'child-1' }),
    event(sessionId, 'api_response', 7, {
      ...child,
      inference_id: 'child-1',
      response_text: '',
      input_token_count: 20,
      output_token_count: 3,
    }),
    event(sessionId, 'tool_request', 8, {
      ...child,
      inference_id: 'child-1',
      tool_call_id: 'skill-1',
      function_name: 'Skill',
      skill_name: 'otel-smoke-skill',
      function_args: JSON.stringify({ skill: 'otel-smoke-skill', version: 2 }),
    }),
    event(sessionId, 'tool_response', 9, {
      ...child,
      tool_call_id: 'skill-1',
      response_body: 'skill loaded',
      result_status: 'completed',
    }),
    event(sessionId, 'api_request', 10, { ...child, inference_id: 'child-2' }),
    event(sessionId, 'api_response', 11, {
      ...child,
      inference_id: 'child-2',
      response_text: 'child result',
      input_token_count: 4,
      output_token_count: 2,
    }),
    event(sessionId, 'tool_response', 12, {
      ...root,
      tool_call_id: 'agent-1',
      response_body: JSON.stringify({ agentId: childId, content: 'child result' }),
      result_status: 'completed',
    }),
    event(sessionId, 'api_request', 13, { ...root, inference_id: 'root-2' }),
    event(sessionId, 'api_response', 14, {
      ...root,
      inference_id: 'root-2',
      response_text: 'root final',
      input_token_count: 3,
      output_token_count: 2,
    }),
  ];

  const record = aggregateCodeAgentOtelEvents(sessionId, events);
  assert.ok(record);
  assert.equal(record.agent, 'main');
  assert.equal(record.agentName, 'main');
  assert.deepEqual(record.agents, ['main', 'Explore']);
  assert.equal(record.interactions?.filter((interaction: any) => interaction.role === 'user').length, 1);
  assert.equal(
    record.interactions?.find((interaction: any) => interaction.role === 'user')?.agent,
    'main',
  );
  const tree = buildAgentCallTree(record.interactions as any[]);
  assert.ok(tree);
  const childNode = findNode(tree, childId);
  assert.ok(childNode);
  assert.equal(childNode.agentName, 'Explore');
  assert.deepEqual(extractExplicitSkillsFromNode(childNode).map((skill) => skill.name), ['otel-smoke-skill']);
  assert.deepEqual(computeOwnSkills('codeagent', record.interactions).map((skill) => skill.name), []);

  const taskCall = record.interactions
    ?.flatMap((interaction: any) => interaction.tool_calls || [])
    .find((call: any) => call.function?.name === 'task');
  assert.ok(taskCall);
  assert.equal(taskCall.codeagent_original_name, 'Agent');
  assert.equal(JSON.parse(taskCall.function.arguments).subagent_session_id, childId);

  const skillCall = record.interactions
    ?.flatMap((interaction: any) => interaction.tool_calls || [])
    .find((call: any) => call.function?.name === 'skill');
  assert.ok(skillCall);
  assert.equal(skillCall.codeagent_original_name, 'Skill');
  assert.deepEqual(record.invokedSkills, [{ name: 'otel-smoke-skill', version: 2 }]);
});

test('CodeAgent aggregation hides automatic memory runs without removing real subagents', () => {
  const sessionId = 'codeagent-memory-filter';
  const childId = 'codeagent-real-child';
  const memoryRunId = 'codeagent-extract-memories';
  const dreamRunId = 'codeagent-auto-dream';
  const root = {
    'execution.agent_run_id': sessionId,
    'execution.agent_id': 'main',
    agent_name: 'main',
  };
  const child = {
    'execution.agent_run_id': childId,
    'execution.parent_agent_run_id': sessionId,
    'execution.agent_id': 'explore',
    agent_name: 'Explore',
  };
  const background = (runId: string) => ({
    'execution.agent_run_id': runId,
    'execution.parent_agent_run_id': sessionId,
    'execution.agent_id': 'subagent',
  });
  const events = [
    event(sessionId, 'user_prompt', 1, { ...root, prompt: 'inspect the project' }),
    event(sessionId, 'api_request', 2, { ...root, inference_id: 'root-1' }),
    event(sessionId, 'api_response', 3, {
      ...root,
      inference_id: 'root-1',
      response_text: '',
      input_token_count: 10,
      output_token_count: 2,
      total_token_count: 12,
    }),
    event(sessionId, 'tool_request', 4, {
      ...root,
      inference_id: 'root-1',
      tool_call_id: 'agent-1',
      function_name: 'Agent',
      function_args: JSON.stringify({ subagent_type: 'Explore', prompt: 'inspect' }),
    }),
    event(sessionId, 'agent.start', 5, child),
    event(sessionId, 'api_request', 6, { ...child, inference_id: 'child-1' }),
    event(sessionId, 'api_response', 7, {
      ...child,
      inference_id: 'child-1',
      response_text: 'child result',
      input_token_count: 20,
      output_token_count: 3,
      total_token_count: 23,
    }),
    event(sessionId, 'tool_response', 8, {
      ...root,
      tool_call_id: 'agent-1',
      response_body: JSON.stringify({ agentId: childId, content: 'child result' }),
      result_status: 'completed',
    }),
    event(sessionId, 'api_request', 9, { ...root, inference_id: 'root-2' }),
    event(sessionId, 'api_response', 10, {
      ...root,
      inference_id: 'root-2',
      response_text: 'root final',
      input_token_count: 4,
      output_token_count: 1,
      total_token_count: 5,
    }),
    event(sessionId, 'api_request', 11, {
      ...background(memoryRunId),
      query_source: 'extract_memories',
      inference_id: 'memory-1',
    }),
    event(sessionId, 'api_response', 12, {
      ...background(memoryRunId),
      inference_id: 'memory-1',
      response_text: '',
      input_token_count: 100,
      output_token_count: 10,
      total_token_count: 110,
    }),
    event(sessionId, 'tool_request', 13, {
      ...background(memoryRunId),
      inference_id: 'memory-1',
      tool_call_id: 'memory-write',
      function_name: 'Write',
      function_args: JSON.stringify({ file_path: '~/.cac/memory/MEMORY.md' }),
    }),
    event(sessionId, 'tool_response', 14, {
      ...background(memoryRunId),
      tool_call_id: 'memory-write',
      response_body: 'memory saved',
      result_status: 'completed',
    }),
    event(sessionId, 'api_request', 15, {
      ...background(dreamRunId),
      query_source: 'auto_dream',
      inference_id: 'dream-1',
    }),
    event(sessionId, 'api_response', 16, {
      ...background(dreamRunId),
      inference_id: 'dream-1',
      response_text: 'dream complete',
      input_token_count: 80,
      output_token_count: 8,
      total_token_count: 88,
    }),
    event(sessionId, 'tool_request', 17, {
      ...background(dreamRunId),
      inference_id: 'dream-1',
      tool_call_id: 'dream-read',
      function_name: 'Read',
      function_args: JSON.stringify({ file_path: '~/.cac/memory/MEMORY.md' }),
    }),
    event(sessionId, 'tool_response', 18, {
      ...background(dreamRunId),
      tool_call_id: 'dream-read',
      response_body: 'memory content',
      result_status: 'completed',
    }),
  ];

  const record = aggregateCodeAgentOtelEvents(sessionId, events);
  assert.ok(record);
  assert.equal(record.final_result, 'root final');
  assert.equal(record.tokens, 40);
  assert.equal(record.llm_call_count, 3);
  assert.equal(record.tool_call_count, 1);
  assert.equal(record.trace_completed_at, '2026-07-24T01:00:10.000Z');
  assert.deepEqual(record.agents, ['main', 'Explore']);
  assert.equal(JSON.stringify(record.interactions).includes('MEMORY.md'), false);
  assert.ok(findNode(buildAgentCallTree(record.interactions as any[])!, childId));
});

test('CodeAgent background marker never removes the root run', () => {
  const sessionId = 'codeagent-memory-root-guard';
  const root = {
    'execution.agent_run_id': sessionId,
    'execution.agent_id': 'main',
  };
  const record = aggregateCodeAgentOtelEvents(sessionId, [
    event(sessionId, 'api_request', 1, {
      ...root,
      query_source: 'extract_memories',
      inference_id: 'root-1',
      request_text: JSON.stringify([{ role: 'user', content: 'keep root' }]),
    }),
    event(sessionId, 'api_response', 2, {
      ...root,
      inference_id: 'root-1',
      response_text: 'root stays visible',
      total_token_count: 2,
    }),
  ]);

  assert.ok(record);
  assert.equal(record.final_result, 'root stays visible');
  assert.equal(record.llm_call_count, 1);
});

test('CodeAgent spool source is registered ahead of generic OTel sources', () => {
  assert.deepEqual(
    listSources().map((source) => source.id),
    ['codeagent-otel-logs', 'claude-otel-logs', 'otel-traces'],
  );
});
