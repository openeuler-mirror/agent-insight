/* eslint-disable @typescript-eslint/no-explicit-any */

import {
    buildAgentCallTree,
    type AgentEvent,
    type AgentNode,
    type RawInteraction,
    walkTree,
} from './agent-trace';

export type FaultPathKind = AgentEvent['kind'] | 'agent' | 'system';

export interface FaultPathStep {
    id: string;
    stepIndex: number;
    name: string;
    meta: string;
    kind: FaultPathKind;
    status: 'ok' | 'error' | 'skipped' | 'running';
    depth: number;
    interactionIndex?: number;
    eventIndex?: number;
    toolCallId?: string;
    startedAt?: number;
    completedAt?: number;
    rawText: string;
    rawInput?: string;
    rawOutput?: string;
}

export interface FailureTraceAnchor {
    step_id: string;
    step_index: number;
    display_name: string;
    kind: FaultPathKind;
    interaction_index?: number;
    event_index?: number;
    tool_call_id?: string;
    started_at?: number;
    completed_at?: number;
    match_method: 'step_id' | 'step_index' | 'interaction_index' | 'tool_call_id' | 'time_window' | 'text_match' | 'type_rule' | 'fallback';
    confidence: number;
    evidence?: string;
}

export interface AnchorableFailure {
    failure_type?: string;
    description?: string;
    context?: string;
    recovery?: string;
    step?: string;
    anchor_step_id?: string;
    trace_anchor?: FailureTraceAnchor;
    [key: string]: any;
}

export function toRawTraceInteractions(input: any[]): RawInteraction[] {
    if (!Array.isArray(input)) return [];
    const out: RawInteraction[] = [];
    for (const item of input) {
        if (!item) continue;
        if (Array.isArray(item.requestMessages) || item.responseMessage) {
            for (const msg of item.requestMessages || []) {
                if (msg) out.push(msg);
            }
            if (item.responseMessage) out.push(item.responseMessage);
            continue;
        }
        out.push(item);
    }
    return out;
}

