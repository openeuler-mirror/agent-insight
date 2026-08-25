import type { ExecutionRecord } from '@/lib/storage/data-service';
import type { InvokedSkill } from '@/lib/shared/interaction-utils';
import { readDeepSeekHarnessOtelEventsForSession } from './spool';
import type {
  DeepSeekHarnessOtelAggregationResult,
  DeepSeekHarnessOtelEvent,
} from './types';

type CanonicalToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  output?: any;
  result?: any;
  state?: string;
  timing?: { started_at?: string; completed_at?: string };
};

type WorkingInteraction = {
  role: 'system' | 'user' | 'assistant' | 'subagent';
  content: string;
  agent: string;
  subagent_name?: string;
  subagent_session_id?: string;
  system_prompt_length?: number;
  model?: string;
  modelID?: string;
  reasoning?: string;
  usage?: {
    input: number;
    output: number;
    reasoning: number;
    total: number;
    cache: { read: number; write: number };
  };
  timeInfo?: { created?: string; completed?: string };
  tool_calls?: CanonicalToolCall[];
  _orderMs: number;
  _sourceSessionId: string;
  _turn?: number;
  _step?: number;
};

type ToolEntry = {
  call: CanonicalToolCall;
  interaction: WorkingInteraction;
  args: Record<string, any>;
};

function text(value: any): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function finiteNumber(value: any): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseArguments(value: any): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value };
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function contentText(value: any): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  if (value.type === 'image') return '';
  if (value.type === 'tool-result') return contentText(value.content);
  return contentText(value.text ?? value.content ?? '');
}

function messageContent(body: any): string {
  return contentText(body?.message?.content ?? body?.content).trim();
}

