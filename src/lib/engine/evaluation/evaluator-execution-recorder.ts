import { saveExecutionRecord, type ExecutionRecord } from '@/lib/storage/data-service';

interface MessageListClientLike {
  listMessages(sessionId: string): Promise<unknown[]>;
}

interface RecordEvaluatorExecutionInput {
  taskId: string;
  agentName: string;
  user?: string | null;
  query?: string | null;
  framework?: string | null;
  /**
   * 写入 Execution.skill 字段, 让"从 Trace"按 skill 过滤能搜到。caller (runner.ts) 解析:
   *   优先 input.skill (运行时加载的真实 skill) > input.tagSkill (baseline 等的归属标签)。
   * 不传时保留 saveExecutionRecord 自己的 skill 推断逻辑 (从 plugin 上报 / sessionId 反查等)。
   */
  skill?: string | null;
  /** 写入 Execution.skillVersion 字段 (跟 skill 配对, 不传时同样让 saveExecutionRecord 自己推断) */
  skillVersion?: number | null;
  /** Fallback assistant output used when opencode has no persisted messages yet. */
  fallbackOutput?: string | null;
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

  const result = messages
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
        .filter(Boolean) as Record<string, unknown>[];

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
    .filter((interaction) => interaction !== null) as EvaluatorTraceInteraction[];
  return result
    .sort((a, b) => (toTimestamp(a.timeInfo?.created) || 0) - (toTimestamp(b.timeInfo?.created) || 0));
}

function inferTimestampFromInteractions(interactions: EvaluatorTraceInteraction[]): Date {
  const firstCreated = interactions
    .map(interaction => toTimestamp(interaction.timeInfo?.created) ?? toTimestamp(interaction.timestamp))
    .find((value): value is number => Number.isFinite(value));
  return firstCreated ? new Date(firstCreated) : new Date();
}

export function inferCompletionTimestampFromInteractions(interactions: EvaluatorTraceInteraction[]): Date {
  const latest = interactions
    .flatMap(interaction => [
      toTimestamp(interaction.timeInfo?.completed),
      toTimestamp(interaction.timeInfo?.created),
      toTimestamp(interaction.timestamp),
    ])
    .filter((value): value is number => Number.isFinite(value))
    .reduce((max, value) => Math.max(max, value), 0);
  return latest > 0 ? new Date(latest) : new Date();
}

function buildFallbackInteractions(input: RecordEvaluatorExecutionInput): EvaluatorTraceInteraction[] {
  const now = new Date().toISOString();
  const query = String(input.query || '').trim();
  const output = String(input.fallbackOutput || '').trim();
  const interactions: EvaluatorTraceInteraction[] = [];
  if (query) {
    interactions.push({
      role: 'user',
      content: query,
      timestamp: now,
    });
  }
  if (output) {
    interactions.push({
      role: 'assistant',
      content: output,
      timestamp: now,
      agent: String(input.agentName || '').trim() || undefined,
    });
  }
  return interactions;
}

export function ensureEvaluatorExecutionInteractions(
  interactions: EvaluatorTraceInteraction[],
  input: RecordEvaluatorExecutionInput,
): EvaluatorTraceInteraction[] {
  const hasAssistantContent = interactions.some(item =>
    item.role === 'assistant'
    && typeof item.content === 'string'
    && item.content.trim().length > 0,
  );
  const fallback = buildFallbackInteractions(input);

  if (interactions.length === 0) return fallback;
  if (hasAssistantContent || !String(input.fallbackOutput || '').trim()) return interactions;

  const assistantFallback = fallback.find(item => item.role === 'assistant');
  return assistantFallback ? [...interactions, assistantFallback] : interactions;
}