export function buildFaultPathSteps(input: any[], locale = 'zh'): FaultPathStep[] {
    const interactions = toRawTraceInteractions(input);
    const steps: FaultPathStep[] = [];
    const push = (step: Omit<FaultPathStep, 'stepIndex'>) => {
        steps.push({ ...step, stepIndex: steps.length + 1 });
    };

    const firstUser = interactions.find(it => it?.role === 'user' && String(it.content || '').trim());
    if (firstUser) {
        push({
            id: 'input:root',
            name: locale === 'zh' ? '用户输入' : 'User input',
            meta: firstUser.usage?.input ? `req ${firstUser.usage.input} tok` : truncateText(String(firstUser.content || ''), 110),
            kind: 'user',
            status: 'ok',
            depth: 0,
            interactionIndex: interactions.indexOf(firstUser),
            startedAt: toMsTimestamp(firstUser.timeInfo?.created) ?? toMsTimestamp(firstUser.timestamp),
            completedAt: toMsTimestamp(firstUser.timeInfo?.completed),
            rawText: String(firstUser.content || ''),
            rawInput: String(firstUser.content || ''),
        });
    }

    const tree = buildAgentCallTree(interactions);
    if (tree) {
        walkTree(tree, (agentNode: AgentNode) => {
            // agent node: input = first user event content; output = last llm event content
            const firstUserEv = agentNode.events.find(e => e.kind === 'user');
            const lastLlmEv = [...agentNode.events].reverse().find(e => e.kind === 'llm');
            const agentRawInput = firstUserEv
                ? (firstUserEv.summary || firstUserEv.interaction?.content || undefined)
                : undefined;
            const agentRawOutput = lastLlmEv
                ? (lastLlmEv.interaction?.content || lastLlmEv.summary || undefined)
                : undefined;

            push({
                id: `agent:${agentNode.id}`,
                name: agentNode.depth === 0
                    ? (locale === 'zh' ? '控制器路由' : 'Controller routing')
                    : (locale === 'zh' ? '子任务执行' : 'Subtask execution'),
                meta: formatAgentMeta(agentNode, locale),
                kind: 'agent',
                status: 'ok',
                depth: agentNode.depth,
                startedAt: agentNode.startedAt,
                completedAt: agentNode.endedAt,
                rawText: [agentNode.agentName, agentNode.subagentType, formatAgentMeta(agentNode, locale)].filter(Boolean).join(' '),
                rawInput: agentRawInput,
                rawOutput: agentRawOutput,
            });

            agentNode.events.forEach((event: AgentEvent, eventIndex: number) => {
                const semantic = semanticEventLabel(event, locale);
                const status = !event.completedAt && !event.startedAt ? 'skipped' : 'ok';

                let rawInput: string | undefined;
                let rawOutput: string | undefined;

                if (event.kind === 'user') {
                    rawInput = event.summary || event.interaction?.content || '';
                } else if (event.kind === 'llm') {
                    // Mirror AgentTraceView.LLMEventBody: collect prior interactions from the
                    // SAME agent node (respecting node boundaries) and format as labelled turns.
                    const eventIdx = event.interactionIndex ?? -1;
                    const priorNodeIndices = new Set(
                        agentNode.interactionIndices.filter(i => i < eventIdx),
                    );
                    const parts: string[] = [];

                    // System prompts attached to this node
                    for (const sp of agentNode.systemPrompts || []) {
                        if (sp.text?.trim()) parts.push(`[System]\n${truncateText(sp.text, 1500)}`);
                    }

                    // Prior user / assistant turns from the same node, in order
                    for (const i of Array.from(priorNodeIndices).sort((a, b) => a - b)) {
                        const it = interactions[i];
                        if (!it || it.role === 'system') continue;
                        const content = typeof it.content === 'string'
                            ? it.content
                            : JSON.stringify(it.content, null, 2);
                        if (!content.trim()) continue;
                        if (it.role === 'user' || it.role === 'opencode') {
                            parts.push(`[User]\n${truncateText(content, 2000)}`);
                        } else if (it.role === 'assistant' || it.role === 'subagent') {
                            parts.push(`[Assistant]\n${truncateText(content, 2000)}`);
                        }
                    }

                    rawInput = parts.length > 0 ? parts.join('\n\n---\n\n') : undefined;
                    rawOutput = event.interaction?.content || event.summary || '';
                } else if (event.kind === 'tool' || event.kind === 'skill' || event.kind === 'task') {
                    if (event.args !== undefined) rawInput = stringifyPreview(event.args, 2000);
                    if ((event.kind === 'tool' || event.kind === 'skill') && event.output !== undefined && event.output !== null) {
                        rawOutput = stringifyPreview(event.output, 2000);
                    }
                }

                push({
                    id: `event:${agentNode.id}:${eventIndex}`,
                    name: semantic.name,
                    meta: semantic.meta,
                    kind: event.kind,
                    status,
                    depth: agentNode.depth + 1,
                    interactionIndex: event.interactionIndex,
                    eventIndex,
                    toolCallId: (event as any)._toolCallId,
                    startedAt: event.startedAt,
                    completedAt: event.completedAt,
                    rawText: [
                        semantic.name,
                        semantic.meta,
                        event.name,
                        event.summary,
                        stringifyPreview(event.args, 500),
                        stringifyPreview(event.output, 500),
                    ].filter(Boolean).join(' '),
                    rawInput: rawInput || undefined,
                    rawOutput: rawOutput || undefined,
                });
            });
        });
    }

    if (steps.length === 0) {
        push({
            id: 'system:missing-trace',
            name: locale === 'zh' ? '链路详情缺失' : 'Trace unavailable',
            meta: locale === 'zh' ? '未找到可还原的 interactions。' : 'No interactions were available.',
            kind: 'system',
            status: 'skipped',
            depth: 0,
            rawText: '',
        });
    }

    return steps;
}

export function attachFailureAnchors<T extends AnchorableFailure>(failures: T[], steps: FaultPathStep[], locale = 'zh'): T[] {
    if (!Array.isArray(failures) || failures.length === 0) return failures;
    return failures.map(failure => {
        if (failure.trace_anchor?.step_id && steps.some(step => step.id === failure.trace_anchor?.step_id)) {
            return failure;
        }
        const anchor = resolveFailureAnchor(failure, steps, locale);
        return anchor ? { ...failure, trace_anchor: anchor } : failure;
    });
}

