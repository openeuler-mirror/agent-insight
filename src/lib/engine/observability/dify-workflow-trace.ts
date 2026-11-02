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

import type { DifyTraceContext, LangfuseTraceNode } from '@/lib/ingest/otel/adapters/langfuse-trace';

export const DIFY_TRACE_MEMBER_BYTES = 4 * 1024 * 1024;
export const DIFY_TRACE_PROJECTION_BYTES = 16 * 1024 * 1024;

export interface DifyTraceMember {
  taskId: string;
  user: string;
  nodes: LangfuseTraceNode[];
}

export function difyExecutionKey(context?: DifyTraceContext): string | undefined {
  if (!context?.tenantId || !context.appId || !context.nodeExecutionId) return undefined;
  return JSON.stringify([context.tenantId, context.appId, context.nodeExecutionId]);
}

function compatible(a: DifyTraceContext, b: DifyTraceContext): boolean {
  return difyExecutionKey(a) === difyExecutionKey(b)
    && (!a.workflowRunId || !b.workflowRunId || a.workflowRunId === b.workflowRunId)
    && (!a.workflowId || !b.workflowId || a.workflowId === b.workflowId)
    && (!a.nodeId || !b.nodeId || a.nodeId === b.nodeId);
}

function qualify(nodes: LangfuseTraceNode[]): LangfuseTraceNode[] {
  const key = (node: LangfuseTraceNode, id: string) => `${node.traceId}:${id}`;
  return nodes.map(node => ({
    ...node,
    spanId: key(node, node.spanId),
    displayParentSpanId: node.displayParentSpanId ? key(node, node.displayParentSpanId) : null,
    linkedGenerationSpanId: node.linkedGenerationSpanId ? key(node, node.linkedGenerationSpanId) : undefined,
  }));
}

export function composeDifyWorkflowTrace(user: string, outer: LangfuseTraceNode[], members: DifyTraceMember[]) {
  const anchors = new Map<string, LangfuseTraceNode[]>();
  for (const node of outer) {
    if (node.dify?.trajectory) continue;
    const key = difyExecutionKey(node.dify);
    if (key) anchors.set(key, [...(anchors.get(key) || []), node]);
  }
  const linked: Array<{ anchor: LangfuseTraceNode; member: DifyTraceMember; root: LangfuseTraceNode }> = [];
  const seen = new Set<string>();
  let truncated = false;
  let nodeCount = outer.length;
  let payloadBytes = 0;
  for (const member of members) {
    if (!user || member.user !== user || seen.has(member.taskId)) continue;
    seen.add(member.taskId);
    const ids = new Set(member.nodes.map(n => n.spanId));
    const roots = member.nodes.filter(n => n.kind === 'agent' && (!n.displayParentSpanId || !ids.has(n.displayParentSpanId)));
    if (roots.length !== 1) continue;
    const root = roots[0];
    const key = difyExecutionKey(root.dify);
    const matching = key ? anchors.get(key) : undefined;
    if (!root.dify?.trajectory || matching?.length !== 1 || member.taskId !== `dify:${root.traceId}`) continue;
    const anchor = matching[0];
    if (!compatible(anchor.dify!, root.dify)) continue;
    if (member.nodes.some(n => n.traceId !== root.traceId || !n.dify?.trajectory || !compatible(root.dify!, n.dify))) continue;
    const bytes = new TextEncoder().encode(JSON.stringify(member.nodes)).byteLength;
    if (bytes > DIFY_TRACE_MEMBER_BYTES || payloadBytes + bytes > DIFY_TRACE_PROJECTION_BYTES) { truncated = true; continue; }
    if (nodeCount + member.nodes.length > 5000) { truncated = true; continue; }
    nodeCount += member.nodes.length;
    payloadBytes += bytes;
    linked.push({ anchor, member, root });
  }
  if (!linked.length) return { nodes: outer, linkedTraces: 0, truncated };
  const nodes = qualify(outer);
  for (const { anchor, member, root } of linked) {
    const qualified = qualify(member.nodes);
    const agent = qualified.find(n => n.spanId === `${root.traceId}:${root.spanId}`)!;
    agent.displayParentSpanId = `${anchor.traceId}:${anchor.spanId}`;
    agent.subagentSessionId = member.taskId;
    nodes.push(...qualified);
  }
  return { nodes, linkedTraces: linked.length, truncated };
}
