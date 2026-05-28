import crypto from 'node:crypto';

import { buildFaultPathSteps } from '@/lib/engine/observability/fault-path';
import type { DebugToolCall, DebugTurn } from './types';

type AnyRecord = Record<string, unknown>;
type AnchorInfo = {
  id: string;
  kind: string;
  stepIndex: number;
  toolCallId?: string;
};

export function hashInteractions(interactions: unknown[]): string {
  let text = '';
  try {
    text = JSON.stringify(interactions ?? []);
  } catch {
    text = String(interactions ?? '');
  }
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function buildDebugTurns(interactions: unknown[]): DebugTurn[] {
  const input = Array.isArray(interactions) ? interactions : [];
  const faultSteps = buildFaultPathSteps(input, 'zh');
  const anchorInfosByInteraction = new Map<number, AnchorInfo[]>();
  for (const step of faultSteps) {
    if (step.interactionIndex == null) continue;
    const list = anchorInfosByInteraction.get(step.interactionIndex) || [];
    list.push({
      id: step.id,
      kind: step.kind,
      stepIndex: step.stepIndex,
      toolCallId: step.toolCallId,
    });
    anchorInfosByInteraction.set(step.interactionIndex, list);
  }

  const turns: DebugTurn[] = [];
  input.forEach((raw, index) => {
    const item = asRecord(raw);
    if (!item) return;
    const directRole = String(item.role || '');
    const responseMessage = asRecord(item.responseMessage);
    const responseRole = String(responseMessage?.role || '');
    const role = normalizeAssistantRole(directRole || responseRole);
    if (!role) return;

    const text = firstNonEmptyText(
      item.content,
      responseMessage?.content,
      responseMessage?.text,
    );
    const reasoningText = firstNonEmptyText(
      item.reasoning,
      item.reasoning_content,
      item.thinking,
      responseMessage?.reasoning,
      responseMessage?.reasoning_content,
      responseMessage?.thinking,
    );
    const anchorInfos = anchorInfosByInteraction.get(index) || [];
    const toolCalls = collectToolCalls(item, responseMessage, anchorInfos);
    if (!text.trim() && !reasoningText.trim() && toolCalls.length === 0) return;

    turns.push({
      turnIndex: turns.length + 1,
      sourceInteractionIndex: index,
      agentName: stringOrUndefined(item.agent) || stringOrUndefined(item.subagent_name),
      role,
      text,
      reasoningText: reasoningText || undefined,
      toolCalls,
      requestContextPreview: previewRequestContext(item.requestMessages),
      startedAt: toMsTimestamp(asRecord(item.timeInfo)?.created) ?? toMsTimestamp(item.timestamp),
      completedAt: toMsTimestamp(asRecord(item.timeInfo)?.completed),
      anchorIds: anchorInfos.map(anchor => anchor.id),
      traceStepIndex: resolveTurnTraceStep(anchorInfos),
    });
  });
  return turns;
}

function collectToolCalls(item: AnyRecord, responseMessage: AnyRecord | null, anchorInfos: AnchorInfo[]): DebugToolCall[] {
  const rawCalls = [
    ...arrayOfRecords(item.tool_calls),
    ...arrayOfRecords(item.toolCalls),
    ...arrayOfRecords(responseMessage?.tool_calls),
  ];
  const out: DebugToolCall[] = [];
  const seen = new Set<string>();
  rawCalls.forEach((call, index) => {
    const name = String(asRecord(call.function)?.name || call.name || call.tool_name || 'unknown');
    const rawArgs = asRecord(call.function)?.arguments ?? call.arguments ?? call.args ?? call.input;
    const args = parseArgs(rawArgs);
    const output = call.output ?? call.result ?? call.error ?? call.stderr;
    const rawError = firstNonEmptyText(call.error, call.stderr, asRecord(call.state)?.error);
    const id = stringOrUndefined(call.id) || stringOrUndefined(call.callID) || stringOrUndefined(call.tool_call_id);
    const key = id ? `id:${id}` : `sig:${name}:${stableStringify(args)}:${index}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      id,
      name,
      args,
      output,
      status: inferToolStatus(name, call, output, rawError),
      startedAt: toMsTimestamp(asRecord(call.timing)?.started_at) ?? toMsTimestamp(call.startedAt),
      completedAt: toMsTimestamp(asRecord(call.timing)?.completed_at) ?? toMsTimestamp(call.completedAt),
      anchorId: resolveToolAnchor(anchorInfos, index, id)?.id,
      traceStepIndex: resolveToolAnchor(anchorInfos, index, id)?.stepIndex,
      rawError: rawError || undefined,
    });
  });
  return out;
}

function resolveToolAnchor(anchorInfos: AnchorInfo[], localToolIndex: number, toolCallId?: string): AnchorInfo | undefined {
  const executableAnchors = anchorInfos.filter(anchor => ['tool', 'skill', 'task'].includes(anchor.kind));
  if (toolCallId) {
    const exact = executableAnchors.find(anchor => anchor.toolCallId === toolCallId);
    if (exact) return exact;
  }
  return executableAnchors[localToolIndex] || executableAnchors[0] || anchorInfos[0];
}

function resolveTurnTraceStep(anchorInfos: AnchorInfo[]): number | undefined {
  return (
    anchorInfos.find(anchor => anchor.kind === 'llm') ||
    anchorInfos.find(anchor => anchor.kind === 'agent') ||
    anchorInfos[0]
  )?.stepIndex;
}

function normalizeAssistantRole(role: string): DebugTurn['role'] | null {
  if (role === 'assistant' || role === 'subagent' || role === 'opencode') return role;
  return null;
}

function inferToolStatus(name: string, call: AnyRecord, output: unknown, rawError: string): DebugToolCall['status'] {
  const stateText = normalizeText([
    call.state,
    call.status,
    call.error,
    call.stderr,
    asRecord(call.state)?.status,
    asRecord(call.state)?.error,
  ].map(value => stringifyPreview(value, 600)).join(' '));
  if (rawError) return 'error';
  if (/\b(error|failed|failure|exception|rejected|invalid)\b|非零|失败|错误|异常/.test(stateText)) return 'error';
  const outputText = normalizeText(stringifyPreview(output, 1200));
  if (isShellLikeTool(name) && /exit code\s*[1-9]|no such file|command not found|traceback|assertionerror|npm err!|failed|失败|错误/.test(outputText)) {
    return 'error';
  }
  if (stateText || output !== undefined) return 'ok';
  return 'unknown';
}

function isShellLikeTool(name: string): boolean {
  return /bash|shell|exec|python|node|npm|pnpm|yarn|pip/i.test(name);
}

function previewRequestContext(value: unknown): string | undefined {
  const messages = Array.isArray(value) ? value : [];
  const lastUser = [...messages].reverse().find(message => asRecord(message)?.role === 'user');
  const text = firstNonEmptyText(asRecord(lastUser)?.content);
  return text ? truncate(text, 1200) : undefined;
}

function parseArgs(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function firstNonEmptyText(...values: unknown[]): string {
  for (const value of values) {
    const text = contentToText(value).trim();
    if (text) return text;
  }
  return '';
}

function contentToText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(part => {
      const rec = asRecord(part);
      return rec?.text != null ? String(rec.text) : stringifyPreview(part, 1000);
    }).filter(Boolean).join('\n');
  }
  return stringifyPreview(value, 1200);
}

function arrayOfRecords(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? value.map(asRecord).filter(Boolean) as AnyRecord[] : [];
}

function asRecord(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' ? value as AnyRecord : null;
}

function stringOrUndefined(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || undefined;
}

function stringifyPreview(value: unknown, max = 1000): string {
  if (value == null) return '';
  if (typeof value === 'string') return truncate(value, max);
  try {
    return truncate(JSON.stringify(value), max);
  } catch {
    return truncate(String(value), max);
  }
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? '');
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function toMsTimestamp(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value > 0 && value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? (parsed > 0 && parsed < 10_000_000_000 ? parsed * 1000 : parsed) : undefined;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
