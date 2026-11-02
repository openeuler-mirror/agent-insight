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

import type { ExecutionRecord } from '@/lib/storage/data-service';
import { isDifyWorkflowRoot } from '../dify';
import type { OtelTraceEvent } from '../types';
import type { OtelTraceAdapter } from './types';
import type { LangfuseTraceNode, LangfuseRequestMessage } from './langfuse-trace';

function parse(value: any): any {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}
function text(value: any): string {
  if (value == null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}
function toolCall(part: any): any {
  return { id: part.id, type: 'function', function: { name: part.name, arguments: text(part.arguments) } };
}
function list(value: any): any[] {
  const parsed = parse(value);
  return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object') : [];
}
function messages(event: OtelTraceEvent): LangfuseRequestMessage[] {
  const a = event.attributes;
  const result: LangfuseRequestMessage[] = [];
  for (const m of list(a['gen_ai.input.messages'] || a['gen_ai.prompt'])) {
    if (typeof m.role !== 'string') continue;
    const parts = list(m.parts);
    const calls = parts.filter(p => p.type === 'tool_call').map(toolCall);
    const responses = parts.filter(p => p.type === 'tool_call_response');
    const content = parts.length ? parts.filter(p => p.type === 'text').map(p => text(p.content)).join('\n') : text(m.text ?? m.content);
    if (content || calls.length || !responses.length) {
      result.push({ role: m.role, content, ...(calls.length ? { tool_calls: calls } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}), ...(m.name ? { name: m.name } : {}),
      });
    }
    for (const response of responses) result.push({ role: 'tool', content: text(response.result), tool_call_id: response.id, name: response.name });
  }
  const instructions = list(a['gen_ai.system_instructions']).filter(p => p.type === 'text').map(p => text(p.content)).join('\n');
  if (instructions && !result.some(m => m.role === 'system')) result.unshift({ role: 'system', content: instructions });
  return result;
}
function response(event: OtelTraceEvent): { content: string; reasoning_content?: string; tool_calls?: any[] } {
  const a = event.attributes;
  const output = parse(a['output.value']);
  const parts = list(a['gen_ai.output.messages']).flatMap(m => list(m.parts));
  const calls = parts.filter(p => p.type === 'tool_call').map(toolCall);
  const reasoning = text(output?.reasoning_content ?? parts.filter(p => p.type === 'thinking' || p.type === 'reasoning').map(p => text(p.content ?? p.text)).join('\n'));
  return { content: text(a['gen_ai.completion'] ?? output?.text ?? parts.filter(p => p.type === 'text').map(p => text(p.content)).join('\n')),
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(calls.length ? { tool_calls: calls } : {}),
  };
}
function iso(ms: number): string { return new Date(ms).toISOString(); }
function endMs(event: OtelTraceEvent): number { return event.startTimeMs + event.latencyMs; }

