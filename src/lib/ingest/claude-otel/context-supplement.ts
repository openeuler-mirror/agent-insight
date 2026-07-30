import type { ClaudeOtelEvent } from './types';

/**
 * 客户端上下文补传(POST /api/ingest/claude/context)的负载 → spool 事件。
 *
 * 拆成纯函数是为了能在没有 DB / HTTP 的情况下测限额与字段映射;路由只负责鉴权和落盘。
 * 事件名与 aggregator 的 CONTEXT_SUPPLEMENT_EVENT 对齐。
 */

export const CONTEXT_SUPPLEMENT_EVENT = 'context_supplement';
export const MAX_CONTEXT_ITEMS = 200;
export const DEFAULT_MAX_TEXT_CHARS = 64_000;

/** 支持的补传类型。都只在客户端本机磁盘上,OTel 事件里拿不到。 */
export const SUPPLEMENT_KINDS = ['system_prompt', 'hook_context', 'tool_output'] as const;
export type SupplementKind = (typeof SUPPLEMENT_KINDS)[number];

export type ContextSupplementItem = {
  kind?: unknown;
  text?: unknown;
  hash?: unknown;
  promptId?: unknown;
  hookEvent?: unknown;
  hookName?: unknown;
  /** tool_output 专属:对应的 tool_use_id,服务端据此把输出挂回那次工具调用 */
  toolUseId?: unknown;
  isError?: unknown;
  capturedAt?: unknown;
};

export type BuildResult = {
  events: ClaudeOtelEvent[];
  /** 被长度上限截断的条数(仅用于回执,便于客户端发现自己配的上限太小) */
  truncated: number;
};

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toIso(value: unknown, fallback: string): string {
  const parsed = typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

export function maxTextChars(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.AGENT_INSIGHT_CLAUDE_CONTEXT_MAX_TEXT);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_TEXT_CHARS;
}

export function buildContextSupplementEvents(
  sessionId: string,
  rawItems: unknown,
  options: { receivedAt: string; maxTextChars: number },
): BuildResult {
  const items = Array.isArray(rawItems) ? rawItems.slice(0, MAX_CONTEXT_ITEMS) : [];
  const events: ClaudeOtelEvent[] = [];
  let truncated = 0;

  items.forEach((raw, index) => {
    const item = (raw || {}) as ContextSupplementItem;
    const kind = asTrimmedString(item.kind) as SupplementKind;
    if (!(SUPPLEMENT_KINDS as readonly string[]).includes(kind)) return;
    const rawText = typeof item.text === 'string' ? item.text : '';
    if (!rawText.trim()) return;
    // 工具输出没有 tool_use_id 就挂不回任何一次调用,直接丢弃
    const toolUseId = asTrimmedString(item.toolUseId);
    if (kind === 'tool_output' && !toolUseId) return;
    const text = rawText.length > options.maxTextChars ? rawText.slice(0, options.maxTextChars) : rawText;
    const wasTruncated = text.length < rawText.length;
    if (wasTruncated) truncated += 1;

    events.push({
      receivedAt: options.receivedAt,
      eventName: CONTEXT_SUPPLEMENT_EVENT,
      // 用客户端记录的采集时间,让补传项在聚合排序里落回它原本的位置
      eventTimestamp: toIso(item.capturedAt, options.receivedAt),
      sequence: index,
      sessionId,
      promptId: asTrimmedString(item.promptId) || undefined,
      // 归属故意不写:trace 属于谁由那批 OTel 日志决定,补传只补内容,不改所有权。
      resource: {},
      attributes: {
        kind,
        text,
        truncated: wasTruncated,
        content_hash: asTrimmedString(item.hash) || undefined,
        hook_event: kind === 'hook_context' ? asTrimmedString(item.hookEvent) || undefined : undefined,
        hook_name: kind === 'hook_context' ? asTrimmedString(item.hookName) || undefined : undefined,
        tool_use_id: kind === 'tool_output' ? toolUseId : undefined,
        is_error: kind === 'tool_output' ? item.isError === true : undefined,
      },
    });
  });

  return { events, truncated };
}
