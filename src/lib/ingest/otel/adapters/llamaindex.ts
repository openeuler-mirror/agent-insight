/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ExecutionRecord } from '@/lib/storage/data-service';
import type { OtelTraceEvent } from '../types';
import type { OtelTraceAdapter } from './types';

type Interaction = Record<string, any>;

const HIDDEN_RUNTIME_STEPS = new Set([
  'init_run',
  'setup_agent',
  'parse_agent_output',
  'aggregate_tool_results',
]);

const WORKFLOW_STEP_LABELS: Record<string, string> = {
  run_agent_step: 'Run agent step',
};

type LogicalLlmCall = {
  event: OtelTraceEvent;
  family: OtelTraceEvent[];
  model: string;
  provider?: string;
  prompt: any;
  output: any;
  usage: OtelTraceEvent['usage'];
  failed: boolean;
  errorMessage?: string;
};

function attr(event: OtelTraceEvent | undefined, key: string): any {
  return event?.attributes?.[key];
}

function content(value: any): any {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function text(value: any): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value.trim() || undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

type PromptMessage = {
  role: string;
  content: string;
};

function messageContent(value: any): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value.trim() || undefined;
  if (Array.isArray(value)) {
    const combined = value.map(messageContent).filter(Boolean).join('\n');
    return combined || undefined;
  }
  if (typeof value === 'object') {
    for (const key of ['content', 'text', 'blocks']) {
      const nested = messageContent(value[key]);
      if (nested) return nested;
    }
  }
  return text(value);
}

function readableLlmText(value: any): string | undefined {
  const parsed = content(value);
  const seen = new Set<any>();

  const visit = (candidate: any, depth = 0): string | undefined => {
    if (candidate == null || depth > 8) return undefined;
    if (typeof candidate === 'string') return candidate.trim() || undefined;
    if (typeof candidate !== 'object') return String(candidate);
    if (seen.has(candidate)) return undefined;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      const combined = candidate.map(item => visit(item, depth + 1)).filter(Boolean).join('\n');
      return combined || undefined;
    }

    // CompletionResponse exposes `text`; ChatResponse exposes
    // `message.content`/`message.blocks`. OpenAI-compatible providers can use
    // choices/candidates/delta. Prefer those semantic fields over serializing
    // the whole framework response object into the LLM row.
    for (const key of ['text', 'content']) {
      const nested = visit(candidate[key], depth + 1);
      if (nested) return nested;
    }
    for (const key of ['message', 'response', 'output', 'delta', 'blocks', 'choices', 'candidates']) {
      const nested = visit(candidate[key], depth + 1);
      if (nested) return nested;
    }
    return undefined;
  };

  const directMessage = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? messageContent(parsed.message ?? parsed.response ?? parsed.output)
    : undefined;
  const extracted = directMessage || visit(parsed) || text(parsed);
  if (!extracted) return undefined;

  // ReAct encodes tool decisions as text even though the following Tool span
  // already carries Action and Action Input. Keep the human-readable thought
  // for tool turns and the actual Answer for terminal turns, matching the
  // native message-part view used by OpenCode.
  const answer = extracted.match(/(?:^|\n)\s*Answer:\s*([\s\S]+)$/i)?.[1]?.trim();
  if (answer) return answer;
  const thought = extracted.match(
    /(?:^|\n)\s*Thought:\s*([\s\S]*?)(?=\n\s*(?:Action|Action Input|Answer|Observation):|$)/i,
  )?.[1]?.trim();
  return thought || extracted;
}

function promptMessages(value: any): PromptMessage[] {
  const parsed = content(value);
  const candidates = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray(parsed.messages)
      ? parsed.messages
      : [];
  return candidates.flatMap((candidate: any) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const role = text(candidate.role ?? candidate.type)?.toLowerCase();
    const message = messageContent(candidate);
    return role && message ? [{ role, content: message }] : [];
  });
}

