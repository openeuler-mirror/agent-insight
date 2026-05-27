/**
 * Agent Trace — 把 OpenCode 上传的 interaction 序列还原为多 Agent 调用树。
 *
 * 类型设计与 OpenTelemetry GenAI semconv 概念对齐：
 *   AgentInvocation ≈ invoke_agent span
 *   ToolInvocation  ≈ execute_tool span
 *   SkillInvocation ≈ execute_tool with name='skill' (sub-kind)
 * 当后续上传层切换到 OTel GenAI 规范时，本模块可平滑替换底层适配器，
 * 上层 UI 组件（AgentTraceView）无需感知。
 */

export type InteractionRole = 'user' | 'assistant' | 'opencode' | 'subagent' | string;

export interface InteractionUsage {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
}

export interface ToolCall {
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
    name?: string;
    arguments?: string;
    state?: string;
    timing?: { started_at?: number; completed_at?: number };
    output?: any;
    result?: any;
    trace_split_parallel_task?: boolean;
}

/** Structured part of an opencode message — preserved verbatim by the uploader
 *  so downstream can distinguish text / reasoning / tool / patch / step-* / compaction. */
export interface InteractionPart {
    type: string;
    id?: string;
    text?: string;
    tool?: string;
    callID?: string;
    state?: { status?: string; input?: unknown; output?: unknown; [k: string]: unknown };
    [k: string]: unknown;
}

export interface RawInteraction {
    role: InteractionRole;
    content?: string;
    timestamp?: number | string;
    timeInfo?: { created?: number | string; completed?: number | string };
    agent?: string;
    subagent_name?: string;
    subagent_session_id?: string;
    tool_calls?: ToolCall[];
    usage?: InteractionUsage;
    // LLM request parameters (present when captured via proxy or enriched SDK)
    model?: string;
    modelID?: string;
    model_id?: string;
    provider?: string;
    providerID?: string;
    temperature?: number;
    max_tokens?: number;
    maxTokens?: number;
    top_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    stop?: string | string[];
    // LLM response metadata
    finish_reason?: string;
    stop_reason?: string;
    latency?: number;
    // OpenCode-specific message metadata (added by uploader on top of the wire payload):
    //   mode === 'compaction' + summary === true  →  compaction-summary message
    //   parts: [{ type: 'compaction' }]            →  compaction-trigger user message
    mode?: string;
    summary?: boolean;
    finish?: string;
    variant?: string | null;
    parts?: InteractionPart[];
}

export type CallKind = 'llm' | 'tool' | 'skill' | 'task' | 'user';

export interface AgentEvent {
    kind: CallKind;
    /** Tool / skill name when kind != 'llm'/'user' */
    name?: string;
    /** Raw arguments for tool/skill (parsed JSON if possible) */
    args?: any;
    /** Output / result if recorded on the same interaction */
    output?: any;
    /** ms since epoch */
    startedAt?: number;
    completedAt?: number;
    /** Backref to the underlying interaction (read-only) */
    interaction: RawInteraction;
    /** Index of the parent interaction in the original array */
    interactionIndex: number;
    /** When kind === 'task', the spawned child node id (filled during build) */
    spawnedChildId?: string;
    /** Free-form summary text shown in the right panel */
    summary?: string;
    /** Token usage attached to this event (only meaningful for llm/task) */
    usage?: InteractionUsage;
}

export interface AgentNodeStats {
    interactions: number;
    llmCalls: number;
    toolCalls: number;
    skillCalls: number;
    taskCalls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    durationMs?: number;
}

export interface AgentNode {
    /** Unique node id within the tree */
    id: string;
    /** Display name of the agent (e.g. "Kuafu (General Diagnostic Executor)") */
    agentName: string;
    /** subagent_type from the spawning task call (e.g. "kuafu"), null for root */
    subagentType: string | null;
    /** OpenCode session id this slice belongs to. Top-level uses 'TOP' */
    sessionId: string;
    /** Parent node id, or null for root */
    parentId: string | null;
    /** When this slice started (first event ts) */
    startedAt?: number;
    /** When this slice ended (last event ts) */
    endedAt?: number;
    /** Sequential events that happened inside this agent */
    events: AgentEvent[];
    /** Direct child nodes (in chronological order of spawn) */
    children: AgentNode[];
    /** Aggregated stats */
    stats: AgentNodeStats;
    /** Depth in the tree (root = 0) */
    depth: number;
    /** Indices of original interactions covered by this slice */
    interactionIndices: number[];
    /** Number of parallel task() calls in the parent interaction that spawned this node (>=1) */
    parallelCallCount?: number;
    /** System prompts attached to this agent (collected from role="system" interactions) */
    systemPrompts?: SystemPromptEntry[];
    /** Compaction boundaries inside this slice, chronological. LLM calls whose
     *  interactionIndex is greater than `compactions[k].interactionIndex` saw
     *  the summary of compaction k (and not the original prior context). */
    compactions?: CompactionBoundary[];
}

