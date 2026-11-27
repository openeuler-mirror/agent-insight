/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
/** subagent_map 的 text 是结构化 JSON,截一刀就整段废了 —— 不参与 maxTextChars,超这个硬上限直接整条丢弃 */
export const MAX_SUBAGENT_MAP_CHARS = 128_000;

/**
 * 支持的补传类型。都只在客户端本机磁盘上,OTel 事件里拿不到。
 *
 * subagent_map:子 agent 归属映射。text 是一段 JSON:
 * `{toolUseId, agentType, spawnDepth, messageUuids[], toolUseIds[]}` ——
 * 来自客户端 `<transcript 同目录>/<sessionId>/subagents/agent-*.jsonl` 及配套 meta.json。
 * OTel 事件不带 agent 标识,聚合器靠 messageUuids 匹配 assistant_response 的
 * message.uuid、靠 toolUseIds 匹配 tool_result 的 tool_use_id,把平铺在 root 的
 * 子 agent 内部轮次逐轮归还给 `<session>:<toolUseId>` 那个子 agent 节点。
 *
 * turn_end:一轮结束信号。Claude Code 的 OTel 日志没有会话级结束事件,服务端只能等
 * 十分钟无活动判超时;hook 是唯一的显式结束点。text 为空,只带 hook 事件名与客户端
 * 采集时间(服务端按事件时间落完成时刻,避免跨机时钟偏差)。
 */
export const SUPPLEMENT_KINDS = ['system_prompt', 'hook_context', 'tool_output', 'subagent_map', 'turn_end'] as const;
export type SupplementKind = (typeof SUPPLEMENT_KINDS)[number];

/**
 * 只有这几种 hook 能当整轮结束:Stop/SessionEnd 是正常结束,StopFailure 是失败结束。
 * SubagentStop 只表示子 agent 结束,整轮可能还在跑,绝不能据此完成 trace。
 */
export const TURN_END_HOOK_EVENTS = ['Stop', 'SessionEnd', 'StopFailure'] as const;

export type ContextSupplementItem = {
  kind?: unknown;
  text?: unknown;
  hash?: unknown;
  promptId?: unknown;
  hookEvent?: unknown;
  hookName?: unknown;
  /** tool_output 专属:对应的 tool_use_id,服务端据此把输出挂回那次工具调用 */
  toolUseId?: unknown;
  /** system_prompt 专属:子 Agent 类型,和 toolUseId 一起限定 system prompt scope */
  agentType?: unknown;
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
    if (kind === 'turn_end') {
      const hookEvent = asTrimmedString(item.hookEvent);
      if (!(TURN_END_HOOK_EVENTS as readonly string[]).includes(hookEvent)) return;
      events.push({
        receivedAt: options.receivedAt,
        eventName: CONTEXT_SUPPLEMENT_EVENT,
        eventTimestamp: toIso(item.capturedAt, options.receivedAt),
        sequence: index,
        sessionId,
        promptId: asTrimmedString(item.promptId) || undefined,
        resource: {},
        attributes: { kind, hook_event: hookEvent },
      });
      return;
    }
    const rawText = typeof item.text === 'string' ? item.text : '';
    if (!rawText.trim()) return;
    // 工具输出/子 agent 映射没有 tool_use_id 就挂不回任何一次调用,直接丢弃
    const toolUseId = asTrimmedString(item.toolUseId);
    if ((kind === 'tool_output' || kind === 'subagent_map') && !toolUseId) return;
    if (kind === 'subagent_map' && rawText.length > MAX_SUBAGENT_MAP_CHARS) return;
    const text = kind === 'subagent_map' || rawText.length <= options.maxTextChars
      ? rawText
      : rawText.slice(0, options.maxTextChars);
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
        tool_use_id: kind === 'system_prompt' || kind === 'tool_output' || kind === 'subagent_map' ? toolUseId || undefined : undefined,
        agent_type: kind === 'system_prompt' ? asTrimmedString(item.agentType) || undefined : undefined,
        is_error: kind === 'tool_output' ? item.isError === true : undefined,
      },
    });
  });

  return { events, truncated };
}
