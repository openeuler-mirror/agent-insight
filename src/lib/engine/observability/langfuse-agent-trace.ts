import {
    langfuseSubagentSessionId,
    type LangfuseTraceNode,
} from '@/lib/ingest/otel/adapters/langfuse-trace';
import type {
    AgentEvent,
    AgentNode,
    AgentNodeStats,
    InteractionUsage,
    RawInteraction,
} from './agent-trace';

export interface LangfuseAgentTraceProjection {
    tree: AgentNode | null;
    interactions: RawInteraction[];
}

function emptyStats(): AgentNodeStats {
    return {
        interactions: 0,
        llmCalls: 0,
        toolCalls: 0,
        skillCalls: 0,
        taskCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        durationMs: undefined,
    };
}

function makeAgentNode(
    id: string,
    agentName: string,
    sessionId: string,
    parentId: string | null,
): AgentNode {
    return {
        id,
        agentName,
        subagentType: parentId ? agentName : null,
        sessionId,
        parentId,
        events: [],
        children: [],
        stats: emptyStats(),
        depth: 0,
        interactionIndices: [],
    };
}

function hasContent(value: unknown): boolean {
    if (value == null) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
}

function contentText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value == null) return '';
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

function userMessageText(value: unknown): string | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const message = value as Record<string, unknown>;
    const role = String(message.role ?? message.type ?? '').toLowerCase();
    if (role !== 'user' && role !== 'human') return undefined;
    return typeof message.content === 'string' && message.content.trim()
        ? message.content.trim()
        : undefined;
}

function lastUserMessage(value: unknown, depth = 0): string | undefined {
    if (value == null || depth > 8) return undefined;
    const direct = userMessageText(value);
    if (direct) return direct;
    if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index--) {
            const found = userMessageText(value[index]) || lastUserMessage(value[index], depth + 1);
            if (found) return found;
        }
        return undefined;
    }
    if (typeof value !== 'object') return undefined;
    const object = value as Record<string, unknown>;
    for (const key of ['history', 'messages']) {
        const found = lastUserMessage(object[key], depth + 1);
        if (found) return found;
    }
    for (const [key, child] of Object.entries(object)) {
        if (key === 'history' || key === 'messages') continue;
        const found = lastUserMessage(child, depth + 1);
        if (found) return found;
    }
    return undefined;
}

function namedQuestion(value: unknown, depth = 0): string | undefined {
    if (value == null || depth > 8 || typeof value !== 'object') return undefined;
    if (Array.isArray(value)) {
        for (const child of value) {
            const found = namedQuestion(child, depth + 1);
            if (found) return found;
        }
        return undefined;
    }
    const object = value as Record<string, unknown>;
    for (const key of ['question', 'query', 'user_input', 'userInput', 'prompt', 'input']) {
        const candidate = object[key];
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    for (const child of Object.values(object)) {
        const found = namedQuestion(child, depth + 1);
        if (found) return found;
    }
    return undefined;
}

export function extractLangfuseUserQuestion(nodes: LangfuseTraceNode[]): string | undefined {
    const ordered = [...nodes].sort((a, b) => a.startedAt - b.startedAt || a.spanId.localeCompare(b.spanId));
    const rootInputs = ordered.filter(node => !node.sourceParentSpanId).map(node => node.input);
    for (const input of rootInputs) {
        const found = lastUserMessage(input) || namedQuestion(input);
        if (found) return found;
    }
    for (const node of ordered) {
        if (node.kind !== 'llm') continue;
        const found = lastUserMessage(node.input) || namedQuestion(node.input);
        if (found) return found;
    }
    return undefined;
}

function usageFromNode(node: LangfuseTraceNode): InteractionUsage | undefined {
    if (!node.usage) return undefined;
    const input = node.usage.inputTokens || 0;
    const output = node.usage.outputTokens || 0;
    const reasoning = node.usage.reasoningTokens || 0;
    const total = node.usage.totalTokens ?? input + output + reasoning;
    if (!input && !output && !reasoning && !total) return undefined;
    return { input, output, reasoning, total };
}

function updateNodeBounds(host: AgentNode, startedAt: number, completedAt: number) {
    if (!host.startedAt || startedAt < host.startedAt) host.startedAt = startedAt;
    if (!host.endedAt || completedAt > host.endedAt) host.endedAt = completedAt;
}

function addUsage(host: AgentNode, usage: InteractionUsage | undefined) {
    if (!usage) return;
    host.stats.inputTokens += usage.input || 0;
    host.stats.outputTokens += usage.output || 0;
    host.stats.reasoningTokens += usage.reasoning || 0;
    host.stats.cacheReadTokens += usage.cache?.read || 0;
    host.stats.cacheWriteTokens += usage.cache?.write || 0;
    host.stats.totalTokens += usage.total || 0;
}

function finalizeNode(node: AgentNode, depth: number) {
    node.depth = depth;
    node.events.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0) || a.interactionIndex - b.interactionIndex);
    node.children.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0) || a.id.localeCompare(b.id));
    for (const child of node.children) finalizeNode(child, depth + 1);
    if (node.startedAt != null && node.endedAt != null) {
        node.stats.durationMs = Math.max(0, node.endedAt - node.startedAt);
    }
}