function eventEnd(event: OtelTraceEvent): number {
  return (event.startTimeMs || Date.parse(event.receivedAt) || Date.now()) + Math.max(0, event.latencyMs || 0);
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function status(event: OtelTraceEvent): string {
  return String(attr(event, 'agent.insight.status') || attr(event, 'tool.status') || 'success').toLowerCase();
}

function directAgentName(event: OtelTraceEvent | undefined): string | undefined {
  return text(attr(event, 'agent.name'));
}

type AgentIdentity = {
  key: string;
  name: string;
};

type AgentInstance = AgentIdentity & {
  first: OtelTraceEvent;
  parentKey?: string;
};

function directAgentIdentity(event: OtelTraceEvent | undefined): AgentIdentity | undefined {
  const name = directAgentName(event);
  if (!name) return undefined;
  const explicit = text(attr(event, 'agent.instance.id'));
  return { key: explicit || `name:${name}`, name };
}

function spanSemanticKind(event: OtelTraceEvent): string {
  return String(attr(event, 'agent.insight.span.kind') || event.kind || 'span').toLowerCase();
}

function functionName(event: OtelTraceEvent): string {
  return text(attr(event, 'workflow.step.name'))
    || text(attr(event, 'code.function'))
    || text(event.name)?.split('.').at(-1)
    || 'step';
}

function humanizeIdentifier(value: string): string {
  const spaced = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : 'Step';
}

function isHiddenRuntimeStep(event: OtelTraceEvent, semantic: string): boolean {
  return semantic === 'workflow_step' && HIDDEN_RUNTIME_STEPS.has(functionName(event).toLowerCase());
}

function readableChainName(event: OtelTraceEvent, semantic: string): string {
  const step = functionName(event);
  if (semantic === 'retriever') return 'Retrieve context';
  if (semantic === 'synthesizer') return 'Synthesize response';
  if (semantic === 'workflow') return 'Run workflow';
  if (semantic === 'workflow_step') {
    return WORKFLOW_STEP_LABELS[step.toLowerCase()] || humanizeIdentifier(step);
  }
  if (semantic === 'chain' && /^(a?query)$/i.test(step)) return 'Query pipeline';
  return humanizeIdentifier(step);
}

function readableToolName(event: OtelTraceEvent): string {
  const raw = text(attr(event, 'tool.name')) || event.name || 'tool';
  return raw.replace(/^(?:FunctionTool|QueryEngineTool)\./i, '') || 'tool';
}

/**
 * LlamaIndex instruments convenience wrappers such as achat -> chat -> complete.
 * They are one provider request, not three calls. Keep the leaf span as the
 * interaction and use its wrapper family only to fill metadata that may have
 * been emitted on an outer span.
 */
function logicalLlmCalls(events: OtelTraceEvent[]): LogicalLlmCall[] {
  const llmEvents = events.filter(event => event.kind === 'llm');
  const byId = new Map(llmEvents.filter(event => event.spanId).map(event => [event.spanId as string, event]));
  const containerIds = new Set(llmEvents.map(event => event.parentSpanId).filter((id): id is string => Boolean(id)));
  return llmEvents
    .filter(event => !event.spanId || !containerIds.has(event.spanId))
    .map(event => {
      const family = [event];
      let parentId = event.parentSpanId;
      const seen = new Set<string>();
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        const parent = byId.get(parentId);
        if (!parent) break;
        family.push(parent);
        parentId = parent.parentSpanId;
      }
      const usageEvent = family.reduce((best, candidate) =>
        candidate.usage.total_tokens > best.usage.total_tokens ? candidate : best
      );
      const failedEvent = family.find(candidate => status(candidate) === 'error');
      return {
        event,
        family,
        model: family.find(candidate => candidate.model && candidate.model !== 'unknown')?.model || event.model || 'unknown',
        provider: family.map(candidate => text(attr(candidate, 'gen_ai.provider.name'))).find(Boolean),
        prompt: family.map(candidate => attr(candidate, 'input.value')).find(value => value != null),
        output: family.map(candidate => attr(candidate, 'output.value')).find(value => value != null),
        usage: usageEvent.usage,
        failed: Boolean(failedEvent),
        errorMessage: failedEvent ? text(attr(failedEvent, 'agent.insight.status_message')) : undefined,
      };
    });
}

