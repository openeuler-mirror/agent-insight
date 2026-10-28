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

import type { AgentNode, RawInteraction } from '@/lib/engine/observability/agent-trace';
import { collaborationSource } from '@/lib/collaboration/display-tree';

export type AgentRelationStats = { durationMs?: number; totalTokens?: number };

export type ParentAgentReference = {
    state: 'resolved';
    taskId: string;
    executionId?: string;
    agentName: string;
    framework?: string | null;
    stats?: AgentRelationStats;
    reported?: boolean;
} | { state: 'pending' | 'ambiguous' | 'unavailable' };

export type ChildAgentReference = ParentAgentReference & { nodeId?: string; subagentType?: string | null };
export type AgentTraceRelations = { parent: ParentAgentReference | null; children: ChildAgentReference[]; unavailable?: boolean };
export type TraceRelations = Record<string, AgentTraceRelations>;

export function selectedParentAgent(
    node: AgentNode,
    root: AgentNode,
    nodes: ReadonlyMap<string, AgentNode>,
    interactions: RawInteraction[],
    rootSessionId?: string,
    externalParent?: ParentAgentReference | null,
    relations?: TraceRelations,
): ParentAgentReference | null {
    if (node.sessionId === 'COLLABORATION') return null;
    const taskIdForNode = node === root ? rootSessionId : node.sessionId;
    if (taskIdForNode && relations?.[taskIdForNode]) return relations[taskIdForNode].parent;
    if (node === root || (rootSessionId && node.sessionId === rootSessionId)) return externalParent ?? null;
    const source = node.interactionIndices.map(index => collaborationSource(interactions[index]))
        .find(item => item?.taskId === node.sessionId);
    if (source) {
        if (!source.parent) return null;
        const parent = [...nodes.values()].find(item => item.sessionId === source.parent);
        return parent ? { state: 'resolved', taskId: source.parent, agentName: parent.agentName } : { state: 'pending' };
    }
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    const taskId = parent === root ? rootSessionId : parent?.sessionId;
    return parent && parent.sessionId !== 'COLLABORATION' && taskId ? { state: 'resolved', taskId, agentName: parent.agentName } : null;
}

export function selectedChildAgents(
    node: AgentNode, root: AgentNode, nodes: ReadonlyMap<string, AgentNode>,
    interactions: RawInteraction[], rootSessionId?: string, relations?: TraceRelations,
): ChildAgentReference[] {
    const taskId = node === root ? rootSessionId : node.sessionId;
    const virtual = node.sessionId === 'COLLABORATION';
    const indexed = !virtual && taskId ? relations?.[taskId]?.children : undefined;
    const sourceFor = (item: AgentNode) => item.interactionIndices.map(index => collaborationSource(interactions[index]))
        .find(source => source?.taskId === item.sessionId);
    const fromNode = (child: AgentNode): ChildAgentReference => ({
        state: 'resolved', taskId: child.sessionId ?? '', nodeId: child.id, agentName: child.agentName, subagentType: child.subagentType,
        stats: { durationMs: child.stats.durationMs, totalTokens: child.stats.totalTokens },
        ...(sourceFor(child)?.sequential ? { reported: true } : {}),
    });
    if (virtual) return node.children.map(fromNode);
    const children: ChildAgentReference[] = indexed ? indexed.map(child => {
        const childNode = child.state === 'resolved' ? [...nodes.values()].find(item => item.sessionId === child.taskId) : undefined;
        return childNode ? { ...child, nodeId: childNode.id, subagentType: childNode.subagentType } : child;
    }) : [...nodes.values()].filter(child => taskId && sourceFor(child)?.parent === taskId).map(fromNode);
    for (const child of node.children) {
        if (sourceFor(child)) continue;
        if (children.some(item => item.state === 'resolved' && child.sessionId && item.taskId === child.sessionId)) continue;
        children.push(fromNode(child));
    }
    return children;
}

export function traceRelationsPending(session?: { parentAgent?: ParentAgentReference | null; traceRelations?: TraceRelations } | null): boolean {
    const waiting = (reference?: ParentAgentReference | null) => reference?.state === 'pending' || reference?.state === 'unavailable';
    return waiting(session?.parentAgent) || Object.values(session?.traceRelations ?? {}).some(relation =>
        relation.unavailable || waiting(relation.parent) || relation.children.some(waiting));
}
