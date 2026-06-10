import fs from 'node:fs';
import path from 'node:path';
import type { ClaudeOtelAppendResult, ClaudeOtelEvent, OtelTraceAppendResult, OtelTraceEvent } from './types';
import { getExistingInsightDir } from '@/lib/agent-insight-paths';

export type SpoolCursor = {
  bytes: number;
};

export type SpoolReadResult<T = any> = {
  events: T[];
  nextCursor: SpoolCursor;
  lineCount: number;
  parseErrors: number;
};

export function getClaudeOtelSpoolDir(): string {
  return process.env.AGENT_INSIGHT_CLAUDE_OTEL_SPOOL_DIR ||
    path.join(getExistingInsightDir(), 'otel_data', 'claude');
}

export function getOtelTraceSpoolDir(): string {
  return process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR ||
    path.join(getExistingInsightDir(), 'otel_data', 'traces');
}

function dayString(date = new Date()): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function appendJsonl(file: string, rows: any[]): void {
  if (!rows.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  fs.appendFileSync(file, text, 'utf8');
}

export function appendClaudeOtelEvents(events: ClaudeOtelEvent[], spoolDir = getClaudeOtelSpoolDir()): ClaudeOtelAppendResult {
  const dirtySessionIds = Array.from(new Set(events.map((e) => e.sessionId).filter(Boolean)));
  if (events.length === 0) return { events, dirtySessionIds };
  const file = path.join(spoolDir, dayString(), 'logs.jsonl');
  appendJsonl(file, events);
  return { events, dirtySessionIds };
}

function listJsonlSpoolFiles(spoolDir: string, fileName?: string): string[] {
  const out: string[] = [];
  try {
    const days = fs.readdirSync(spoolDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const day of days) {
      const dir = path.join(spoolDir, day.name);
      let files: string[] = [];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') && (!fileName || f === fileName));
      } catch {
        continue;
      }
      for (const file of files) out.push(path.join(dir, file));
    }
  } catch {}
  return out.sort();
}

export function listClaudeOtelSpoolFiles(spoolDir = getClaudeOtelSpoolDir()): string[] {
  return listJsonlSpoolFiles(spoolDir, 'logs.jsonl');
}

export function appendOtelTraceEvents(events: OtelTraceEvent[], spoolDir = getOtelTraceSpoolDir()): OtelTraceAppendResult {
  const dirtySessionIds = Array.from(new Set(events.map((e) => e.sessionId).filter(Boolean)));
  if (events.length === 0) return { events, dirtySessionIds };
  const file = path.join(spoolDir, dayString(), 'traces.jsonl');
  appendJsonl(file, events);
  return { events, dirtySessionIds };
}

export function listOtelTraceSpoolFiles(spoolDir = getOtelTraceSpoolDir()): string[] {
  return listJsonlSpoolFiles(spoolDir, 'traces.jsonl');
}

export function readClaudeOtelEventsForSession(sessionId: string, spoolDir = getClaudeOtelSpoolDir()): ClaudeOtelEvent[] {
  const events: ClaudeOtelEvent[] = [];
  for (const file of listClaudeOtelSpoolFiles(spoolDir)) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event?.sessionId === sessionId) events.push(event);
      } catch {}
    }
  }
  return events;
}

export function readOtelTraceEventsForSession(sessionId: string, spoolDir = getOtelTraceSpoolDir()): OtelTraceEvent[] {
  const events: OtelTraceEvent[] = [];
  for (const file of listOtelTraceSpoolFiles(spoolDir)) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event?.sessionId === sessionId) events.push(event);
      } catch {}
    }
  }
  return events;
}

export function readNewLinesSince<T = any>(
  file: string,
  cursor: SpoolCursor = { bytes: 0 },
): SpoolReadResult<T> {
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch {
    return { events: [], nextCursor: { bytes: cursor.bytes || 0 }, lineCount: 0, parseErrors: 0 };
  }

  const lastNewline = buffer.lastIndexOf(0x0a);
  const committed = lastNewline >= 0 ? buffer.subarray(0, lastNewline + 1) : Buffer.alloc(0);
  const start = Math.min(Math.max(0, cursor.bytes || 0), committed.length);
  const text = committed.subarray(start).toString('utf8');
  const events: T[] = [];
  let lineCount = 0;
  let parseErrors = 0;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    lineCount += 1;
    try {
      events.push(JSON.parse(line));
    } catch {
      parseErrors += 1;
    }
  }

  return {
    events,
    nextCursor: { bytes: committed.length },
    lineCount,
    parseErrors,
  };
}
