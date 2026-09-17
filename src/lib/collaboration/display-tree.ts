import { buildAgentCallTree, type AgentNode, type RawInteraction } from '../engine/observability/agent-trace';
import type { Anchor } from './resolve';

export interface CollaborationSource {
    taskId: string;
    index: number;
    version: string;
    parent?: string;
    sequential?: boolean;
    order?: string;
    anchor?: Anchor;
}
export function collaborationSource(item: unknown): CollaborationSource | undefined {
    return (item as { _collaboration?: CollaborationSource } | undefined)?._collaboration;
}
export function sameCollaborationSource(a: unknown, b: unknown): boolean {
    return JSON.stringify(collaborationSource(a)) === JSON.stringify(collaborationSource(b));
}

export function buildCollaborationTraceTree(interactions: RawInteraction[]): AgentNode | null {
    if (!interactions.some(collaborationSource)) return buildAgentCallTree(interactions);
    const groups = new Map<string, { source: CollaborationSource; items: RawInteraction[]; indices: number[]; tree?: AgentNode }>();
    interactions.forEach((item, index) => {
        const source = collaborationSource(item);
        if (!source) return;
        const group = groups.get(source.taskId) ?? { source, items: [], indices: [] };
        group.items.push(item); group.indices.push(index); groups.set(source.taskId, group);
    });
    for (const [id, group] of groups) {
        const tree = buildAgentCallTree(group.items);
        if (!tree) continue;
        const scope = (value: string) => `${encodeURIComponent(id)}:${value}`;
        const remap = (node: AgentNode) => {
            node.id = scope(node.id);
            if (node.parentId) node.parentId = scope(node.parentId);
            node.interactionIndices = node.interactionIndices.map(index => group.indices[index]);
            for (const event of node.events) {
                event.interactionIndex = group.indices[event.interactionIndex];
                if (event.spawnedChildId) event.spawnedChildId = scope(event.spawnedChildId);
            }
            for (const boundary of node.compactions ?? []) boundary.interactionIndex = group.indices[boundary.interactionIndex];
            node.children.forEach(remap);
        };
        remap(tree);
        tree.sessionId = id;
        group.tree = tree;
    }
    const root = groups.values().next().value?.tree;
    if (!root) return null;
    const parallelRoots = [root];
    for (const group of groups.values()) {
        const child = group.tree;
        const parentGroup = group.source.parent ? groups.get(group.source.parent) : undefined;
        if (!child || !parentGroup?.tree) continue;
        if (group.source.sequential) {
            parallelRoots.push(child);
            Object.assign(child, { collaborationLabel: '上报关联 · 顺序展示', collaborationReason: '未提供 fromLocator，按上报顺序并列展示' });
            continue;
        }
        const anchor = group.source.anchor;
        const position = anchor?.position ?? (anchor?.status === 'candidate' && anchor.candidates?.length === 1 ? anchor.candidates[0] : undefined);
        let parent = parentGroup.tree;
        let matched: AgentNode['events'][number] | undefined;
        const visit = (node: AgentNode) => {
            const candidates = node.events.filter(event => event.interactionIndex === parentGroup.indices[position?.interactionIndex ?? -1] && event.kind !== 'llm' && event.kind !== 'user');
            const recordId = anchor?.matchedRecord?.recordId ?? (anchor?.status === 'candidate' ? anchor.candidates?.[0]?.recordId : undefined);
            const match = recordId ? candidates.find(event => event.toolCallId === recordId) : candidates[position?.callIndex ?? -1];
            if (match && !match.spawnedChildId) { matched = match; parent = node; }
            node.children.forEach(visit);
        };
        if (position) visit(parent);
        parent.children.push(child); child.parentId = parent.id;
        if (matched) matched.spawnedChildId = child.id;
        const labels: Record<string, string> = { confirmed: '明确调用', time_ordered: '按时间推定', candidate: '候选步骤' };
        Object.assign(child, { collaborationLabel: `上报关联 · ${matched ? labels[anchor?.status ?? ''] ?? '未定位' : '未定位到步骤'}`, collaborationReason: anchor?.message });
    }
    const depth = (node: AgentNode, level: number) => { node.depth = level; node.children.forEach(child => depth(child, level + 1)); };
    const orders = new Map([...groups.values()].flatMap(group => group.tree ? [[group.tree.id, Date.parse(group.source.order ?? '') || 0] as const] : []));
    parallelRoots.splice(1, parallelRoots.length - 1, ...parallelRoots.slice(1).sort((a, b) => (orders.get(a.id) ?? 0) - (orders.get(b.id) ?? 0)));
    const displayRoot: AgentNode = parallelRoots.length === 1 ? root : {
        id: 'collaboration-trace', agentName: '协作 Trace', subagentType: null, sessionId: 'COLLABORATION',
        parentId: null, events: [], children: parallelRoots, depth: 0, interactionIndices: [],
        stats: { interactions: 0, llmCalls: 0, toolCalls: 0, skillCalls: 0, taskCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 },
    };
    if (displayRoot !== root) {
        parallelRoots.forEach(node => { node.parentId = displayRoot.id; });
        const starts = parallelRoots.flatMap(node => node.startedAt == null ? [] : [node.startedAt]);
        const ends = parallelRoots.flatMap(node => node.endedAt == null ? [] : [node.endedAt]);
        if (starts.length) displayRoot.startedAt = Math.min(...starts);
        if (ends.length) displayRoot.endedAt = Math.max(...ends);
        if (displayRoot.startedAt != null && displayRoot.endedAt != null) displayRoot.stats.durationMs = Math.max(0, displayRoot.endedAt - displayRoot.startedAt);
    }
    depth(displayRoot, 0);
    return displayRoot;
}