export interface SystemPromptEntry {
    text: string;
    sha256?: string;
    length?: number;
    modelID?: string;
    providerID?: string;
}

/** A point in the interaction stream where opencode replaced prior context with
 *  a synthetic summary message. LLM calls *after* this index in the same node
 *  saw the summary instead of the original prior messages.
 *
 *  Detection signal: assistant/subagent message with `mode === 'compaction'`
 *  AND `summary === true`. The immediately preceding user/opencode message
 *  that carries a `parts[].type === 'compaction'` marker is the trigger; it
 *  carries no semantic content and is excluded from the node entirely. */
export interface CompactionBoundary {
    /** Index of the compaction-summary message in the original interactions array. */
    interactionIndex: number;
    /** Concatenated text of all text-parts on the summary message — what the model now sees. */
    summaryText: string;
    /** Concatenated reasoning-part text — the planning the compaction model did. */
    reasoningText?: string;
    /** Model used to produce the compaction (often different from the agent's main model). */
    modelID?: string;
    providerID?: string;
    /** When the compaction happened. */
    startedAt?: number;
    completedAt?: number;
    /** Token cost of the compaction itself. */
    usage?: InteractionUsage;
}

/**
 * Build a hierarchical agent call tree from a flat interaction array.
 *
 * Strategy:
 *   1. Walk interactions in order. Each interaction has an `agent` and possibly
 *      a `subagent_session_id` (the OpenCode session id of the agent currently
 *      producing this turn).
 *   2. The "current node" is determined by (agent, sessionId). When we see a
 *      `task` tool call, we *open* a pending child slot waiting for the next
 *      interaction with the matching subagent_type/session.
 *   3. Each call to `task` creates a brand-new child node — even if a previous
 *      call to the same subagent reused the same session id (this matches the
 *      product requirement: 4 calls to Dayu = 4 parallel nodes, not one).
 *   4. Tool calls / skill calls / LLM responses become events on the current node.
 */