/**
 * Projects Langfuse observations into the established AgentTraceView model.
 * Visibility and wrapper collapsing are decided by the Langfuse adapter; this
 * layer only translates visible observations and never matches business names.
 */
export function buildLangfuseAgentTrace(
    sourceNodes: LangfuseTraceNode[],
    rootSessionId?: string,
): LangfuseAgentTraceProjection {
    const nodes = sourceNodes
        .filter(node => node.visibility === 'visible')
        .sort((a, b) => a.startedAt - b.startedAt || a.spanId.localeCompare(b.spanId));
    if (nodes.length === 0) return { tree: null, interactions: [] };

    const nodeBySpanId = new Map(nodes.map(node => [node.spanId, node]));
    const firstRoot = nodes.find(node => !node.displayParentSpanId) || nodes[0];
    const root = firstRoot.kind === 'agent'
        ? makeAgentNode(`lf-agent-${firstRoot.spanId}`, firstRoot.name, firstRoot.spanId, null)
        : makeAgentNode(`lf-root-${firstRoot.traceId}`, firstRoot.name || 'Langfuse', firstRoot.traceId, null);
    const agentBySpanId = new Map<string, AgentNode>();
    if (firstRoot.kind === 'agent') agentBySpanId.set(firstRoot.spanId, root);

    for (const observation of nodes) {
        if (observation.kind !== 'agent' || agentBySpanId.has(observation.spanId)) continue;
        const sessionId = observation.subagentSessionId
            || (rootSessionId ? langfuseSubagentSessionId(rootSessionId, observation.spanId) : observation.spanId);
        agentBySpanId.set(
            observation.spanId,
            makeAgentNode(`lf-agent-${observation.spanId}`, observation.name, sessionId, root.id),
        );
    }

    const nearestAgent = (observation: LangfuseTraceNode): AgentNode => {
        let parentId = observation.displayParentSpanId;
        const seen = new Set<string>();
        while (parentId && !seen.has(parentId)) {
            seen.add(parentId);
            const agent = agentBySpanId.get(parentId);
            if (agent) return agent;
            parentId = nodeBySpanId.get(parentId)?.displayParentSpanId || null;
        }
        return root;
    };

    for (const observation of nodes) {
        if (observation.kind !== 'agent' || observation.spanId === firstRoot.spanId) continue;
        const child = agentBySpanId.get(observation.spanId)!;
        const parent = nearestAgent(observation);
        child.parentId = parent.id;
        child.subagentType = observation.name;
        parent.children.push(child);
    }

    const interactions: RawInteraction[] = [];
    const addInteraction = (host: AgentNode, interaction: RawInteraction): number => {
        const index = interactions.push(interaction) - 1;
        host.interactionIndices.push(index);
        return index;
    };

    const addObservationEvent = (
        host: AgentNode,
        observation: LangfuseTraceNode,
        spawnedChildId?: string,
    ) => {
        if (observation.kind === 'llm' && hasContent(observation.input)) {
            addInteraction(host, {
                role: 'user',
                content: contentText(observation.input),
                timestamp: observation.startedAt,
                timeInfo: { created: observation.startedAt, completed: observation.startedAt },
                agent: host.agentName,
            });
        }

        const usage = usageFromNode(observation);
        const interaction: RawInteraction = {
            role: observation.kind === 'tool' ? 'opencode' : 'assistant',
            content: contentText(observation.output),
            timestamp: observation.startedAt,
            timeInfo: { created: observation.startedAt, completed: observation.completedAt },
            agent: host.agentName,
            model: observation.model,
            usage,
        };
        const interactionIndex = addInteraction(host, interaction);
        const kind: AgentEvent['kind'] = observation.kind === 'llm'
            ? 'llm'
            : observation.kind === 'tool'
                ? 'tool'
                : observation.kind === 'chain' || observation.kind === 'span'
                    ? 'chain'
                    : 'task';
        const visibleParent = observation.displayParentSpanId
            ? nodeBySpanId.get(observation.displayParentSpanId)
            : undefined;
        const parentSourceSpanId = visibleParent
            && visibleParent.kind !== 'agent'
            && nearestAgent(visibleParent).id === host.id
            ? visibleParent.spanId
            : undefined;
        const event: AgentEvent = {
            kind,
            name: observation.name,
            args: observation.input,
            output: observation.output,
            toolCallId: observation.toolCallId || observation.spanId,
            toolStatus: observation.status,
            startedAt: observation.startedAt,
            completedAt: observation.completedAt,
            interaction,
            interactionIndex,
            spawnedChildId,
            sourceSpanId: observation.spanId,
            parentSourceSpanId,
            treeHidden: observation.kind === 'agent' && !!spawnedChildId,
            summary: observation.name,
            usage,
        };
        host.events.push(event);
        host.stats.interactions++;
        if (kind === 'llm') host.stats.llmCalls++;
        else if (kind === 'tool') host.stats.toolCalls++;
        else if (spawnedChildId && observation.kind !== 'agent') host.stats.taskCalls++;
        addUsage(host, usage);
        updateNodeBounds(host, observation.startedAt, observation.completedAt);
    };

    const userQuestion = extractLangfuseUserQuestion(nodes);
    if (userQuestion) {
        const interaction: RawInteraction = {
            role: 'user',
            content: userQuestion,
            timestamp: firstRoot.startedAt,
            timeInfo: { created: firstRoot.startedAt, completed: firstRoot.startedAt },
            agent: root.agentName,
        };
        const interactionIndex = addInteraction(root, interaction);
        root.events.push({
            kind: 'user',
            interaction,
            interactionIndex,
            startedAt: firstRoot.startedAt,
            completedAt: firstRoot.startedAt,
            summary: userQuestion,
        });
        root.stats.interactions++;
    }

    for (const observation of nodes) {
        if (observation.kind === 'agent') {
            const agent = agentBySpanId.get(observation.spanId)!;
            updateNodeBounds(agent, observation.startedAt, observation.completedAt);
            if (agent !== root) addObservationEvent(nearestAgent(observation), observation, agent.id);
            else if (hasContent(observation.input) || hasContent(observation.output)) addObservationEvent(agent, observation);
            continue;
        }
        addObservationEvent(nearestAgent(observation), observation);
    }

    const overallStart = Math.min(...nodes.map(node => node.startedAt));
    const overallEnd = Math.max(...nodes.map(node => node.completedAt));
    updateNodeBounds(root, overallStart, overallEnd);
    finalizeNode(root, 0);
    return { tree: root, interactions };
}