function buildRelationships(events: OtelTraceEvent[]) {
  const byId = new Map(events.filter(event => event.spanId).map(event => [event.spanId as string, event]));
  const named = events.filter(event => directAgentIdentity(event));
  const explicitByName = new Map<string, AgentIdentity>();
  for (const event of named) {
    const identity = directAgentIdentity(event) as AgentIdentity;
    if (text(attr(event, 'agent.instance.id')) && !explicitByName.has(identity.name)) {
      explicitByName.set(identity.name, identity);
    }
  }
  const identityFor = (event: OtelTraceEvent | undefined): AgentIdentity | undefined => {
    const identity = directAgentIdentity(event);
    if (!identity) return undefined;
    return text(attr(event, 'agent.instance.id')) ? identity : explicitByName.get(identity.name) || identity;
  };
  const rootAgent = events.find(event => event.kind === 'agent');
  const primary = identityFor(rootAgent) || identityFor(named[0]) || {
    key: 'TOP',
    name: text(attr(rootAgent || events[0], 'agent.name'))
      || 'LlamaIndex Agent',
  };
  const identityBySpan = new Map<string, AgentIdentity>();
  for (const event of named) {
    if (event.spanId) identityBySpan.set(event.spanId, identityFor(event) as AgentIdentity);
  }

  const owner = (event: OtelTraceEvent): AgentIdentity => {
    const own = identityFor(event);
    if (own && text(attr(event, 'agent.instance.id'))) return own;
    let parentId = event.parentSpanId;
    const seen = new Set<string>();
    let nearestContext: AgentIdentity | undefined;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      const identity = identityFor(parent);
      if (identity && text(attr(parent, 'agent.instance.id'))) return identity;
      if (identity && !nearestContext) nearestContext = identity;
      parentId = parent.parentSpanId;
    }
    // AgentWorkflow emits many LLM/tool spans as siblings of run_agent_step.
    // On those spans LlamaIndex can leave agent.name set to the workflow root
    // even after a handoff. The latest explicit agent instance is the active
    // workflow agent and therefore wins over a root-only ancestor context.
    const priorExplicit = [...named].reverse().find(candidate =>
      candidate.startTimeMs <= event.startTimeMs
      && Boolean(text(attr(candidate, 'agent.instance.id')))
    );
    if (nearestContext && nearestContext.key !== primary.key) return nearestContext;
    if (priorExplicit) return identityFor(priorExplicit) as AgentIdentity;
    if (nearestContext) return nearestContext;
    if (own) return own;
    const prior = [...named].reverse().find(candidate => candidate.startTimeMs <= event.startTimeMs);
    return identityFor(prior || named[0]) || primary;
  };

  const instances = new Map<string, AgentInstance>();
  for (const event of named) {
    const identity = identityFor(event) as AgentIdentity;
    if (!instances.has(identity.key)) instances.set(identity.key, { ...identity, first: event });
  }
  if (!instances.has(primary.key)) instances.set(primary.key, { ...primary, first: events[0] });

  for (const instance of instances.values()) {
    if (instance.key === primary.key) continue;
    // AgentWorkflow handoffs are often sibling spans under the workflow root,
    // so structural span ancestry alone flattens a multi-level handoff chain.
    // Prefer the source agent that emitted the matching handoff tool event.
    const handoff = [...events].reverse().find(event => {
      if (event.kind !== 'tool' || event.startTimeMs > instance.first.startTimeMs) return false;
      const name = text(attr(event, 'tool.name'))?.toLowerCase();
      if (name !== 'handoff') return false;
      const args = content(attr(event, 'tool.arguments') ?? attr(event, 'input.value'));
      return args && typeof args === 'object'
        && text(args.to_agent ?? args.toAgent)?.toLowerCase() === instance.name.toLowerCase();
    });
    const handoffParent = handoff ? owner(handoff) : undefined;
    if (handoffParent && handoffParent.key !== instance.key && instances.has(handoffParent.key)) {
      instance.parentKey = handoffParent.key;
      continue;
    }
    let parentId = instance.first.parentSpanId;
    let parentKey: string | undefined;
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      const candidate = identityBySpan.get(parentId) || identityFor(parent);
      if (candidate && candidate.key !== instance.key) {
        parentKey = candidate.key;
        break;
      }
      parentId = parent.parentSpanId;
    }
    instance.parentKey = parentKey || primary.key;
  }
  const sessionByAgent = new Map<string, string>([[primary.key, 'TOP']]);
  for (const instance of instances.values()) {
    if (instance.key !== primary.key) {
      sessionByAgent.set(
        instance.key,
        text(attr(instance.first, 'agent.instance.id'))
          || instance.first.spanId
          || `${instance.first.traceId}:${instance.key}`,
      );
    }
  }
  return { primary, owner, instances, sessionByAgent };
}

