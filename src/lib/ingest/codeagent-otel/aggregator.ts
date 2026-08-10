import type { ExecutionRecord } from '@/lib/storage/data-service';
import type { InvokedSkill } from '@/lib/shared/interaction-utils';
import { readCodeAgentOtelEventsForSession, type CodeAgentOtelEvent } from './spool';

export type CodeAgentOtelAggregationResult = {
  sessionId: string;
  record: ExecutionRecord | null;
  eventCount: number;
};

type CanonicalToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  output?: any;
  result?: any;
  state?: string;
  timing?: { started_at?: string; completed_at?: string };
  codeagent_original_name?: string;
};

type CanonicalInteraction = {
  role: 'user' | 'assistant' | 'subagent';
  content: string;
  agent?: string;
  subagent_name?: string;
  subagent_session_id?: string;
  model?: string;
  modelID?: string;
  usage?: {
    input: number;
    output: number;
    reasoning: number;
    total: number;
    cache: { read: number; write: number };
  };
  timeInfo?: { created?: string; completed?: string };
  tool_calls?: CanonicalToolCall[];
  _orderMs?: number;
  _runId?: string;
};

type ToolEntry = {
  call: CanonicalToolCall;
  interaction: CanonicalInteraction;
  parentRunId: string;
  args: Record<string, any>;
  startedAt?: string;
};

const HIDDEN_BACKGROUND_QUERY_SOURCES = new Set([
  'extract_memories',
  'auto_dream',
]);

function asString(value: any): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function asNumber(value: any): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function parseJson(value: any): any {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function asArgs(value: any): Record<string, any> {
  const parsed = parseJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...parsed } : {};
}

function eventTimestamp(event: CodeAgentOtelEvent): string {
  return event.eventTimestamp || event.receivedAt;
}

function eventTimeMs(event: CodeAgentOtelEvent): number {
  const value = Date.parse(eventTimestamp(event));
  return Number.isFinite(value) ? value : 0;
}

function eventRunId(event: CodeAgentOtelEvent, sessionId: string): string {
  const attributes = event.attributes || {};
  const explicit = asString(attributes['execution.agent_run_id']);
  if (explicit) return explicit;
  const agentId = asString(attributes.agent_id);
  return agentId && agentId !== 'main' ? agentId : sessionId;
}

function eventAgentName(event: CodeAgentOtelEvent, runId: string, sessionId: string): string {
  const attributes = event.attributes || {};
  return asString(attributes.agent_name) ||
    asString(attributes['execution.agent_id']) ||
    (runId === sessionId ? 'CodeAgent' : 'Subagent');
}

function hiddenBackgroundRunIds(events: CodeAgentOtelEvent[], sessionId: string): Set<string> {
  const runIds = new Set<string>();
  for (const event of events) {
    if (event.eventName !== 'api_request') continue;
    const attributes = event.attributes || {};
    const querySource = asString(attributes.query_source);
    if (!querySource || !HIDDEN_BACKGROUND_QUERY_SOURCES.has(querySource)) continue;
    const runId = eventRunId(event, sessionId);
    const parentRunId = asString(attributes['execution.parent_agent_run_id']);
    if (runId !== sessionId && parentRunId === sessionId) runIds.add(runId);
  }
  return runIds;
}

function eventKey(event: CodeAgentOtelEvent): string {
  const attributes = event.attributes || {};
  return [
    event.eventName,
    event.eventTimestamp,
    event.spanId,
    attributes.inference_id,
    attributes.tool_call_id,
    attributes['execution.agent_run_id'],
  ].map((value) => String(value || '')).join('|');
}

