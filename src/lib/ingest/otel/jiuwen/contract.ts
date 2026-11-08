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

import type { JiuwenSpan } from './aggregate';

export function isSemanticJiuwenSpan(span: Pick<JiuwenSpan, 'attrs'>): boolean {
  return !!(span.attrs['openjiuwen.trajectory.schema_version'] || span.attrs['openjiuwen.trajectory.record.kind']);
}

export function isJiuwenInference(span: JiuwenSpan): boolean {
  if (span.name === 'llm.call') return true;
  const kind = span.attrs['openjiuwen.trajectory.record.kind'];
  return (kind === 'inference' || (!kind && /^chat(?: |$)/.test(span.name)))
    && span.attrs['gen_ai.operation.name'] === 'chat';
}

export function isJiuwenTool(span: JiuwenSpan): boolean {
  return span.name.startsWith('tool.') || (
    span.attrs['gen_ai.operation.name'] === 'execute_tool'
    && (!span.attrs['openjiuwen.trajectory.record.kind'] || span.attrs['openjiuwen.trajectory.record.kind'] === 'tool')
  );
}

export function jiuwenSpanSession(span: Pick<JiuwenSpan, 'attrs'>): string | undefined {
  const session = span.attrs['agentteam.session.id'] ?? span.attrs['gen_ai.conversation.id'];
  return session ? String(session) : undefined;
}

export function isEndedJiuwenRoot(span: { name: string; endNs: number; parentSpanId?: string; attrs?: Record<string, unknown> }): boolean {
  if (span.endNs <= 0) return false;
  if (span.attrs?.['openjiuwen.trace.root']) return span.attrs['openjiuwen.trace.complete'] === true;
  return span.name.startsWith('team.') && !span.parentSpanId;
}

export function parseJiuwenValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

export function jiuwenText(value: unknown): string {
  const parsed = value;
  if (typeof parsed === 'string') return parsed;
  if (Array.isArray(parsed)) return parsed.map(jiuwenText).filter(Boolean).join('\n');
  if (!parsed || typeof parsed !== 'object') return '';
  const part = parsed as Record<string, unknown>;
  if (part.type && part.type !== 'text') return '';
  return jiuwenText(part.parts ?? part.content ?? part.text);
}

export function jiuwenMessages(attrs: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const parsed = parseJiuwenValue(attrs[key]);
  return Array.isArray(parsed) ? parsed.filter((message): message is Record<string, unknown> => !!message && typeof message === 'object') : [];
}

export function semanticUserPrompt(attrs: Record<string, unknown>): string {
  const users = jiuwenMessages(attrs, 'gen_ai.input.messages')
    .filter(m => m.role === 'user').map(jiuwenText).filter(Boolean);
  const authored = users.filter(text => /"type"\s*:\s*"user input"/.test(text));
  if (authored.length) return authored[authored.length - 1];
  return users.filter(text => !text.trimStart().startsWith('<system-reminder>')).at(-1) ?? '';
}

export function jiuwenOutputParts(span: JiuwenSpan): Record<string, unknown>[] {
  return jiuwenMessages(span.attrs, 'gen_ai.output.messages')
    .filter(message => message.role === 'assistant').flatMap(message => Array.isArray(message.parts) ? message.parts as Record<string, unknown>[] : []);
}

export function normalizeJiuwenSpan(span: JiuwenSpan): JiuwenSpan {
  if (!isJiuwenInference(span) && !isJiuwenTool(span)) return span;
  const attrs = { ...span.attrs };
  const aliases: Record<string, string> = {
    'gen_ai.usage.prompt_tokens': 'gen_ai.usage.input_tokens',
    'gen_ai.usage.completion_tokens': 'gen_ai.usage.output_tokens',
    'gen_ai.tool.id': 'gen_ai.tool.call.id',
    'gen_ai.tool.input': 'gen_ai.tool.call.arguments',
    'gen_ai.tool.output': 'gen_ai.tool.call.result',
  };
  for (const [legacy, current] of Object.entries(aliases)) {
    if (attrs[current] != null) attrs[legacy] = typeof attrs[current] === 'object' ? JSON.stringify(attrs[current]) : attrs[current];
  }
  if (attrs['gen_ai.output.messages'] != null) {
    attrs['gen_ai.completion.0.content'] = jiuwenMessages(attrs, 'gen_ai.output.messages')
      .filter(message => message.role === 'assistant').map(jiuwenText).filter(Boolean).join('\n');
  }
  const name = isJiuwenInference(span) ? 'llm.call' : span.name.startsWith('tool.')
    ? span.name : `tool.${attrs['gen_ai.tool.name'] ?? span.name.replace(/^execute_tool\s*/, '')}`;
  return { ...span, attrs, name };
}