export function buildAgentCallTree(interactions: RawInteraction[]): AgentNode | null {
    if (!interactions || interactions.length === 0) return null;

    let nodeIdCounter = 0;
    const nextId = () => `n${++nodeIdCounter}`;

    const rootAgentName = interactions.find(i => i.agent)?.agent || 'Agent';
    const root: AgentNode = makeNode({
        id: nextId(),
        agentName: rootAgentName,
        subagentType: null,
        sessionId: 'TOP',
        parentId: null,
        depth: 0,
    });

    /**
     * In OpenCode, a child agent's session_id can be re-visited across multiple
     * parent task() invocations — the runtime persists the child session and
     * re-uses it for follow-up calls. We treat each *parent task interaction*
     * (the LLM turn that issued one or more task() calls of a given type) as a
     * separate spawn boundary, producing a fresh child node. Within one parent
     * interaction, parallel task() calls of the same subagent_type collapse
     * into a single spawn (we can't reliably split a shared session by which
     * parallel call drove which inner step).
     */
    interface PendingTask {
        parentNode: AgentNode;
        subagentType: string;
        startedAt?: number;
        /** Spawn events from the same parent interaction that share this claim */
        spawnEvents: AgentEvent[];
        /** Number of parallel task() calls collapsed into this spawn */
        parallelCount: number;
        /** Original parent interaction index — used to detect spawn boundary */
        parentInteractionIndex: number;
    }

    /** Pending task spawns waiting for their first subagent interaction */
    const pendingByType = new Map<string, PendingTask[]>();

    /** session_id → active child node currently receiving interactions */
    const sessionToNode = new Map<string, AgentNode>();
    sessionToNode.set('TOP', root);

    /** subagent_session_id → buffered system prompts waiting for node creation */
    const pendingSysPrompts = new Map<string, SystemPromptEntry[]>();

    function attachSystemPrompts(host: AgentNode, sid: string) {
        const buf = pendingSysPrompts.get(sid);
        if (!buf || !buf.length) return;
        if (!host.systemPrompts) host.systemPrompts = [];
        for (const entry of buf) {
            const dup = host.systemPrompts.some(s =>
                (entry.sha256 && s.sha256 === entry.sha256) ||
                (!entry.sha256 && s.text === entry.text),
            );
            if (!dup) host.systemPrompts.push(entry);
        }
        pendingSysPrompts.delete(sid);
    }

    for (let idx = 0; idx < interactions.length; idx++) {
        const it = interactions[idx];

        // System prompts (role === 'system') are metadata, not events.
        // Stash on the appropriate node's `systemPrompts`. If the sub-agent's
        // node hasn't been created yet (system prompt comes before the first
        // non-system interaction in the sub-session slice), buffer it; the
        // buffer is drained when the node is born.
        if (it.role === 'system') {
            const entry: SystemPromptEntry = {
                text: it.content || '',
                sha256: (it as any).system_prompt_sha256,
                length: (it as any).system_prompt_length,
                modelID: (it as any).system_prompt_modelID,
                providerID: (it as any).system_prompt_providerID,
            };
            if (!entry.text) continue;
            const subSid = it.subagent_session_id;
            if (!subSid) {
                // root system prompt
                if (!root.systemPrompts) root.systemPrompts = [];
                const dup = root.systemPrompts.some(s =>
                    (entry.sha256 && s.sha256 === entry.sha256) ||
                    (!entry.sha256 && s.text === entry.text),
                );
                if (!dup) root.systemPrompts.push(entry);
            } else if (sessionToNode.has(subSid)) {
                const host = sessionToNode.get(subSid)!;
                if (!host.systemPrompts) host.systemPrompts = [];
                const dup = host.systemPrompts.some(s =>
                    (entry.sha256 && s.sha256 === entry.sha256) ||
                    (!entry.sha256 && s.text === entry.text),
                );
                if (!dup) host.systemPrompts.push(entry);
            } else {
                // Node not yet created — buffer until birth.
                if (!pendingSysPrompts.has(subSid)) pendingSysPrompts.set(subSid, []);
                pendingSysPrompts.get(subSid)!.push(entry);
            }
            continue;
        }

        const isSub = it.role === 'subagent' && !!it.subagent_session_id;
        const sid = isSub ? (it.subagent_session_id as string) : 'TOP';
        const agentName = it.agent || (isSub ? (it.subagent_name || 'Subagent') : rootAgentName);

        let host: AgentNode | undefined;

        if (isSub) {
            const sType = inferSubagentType(it);
            const queue = (sType && pendingByType.get(sType)) || [];
            const claim = queue.length > 0 ? queue[0] : undefined;

            if (claim) {
                // A pending spawn exists for this subagent_type → start a fresh
                // node (even if the session_id was seen before — this is a new
                // logical invocation from the parent).
                queue.shift();
                const parent = claim.parentNode;
                host = makeNode({
                    id: nextId(),
                    agentName,
                    subagentType: sType,
                    sessionId: sid,
                    parentId: parent.id,
                    depth: parent.depth + 1,
                });
                (host as AgentNode).parallelCallCount = claim.parallelCount;
                parent.children.push(host);
                sessionToNode.set(sid, host); // rebind: subsequent same-sid interactions extend this newest slice
                if (claim.spawnEvents[0]) claim.spawnEvents[0].spawnedChildId = host.id;
                if (claim.startedAt && !host.startedAt) host.startedAt = claim.startedAt;
                attachSystemPrompts(host, sid);
            } else {
                // No pending claim — extend the existing slice for this session
                host = sessionToNode.get(sid);
            }
        } else {
            host = sessionToNode.get(sid) || root;
        }

        // Defensive: still no host → fall back to root
        if (!host) host = root;

        // Compaction trigger: an opencode/user/subagent message whose entire
        // payload is just a `parts: [{type:'compaction'}]` marker. It has no
        // semantic content for any LLM call — drop it from the node entirely
        // so the timeline doesn't show an empty turn.
        if (isCompactionTrigger(it)) {
            continue;
        }

        // Time + token aggregation always runs (compaction has real cost the
        // user paid for, and we want the node's startedAt/endedAt to span it).
        const startedAt = interactionStartedAt(it);
        const completedAt = interactionCompletedAt(it) ?? startedAt;
        if (startedAt != null && (!host.startedAt || startedAt < host.startedAt)) host.startedAt = startedAt;
        if (completedAt != null && (!host.endedAt || completedAt > host.endedAt)) host.endedAt = completedAt;

        const u = it.usage;
        if (u) {
            host.stats.inputTokens += u.input || 0;
            host.stats.outputTokens += u.output || 0;
            host.stats.cacheReadTokens += u.cache?.read || 0;
            host.stats.cacheWriteTokens += u.cache?.write || 0;
            host.stats.reasoningTokens += u.reasoning || 0;
            host.stats.totalTokens += u.total || 0;
        }

        // Compaction summary: attach as boundary metadata, then bail before
        // we add it to interactionIndices / events / stats.interactions.
        // Compaction is a system action, not an agent step — we don't want it
        // showing up in the timeline or skewing per-node interaction counts.
        // The Input (Prompt) panel reads `node.compactions` directly to fold
        // prior context behind the summary.
        if (isCompactionSummary(it)) {
            const boundary: CompactionBoundary = {
                interactionIndex: idx,
                summaryText: extractPartsText(it.parts, 'text'),
                reasoningText: extractPartsText(it.parts, 'reasoning') || undefined,
                modelID: it.modelID,
                providerID: it.providerID,
                startedAt,
                completedAt,
                usage: it.usage,
            };
            if (!host.compactions) host.compactions = [];
            host.compactions.push(boundary);
            continue;
        }

        // Record this interaction on host (regular path)
        host.interactionIndices.push(idx);
        host.stats.interactions++;
        if (host.agentName === 'Agent' && agentName) host.agentName = agentName;

        // Convert this interaction into events
        const events = interactionToEvents(it, idx);

        // Group parallel task() calls in this same interaction by subagent_type
        // so they collapse into a single spawn (one child node).
        const taskGroupsByType = new Map<string, AgentEvent[]>();
        const addPendingTask = (sType: string, groupEvents: AgentEvent[]) => {
            const arr = pendingByType.get(sType) || [];
            arr.push({
                parentNode: host,
                subagentType: sType,
                startedAt: groupEvents[0]?.startedAt,
                spawnEvents: groupEvents,
                parallelCount: groupEvents.length,
                parentInteractionIndex: idx,
            });
            pendingByType.set(sType, arr);
        };

        for (const ev of events) {
            host.events.push(ev);
            if (ev.kind === 'llm') host.stats.llmCalls++;
            else if (ev.kind === 'skill') host.stats.skillCalls++;
            else if (ev.kind === 'task') {
                host.stats.taskCalls++;
                const sType = ev.args?.subagent_type || ev.args?.subagentType;
                if (sType) {
                    if ((ev as any).splitParallelTask) {
                        addPendingTask(sType, [ev]);
                    } else {
                        const g = taskGroupsByType.get(sType) || [];
                        g.push(ev);
                        taskGroupsByType.set(sType, g);
                    }
                }
            } else if (ev.kind === 'tool') host.stats.toolCalls++;
        }

        for (const [sType, groupEvents] of taskGroupsByType) {
            addPendingTask(sType, groupEvents);
        }
    }

    // Compute durations
    finalizeStats(root);
    return root;
}

