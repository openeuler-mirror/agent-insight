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

import { format } from 'node:util';

export type LogLevel = 'debug' | 'log' | 'info' | 'warn' | 'error';
type LogConsole = Pick<Console, LogLevel>;
const priority = { debug: 10, log: 20, info: 20, warn: 30, error: 40 };

export function getLogLevel(): LogLevel {
  const value = (process.env.AGENT_INSIGHT_LOG_LEVEL || process.env.LOG_LEVEL || '').trim().toLowerCase();
  if (value === 'log') return 'info';
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error' ? value : 'error';
}

export function isLogEnabled(level: LogLevel): boolean {
  return priority[level] >= priority[getLogLevel()];
}

const sensitiveKey = /^(?:authorization|proxy-authorization|cookie|set-cookie|.*(?:password|passwd|secret(?:[-_]?key)?|api[-_]?key|access[-_]?token|refresh[-_]?token)|token|headers|prompts|(?:prompt|input|output|response|request|body|content)(?:Preview|Text|Body|Json)?|payload|messages|interactions|query|query_preview|answer|finalResult|final_result|raw_output|textPreview|textHead|extracted)$/i;

function redactText(text: string): string {
  return text
    .replace(/(\b(?:query|answer|finalResult|final_result|prompt|raw_output)\s*["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,\n}]+)/gi, '$1[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[a-z\d+/_=.-]+/gi, '$1 [REDACTED]')
    .replace(/((?:password|passwd|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|token|authorization|cookie)\s*["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&}]+)/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

export function sanitizeLogValue(value: unknown): unknown {
  return sanitize(value, new WeakSet(), 0, { nodes: 512, chars: 32_768 });
}

function sanitize(value: unknown, seen: WeakSet<object>, depth: number, budget: { nodes: number; chars: number }): unknown {
  if (--budget.nodes < 0 || budget.chars <= 0) return '[TRUNCATED: context budget]';
  if (typeof value === 'string') {
    if (value.length > 65_536) return `[TRUNCATED: oversized log string, ${value.length} chars]`;
    const jsonAt = value.indexOf('{');
    if (jsonAt >= 0 && value.trimEnd().endsWith('}')) {
      try {
        const parsed = JSON.parse(value.slice(jsonAt));
        return redactText(value.slice(0, jsonAt)) + JSON.stringify(sanitize(parsed, seen, depth + 1, budget));
      } catch { /* Legacy text logs need not contain JSON. */ }
    }
    const redacted = redactText(value);
    const limit = Math.min(16_384, budget.chars);
    budget.chars -= Math.min(limit, redacted.length);
    return redacted.length > limit ? `${redacted.slice(0, limit)} [TRUNCATED: ${redacted.length} chars]` : redacted;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  if (depth >= 8) return '[TRUNCATED: depth]';
  seen.add(value);
  try {
    if (value instanceof Error) {
      return {
        name: value.name, message: value instanceof SyntaxError ? '[parser source excerpt omitted]' : sanitize(value.message, seen, depth + 1, budget),
        code: sanitize((value as Error & { code?: unknown }).code, seen, depth + 1, budget),
        stack: value.stack?.split('\n').filter(line => /^\s+at /.test(line)).slice(0, 12).map(redactText),
      };
    }
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const item of value.slice(0, 100)) {
        if (budget.nodes <= 0 || budget.chars <= 0) break;
        result.push(sanitize(item, seen, depth + 1, budget));
      }
      if (result.length < value.length) result.push(`[TRUNCATED: ${value.length - result.length} items]`);
      return result;
    }
    const result: Record<string, unknown> = {};
    const keys = Object.keys(value);
    let count = 0;
    for (const key of keys.slice(0, 100)) {
      if (budget.nodes <= 0 || budget.chars <= 0) break;
      count++;
      result[key.slice(0, 256)] = sensitiveKey.test(key) ? '[REDACTED]' : sanitize((value as Record<string, unknown>)[key], seen, depth + 1, budget);
    }
    if (count < keys.length) result.__truncatedFields = `[TRUNCATED: ${keys.length - count} fields]`;
    return result;
  } finally { seen.delete(value); }
}

const stateKey = Symbol.for('agent-insight.server-console');
const globals = globalThis as typeof globalThis & { [stateKey]?: WeakSet<object> };

export function installServerLogging(target: LogConsole = console): void {
  const installed = globals[stateKey] ??= new WeakSet();
  if (installed.has(target)) return;
  installed.add(target);
  for (const level of ['debug', 'log', 'info', 'warn', 'error'] as const) {
    const write = target[level].bind(target);
    target[level] = (...args: unknown[]) => {
      if (!isLogEnabled(level)) return;
      try {
        const safe = args.map((arg, index) => {
          if (index > 0 && typeof args[index - 1] === 'string' && /(?:raw\s+body|full\s+(?:request|response)|prompt)\s*:\s*$/i.test(args[index - 1] as string)) return '[REDACTED]';
          const value = sanitizeLogValue(arg);
          return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
        });
        const line = format(...safe);
        write(line.length > 65_536 ? `${line.slice(0, 65_536)} [TRUNCATED: line length]` : line);
      } catch {
        try { write('[logger] log formatting or output failed'); } catch {}
      }
    };
  }
}