function dedupeAndSort(events: CodeAgentOtelEvent[]): CodeAgentOtelEvent[] {
  const seen = new Set<string>();
  return [...events]
    .sort((left, right) => eventTimeMs(left) - eventTimeMs(right) || (left.sequence || 0) - (right.sequence || 0))
    .filter((event) => {
      const key = eventKey(event);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeToolName(name: string): { canonical: string; original?: string } {
  const lower = name.toLowerCase();
  if (lower === 'agent' || lower === 'task') return { canonical: 'task', original: name };
  if (lower === 'skill') return { canonical: 'skill', original: name };
  return { canonical: name };
}

function toolOutput(attributes: Record<string, any>): any {
  const value = attributes.response_body ?? attributes.result ?? attributes.output ?? attributes.tool_result;
  return parseJson(value);
}

function findAgentId(value: any, depth = 0): string | undefined {
  if (value == null || depth > 4) return undefined;
  const parsed = parseJson(value);
  if (parsed !== value) return findAgentId(parsed, depth + 1);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAgentId(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== 'object') return undefined;
  const record = value as Record<string, any>;
  const direct = record.agentId ?? record.agent_id ?? record.subagent_session_id ?? record.session_id;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  for (const item of Object.values(record)) {
    const found = findAgentId(item, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function contentText(value: any): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => contentText(item?.text ?? item?.content ?? item)).filter(Boolean).join("\n");
  if (value && typeof value === "object") return contentText(value.text ?? value.content ?? "");
  return "";
}

function userTextFromRequest(value: any): string | undefined {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return undefined;
  for (const message of parsed) {
    if (String(message?.role || "").toLowerCase() !== "user") continue;
    const text = contentText(message?.content).trim();
    if (text) return text;
  }
  return undefined;
}

function uniqueSkills(skills: InvokedSkill[]): InvokedSkill[] {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    if (seen.has(skill.name)) return false;
    seen.add(skill.name);
    return true;
  });
}

export function aggregateCodeAgentOtelEvents(
  sessionId: string,
  inputEvents: CodeAgentOtelEvent[],
): ExecutionRecord | null {
  const sessionEvents = dedupeAndSort(inputEvents.filter((event) => event.sessionId === sessionId));
  const hiddenRunIds = hiddenBackgroundRunIds(sessionEvents, sessionId);
  const events = sessionEvents.filter((event) => !hiddenRunIds.has(eventRunId(event, sessionId)));
  if (events.length === 0) return null;

  const agentNames = new Map<string, string>();
  const parentRuns = new Map<string, string>();
  for (const event of events) {
    const runId = eventRunId(event, sessionId);
    const attributes = event.attributes || {};
    const explicitAgentName = asString(attributes.agent_name) || asString(attributes['execution.agent_id']);
    if (explicitAgentName || !agentNames.has(runId)) {
      agentNames.set(runId, explicitAgentName || eventAgentName(event, runId, sessionId));
    }
    const parent = asString(attributes['execution.parent_agent_run_id']);
    if (runId !== sessionId && parent) parentRuns.set(runId, parent);
  }
  agentNames.set(sessionId, agentNames.get(sessionId) || 'CodeAgent');
  const rootAgentName = agentNames.get(sessionId)!;

  const requestByInference = new Map<string, CodeAgentOtelEvent>();
  for (const event of events) {
    if (event.eventName !== 'api_request') continue;
    const inferenceId = asString(event.attributes?.inference_id) || event.spanId;
    if (inferenceId) requestByInference.set(inferenceId, event);
  }

  const turnsByInference = new Map<string, CanonicalInteraction>();
  const interactions: CanonicalInteraction[] = [];
  const userPromptKeys = new Set<string>();
  for (const event of events) {
    if (event.eventName !== 'user_prompt') continue;
    const prompt = asString(event.attributes?.prompt);
    if (!prompt) continue;
    const promptKey = asString(event.attributes?.prompt_id) || prompt;
    if (userPromptKeys.has(promptKey)) continue;
    userPromptKeys.add(promptKey);
    interactions.push({
      role: 'user',
      content: prompt,
      agent: rootAgentName,
      timeInfo: { created: eventTimestamp(event), completed: eventTimestamp(event) },
      _orderMs: eventTimeMs(event),
      _runId: sessionId,
    });
  }

  if (interactions.length === 0) {
    const request = events.find((event) =>
      event.eventName === 'api_request' &&
      eventRunId(event, sessionId) === sessionId &&
      userTextFromRequest(event.attributes?.request_text),
    );
    const prompt = request ? userTextFromRequest(request.attributes?.request_text) : undefined;
    if (request && prompt) {
      interactions.push({
        role: 'user',
        content: prompt,
        agent: rootAgentName,
        timeInfo: { created: eventTimestamp(request), completed: eventTimestamp(request) },
        _orderMs: eventTimeMs(request),
        _runId: sessionId,
      });
    }
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let totalTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let maxSingleCallTokens = 0;
  let model: string | null = null;

  for (const event of events) {
    if (event.eventName !== 'api_response') continue;
    const attributes = event.attributes || {};
    const inferenceId = asString(attributes.inference_id) || event.spanId || `${eventTimeMs(event)}`;
    const runId = eventRunId(event, sessionId);
    const request = requestByInference.get(inferenceId);
    const input = asNumber(attributes.input_token_count);
    const output = asNumber(attributes.output_token_count);
    const reasoning = asNumber(attributes.thoughts_token_count);
    const cacheRead = asNumber(attributes.cached_content_token_count);
    const cacheWrite = asNumber(attributes.cache_creation_token_count);
    const total = asNumber(attributes.total_token_count) || input + output + cacheRead + cacheWrite;
    const eventModel = asString(attributes.model) || asString(attributes.model_id) || asString(attributes.model_version);
    if (!model && eventModel) model = eventModel;
    inputTokens += input;
    outputTokens += output;
    reasoningTokens += reasoning;
    totalTokens += total;
    cacheReadTokens += cacheRead;
    cacheWriteTokens += cacheWrite;
    maxSingleCallTokens = Math.max(maxSingleCallTokens, total);

    const isSubagent = runId !== sessionId;
    const agentName = agentNames.get(runId) || eventAgentName(event, runId, sessionId);
    const interaction: CanonicalInteraction = {
      role: isSubagent ? 'subagent' : 'assistant',
      content: asString(attributes.response_text) || asString(attributes.reasoning_text) || '',
      agent: agentName,
      ...(isSubagent ? { subagent_name: agentName, subagent_session_id: runId } : {}),
      model: eventModel,
      modelID: eventModel,
      usage: { input, output, reasoning, total, cache: { read: cacheRead, write: cacheWrite } },
      timeInfo: {
        created: request ? eventTimestamp(request) : eventTimestamp(event),
        completed: eventTimestamp(event),
      },
      tool_calls: [],
      _orderMs: request ? eventTimeMs(request) : eventTimeMs(event),
      _runId: runId,
    };
    turnsByInference.set(inferenceId, interaction);
    interactions.push(interaction);
  }

  const toolEntries = new Map<string, ToolEntry>();
  const taskEntries: ToolEntry[] = [];
  const invokedSkills: InvokedSkill[] = [];

  for (const event of events) {
    if (event.eventName !== 'tool_request') continue;
    const attributes = event.attributes || {};
    const inferenceId = asString(attributes.inference_id) || event.spanId || `${eventTimeMs(event)}`;
    const runId = eventRunId(event, sessionId);
    let interaction = turnsByInference.get(inferenceId);
    if (!interaction) {
      const isSubagent = runId !== sessionId;
      const agentName = agentNames.get(runId) || eventAgentName(event, runId, sessionId);
      interaction = {
        role: isSubagent ? 'subagent' : 'assistant',
        content: '',
        agent: agentName,
        ...(isSubagent ? { subagent_name: agentName, subagent_session_id: runId } : {}),
        tool_calls: [],
        timeInfo: { created: eventTimestamp(event) },
        _orderMs: eventTimeMs(event),
        _runId: runId,
      };
      turnsByInference.set(inferenceId, interaction);
      interactions.push(interaction);
    }

    const originalName = asString(attributes.function_name) || 'unknown';
    const normalizedName = normalizeToolName(originalName);
    const args = asArgs(attributes.function_args);
    const skillName = asString(attributes.skill_name);
    if (normalizedName.canonical === 'skill' && skillName && !args.skill && !args.name) args.skill = skillName;
    if (normalizedName.canonical === 'skill') {
      const name = asString(args.skill) || asString(args.skill_name) || asString(args.name);
      if (name) invokedSkills.push({ name, version: Number.isFinite(Number(args.version)) ? Number(args.version) : null });
    }
    if (normalizedName.canonical === 'task') {
      args.subagent_type = String(args.subagent_type || args.agent || args.agent_name || 'subagent').trim().toLowerCase();
    }

    const id = asString(attributes.tool_call_id) || event.spanId || `tool-${eventTimeMs(event)}`;
    const call: CanonicalToolCall = {
      id,
      type: 'function',
      function: { name: normalizedName.canonical, arguments: JSON.stringify(args) },
      state: 'running',
      timing: { started_at: eventTimestamp(event) },
      ...(normalizedName.original ? { codeagent_original_name: normalizedName.original } : {}),
    };
    interaction.tool_calls = interaction.tool_calls || [];
    interaction.tool_calls.push(call);
    const entry = { call, interaction, parentRunId: runId, args, startedAt: eventTimestamp(event) };
    toolEntries.set(id, entry);
    if (event.spanId) toolEntries.set(`span:${event.spanId}`, entry);
    if (normalizedName.canonical === 'task') taskEntries.push(entry);
  }

  for (const event of events) {
    if (event.eventName !== 'tool_response') continue;
    const attributes = event.attributes || {};
    const id = asString(attributes.tool_call_id);
    const entry = (id ? toolEntries.get(id) : undefined) || (event.spanId ? toolEntries.get(`span:${event.spanId}`) : undefined);
    if (!entry) continue;
    const output = toolOutput(attributes);
    entry.call.output = output;
    entry.call.result = output;
    const status = asString(attributes.result_status) || (attributes.success === false ? 'error' : 'completed');
    entry.call.state = status === 'completed' || status === 'success' ? 'completed' : status;
    entry.call.timing = { ...entry.call.timing, completed_at: eventTimestamp(event) };
    if (entry.call.function.name === 'task') {
      const agentId = findAgentId(output);
      if (agentId) entry.args.subagent_session_id = agentId;
      entry.call.function.arguments = JSON.stringify(entry.args);
    }
  }

  const childRuns = Array.from(agentNames.keys()).filter((runId) => runId !== sessionId);
  for (const childRunId of childRuns) {
    const parentRunId = parentRuns.get(childRunId) || sessionId;
    const childName = (agentNames.get(childRunId) || 'subagent').toLowerCase();
    const entry = taskEntries.find((candidate) => {
      if (candidate.parentRunId !== parentRunId || candidate.args.subagent_session_id) return false;
      const type = String(candidate.args.subagent_type || '').toLowerCase();
      return !type || type === 'subagent' || childName.includes(type) || type.includes(childName);
    }) || taskEntries.find((candidate) => candidate.parentRunId === parentRunId && !candidate.args.subagent_session_id);
    if (!entry) continue;
    entry.args.subagent_session_id = childRunId;
    if (!entry.args.subagent_type || entry.args.subagent_type === 'subagent') {
      entry.args.subagent_type = agentNames.get(childRunId) || 'subagent';
    }
    entry.call.function.arguments = JSON.stringify(entry.args);
  }

  interactions.sort((left, right) => (left._orderMs || 0) - (right._orderMs || 0));
  const cleanInteractions = interactions.map(({ _orderMs, _runId, ...interaction }) => interaction);
  const rootMessages = cleanInteractions.filter((interaction) => interaction.role !== 'subagent');
  const requestQuery = events
    .filter((event) => event.eventName === 'api_request' && eventRunId(event, sessionId) === sessionId)
    .map((event) => userTextFromRequest(event.attributes?.request_text))
    .find(Boolean);
  const query = rootMessages.find((interaction) => interaction.role === 'user' && interaction.content.trim())?.content ||
    requestQuery ||
    `CodeAgent Session ${sessionId}`;
  const finalResult = [...rootMessages].reverse().find((interaction) => interaction.role === 'assistant' && interaction.content.trim())?.content ||
    '[No final text output]';
  const toolCalls = Array.from(new Set(Array.from(toolEntries.values()).map((entry) => entry.call)));
  const firstAt = eventTimeMs(events[0]);
  const lastAt = eventTimeMs(events[events.length - 1]);
  const user = events.map((event) => event.user).find((value) => typeof value === 'string' && value.trim()) || null;
  const skills = uniqueSkills(invokedSkills);

  return {
    task_id: sessionId,
    query,
    framework: 'codeagent',
    model,
    tokens: totalTokens,
    latency: Math.max(0, lastAt - firstAt) / 1000,
    timestamp: eventTimestamp(events[0]),
    trace_completed_at: eventTimestamp(events[events.length - 1]),
    final_result: finalResult,
    interactions: cleanInteractions,
    skills: skills.map((skill) => skill.name),
    invokedSkills: skills,
    agent: rootAgentName,
    agentName: rootAgentName,
    agents: Array.from(new Set(agentNames.values())),
    user,
    tool_call_count: toolCalls.length,
    llm_call_count: events.filter((event) => event.eventName === 'api_response').length,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: reasoningTokens,
    tool_call_error_count: toolCalls.filter((call) => call.state === 'error' || call.state === 'failed').length,
    cache_read_input_tokens: cacheReadTokens,
    cache_creation_input_tokens: cacheWriteTokens,
    max_single_call_tokens: maxSingleCallTokens,
    session_merge_strategy: 'snapshot-replace',
  };
}

export function aggregateCodeAgentOtelSession(sessionId: string): CodeAgentOtelAggregationResult {
  const events = readCodeAgentOtelEventsForSession(sessionId);
  return {
    sessionId,
    eventCount: events.length,
    record: aggregateCodeAgentOtelEvents(sessionId, events),
  };
}