function aggregate(sessionId: string, events: OtelTraceEvent[]): ExecutionRecord | null {
  const own = events.filter(e => e.framework === 'dify' && e.sessionId === sessionId);
  if (!own.length) return null;
  const ids = new Set(own.map(e => e.spanId));
  const workflowRoot = own.find(e => isDifyWorkflowRoot(e.name));
  const agentRoot = own.find(e => e.kind === 'agent' && !ids.has(e.parentSpanId));
  const root = workflowRoot || agentRoot;
  const trajectory = own.some(e => e.attributes['dify.trajectory'] === true);
  const agentName = root?.attributes['gen_ai.agent.name'] || own.find(e => e.attributes['gen_ai.agent.name'])?.attributes['gen_ai.agent.name'] || 'Dify';
  const start = own.find(e => e.attributes['node.type'] === 'start');
  const inputs = parse(start?.attributes['output.value']) || {};
  const llms = own.filter(e => e.kind === 'llm');
  const tools = own.filter(e => e.kind === 'tool');
  const terminal = [...own].reverse().find(e => ['end', 'answer'].includes(e.attributes['node.type']));
  const output = parse(terminal?.attributes['output.value']);
  const final = (typeof output === 'string' ? output : output?.answer ?? output?.text ?? output)
    ?? agentRoot?.attributes.final_result ?? (trajectory && llms.length ? response(llms[llms.length - 1]).content : undefined);
  const firstMessages = llms.flatMap(messages);
  const query = text(inputs['sys.query'] ?? inputs.question ?? firstMessages.find(m => m.role === 'user')?.content);
  const interactions: any[] = [];
  if (query) interactions.push({ role: 'user', content: query, timestamp: iso(start?.startTimeMs ?? own[0].startTimeMs) });
  for (const event of own) {
    const base = {
      role: 'assistant', spanId: event.spanId, parentSpanId: event.parentSpanId, traceId: event.traceId,
      name: event.name, agent: 'Dify', timestamp: iso(event.startTimeMs),
      timeInfo: { created: iso(event.startTimeMs), completed: iso(endMs(event)) },
    };
    if (event.kind === 'llm') {
      const outputValue = response(event);
      interactions.push({ ...base, content: outputValue.content, reasoning_content: outputValue.reasoning_content,
        model: event.model, requestMessages: messages(event),
        provider: event.attributes['gen_ai.provider.name'],
        finish_reason: list(event.attributes['gen_ai.output.messages']).find(m => m.finish_reason)?.finish_reason,
        usage: { ...event.usage, total: event.usage.total_tokens },
      });
    } else if (event.kind === 'tool') {
      interactions.push({ ...base, role: 'opencode', content: '', tool_calls: [{
        id: event.attributes['gen_ai.tool.call.id'] || event.spanId, type: 'function',
        state: event.attributes['agent.insight.status'] === 'error' ? 'error' : event.attributes['dify.span.ended'] ? 'success' : 'running',
        function: { name: event.attributes['gen_ai.tool.name'] || event.attributes['tool.name'] || event.name || 'tool', arguments: text(event.attributes['gen_ai.tool.call.arguments'] ?? event.attributes['input.value']) },
        output: text(event.attributes['gen_ai.tool.call.result'] ?? event.attributes['output.value']), result: text(event.attributes['gen_ai.tool.call.result'] ?? event.attributes['output.value']),
        error: event.attributes['agent.insight.status_message'],
        timing: { started_at: iso(event.startTimeMs), completed_at: iso(endMs(event)) },
      }] });
    }
  }
  const generationByCall = new Map<string, string>();
  const ambiguousCalls = new Set<string>();
  for (const event of llms) {
    for (const call of response(event).tool_calls || []) {
      if (!call.id) continue;
      if (generationByCall.has(call.id) && generationByCall.get(call.id) !== event.spanId) ambiguousCalls.add(call.id);
      else generationByCall.set(call.id, event.spanId!);
    }
  }
  const nodes: LangfuseTraceNode[] = own.map(e => ({
    traceId: e.traceId!, spanId: e.spanId!, parentSpanId: e.parentSpanId || null,
    sourceParentSpanId: e.parentSpanId || null,
    displayParentSpanId: ids.has(e.parentSpanId) ? e.parentSpanId! : null,
    name: (e.kind === 'agent' ? e.attributes['gen_ai.agent.name'] : e.kind === 'tool' ? e.attributes['gen_ai.tool.name'] : undefined) || e.name || e.attributes['node.type'] || 'Workflow', kind: e.kind,
    startedAt: e.startTimeMs, completedAt: endMs(e), durationMs: e.latencyMs,
    input: isDifyWorkflowRoot(e.name) && query ? [{ role: 'user', content: query }]
      : e.kind === 'llm' ? messages(e) : e.kind === 'agent' ? messages(llms[0] || e) : parse(e.attributes['gen_ai.tool.call.arguments'] ?? e.attributes['input.value']),
    output: e.kind === 'llm' ? response(e) : e.kind === 'agent' ? e.attributes.final_result : parse(e.attributes['gen_ai.tool.call.result'] ?? e.attributes['output.value']),
    status: e.attributes['agent.insight.status'] || 'unset', statusMessage: e.attributes['agent.insight.status_message'],
    model: e.model, usage: e.kind === 'llm' ? { inputTokens: e.usage.input_tokens, outputTokens: e.usage.output_tokens, totalTokens: e.usage.total_tokens } : undefined,
    visibility: 'visible',
    dify: Object.fromEntries(Object.entries({
      tenantId: e.attributes['dify.tenant_id'] ?? root?.attributes['dify.tenant_id'],
      appId: e.attributes['dify.app_id'] ?? root?.attributes['dify.app_id'],
      workflowId: e.attributes['dify.workflow.id'] ?? e.attributes['dify.workflow_id'] ?? root?.attributes['dify.workflow_id'],
      workflowRunId: e.attributes['dify.workflow.run_id'] ?? inputs['sys.workflow_run_id'],
      nodeId: e.attributes['dify.node.id'] ?? e.attributes['node.id'],
      nodeExecutionId: e.attributes['dify.node.execution_id'] ?? e.attributes['node.execution_id'],
      nodeType: e.attributes['node.type'],
      trajectory: e.attributes['dify.trajectory'] === true ? true : undefined,
    }).filter(([, value]) => value !== undefined && value !== null && value !== '')),
  }));
  const eventById = new Map(own.map(e => [e.spanId, e]));
  for (const node of nodes) {
    if (node.kind !== 'tool') continue;
    const event = eventById.get(node.spanId)!;
    const callId = event.attributes['gen_ai.tool.call.id'];
    const linked = callId && !ambiguousCalls.has(callId) ? generationByCall.get(callId) : undefined;
    node.toolCallId = callId;
    node.linkedGenerationSpanId = linked;
    node.orphanTool = !linked;
    if (linked && linked !== node.spanId) node.displayParentSpanId = linked;
  }
  const begun = root?.startTimeMs ?? own[0].startTimeMs;
  return {
    task_id: sessionId, framework: 'dify', label: trajectory ? 'Dify Agent' : 'Dify Workflow', agent: agentName, agentName,
    query: query || (trajectory ? 'Dify Agent' : 'Dify Workflow'), final_result: text(final),
    user: own.find(e => e.authenticatedUser)?.user || own[0].user || 'anonymous',
    authenticated_ingest: own.some(e => e.authenticatedUser === true),
    model: llms.find(e => e.model)?.model || 'unknown',
    timestamp: new Date(begun), trace_started_at: new Date(begun),
    trace_completed_at: root?.attributes['dify.span.ended']
      && (root.kind === 'agent' || own.some(e => e.attributes['node.type'] === 'end') || root.attributes['agent.insight.status'] === 'error')
      ? new Date(endMs(root)) : undefined,
    latency: root?.latencyMs ?? Math.max(...own.map(endMs)) - begun,
    tokens: llms.reduce((sum, e) => sum + e.usage.total_tokens, 0),
    input_tokens: llms.reduce((sum, e) => sum + e.usage.input_tokens, 0),
    output_tokens: llms.reduce((sum, e) => sum + e.usage.output_tokens, 0),
    llm_call_count: llms.length, tool_call_count: tools.length,
    tool_call_error_count: tools.filter(e => e.attributes['agent.insight.status'] === 'error').length,
    interactions, langfuseTraceNodes: nodes,
  };
}

export const difyOtelTraceAdapter: OtelTraceAdapter = {
  id: 'dify', matches: events => events.some(e => e.framework === 'dify'), aggregate,
};
