import type { AgentNode, RawInteraction } from '@/lib/engine/observability/agent-trace';
import { collaborationSource } from '@/lib/collaboration/display-tree';

export type ParentAgentReference = {
    state: 'resolved';
    taskId: string;
    executionId?: string;
    agentName: string;
    framework?: string | null;
} | { state: 'pending' | 'ambiguous' | 'unavailable' };

export function selectedParentAgent(
    node: AgentNode,
    root: AgentNode,
    nodes: ReadonlyMap<string, AgentNode>,
    interactions: RawInteraction[],
    rootSessionId?: string,
    externalParent?: ParentAgentReference | null,
): ParentAgentReference | null {
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
    return parent && taskId ? { state: 'resolved', taskId, agentName: parent.agentName } : null;
}
