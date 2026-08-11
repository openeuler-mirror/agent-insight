import type { ExecutionRecord } from '@/lib/storage/data-service';
import type { InvokedSkill } from '@/lib/shared/interaction-utils';
import type { OtelTraceEvent } from '../types';
import type { OtelTraceAdapter } from './types';

type AnyObject = Record<string, any>;

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const result = String(value).trim();
  return result || undefined;
}

function actionKind(event: OtelTraceEvent): string {
  return text(event.attributes?.['actrail.action.kind']) || '';
}

function actionId(event: OtelTraceEvent): string | undefined {
  return text(event.attributes?.['actrail.action.id']);
}

function eventEndMs(event: OtelTraceEvent): number {
  return (event.startTimeMs || 0) + Math.max(0, event.latencyMs || 0);
}

function toIso(value: number): string {
  return new Date(value || Date.now()).toISOString();
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function parseToolCalls(response: OtelTraceEvent | undefined, call: OtelTraceEvent): AnyObject[] {
  const parsed = parseJson(response?.attributes?.['llm.response.tool_calls_json']);
  if (!Array.isArray(parsed)) return [];

  const startedAt = call.startTimeMs || Date.parse(call.receivedAt) || Date.now();
  const completedAt = eventEndMs(call) || startedAt;
  return parsed
    .filter((item) => item && typeof item === 'object')
    .map((item: any, index) => {
      const name = text(item?.function?.name) || text(item?.name) || 'tool';
      const rawArguments = item?.function?.arguments ?? item?.arguments ?? {};
      return {
        id: text(item?.id) || `${call.spanId || 'actrail-call'}:tool:${index}`,
        type: text(item?.type) || 'function',
        function: {
          name,
          arguments: typeof rawArguments === 'string'
            ? rawArguments
            : JSON.stringify(rawArguments),
        },
        timing: {
          started_at: toIso(startedAt),
          completed_at: toIso(completedAt),
        },
      };
    });
}

function skillCalls(toolCalls: AnyObject[]): InvokedSkill[] {
  const seen = new Set<string>();
  const skills: InvokedSkill[] = [];
  for (const call of toolCalls) {
    const name = text(call?.function?.name)?.toLowerCase();
    if (name !== 'skill' && name !== 'load_skill') continue;
    const args = parseJson(call?.function?.arguments);
    if (!args || typeof args !== 'object' || Array.isArray(args)) continue;
    const skillName = text((args as AnyObject).name || (args as AnyObject).skill_name);
    if (!skillName || seen.has(skillName)) continue;
    seen.add(skillName);
    const rawVersion = (args as AnyObject).version;
    const numericVersion = rawVersion === undefined || rawVersion === null
      ? null
      : Number(rawVersion);
    skills.push({
      name: skillName,
      version: numericVersion !== null && Number.isFinite(numericVersion)
        ? numericVersion
        : null,
    });
  }
  return skills;
}

function selectAgentName(events: OtelTraceEvent[]): string {
  const invocation = events.find((event) =>
    actionKind(event) === 'command.invocation' &&
    text(event.attributes?.['invocation.kind']) === 'agent'
  );
  if (!invocation) return 'AcTrail Agent';
  return text(invocation.name) ||
    text(invocation.attributes?.['agent.child.executable']) ||
    'AcTrail Agent';
}

function usageFrom(response: OtelTraceEvent | undefined) {
  const usage = response?.usage;
  return {
    input: usage?.input_tokens || 0,
    output: usage?.output_tokens || 0,
    reasoning: usage?.reasoning_tokens || 0,
    total: usage?.total_tokens || 0,
  };
}

function requestAgentSessionId(pair: LlmPair): string | undefined {
  return text(pair.request?.attributes?.['actrail.agent.session_id']);
}

function rootPromptSelection(pairs: LlmPair[]): {
  prompts: Set<string>;
  inference: 'dominant-request-session' | 'repeated-request-preview' | 'first-request-preview';
  rootSessionId?: string;
  observedSessionCount: number;
} {
  const sessionCounts = new Map<string, number>();
  for (const pair of pairs) {
    const agentSessionId = requestAgentSessionId(pair);
    if (agentSessionId) {
      sessionCounts.set(agentSessionId, (sessionCounts.get(agentSessionId) || 0) + 1);
    }
  }

  const rootSessionId = [...sessionCounts.entries()]
    .sort((left, right) => right[1] - left[1])[0]?.[0];
  if (rootSessionId) {
    const prompts = new Set(
      pairs
        .filter((pair) => requestAgentSessionId(pair) === rootSessionId)
        .map((pair) => text(pair.request?.attributes?.['llm.request.message_preview']))
        .filter((prompt): prompt is string => Boolean(prompt)),
    );
    if (prompts.size > 0) {
      return {
        prompts,
        inference: 'dominant-request-session',
        rootSessionId,
        observedSessionCount: sessionCounts.size,
      };
    }
  }

  const counts = new Map<string, number>();
  for (const pair of pairs) {
    const prompt = text(pair.request?.attributes?.['llm.request.message_preview']);
    if (prompt) counts.set(prompt, (counts.get(prompt) || 0) + 1);
  }
  const repeated = new Set(
    [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([prompt]) => prompt),
  );
  if (repeated.size > 0) {
    return {
      prompts: repeated,
      inference: 'repeated-request-preview',
      observedSessionCount: sessionCounts.size,
    };
  }

  const first = pairs
    .map((pair) => text(pair.request?.attributes?.['llm.request.message_preview']))
    .find(Boolean);
  return {
    prompts: first ? new Set([first]) : new Set(),
    inference: 'first-request-preview',
    observedSessionCount: sessionCounts.size,
  };
}

type LlmPair = {
  call: OtelTraceEvent;
  request?: OtelTraceEvent;
  response?: OtelTraceEvent;
};

function isTruthy(value: unknown): boolean {
  return value === true || value === 1 || ['true', '1', 'yes'].includes(String(value || '').trim().toLowerCase());
}

function requestPreview(pair: LlmPair): string | undefined {
  return text(pair.request?.attributes?.['llm.request.message_preview']);
}

function sessionPrompt(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined;
  const match = prompt.match(/<session>\s*([\s\S]*?)\s*<\/session>/i);
  return text(match?.[1]);
}

function isTitleGenerationPair(pair: LlmPair): boolean {
  if (text(pair.request?.attributes?.['llm.request.background_kind']) === 'title_generation') {
    return true;
  }

  const prompt = requestPreview(pair);
  if (!sessionPrompt(prompt) || !/<\/session>[\s\S]*\bWrite the title\b/i.test(prompt || '')) {
    return false;
  }

  const response = parseJson(pair.response?.attributes?.['llm.response.content_text']);
  return Boolean(
    response &&
    typeof response === 'object' &&
    !Array.isArray(response) &&
    text((response as AnyObject).title),
  );
}

function isInternalLlmPair(pair: LlmPair): boolean {
  return isTitleGenerationPair(pair) || [pair.request, pair.call, pair.response].some((event) =>
    isTruthy(event?.attributes?.['actrail.llm.internal'])
  );
}

function primaryTitlePrompt(pairs: LlmPair[]): string | undefined {
  const prompts = pairs
    .filter(isTitleGenerationPair)
    .map((pair) => requestPreview(pair))
    .filter((prompt): prompt is string => Boolean(prompt));
  const prompt = prompts.find((candidate) =>
    !candidate.startsWith('The following is the text to summarize:') &&
    !candidate.startsWith('You are a title generator')
  ) || prompts[0];
  return sessionPrompt(prompt) || prompt;
}

function pairStartMs(pair: LlmPair): number {
  const starts = [pair.request, pair.call, pair.response]
    .map((event) => event?.startTimeMs || 0)
    .filter((value) => value > 0);
  return starts.length > 0
    ? Math.min(...starts)
    : Date.parse(pair.call.receivedAt) || Date.now();
}

function pairEndMs(pair: LlmPair): number {
  const ends = [pair.request, pair.call, pair.response]
    .filter((event): event is OtelTraceEvent => Boolean(event))
    .map(eventEndMs)
    .filter((value) => value > 0);
  return ends.length > 0 ? Math.max(...ends) : pairStartMs(pair);
}

function buildLlmPairs(events: OtelTraceEvent[]): LlmPair[] {
  const byActionId = new Map<string, OtelTraceEvent>();
  for (const event of events) {
    const id = actionId(event);
    if (id) byActionId.set(id, event);
  }

  return events
    .filter((event) => actionKind(event) === 'llm.call')
    .map((call) => ({
      call,
      request: byActionId.get(text(call.attributes?.['llm.call.request_action_id']) || ''),
      response: byActionId.get(text(call.attributes?.['llm.call.response_action_id']) || ''),
    }))
    .sort((left, right) => left.call.startTimeMs - right.call.startTimeMs);
}

export function aggregateActrailTraceEvents(
  sessionId: string,
  events: OtelTraceEvent[],
): ExecutionRecord | null {
  const ordered = events
    .filter((event) => event.sessionId === sessionId)
    .sort((left, right) => left.startTimeMs - right.startTimeMs);
  if (ordered.length === 0) return null;

  const allPairs = buildLlmPairs(ordered);
  const pairs = allPairs.filter((pair) => !isInternalLlmPair(pair));
  if (pairs.length === 0) return null;

  const agentName = selectAgentName(ordered);
  const promptSelection = rootPromptSelection(pairs);
  const titlePrompt = primaryTitlePrompt(allPairs);
  const topLevelPrompts = titlePrompt ? new Set<string>() : promptSelection.prompts;
  const emittedPrompts = new Set<string>();
  const interactions: AnyObject[] = [];
  const allToolCalls: AnyObject[] = [];

  if (titlePrompt) {
    const firstPair = pairs[0];
    const startedAt = pairStartMs(firstPair);
    interactions.push({
      role: 'user',
      content: titlePrompt,
      agent: agentName,
      timestamp: toIso(startedAt),
      timeInfo: {
        created: toIso(startedAt),
        completed: toIso(startedAt),
      },
      traceId: firstPair.call.traceId,
      spanId: (firstPair.call.spanId || actionId(firstPair.call) || 'llm') + ':input',
    });
  }

  for (const pair of pairs) {
    const prompt = text(pair.request?.attributes?.['llm.request.message_preview']);
    const startedAt = pairStartMs(pair);
    const completedAt = pairEndMs(pair);

    if (prompt && topLevelPrompts.has(prompt) && !emittedPrompts.has(prompt)) {
      emittedPrompts.add(prompt);
      interactions.push({
        role: 'user',
        content: prompt,
        agent: agentName,
        timestamp: toIso(startedAt),
        timeInfo: {
          created: toIso(startedAt),
          completed: toIso(startedAt),
        },
        traceId: pair.call.traceId,
        spanId: `${pair.call.spanId || actionId(pair.call) || 'llm'}:input`,
      });
    }

    const responseContent = text(pair.response?.attributes?.['llm.response.content_text']) || '';
    const reasoning = text(pair.response?.attributes?.['llm.response.reasoning_text']);
    const toolCalls = parseToolCalls(pair.response, pair.call);
    allToolCalls.push(...toolCalls);
    const usage = usageFrom(pair.response);
    const status = text(pair.call.attributes?.['actrail.action.status']);
    const errorMessage = status === 'error'
      ? text(pair.call.attributes?.['http.response.reason']) || 'AcTrail recorded an LLM call error'
      : undefined;

    interactions.push({
      role: 'assistant',
      content: responseContent,
      agent: agentName,
      model: pair.call.model || pair.response?.model || pair.request?.model,
      provider: text(pair.response?.attributes?.['llm.response.provider_id']),
      timestamp: toIso(startedAt),
      timeInfo: {
        created: toIso(startedAt),
        completed: toIso(completedAt),
      },
      traceId: pair.call.traceId,
      spanId: pair.call.spanId,
      parentSpanId: pair.call.parentSpanId,
      name: pair.call.name,
      requestMessages: prompt ? [{ role: 'user', content: prompt }] : undefined,
      usage,
      parts: reasoning ? [{ type: 'reasoning', text: reasoning }] : undefined,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      ...(errorMessage ? { status: 'error', error: { message: errorMessage } } : {}),
    });
  }

  const responses = pairs.map((pair) => pair.response).filter(Boolean) as OtelTraceEvent[];
  const totalUsage = responses.reduce(
    (sum, response) => ({
      input: sum.input + response.usage.input_tokens,
      output: sum.output + response.usage.output_tokens,
      reasoning: sum.reasoning + (response.usage.reasoning_tokens || 0),
      total: sum.total + response.usage.total_tokens,
    }),
    { input: 0, output: 0, reasoning: 0, total: 0 },
  );
  const firstEvent = ordered[0];
  const traceStartedAt = Math.min(...pairs.map(pairStartMs));
  const traceCompletedAt = Math.max(...pairs.map(pairEndMs));
  const finalResult = [...interactions]
    .reverse()
    .find((interaction) => interaction.role === 'assistant' && text(interaction.content))
    ?.content || '';
  const query = titlePrompt ||
    interactions.find((interaction) => interaction.role === 'user')?.content ||
    text(pairs[0]?.request?.attributes?.['llm.request.message_preview']) ||
    'AcTrail Session';
  const invokedSkills = skillCalls(allToolCalls);
  const actionCounts = ordered.reduce<Record<string, number>>((counts, event) => {
    const kind = actionKind(event) || 'unknown';
    counts[kind] = (counts[kind] || 0) + 1;
    return counts;
  }, {});
  const unmatchedResponses = ordered.filter((event) =>
    actionKind(event) === 'llm.response' &&
    !allPairs.some((pair) => pair.response === event)
  ).length;

  return {
    task_id: sessionId,
    query,
    framework: 'actrail',
    model: pairs.map((pair) => pair.call.model || pair.response?.model).find(Boolean) || 'unknown',
    tokens: totalUsage.total,
    latency: Math.max(0, traceCompletedAt - traceStartedAt) / 1000,
    final_result: finalResult,
    trace_started_at: toIso(traceStartedAt),
    trace_completed_at: finalResult ? toIso(traceCompletedAt) : undefined,
    timestamp: new Date(traceStartedAt),
    label: 'AcTrail',
    user: firstEvent.user || 'anonymous',
    interactions,
    agent: agentName,
    agentName,
    llm_call_count: pairs.length,
    tool_call_count: allToolCalls.length,
    tool_call_error_count: 0,
    input_tokens: totalUsage.input,
    output_tokens: totalUsage.output,
    reasoning_tokens: totalUsage.reasoning || undefined,
    skills: invokedSkills.map((skill) => skill.name),
    invokedSkills,
    actrail_summary: {
      traceId: firstEvent.traceId,
      displayName: text(firstEvent.attributes?.['actrail.trace.display_name']),
      profileName: text(firstEvent.attributes?.['actrail.trace.profile_name']),
      scopeVersion: text(firstEvent.attributes?.['otel.scope.version']),
      actionCount: ordered.length,
      actionCounts,
      pairedLlmCalls: pairs.filter((pair) => pair.request && pair.response).length,
      internalLlmCallsFiltered: allPairs.length - pairs.length,
      unmatchedResponses,
      userTurnInference: titlePrompt ? 'title-generation-preview' : promptSelection.inference,
      inferredRootAgentSessionId: promptSelection.rootSessionId,
      observedAgentSessionCount: promptSelection.observedSessionCount,
      subagentTreeAvailable: false,
      toolResultsAvailable: false,
    },
  };
}

export const actrailOtelTraceAdapter: OtelTraceAdapter = {
  id: 'actrail',
  matches: (events) => events.some((event) =>
    event.serviceName === 'actrail' ||
    event.attributes?.['otel.scope.name'] === 'actrail.semantic_actions' ||
    event.attributes?.['actrail.action.kind'] !== undefined
  ),
  aggregate: aggregateActrailTraceEvents,
};