export function resolveFailureAnchor(failure: AnchorableFailure, steps: FaultPathStep[], locale = 'zh'): FailureTraceAnchor | null {
    if (!steps.length) return null;

    const explicitId = String(failure.anchor_step_id || failure.trace_anchor?.step_id || '').trim();
    if (explicitId) {
        const step = steps.find(s => s.id === explicitId);
        if (step) return makeAnchor(step, 'step_id', 0.98, locale === 'zh' ? 'LLM 返回了候选步骤 ID，且后端校验存在' : 'The model returned a valid step id');
    }

    const isOldInferenceStep = /推理判断|时间窗口匹配/i.test(failure.step || '');
    const stepMatch = !isOldInferenceStep ? String(failure.step || '').match(/第\s*(\d+)\s*步/i) : null;
    if (stepMatch) {
        const idx = Number(stepMatch[1]);
        const step = steps.find(s => s.stepIndex === idx);
        if (step) return makeAnchor(step, 'step_index', 0.9, locale === 'zh' ? '来自故障记录的步骤编号' : 'Matched by failure step index');
    }

    const exact = findExactMetadataMatch(failure, steps, locale);
    if (exact) return exact;

    const text = normalizeSearchText([failure.failure_type, failure.description, failure.context, failure.recovery, failure.step].filter(Boolean).join(' '));
    const scored = steps.map(step => {
        let score = 0;
        const raw = normalizeSearchText(step.rawText || `${step.name} ${step.meta}`);
        for (const token of tokenizeFaultText(text)) {
            if (raw.includes(token)) score += token.length > 4 ? 2 : 1;
        }
        if (/401|authentication|unauthori[sz]ed|api[_\s-]?key|认证|鉴权|权限/.test(text) && step.kind === 'llm') score += 8;
        if (/tool|工具|bash|command|exit code|stderr|非零/.test(text) && step.kind === 'tool') score += 7;
        if (/skill|技能|SKILL\.md/i.test(text) && step.kind === 'skill') score += 7;
        if (/timeout|超时|卡住/.test(text)) score += 3;
        return { step, score };
    }).sort((a, b) => b.score - a.score);

    if (scored[0]?.score > 0) {
        const method = scored[0].score >= 7 ? 'type_rule' : 'text_match';
        const confidence = scored[0].score >= 7 ? 0.78 : 0.58;
        return makeAnchor(
            scored[0].step,
            method,
            confidence,
            scored[0].score >= 7
                ? (locale === 'zh' ? '根据错误内容和节点类型匹配' : 'Matched by error content and step type')
                : (locale === 'zh' ? '根据错误上下文文本匹配' : 'Matched by error context text'),
        );
    }

    const fallback = [...steps].reverse().find(s => s.kind === 'llm' || s.kind === 'tool' || s.kind === 'skill')
        || [...steps].reverse().find(s => s.status !== 'skipped');
    return fallback
        ? makeAnchor(fallback, 'fallback', 0.35, locale === 'zh' ? '未找到精确锚点，回退到最后一个已执行关键节点' : 'Fell back to the latest meaningful executed step')
        : null;
}

export function formatFaultPathStepForPrompt(step: FaultPathStep): string {
    return [
        `- step_id: ${step.id}`,
        `  step_index: ${step.stepIndex}`,
        `  name: ${step.name}`,
        `  kind: ${step.kind}`,
        `  meta: ${step.meta || '-'}`,
        step.interactionIndex != null ? `  interaction_index: ${step.interactionIndex}` : '',
        step.toolCallId ? `  tool_call_id: ${step.toolCallId}` : '',
        step.startedAt != null ? `  started_at: ${step.startedAt}` : '',
        step.completedAt != null ? `  completed_at: ${step.completedAt}` : '',
        step.rawText ? `  evidence_text: ${truncateText(step.rawText, 220)}` : '',
    ].filter(Boolean).join('\n');
}

