import { saveExecutionRecord } from '@/lib/storage/data-service';

interface MessageListClientLike {
  listMessages(sessionId: string): Promise<unknown[]>;
}

interface RecordEvaluatorExecutionInput {
  taskId: string;
  agentName: string;
  user?: string | null;
  query?: string | null;
  framework?: string | null;
}

interface OpencodeTokenUsage {
  input?: unknown;
  output?: unknown;
  reasoning?: unknown;
  cache?: {
    read?: unknown;
    write?: unknown;
  } | null;
}

interface OpencodeTimeInfo {
  created?: unknown;
  completed?: unknown;
}

export interface EvaluatorTraceInteraction {
  role: string;
  content?: string;
  timestamp?: string;
  timeInfo?: { created?: unknown; completed?: unknown };
  agent?: string;
  modelID?: string;
  providerID?: string;
  cost?: unknown;
  tool_calls?: Array<Record<string, unknown>>;
  usage?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
    total?: number;
  };
}

function toFiniteNumber(value: unknown): number | undefined {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string'
    ? Number(value)
    : NaN;
  return Number.isFinite(numeric) ? numeric : undefined;
}

function toTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? numeric : null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function usageTotalsFromTokens(tokens: OpencodeTokenUsage | null | undefined) {
  const input = toFiniteNumber(tokens?.input) || 0;
  const rawOutput = toFiniteNumber(tokens?.output) || 0;
  const reasoning = toFiniteNumber(tokens?.reasoning) || 0;
  const cacheRead = toFiniteNumber(tokens?.cache?.read) || 0;
  const cacheWrite = toFiniteNumber(tokens?.cache?.write) || 0;
  const output = reasoning > 0 && rawOutput < reasoning ? rawOutput + reasoning : rawOutput;
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total: input + output + reasoning + cacheRead + cacheWrite,
  };
}

function stringifyJson(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function extractTextFromParts(parts: unknown[]): string {
  const texts = parts
    .map(part => {
      if (!part || typeof part !== 'object') return '';
      const typedPart = part as Record<string, unknown>;
      return String(typedPart.type || '').toLowerCase() === 'text'
        ? String(typedPart.text || '')
        : '';
    })
    .filter(Boolean);
  return texts.join('');
}

function normalizeRole(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : 'assistant';
}

function isRawOpencodeMessage(value: unknown): value is { info?: Record<string, unknown>; parts?: unknown[] } {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const info = record.info;
  if (!info || typeof info !== 'object') return false;
  const parts = record.parts;
  return Array.isArray(parts) || Array.isArray((info as Record<string, unknown>).parts);
}

export function normalizeEvaluatorExecutionInteractions(messages: unknown[]): EvaluatorTraceInteraction[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  return messages
    .map(message => {
      if (!isRawOpencodeMessage(message)) return null;
      const info = (message.info || {}) as Record<string, unknown>;
      const parts = Array.isArray(message.parts)
        ? message.parts
        : Array.isArray(info.parts)
        ? info.parts as unknown[]
        : [];
      const role = normalizeRole(info.role);
      const created = (info.time as OpencodeTimeInfo | undefined)?.created;
      const completed = (info.time as OpencodeTimeInfo | undefined)?.completed;
      const createdTimestamp = toTimestamp(created);
      const content = role === 'user'
        ? extractTextFromParts(parts) || String(info.system || '')
        : extractTextFromParts(parts);

      const toolCalls = parts
        .map(part => {
          if (!part || typeof part !== 'object') return null;
          const typedPart = part as Record<string, unknown>;
          if (String(typedPart.type || '').toLowerCase() !== 'tool') return null;
          const state = typedPart.state && typeof typedPart.state === 'object'
            ? typedPart.state as Record<string, unknown>
            : {};
          return {
            id: typedPart.callID || typedPart.callId || typedPart.id,
            type: 'function',
            function: {
              name: typedPart.tool,
              arguments: stringifyJson(state.input),
            },
            state: state.status || state.state,
            output: state.output,
          } satisfies Record<string, unknown>;
        })
        .filter((toolCall): toolCall is Record<string, unknown> => Boolean(toolCall));

      const tokens = info.tokens && typeof info.tokens === 'object'
        ? info.tokens as OpencodeTokenUsage
        : undefined;
      const usage = tokens
        ? {
            input: toFiniteNumber(tokens.input),
            output: toFiniteNumber(tokens.output),
            reasoning: toFiniteNumber(tokens.reasoning),
            cache: {
              read: toFiniteNumber(tokens.cache?.read),
              write: toFiniteNumber(tokens.cache?.write),
            },
            total: usageTotalsFromTokens(tokens).total,
          }
        : undefined;

      return {
        role,
        content: content || undefined,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        usage,
        timestamp: createdTimestamp !== null ? new Date(createdTimestamp).toISOString() : undefined,
        timeInfo: created != null || completed != null ? { created, completed } : undefined,
        agent: typeof info.agent === 'string' ? info.agent : undefined,
        modelID: typeof info.modelID === 'string' ? info.modelID : undefined,
        providerID: typeof info.providerID === 'string' ? info.providerID : undefined,
        cost: info.cost,
      } satisfies EvaluatorTraceInteraction;
    })
    .filter((interaction): interaction is EvaluatorTraceInteraction => Boolean(interaction))
    .sort((a, b) => (toTimestamp(a.timeInfo?.created) || 0) - (toTimestamp(b.timeInfo?.created) || 0));
}

function inferTimestampFromInteractions(interactions: EvaluatorTraceInteraction[]): Date {
  const firstCreated = interactions
    .map(interaction => toTimestamp(interaction.timeInfo?.created) ?? toTimestamp(interaction.timestamp))
    .find((value): value is number => Number.isFinite(value));
  return firstCreated ? new Date(firstCreated) : new Date();
}

export async function recordEvaluatorExecution(
  client: MessageListClientLike,
  input: RecordEvaluatorExecutionInput,
): Promise<number> {
  const taskId = String(input.taskId || '').trim();
  const agentName = String(input.agentName || '').trim();
  if (!taskId || !agentName) return 0;

  const rawMessages = await client.listMessages(taskId);
  const interactions = normalizeEvaluatorExecutionInteractions(Array.isArray(rawMessages) ? rawMessages : []);

  await saveExecutionRecord({
    task_id: taskId,
    upload_id: taskId,
    query: String(input.query || '').trim() || undefined,
    framework: input.framework || 'opencode',
    user: input.user ?? null,
    agent: agentName,
    agentName,
    interactions,
    timestamp: inferTimestampFromInteractions(interactions),
    skip_evaluation: true,
    skip_internal_judgment: true,
    failures: [],
    skill_issues: [],
    force_query_update: true,
    opencode_cli_completed: true,
  });

  return interactions.length;
}