function ownerFields(
  identity: AgentIdentity,
  primary: AgentIdentity,
  sessionByAgent: Map<string, string>,
): Interaction {
  if (identity.key === primary.key) return { role: 'assistant', agent: identity.name };
  return {
    role: 'subagent',
    agent: identity.name,
    subagent_name: identity.name,
    subagent_session_id: sessionByAgent.get(identity.key),
  };
}

function baseInteraction(event: OtelTraceEvent): Interaction {
  const started = event.startTimeMs || Date.parse(event.receivedAt) || Date.now();
  return {
    timestamp: iso(started),
    timeInfo: { created: iso(started), completed: iso(eventEnd(event)) },
    traceId: event.traceId,
    spanId: event.spanId,
    parentSpanId: event.parentSpanId,
    name: event.name,
  };
}

function toolCall(event: OtelTraceEvent): Interaction {
  const output = content(attr(event, 'tool.output') ?? attr(event, 'output.value'));
  return {
    id: event.spanId,
    type: 'function',
    state: status(event),
    function: {
      name: readableToolName(event),
      arguments: text(attr(event, 'tool.arguments') ?? attr(event, 'input.value')) || '{}',
    },
    output,
    result: output,
    timing: {
      started_at: iso(event.startTimeMs),
      completed_at: iso(eventEnd(event)),
    },
  };
}