export async function recordEvaluatorExecution(
  client: MessageListClientLike,
  input: RecordEvaluatorExecutionInput,
): Promise<number> {
  const taskId = String(input.taskId || '').trim();
  const agentName = String(input.agentName || '').trim();
  if (!taskId || !agentName) return 0;

  const rawMessages = await client.listMessages(taskId);
  const interactions = ensureEvaluatorExecutionInteractions(
    normalizeEvaluatorExecutionInteractions(Array.isArray(rawMessages) ? rawMessages : []),
    input,
  );

  await saveExecutionRecord({
    task_id: taskId,
    upload_id: taskId,
    query: String(input.query || '').trim() || undefined,
    framework: input.framework || 'opencode',
    user: input.user ?? null,
    agent: agentName,
    agentName,
    final_result: String(input.fallbackOutput || '').trim() || undefined,
    // caller (runner.ts) 给 baseline / grayscale-skill-agent 这些后台 agent 主动填 skill,
    // 让"从 Trace"按 skill 过滤能搜到。不传时让 saveExecutionRecord 自己推断。
    skill: input.skill ?? undefined,
    skill_version: input.skillVersion ?? undefined,
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

// =========================================================================
// 直连 LLM 评测器的 trace 记录（不经过 opencode session）。
//
// 预置评测器（trace-quality / task-completion）的 system prompt 明确禁止派发 subagent /
// 调用工具，本质是"一次 prompt → 一段 JSON"的单轮 judge。这种场景没必要为了拿一条 trace
// 而起一个 ephemeral opencode 进程（实测 spawn→ready 中位数 ~1.5s + session 往返 ~0.14s）。
//
// recordEvaluatorExecution 唯一依赖 opencode 的地方是 `client.listMessages()` —— 用来把
// session 里的真实 message 拉回来。对单轮 judge，我们手里已经有完整的 {system rubric, user prompt,
// assistant 输出, token usage}，直接合成 interactions 落库即可，产出的 trace 与走 opencode 的等价
// （system + user + assistant 三条，没有工具调用）。
// =========================================================================

export interface DirectEvaluatorTraceInput {
  agentName: string;
  /** 列表展示用的短 query（caseInput），写入 Execution.query。 */
  query?: string | null;
  /**
   * 评测器的 system prompt（rubric / 输出 schema）。作为 trace 的 system 一条记录，跟 opencode
   * 路径对齐——opencode 的 listMessages 会带上 system，直连若不显式传就会在链路详情页丢失评测器
   * 的判分依据。注意：模型调用本身始终带 system（见 evaluateXxxDirectAndRecord 的 invoke），这里
   * 只影响 trace 记录是否完整，与评分正确性无关。
   */
  systemPrompt?: string | null;
  /** 实际发给模型的 user 消息（通常是大块 JSON payload），作为 user interaction 正文。 */
  userMessage?: string | null;
  /** 模型返回的评测 JSON 文本，作为 assistant interaction 正文 + final_result。 */
  assistantOutput?: string | null;
  /** 从 LLM 响应里抽出的 token 用量；total 缺省时按 input+output 估算。 */
  usage?: { input?: number; output?: number; total?: number } | null;
  modelID?: string | null;
  /** 本次直连模型调用开始时间。 */
  startedAtISO?: string;
  /** 本次直连模型调用完成时间。 */
  completedAtISO?: string;
  /** 兼容旧测试的单点时间戳；未提供起止时间时作为两者的回退值。 */
  timestampISO?: string;
}

export interface RecordDirectEvaluatorExecutionInput extends DirectEvaluatorTraceInput {
  /** Execution 主键（合成 id，例如 `trace-quality-evaluator-<uuid>`）。 */
  taskId: string;
  user?: string | null;
  skill?: string | null;
  skillVersion?: number | null;
  /** 默认 'direct-llm'，便于在「从 Trace」里区分直连评测与 opencode 评测。 */
  framework?: string | null;
}

/**
 * 纯函数：把一次直连 LLM judge 合成成 trace interactions（system + user + assistant 三条）。
 * 与 saveExecutionRecord 的副作用解耦，方便单测。
 */
export function buildDirectEvaluatorInteractions(
  input: DirectEvaluatorTraceInput,
): EvaluatorTraceInteraction[] {
  const fallbackMs = toTimestamp(input.timestampISO) ?? Date.now();
  const startedAtMs = toTimestamp(input.startedAtISO) ?? fallbackMs;
  const candidateCompletedAtMs = toTimestamp(input.completedAtISO) ?? startedAtMs;
  const completedAtMs = Math.max(startedAtMs, candidateCompletedAtMs);
  const startedAt = new Date(startedAtMs).toISOString();
  const completedAt = new Date(completedAtMs).toISOString();
  const interactions: EvaluatorTraceInteraction[] = [];

  // system rubric 在最前——与 opencode trace 对齐，链路详情页能看到评测器的判分依据。
  const systemContent = String(input.systemPrompt || '').trim();
  if (systemContent) {
    interactions.push({ role: 'system', content: systemContent, timestamp: startedAt });
  }

  const userContent = String(input.userMessage || input.query || '').trim();
  if (userContent) {
    interactions.push({ role: 'user', content: userContent, timestamp: startedAt });
  }

  const assistant = String(input.assistantOutput || '').trim();
  if (assistant) {
    const usage = input.usage
      ? {
          input: input.usage.input,
          output: input.usage.output,
          total:
            typeof input.usage.total === 'number'
              ? input.usage.total
              : (input.usage.input || 0) + (input.usage.output || 0),
        }
      : undefined;
    interactions.push({
      role: 'assistant',
      content: assistant,
      timestamp: startedAt,
      timeInfo: {
        created: startedAt,
        completed: completedAt,
      },
      agent: input.agentName || undefined,
      modelID: input.modelID || undefined,
      usage,
    });
  }

  return interactions;
}

/**
 * 纯函数：把直连评测输入转换为 saveExecutionRecord 契约，供计时字段回归测试。
 */
export function buildDirectEvaluatorExecutionRecord(
  input: RecordDirectEvaluatorExecutionInput,
): ExecutionRecord | null {
  const taskId = String(input.taskId || '').trim();
  const agentName = String(input.agentName || '').trim();
  if (!taskId || !agentName) return null;

  const interactions = buildDirectEvaluatorInteractions(input);
  if (interactions.length === 0) return null;
  const traceStartedAt = inferTimestampFromInteractions(interactions);
  const traceCompletedAt = inferCompletionTimestampFromInteractions(interactions);
  const latencySeconds = Math.max(0, traceCompletedAt.getTime() - traceStartedAt.getTime()) / 1000;

  return {
    task_id: taskId,
    upload_id: taskId,
    query: String(input.query || '').trim() || undefined,
    framework: input.framework || 'direct-llm',
    user: input.user ?? null,
    agent: agentName,
    agentName,
    model: input.modelID ?? undefined,
    final_result: String(input.assistantOutput || '').trim() || undefined,
    skill: input.skill ?? undefined,
    skill_version: input.skillVersion ?? undefined,
    interactions,
    latency: latencySeconds,
    timestamp: traceStartedAt,
    trace_started_at: traceStartedAt,
    skip_evaluation: true,
    skip_internal_judgment: true,
    failures: [],
    skill_issues: [],
    force_query_update: true,
    trace_completed_at: traceCompletedAt,
  };
}

/**
 * 把一次直连 LLM 评测落成一条 Execution/Session trace —— 不需要 opencode client。
 * 返回写入的 interaction 条数（0 表示缺少 taskId/agentName 或内容为空，未落库）。
 */
export async function recordDirectEvaluatorExecution(
  input: RecordDirectEvaluatorExecutionInput,
): Promise<number> {
  const record = buildDirectEvaluatorExecutionRecord(input);
  if (!record) return 0;

  await saveExecutionRecord(record);

  return Array.isArray(record.interactions) ? record.interactions.length : 0;
}

/**
 * 评测传输层开关：默认走直连 LLM（无 opencode 进程）。设 EVAL_FORCE_OPENCODE_TRANSPORT=1
 * 可强制回到旧的 ephemeral-opencode 路径（线上一键回滚，无需改代码）。
 */
export function shouldForceOpencodeEvalTransport(): boolean {
  return process.env.EVAL_FORCE_OPENCODE_TRANSPORT === '1';
}