function findExactMetadataMatch(failure: AnchorableFailure, steps: FaultPathStep[], locale: string): FailureTraceAnchor | null {
    const raw = stringifyPreview(failure, 2000);
    const toolId = raw.match(/(?:tool_call_id|toolCallId|call_)[\"':\s-]*([A-Za-z0-9_.:-]{6,})/)?.[1];
    if (toolId) {
        const step = steps.find(s => s.toolCallId === toolId);
        if (step) return makeAnchor(step, 'tool_call_id', 0.99, locale === 'zh' ? '根据 tool_call_id 精确匹配' : 'Matched exactly by tool_call_id');
    }
    const interactionIdx = raw.match(/(?:interaction_index|interactionIndex)[\"':\s-]*(\d+)/)?.[1];
    if (interactionIdx) {
        const n = Number(interactionIdx);
        const step = steps.find(s => s.interactionIndex === n);
        if (step) return makeAnchor(step, 'interaction_index', 0.94, locale === 'zh' ? '根据 interaction_index 精确匹配' : 'Matched by interaction_index');
    }
    return null;
}

function makeAnchor(step: FaultPathStep, matchMethod: FailureTraceAnchor['match_method'], confidence: number, evidence: string): FailureTraceAnchor {
    return {
        step_id: step.id,
        step_index: step.stepIndex,
        display_name: step.name,
        kind: step.kind,
        interaction_index: step.interactionIndex,
        event_index: step.eventIndex,
        tool_call_id: step.toolCallId,
        started_at: step.startedAt,
        completed_at: step.completedAt,
        match_method: matchMethod,
        confidence,
        evidence,
    };
}

function formatAgentMeta(agentNode: AgentNode, locale: string): string {
    const pieces: string[] = [];
    if (agentNode.agentName) pieces.push(agentNode.agentName);
    if (agentNode.subagentType) pieces.push(`type ${agentNode.subagentType}`);
    const counts = [
        agentNode.stats.llmCalls ? `${agentNode.stats.llmCalls} LLM` : '',
        agentNode.stats.toolCalls ? `${agentNode.stats.toolCalls} tool` : '',
        agentNode.stats.skillCalls ? `${agentNode.stats.skillCalls} skill` : '',
        agentNode.stats.taskCalls ? `${agentNode.stats.taskCalls} task` : '',
    ].filter(Boolean).join(' · ');
    if (counts) pieces.push(counts);
    return pieces.join(' · ') || (locale === 'zh' ? '执行 Agent' : 'Agent');
}

function semanticEventLabel(event: AgentEvent, locale: string): { name: string; meta: string } {
    const zh = locale === 'zh';
    if (event.kind === 'user') {
        return {
            name: zh ? '用户输入' : 'User input',
            meta: event.usage?.input ? `req ${event.usage.input} tok` : truncateText(event.summary || '', 96),
        };
    }
    if (event.kind === 'llm') {
        const provider = inferProvider(event);
        const req = event.usage?.input ? `req ${event.usage.input} tok` : '';
        const out = event.usage?.output ? `out ${event.usage.output} tok` : '';
        return {
            name: zh ? '模型调用' : 'Model call',
            meta: [provider, req, out].filter(Boolean).join(' · ') || truncateText(event.summary || 'assistant response', 96),
        };
    }
    if (event.kind === 'skill') {
        const skillName = event.args?.name || event.args?.skill || event.name || 'skill';
        return {
            name: zh ? '执行 Skill' : 'Run skill',
            meta: `skill ${skillName}`,
        };
    }
    if (event.kind === 'task') {
        const subType = event.args?.subagent_type || event.args?.subagentType || 'subagent';
        return {
            name: zh ? '调度子任务' : 'Dispatch subtask',
            meta: `spawn ${subType}`,
        };
    }
    const toolName = event.name || 'tool';
    return {
        name: zh ? '工具调用' : 'Tool call',
        meta: formatToolMeta(toolName, event.args),
    };
}

function inferProvider(event: AgentEvent): string {
    const raw = [
        event.name,
        (event.interaction as any)?.providerID,
        (event.interaction as any)?.modelID,
        event.summary,
    ].filter(Boolean).join(' ').toLowerCase();
    if (raw.includes('openai') || raw.includes('gpt') || raw.includes('chat.completions')) return 'OpenAI';
    if (raw.includes('deepseek')) return 'DeepSeek';
    if (raw.includes('anthropic') || raw.includes('claude')) return 'Anthropic';
    return 'LLM Provider';
}

function formatToolMeta(toolName: string, args: any): string {
    if (toolName === 'bash') return `bash ${truncateText(args?.command || '', 72)}`;
    if (toolName === 'read') return `read ${args?.path || args?.file_path || ''}`.trim();
    if (toolName === 'write') return `write ${args?.path || args?.file_path || ''}`.trim();
    if (toolName === 'glob') return `glob ${args?.pattern || ''}`.trim();
    if (toolName === 'grep') return `grep ${args?.pattern || ''}`.trim();
    return `${toolName}${args ? ` ${truncateText(stringifyPreview(args, 90), 90)}` : ''}`;
}

function toMsTimestamp(v: any): number | undefined {
    if (v == null) return undefined;
    if (typeof v === 'number' && Number.isFinite(v)) return v > 0 && v < 10_000_000_000 ? v * 1000 : v;
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

function normalizeSearchText(value: string): string {
    return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenizeFaultText(value: string): string[] {
    return Array.from(new Set(value.split(/[^a-z0-9_\-.]+/i).map(s => s.trim().toLowerCase()).filter(s => s.length >= 3))).slice(0, 12);
}

function stringifyPreview(value: any, max = 300): string {
    if (value == null) return '';
    if (typeof value === 'string') return truncateText(value, max);
    try {
        return truncateText(JSON.stringify(value), max);
    } catch {
        return truncateText(String(value), max);
    }
}

function truncateText(input: string, max: number): string {
    const s = String(input || '');
    return s.length > max ? `${s.slice(0, max)}...` : s;
}