function makeNode(init: {
    id: string;
    agentName: string;
    subagentType: string | null;
    sessionId: string;
    parentId: string | null;
    depth: number;
}): AgentNode {
    return {
        ...init,
        events: [],
        children: [],
        startedAt: undefined,
        endedAt: undefined,
        stats: {
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
        },
        interactionIndices: [],
    };
}

function finalizeStats(node: AgentNode): void {
    if (Number.isFinite(node.startedAt) && Number.isFinite(node.endedAt)) {
        const duration = (node.endedAt as number) - (node.startedAt as number);
        node.stats.durationMs = duration >= 0 ? duration : undefined;
    }
    for (const c of node.children) finalizeStats(c);
}

function interactionToEvents(it: RawInteraction, idx: number): AgentEvent[] {
    const out: AgentEvent[] = [];
    const baseTs = interactionStartedAt(it);
    const completedAt = interactionCompletedAt(it);

    const calls = dedupeToolCalls(it.tool_calls || []);

    // user message → user event
    if (it.role === 'user' && (it.content || '').trim()) {
        out.push({
            kind: 'user',
            interaction: it,
            interactionIndex: idx,
            startedAt: baseTs,
            completedAt,
            summary: it.content || '',
        });
    }

    if (calls.length === 0) {
        // Pure LLM/text response with no tool calls — emit an llm event if there's content
        if ((it.role === 'assistant' || it.role === 'subagent' || it.role === 'opencode') && (it.content || '').trim()) {
            out.push({
                kind: 'llm',
                interaction: it,
                interactionIndex: idx,
                startedAt: baseTs,
                completedAt,
                summary: it.content || '',
                usage: it.usage,
            });
        }
        return out;
    }

    // First, if there's textual reasoning content alongside tool calls, emit it as llm
    if ((it.content || '').trim()) {
        out.push({
            kind: 'llm',
            interaction: it,
            interactionIndex: idx,
            startedAt: baseTs,
            completedAt,
            summary: it.content || '',
            usage: it.usage,
        });
    }

    for (const tc of calls) {
        const name = tc.function?.name || tc.name || 'unknown';
        const argStr = tc.function?.arguments ?? tc.arguments;
        let args: any = undefined;
        if (typeof argStr === 'string') {
            try {
                args = JSON.parse(argStr);
            } catch {
                args = argStr;
            }
        } else {
            args = argStr;
        }

        const kind: CallKind = name === 'task' ? 'task' : name === 'skill' ? 'skill' : 'tool';
        const ev: AgentEvent = {
            kind,
            name,
            args,
            output: tc.output ?? tc.result,
            interaction: it,
            interactionIndex: idx,
            startedAt: toMsTimestamp(tc.timing?.started_at) ?? baseTs,
            completedAt: toMsTimestamp(tc.timing?.completed_at),
            summary: summarizeToolCall(name, args),
        };
        (ev as any)._toolCallId = tc.id;
        (ev as any).splitParallelTask = !!tc.trace_split_parallel_task;
        out.push(ev);
    }

    return out;
}