export function aggregateLlamaIndexTraceEvents(sessionId: string, source: OtelTraceEvent[]): ExecutionRecord | null {
  const events = source
    .filter(event => event.sessionId === sessionId)
    .sort((a, b) => a.startTimeMs - b.startTimeMs || eventEnd(a) - eventEnd(b));
  if (!events.length) return null;

  const relationships = buildRelationships(events);
  const logicalLlms = logicalLlmCalls(events);
  const logicalLlmBySpan = new Map(logicalLlms.map(call => [call.event.spanId, call]));
  const interactions: Interaction[] = [];
  const systemPrompts = new Set<string>();
  const queryEvent = events.find(event => text(attr(event, 'agent.query')) || (event.kind === 'agent' && text(attr(event, 'input.value'))));
  const query = text(attr(queryEvent || events[0], 'agent.query')) || text(attr(queryEvent || events[0], 'input.value')) || 'LlamaIndex Session';
  interactions.push({
    role: 'user',
    content: query,
    agent: relationships.primary.name,
    timestamp: iso(queryEvent?.startTimeMs || events[0].startTimeMs),
  });

  const taskDescription = (instance: AgentInstance): string => {
    const declared = text(attr(instance.first, 'agent.task'));
    if (declared && declared.length <= 256 && !/^[\[{]/.test(declared.trim())) return declared;
    const handoff = [...events].reverse().find(event => {
      if (event.kind !== 'tool' || event.startTimeMs > instance.first.startTimeMs) return false;
      const name = text(attr(event, 'tool.name'))?.toLowerCase();
      const args = content(attr(event, 'tool.arguments') ?? attr(event, 'input.value'));
      return name === 'handoff'
        && args && typeof args === 'object'
        && text(args.to_agent ?? args.toAgent)?.toLowerCase() === instance.name.toLowerCase();
    });
    if (handoff) {
      const args = content(attr(handoff, 'tool.arguments') ?? attr(handoff, 'input.value'));
      const reason = args && typeof args === 'object'
        ? text(args.reason ?? args.description ?? args.task)
        : undefined;
      if (reason) return reason;
    }
    return `Run LlamaIndex agent ${instance.name}`;
  };

  for (const instance of relationships.instances.values()) {
    if (instance.key === relationships.primary.key) continue;
    const parent = relationships.instances.get(instance.parentKey || '') || relationships.primary;
    const first = instance.first;
    const ownedEvents = events.filter(event => relationships.owner(event).key === instance.key);
    const failed = ownedEvents.some(event => status(event) === 'error');
    const last = ownedEvents.at(-1) || first;
    const call: Interaction = {
      ...ownerFields(parent, relationships.primary, relationships.sessionByAgent),
      content: '',
      trace_synthetic: true,
      ...baseInteraction(first),
      tool_calls: [{
        id: `spawn:${first.spanId || instance.name}`,
        type: 'function',
        state: failed ? 'error' : 'success',
        function: {
          name: 'task',
          arguments: JSON.stringify({
            subagent_type: instance.name.match(/^([A-Za-z][\w-]*)/)?.[1].toLowerCase()
              || instance.name.toLowerCase(),
            description: taskDescription(instance),
            subagent_session_id: relationships.sessionByAgent.get(instance.key),
          }),
        },
        output: text(attr(last, 'output.value')),
        timing: { started_at: iso(first.startTimeMs), completed_at: iso(eventEnd(last)) },
      }],
    };
    interactions.push(call);
  }

  const llmInteractions: {
    event: OtelTraceEvent;
    owner: AgentIdentity;
    interaction: Interaction;
  }[] = [];
  for (const event of events) {
    const semantic = spanSemanticKind(event);
    const owner = relationships.owner(event);
    if (event.kind === 'llm') {
      const logical = logicalLlmBySpan.get(event.spanId);
      if (!logical) continue;
      const prompt = content(logical.prompt);
      const messages = promptMessages(logical.prompt);
      for (const message of messages.filter(candidate => candidate.role === 'system')) {
        const key = `${owner.key}\u0000${message.content}`;
        if (systemPrompts.has(key)) continue;
        systemPrompts.add(key);
        interactions.push({
          ...ownerFields(owner, relationships.primary, relationships.sessionByAgent),
          role: 'system',
          content: message.content,
          timestamp: iso(event.startTimeMs),
        });
      }
      const interaction: Interaction = {
        ...ownerFields(owner, relationships.primary, relationships.sessionByAgent),
        ...baseInteraction(event),
        content: readableLlmText(logical.output) || '',
        model: logical.model,
        provider: logical.provider,
        usage: {
          input_tokens: logical.usage.input_tokens,
          output_tokens: logical.usage.output_tokens,
          total: logical.usage.total_tokens,
        },
        latency: event.latencyMs,
        ...(messages.length
          ? { requestMessages: messages }
          : prompt ? { requestMessages: [{ role: 'user', content: prompt }] } : {}),
        ...(logical.failed ? {
          status: 'error',
          error: { message: logical.errorMessage },
          error_summary: logical.errorMessage || 'LLM 调用失败',
        } : {}),
      };
      interactions.push(interaction);
      llmInteractions.push({ event, owner, interaction });
      continue;
    }
    if (event.kind === 'tool') {
      const host = [...llmInteractions].reverse().find(item =>
        item.owner.key === owner.key && item.event.startTimeMs <= event.startTimeMs
      )?.interaction;
      if (host) {
        host.tool_calls = [...(host.tool_calls || []), toolCall(event)];
      } else {
        interactions.push({
          ...ownerFields(owner, relationships.primary, relationships.sessionByAgent),
          ...baseInteraction(event),
          content: '',
          tool_calls: [toolCall(event)],
        });
      }
      continue;
    }
    if (event.kind === 'chain') {
      if (isHiddenRuntimeStep(event, semantic)) continue;
      const displayName = readableChainName(event, semantic);
      interactions.push({
        role: 'trace',
        agent: owner.name,
        ...(owner.key === relationships.primary.key ? {} : {
          subagent_name: owner.name,
          subagent_session_id: relationships.sessionByAgent.get(owner.key),
        }),
        ...baseInteraction(event),
        content: displayName,
        trace_kind: 'chain',
        trace_name: displayName,
        trace_args: content(attr(event, 'retrieval.query') ?? attr(event, 'input.value')),
        trace_output: content(attr(event, 'retrieval.nodes') ?? attr(event, 'output.value')),
        trace_status: status(event),
      });
    }
  }

  interactions.sort((a, b) => (Date.parse(a.timestamp || '') || 0) - (Date.parse(b.timestamp || '') || 0));
  const usage = logicalLlms.reduce((sum, call) => ({
    input: sum.input + call.usage.input_tokens,
    output: sum.output + call.usage.output_tokens,
    total: sum.total + call.usage.total_tokens,
  }), { input: 0, output: 0, total: 0 });
  const rootOutputs = llmInteractions.filter(item =>
    item.owner.key === relationships.primary.key
    && String(item.interaction.content || '').trim()
  );
  const finalEvent = [...events].reverse().find(event => event.kind === 'agent') || events.at(-1);
  const finalResult = rootOutputs.at(-1)?.interaction.content
    || readableLlmText(finalEvent ? attr(finalEvent, 'output.value') : undefined)
    || '';
  const started = Math.min(...events.map(event => event.startTimeMs || Date.now()));
  const completed = Math.max(...events.map(eventEnd));
  const model = logicalLlms.find(call => call.model !== 'unknown')?.model || 'unknown';
  const failures = events
    .filter(event => status(event) === 'error')
    .filter((event, index, failed) => {
      const message = text(attr(event, 'agent.insight.status_message')) || '';
      return failed.findIndex(candidate =>
        candidate.kind === event.kind
        && candidate.name === event.name
        && (text(attr(candidate, 'agent.insight.status_message')) || '') === message
      ) === index;
    })
    .map(event => ({
      failure_type: `${event.kind || 'runtime'}_error`,
      description: text(attr(event, 'agent.insight.status_message')) || `${event.name || event.kind} failed`,
      context: event.name || event.kind,
      recovery: 'Resolve the upstream runtime error and retry the operation.',
    }));

  return {
    task_id: sessionId,
    query,
    framework: 'llamaindex',
    model,
    tokens: usage.total,
    // ExecutionRecord latency is stored in seconds; individual span/event
    // timestamps remain milliseconds for timeline rendering.
    latency: Math.max(0, completed - started) / 1000,
    final_result: finalResult,
    trace_completed_at: finalResult || failures.length ? new Date(completed) : undefined,
    timestamp: new Date(started),
    label: 'llamaindex',
    user: events[0].user || 'anonymous',
    interactions,
    agent: relationships.primary.name,
    agentName: relationships.primary.name,
    llm_call_count: logicalLlms.length,
    tool_call_count: events.filter(event => event.kind === 'tool').length,
    tool_call_error_count: events.filter(event => event.kind === 'tool' && status(event) === 'error').length,
    input_tokens: usage.input,
    output_tokens: usage.output,
    ...(failures.length ? { failures } : {}),
  };
}

export const llamaIndexOtelTraceAdapter: OtelTraceAdapter = {
  id: 'llamaindex',
  matches(events) {
    return events.some(event =>
      event.serviceName === 'llamaindex' || event.attributes?.['agent.insight.framework'] === 'llamaindex'
    );
  },
  aggregate: aggregateLlamaIndexTraceEvents,
};
