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

import { otelAttrsToObject } from '@/lib/ingest/claude-otel/otlp-json';
import type { OtelTraceEvent } from './types';

export function isDifyWorkflowRoot(name: unknown): boolean {
  return name === 'services.workflow_run_agg.WorkflowRunAgg.run';
}

function isDifyAgentTrajectory(attributes: Record<string, any>): boolean {
  return attributes['service.name'] === 'dify-agent-trajectory'
    || (typeof attributes['dify.agent_id'] === 'string' && Boolean(attributes['dify.agent_id'].trim()));
}

const agentOperations: Record<string, OtelTraceEvent['kind']> = {
  invoke_agent: 'agent', chat: 'llm', execute_tool: 'tool',
};

export function splitDifyOtlpTraces(body: any) {
  const dify: any[] = [];
  const other: any[] = [];
  const entries = (value: any): any[] => Array.isArray(value)
    ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) : [];
  for (const resource of entries(body?.resourceSpans)) {
    const resourceAttrs = otelAttrsToObject(resource.resource?.attributes);
    const selected: any[] = [];
    const remaining: any[] = [];
    for (const scope of entries(resource.scopeSpans)) {
      const owned: any[] = [];
      const foreign: any[] = [];
      for (const span of entries(scope.spans)) {
        const a = { ...resourceAttrs, ...otelAttrsToObject(span.attributes) };
        const claim = a['agent.insight.framework'];
        const native = (!claim || claim === 'dify') && (
          claim === 'dify' || a['gen_ai.framework'] === 'dify' || a['service.name'] === 'langgenius/dify' || isDifyAgentTrajectory(a)
        );
        (native ? owned : foreign).push(span);
      }
      if (owned.length) selected.push({ ...scope, spans: owned });
      if (foreign.length) remaining.push({ ...scope, spans: foreign });
    }
    if (selected.length) dify.push({ ...resource, scopeSpans: selected });
    if (remaining.length) other.push({ ...resource, scopeSpans: remaining });
  }
  return { dify: { resourceSpans: dify }, other: { ...body, resourceSpans: other } };
}

function nano(value: unknown): bigint {
  try { return BigInt(String(value || 0)); } catch { return BigInt(0); }
}

export function normalizeDifyOtlpTraces(
  body: any,
  opts: { receivedAt?: string; authenticatedUser?: string } = {},
): OtelTraceEvent[] {
  const events: OtelTraceEvent[] = [];
  for (const resource of body.resourceSpans || []) {
    const resourceAttrs = otelAttrsToObject(resource.resource?.attributes);
    for (const scope of resource.scopeSpans || []) {
      for (const span of scope.spans || []) {
        const a = { ...resourceAttrs, ...otelAttrsToObject(span.attributes) };
        const node = a['node.type'];
        const root = isDifyWorkflowRoot(span.name);
        const agentKind = isDifyAgentTrajectory(a) ? agentOperations[String(a['gen_ai.operation.name'])] : undefined;
        if (a['logfire.span_type'] === 'pending_span' || (!node && !root && !agentKind)) continue;
        if (typeof span.traceId !== 'string' || !span.traceId || !span.spanId) continue;
        const start = nano(span.startTimeUnixNano);
        const end = nano(span.endTimeUnixNano);
        const failed = span.status?.code === 2 || span.status?.code === 'STATUS_CODE_ERROR';
        a['agent.insight.framework'] = 'dify';
        a['agent.insight.status'] = failed ? 'error' : span.status?.code === 1 || span.status?.code === 'STATUS_CODE_OK' ? 'success' : 'unset';
        a['agent.insight.status_message'] = span.status?.message;
        a['dify.span.ended'] = end > 0 && end >= start;
        if (agentKind) {
          a['dify.trajectory'] = true;
          if (!failed && a['dify.span.ended']) a['agent.insight.status'] = 'success';
        }
        if (span.events?.length) a['dify.span.events'] = span.events;
        const count = (key: string) => Math.max(0, Number(a[key]) || 0);
        const input = count('gen_ai.usage.input_tokens');
        const output = count('gen_ai.usage.output_tokens');
        events.push({
          receivedAt: opts.receivedAt || new Date().toISOString(),
          framework: 'dify', sessionId: `dify:${span.traceId}`, traceId: span.traceId,
          spanId: span.spanId, parentSpanId: span.parentSpanId || undefined,
          name: span.name, kind: agentKind || (node === 'llm' ? 'llm' : node === 'tool' ? 'tool' : 'chain'),
          serviceName: resourceAttrs['service.name'] || 'langgenius/dify',
          user: opts.authenticatedUser, authenticatedUser: Boolean(opts.authenticatedUser),
          model: a['gen_ai.request.model'],
          usage: { input_tokens: input, output_tokens: output, total_tokens: count('gen_ai.usage.total_tokens') || input + output },
          startTimeMs: Number(start / BigInt(1_000_000)),
          latencyMs: end >= start ? Number((end - start) / BigInt(1_000_000)) : 0,
          attributes: a,
        });
      }
    }
  }
  return events;
}