function toMsTimestamp(v: any): number | undefined {
    if (v == null) return undefined;
    if (typeof v === 'number' && Number.isFinite(v)) {
        // Treat plausible Unix seconds as seconds, otherwise milliseconds.
        return v > 0 && v < 10_000_000_000 ? v * 1000 : v;
    }
    if (typeof v === 'string') {
        const s = v.trim();
        if (!s) return undefined;
        if (/^\d+(\.\d+)?$/.test(s)) {
            const n = Number(s);
            if (!Number.isFinite(n)) return undefined;
            return n > 0 && n < 10_000_000_000 ? n * 1000 : n;
        }
        const parsed = Date.parse(s);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

function interactionStartedAt(it: RawInteraction): number | undefined {
    return toMsTimestamp(it.timeInfo?.created) ?? toMsTimestamp(it.timestamp);
}

function interactionCompletedAt(it: RawInteraction): number | undefined {
    return toMsTimestamp(it.timeInfo?.completed);
}

function stableStringify(v: any): string {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    try {
        return JSON.stringify(v);
    } catch {
        return String(v);
    }
}

function toolCallKey(tc: ToolCall): string {
    const id = tc.id;
    if (typeof id === 'string' && id.trim()) return `id:${id.trim()}`;
    const name = tc.function?.name || tc.name || 'unknown';
    const args = tc.function?.arguments ?? tc.arguments ?? '';
    return `sig:${name}:${stableStringify(args)}`;
}

function mergeToolCall(existing: ToolCall, incoming: ToolCall): ToolCall {
    const out: ToolCall = { ...existing, ...incoming };
    if (existing.output !== undefined && incoming.output === undefined) out.output = existing.output;
    if (existing.result !== undefined && incoming.result === undefined) out.result = existing.result;
    if (existing.timing && !incoming.timing) out.timing = existing.timing;
    return out;
}

function dedupeToolCalls(calls: ToolCall[]): ToolCall[] {
    const out: ToolCall[] = [];
    const pos = new Map<string, number>();
    for (const tc of calls) {
        const key = toolCallKey(tc);
        const idx = pos.get(key);
        if (idx == null) {
            pos.set(key, out.length);
            out.push(tc);
        } else {
            out[idx] = mergeToolCall(out[idx], tc);
        }
    }
    return out;
}

/** True when this interaction is the user-side "trigger" that asks opencode to
 *  start a compaction turn. Shape: role in {user,opencode,subagent}, no text
 *  content, parts contains exactly one entry whose type is 'compaction'. */
function isCompactionTrigger(it: RawInteraction): boolean {
    if (it.role !== 'user' && it.role !== 'opencode' && it.role !== 'subagent') return false;
    if ((it.content || '').trim()) return false;
    const parts = it.parts;
    if (!Array.isArray(parts) || parts.length === 0) return false;
    // All parts must be compaction markers (typically just one, but be lenient).
    return parts.every((p) => (p?.type || '').toLowerCase() === 'compaction');
}

/** True when this interaction is the assistant/subagent-side compaction result
 *  message — the synthetic message that replaces prior context for subsequent
 *  LLM calls in the same session. Signal: `mode === 'compaction'` AND
 *  `summary === true`. Either alone is enough in opencode's current shape, but
 *  we require both to be conservative. */
function isCompactionSummary(it: RawInteraction): boolean {
    return it.mode === 'compaction' && it.summary === true;
}

/** Concatenate the text of all parts of a given type, in order. */
function extractPartsText(parts: InteractionPart[] | undefined, partType: string): string {
    if (!Array.isArray(parts) || parts.length === 0) return '';
    const buf: string[] = [];
    for (const p of parts) {
        if ((p?.type || '').toLowerCase() !== partType) continue;
        const t = typeof p?.text === 'string' ? p.text : '';
        if (t) buf.push(t);
    }
    return buf.join('');
}

export function inferSubagentType(it: RawInteraction): string | null {
    // The subagent_name field looks like "Kuafu (General Diagnostic Executor)".
    // The subagent_type field on the spawning task arg is lowercased: "kuafu".
    // We compare loosely.
    const raw = (it.subagent_name || it.agent || '').trim();
    if (!raw) return null;
    // Take the first token before space/paren and lowercase
    const m = raw.match(/^([A-Za-z][\w-]*)/);
    return m ? m[1].toLowerCase() : raw.toLowerCase();
}

function summarizeToolCall(name: string, args: any): string {
    if (!args || typeof args !== 'object') return name;
    if (name === 'task') {
        const desc = args.description || args.subagent_type || '';
        const subType = args.subagent_type ? `[${args.subagent_type}]` : '';
        return `task ${subType} ${desc}`.trim();
    }
    if (name === 'skill') return `skill: ${args.name || ''}`;
    if (name === 'bash') return `bash: ${(args.command || '').slice(0, 80)}`;
    if (name === 'read') return `read: ${args.path || args.file_path || ''}`;
    if (name === 'write') return `write: ${args.path || args.file_path || ''}`;
    if (name === 'glob') return `glob: ${args.pattern || ''}`;
    return name;
}

/** Walk the tree depth-first. */
export function walkTree(root: AgentNode, fn: (n: AgentNode) => void): void {
    fn(root);
    for (const c of root.children) walkTree(c, fn);
}

/** Find a node by id. */
export function findNode(root: AgentNode, id: string): AgentNode | null {
    if (root.id === id) return root;
    for (const c of root.children) {
        const f = findNode(c, id);
        if (f) return f;
    }
    return null;
}

/** Total descendant count (excluding root). */
export function totalNodeCount(root: AgentNode): number {
    let count = 0;
    walkTree(root, () => count++);
    return count;
}

/** Format milliseconds as "1h 1m 46s" / "1m 46s" / "1.2s" / "350ms" */
export function formatDuration(ms?: number): string {
    if (ms == null || !Number.isFinite(ms)) return '-';
    if (ms < 0) return '-';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    
    const totalSeconds = Math.floor(ms / 1000);
    if (totalSeconds < 60) {
        return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
    }
    
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    
    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
    
    return parts.join(' ');
}

/** Format a token count as "1.2k" / "12k" / "1.2M" */
export function formatTokens(n: number): string {
    if (!n) return '0';
    if (n < 1000) return n.toString();
    if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
    return `${(n / 1_000_000).toFixed(1)}M`;
}