function messageReasoning(body: any): string {
  const blocks = body?.message?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block: any) => block?.type === 'reasoning')
    .map((block: any) => contentText(block))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function visibleAssistantContent(body: any): string {
  const blocks = body?.message?.content;
  if (!Array.isArray(blocks)) return messageContent(body);
  return blocks
    .filter((block: any) => block?.type !== 'reasoning' && block?.type !== 'tool-call')
    .map((block: any) => contentText(block))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function sourceSessionId(event: DeepSeekHarnessOtelEvent): string {
  return event.sourceSessionId || event.sessionId;
}

function eventTimeMs(event: DeepSeekHarnessOtelEvent): number {
  const parsed = Date.parse(event.eventTimestamp || event.receivedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dedupeAndSort(events: DeepSeekHarnessOtelEvent[]): DeepSeekHarnessOtelEvent[] {
  const latest = new Map<string, DeepSeekHarnessOtelEvent>();
  for (const event of events) {
    const identity = event.sequence === undefined
      ? `${sourceSessionId(event)}|ops|${event.eventType}|${event.eventTimestamp}|${JSON.stringify(event.body)}`
      : `${sourceSessionId(event)}|${event.sequence}`;
    const existing = latest.get(identity);
    if (!existing || Date.parse(event.receivedAt) >= Date.parse(existing.receivedAt)) latest.set(identity, event);
  }
  return [...latest.values()].sort((left, right) => (
    eventTimeMs(left) - eventTimeMs(right)
    || sourceSessionId(left).localeCompare(sourceSessionId(right))
    || (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER)
  ));
}

function toolResult(body: any): { output: any; failed: boolean } {
  const blocks = body?.message?.content;
  const resultBlock = Array.isArray(blocks)
    ? blocks.find((block: any) => block?.type === 'tool-result')
    : undefined;
  const output = resultBlock ? contentText(resultBlock.content).trim() : messageContent(body);
  return {
    output,
    failed: resultBlock?.isError === true || Boolean(body?.error),
  };
}

function normalizeToolName(name: string): string {
  const lower = name.trim().toLowerCase();
  return lower === 'subagent' ? 'task' : name;
}

function skillFromArgs(args: Record<string, any>): InvokedSkill | undefined {
  const name = text(args.name ?? args.skill ?? args.skill_name ?? args.skillName);
  if (!name || !/^[a-zA-Z0-9_.-]+$/.test(name)) return undefined;
  const rawVersion = args.version;
  const version = rawVersion === undefined || rawVersion === null || rawVersion === ''
    ? null
    : Number(rawVersion);
  return { name, version: version !== null && Number.isFinite(version) ? version : null };
}

function uniqueSkills(values: InvokedSkill[]): InvokedSkill[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.name}|${value.version ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function turnStepKey(source: string, body: any): string {
  return `${source}|${finiteNumber(body?.turn)}|${finiteNumber(body?.step)}`;
}

export function aggregateDeepSeekHarnessOtelEvents(
  sessionId: string,
  inputEvents: DeepSeekHarnessOtelEvent[],
): ExecutionRecord | null {
  const events = dedupeAndSort(inputEvents.filter((event) => event.sessionId === sessionId));
  if (events.length === 0) return null;

  const rootSourceSessionId = sessionId;
  const agentNames = new Map<string, string>([[rootSourceSessionId, 'DeepSeek Harness']]);
  for (const event of events) {
    if (event.eventType !== 'subagent/descriptor') continue;
    const label = text(event.body?.label ?? event.body?.agentPreset) || 'Subagent';
    agentNames.set(sourceSessionId(event), label);
  }

  let model: string | null = null;
  const interactions: WorkingInteraction[] = [];
  const interactionsByStep = new Map<string, WorkingInteraction>();
  const tools = new Map<string, ToolEntry>();
  const taskEntries: ToolEntry[] = [];
  const skills: InvokedSkill[] = [];
  const seenSystemPromptSources = new Set<string>();
  const failures: NonNullable<ExecutionRecord['failures']> = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let maxSingleCallTokens = 0;
  let llmCallCount = 0;

  const interactionForStep = (event: DeepSeekHarnessOtelEvent): WorkingInteraction => {
    const source = sourceSessionId(event);
    const key = turnStepKey(source, event.body);
    let interaction = interactionsByStep.get(key);
    if (interaction) return interaction;
    const isSubagent = source !== rootSourceSessionId;
    const agent = agentNames.get(source) || (isSubagent ? 'Subagent' : 'DeepSeek Harness');
    interaction = {
      role: isSubagent ? 'subagent' : 'assistant',
      content: '',
      agent,
      ...(isSubagent ? { subagent_name: agent, subagent_session_id: source } : {}),
      timeInfo: { created: event.eventTimestamp },
      tool_calls: [],
      _orderMs: eventTimeMs(event),
      _sourceSessionId: source,
      _turn: finiteNumber(event.body?.turn),
      _step: finiteNumber(event.body?.step),
    };
    interactionsByStep.set(key, interaction);
    interactions.push(interaction);
    return interaction;
  };

  for (const event of events) {
    const body = event.body || {};
    const source = sourceSessionId(event);
    const isSubagent = source !== rootSourceSessionId;

    if (event.eventType === 'request/header') {
      if (!model && source === rootSourceSessionId) model = text(body?.header?.config?.model) || null;
      const systemPrompt = typeof body?.header?.system === 'string' ? body.header.system : '';
      if (systemPrompt.trim() && !seenSystemPromptSources.has(source)) {
        seenSystemPromptSources.add(source);
        const agent = agentNames.get(source) || (isSubagent ? 'Subagent' : 'DeepSeek Harness');
        interactions.push({
          role: 'system',
          content: systemPrompt,
          agent,
          ...(isSubagent ? { subagent_name: agent, subagent_session_id: source } : {}),
          system_prompt_length: systemPrompt.length,
          timeInfo: { created: event.eventTimestamp, completed: event.eventTimestamp },
          _orderMs: eventTimeMs(event),
          _sourceSessionId: source,
        });
      }
      continue;
    }

    if (event.eventType === 'user/message') {
      if (isSubagent) continue;
      if (body?.source?.kind !== 'user') continue;
      const content = messageContent({ message: body });
      if (!content) continue;
      interactions.push({
        role: 'user',
        content,
        agent: agentNames.get(source) || 'DeepSeek Harness',
        timeInfo: { created: event.eventTimestamp, completed: event.eventTimestamp },
        _orderMs: eventTimeMs(event),
        _sourceSessionId: source,
      });
      continue;
    }

    if (event.eventType === 'assistant/message') {
      const interaction = interactionForStep(event);
      const content = visibleAssistantContent(body);
      const reasoning = messageReasoning(body);
      if (content) interaction.content = content;
      if (reasoning) interaction.reasoning = reasoning;
      const eventModel = text(body?.message?.source?.model) || model || undefined;
      if (!model && eventModel) model = eventModel;
      interaction.model = eventModel;
      interaction.modelID = eventModel;
      interaction.timeInfo = {
        created: interaction.timeInfo?.created || event.eventTimestamp,
        completed: event.eventTimestamp,
      };
      const usage = body?.usage || {};
      const input = finiteNumber(usage.inputTokens);
      const output = finiteNumber(usage.outputTokens);
      const reasoningUsage = finiteNumber(usage.reasoningTokens);
      const cacheRead = finiteNumber(usage.cacheReadTokens);
      const cacheWrite = finiteNumber(usage.cacheWriteTokens);
      const total = input + output + cacheRead + cacheWrite;
      interaction.usage = { input, output, reasoning: reasoningUsage, total, cache: { read: cacheRead, write: cacheWrite } };
      inputTokens += input;
      outputTokens += output;
      reasoningTokens += reasoningUsage;
      cacheReadTokens += cacheRead;
      cacheWriteTokens += cacheWrite;
      maxSingleCallTokens = Math.max(maxSingleCallTokens, total);
      llmCallCount += 1;
      continue;
    }

    if (event.eventType === 'tool/call') {
      const interaction = interactionForStep(event);
      const rawName = text(body.name) || 'unknown';
      const name = normalizeToolName(rawName);
      const args = parseArguments(body.arguments);
      if (name === 'task') {
        args.subagent_type = text(args.subagent_type ?? args.agent ?? args.name) || 'subagent';
      }
      if (name.toLowerCase() === 'skill') {
        const skill = skillFromArgs(args);
        if (skill) skills.push(skill);
      }
      const callId = text(body.callId) || `tool-${source}-${event.sequence ?? eventTimeMs(event)}`;
      const call: CanonicalToolCall = {
        id: callId,
        type: 'function',
        function: { name, arguments: typeof body.arguments === 'string' ? body.arguments : JSON.stringify(args) },
        state: 'running',
        timing: { started_at: event.eventTimestamp },
      };
      interaction.tool_calls = interaction.tool_calls || [];
      interaction.tool_calls.push(call);
      const entry = { call, interaction, args };
      tools.set(callId, entry);
      if (name === 'task') taskEntries.push(entry);
      continue;
    }

    if (event.eventType === 'tool/result') {
      const callId = text(body?.message?.source?.callId)
        || text(body?.message?.content?.[0]?.toolCallId)
        || text(body.callId);
      const entry = callId ? tools.get(callId) : undefined;
      if (!entry) continue;
      const result = toolResult(body);
      entry.call.output = result.output;
      entry.call.result = result.output;
      entry.call.state = result.failed ? 'error' : 'completed';
      entry.call.timing = { ...entry.call.timing, completed_at: event.eventTimestamp };
      continue;
    }

    if (event.eventType === 'turn/end') {
      const reason = body?.reason;
      if (reason?.kind === 'error') {
        failures.push({
          failure_type: 'turn_error',
          description: text(reason?.error?.message) || 'DeepSeek Harness turn failed',
          context: JSON.stringify(reason.error || reason),
          recovery: 'Inspect the failing model or tool event in this Trace.',
        });
      } else if (reason?.kind === 'aborted' || reason?.kind === 'blocked' || reason?.kind === 'max-tokens') {
        failures.push({
          failure_type: `turn_${reason.kind}`,
          description: `DeepSeek Harness turn ended with ${reason.kind}`,
          context: JSON.stringify(reason),
          recovery: 'Inspect the turn boundary and preceding events.',
        });
      }
    }
  }

  const childSessions = [...agentNames.keys()].filter((source) => source !== rootSourceSessionId);
  const unclaimedTasks = taskEntries.filter((entry) => !text(entry.args.subagent_session_id));
  for (const childSession of childSessions) {
    const childName = (agentNames.get(childSession) || 'subagent').toLowerCase();
    const match = unclaimedTasks.find((entry) => {
      const type = text(entry.args.subagent_type)?.toLowerCase();
      return !type || type === 'subagent' || childName.includes(type) || type.includes(childName);
    }) || unclaimedTasks[0];
    if (!match) continue;
    match.args.subagent_session_id = childSession;
    match.call.function.arguments = JSON.stringify(match.args);
    unclaimedTasks.splice(unclaimedTasks.indexOf(match), 1);
  }

  interactions.sort((left, right) => left._orderMs - right._orderMs);
  const cleanInteractions = interactions.map((interaction) => {
    const { _orderMs, _sourceSessionId, _turn, _step, ...clean } = interaction;
    return clean;
  });
  const rootInteractions = interactions.filter((interaction) => interaction._sourceSessionId === rootSourceSessionId);
  const query = rootInteractions.find((interaction) => interaction.role === 'user' && interaction.content.trim())?.content
    || `DeepSeek Harness Session ${sessionId}`;
  const finalResult = [...rootInteractions].reverse()
    .find((interaction) => interaction.role === 'assistant' && interaction.content.trim())?.content
    || '[No final text output]';
  const firstAt = eventTimeMs(events[0]);
  const lastAt = eventTimeMs(events[events.length - 1]);
  const user = events.map((event) => text(event.user)).find(Boolean) || null;
  const invokedSkills = uniqueSkills(skills);
  const parentSessionId = events.map((event) => text(event.attributes?.['session.parent_id'])).find(Boolean);
  const seedLength = events.map((event) => finiteNumber(event.attributes?.['session.seed_length'])).find((value) => value > 0);
  const rootAgentName = agentNames.get(rootSourceSessionId) || 'DeepSeek Harness';

  return {
    task_id: sessionId,
    query,
    framework: 'deepseek-harness',
    model,
    tokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    latency: Math.max(0, lastAt - firstAt) / 1000,
    timestamp: events[0].eventTimestamp,
    trace_started_at: events[0].eventTimestamp,
    trace_completed_at: events[events.length - 1].eventTimestamp,
    final_result: finalResult,
    interactions: cleanInteractions,
    skills: invokedSkills.map((skill) => skill.name),
    invokedSkills,
    agent: rootAgentName,
    agentName: rootAgentName,
    agents: Array.from(new Set(agentNames.values())),
    user,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: reasoningTokens,
    cache_read_input_tokens: cacheReadTokens,
    cache_creation_input_tokens: cacheWriteTokens,
    max_single_call_tokens: maxSingleCallTokens,
    llm_call_count: llmCallCount,
    tool_call_count: tools.size,
    tool_call_error_count: [...tools.values()].filter((entry) => entry.call.state === 'error').length,
    failures,
    parent_session_id: parentSessionId,
    seed_length: seedLength,
    session_merge_strategy: 'snapshot-replace',
  };
}

export function aggregateDeepSeekHarnessOtelSession(sessionId: string): DeepSeekHarnessOtelAggregationResult {
  const events = readDeepSeekHarnessOtelEventsForSession(sessionId);
  const record = aggregateDeepSeekHarnessOtelEvents(sessionId, events);
  if (record) return { sessionId, record, eventCount: events.length, disposition: 'persisted' };
  return {
    sessionId,
    record: null,
    eventCount: events.length,
    disposition: events.length === 0 ? 'retry-later' : 'discard',
  };
}
