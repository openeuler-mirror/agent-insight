import fs from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
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

const READ_CHUNK_BYTES = 1024 * 1024;

function dayString(date = new Date()): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function safeSessionPathSegment(sessionId: string): string {
  const raw = String(sessionId || 'unknown').trim() || 'unknown';
  const sanitized = raw
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'session';
  if (sanitized === raw && raw !== '.' && raw !== '..' && raw.length <= 80) {
    return raw;
  }
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 10);
  return `${sanitized}-${hash}`;
}

function sessionSpoolFile(spoolDir: string, fileName: string, sessionId: string): string {
  return path.join(spoolDir, dayString(), 'sessions', safeSessionPathSegment(sessionId), fileName);
}

function appendJsonl(file: string, rows: any[]): void {
  if (!rows.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  fs.appendFileSync(file, text, 'utf8');
}

function appendJsonlBySession<T extends { sessionId?: string }>(spoolDir: string, fileName: string, events: T[]): void {
  const groups = new Map<string, T[]>();
  for (const event of events) {
    const sessionId = typeof event.sessionId === 'string' && event.sessionId.trim() ? event.sessionId : 'unknown';
    const group = groups.get(sessionId);
    if (group) {
      group.push(event);
    } else {
      groups.set(sessionId, [event]);
    }
  }
  for (const [sessionId, rows] of groups) {
    appendJsonl(sessionSpoolFile(spoolDir, fileName, sessionId), rows);
  }
}

export function appendClaudeOtelEvents(events: ClaudeOtelEvent[], spoolDir = getClaudeOtelSpoolDir()): ClaudeOtelAppendResult {
  const dirtySessionIds = Array.from(new Set(events.map((e) => e.sessionId).filter(Boolean)));
  if (events.length === 0) return { events, dirtySessionIds };
  appendJsonlBySession(spoolDir, 'logs.jsonl', events);
  return { events, dirtySessionIds };
}

function collectJsonlSpoolFiles(dir: string, fileName: string | undefined, out: string[]): void {
  let entries: Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsonlSpoolFiles(fullPath, fileName, out);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl') && (!fileName || entry.name === fileName)) {
      out.push(fullPath);
    }
  }
}

function listJsonlSpoolFiles(spoolDir: string, fileName?: string): string[] {
  const out: string[] = [];
  try {
    const days = fs.readdirSync(spoolDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const day of days) {
      collectJsonlSpoolFiles(path.join(spoolDir, day.name), fileName, out);
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
  appendJsonlBySession(spoolDir, 'traces.jsonl', events);
  return { events, dirtySessionIds };
}

export function listOtelTraceSpoolFiles(spoolDir = getOtelTraceSpoolDir()): string[] {
  return listJsonlSpoolFiles(spoolDir, 'traces.jsonl');
}

function readJsonlEventsForSession<T extends { sessionId?: string }>(file: string, sessionId: string): T[] {
  const events: T[] = [];
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return events;
  }

  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const decoder = new StringDecoder('utf8');
  let pending = '';

  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      pending += decoder.write(buffer.subarray(0, bytesRead));
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event?.sessionId === sessionId) events.push(event);
        } catch {}
      }
    }

    pending += decoder.end();
    if (pending.trim()) {
      try {
        const event = JSON.parse(pending);
        if (event?.sessionId === sessionId) events.push(event);
      } catch {}
    }
  } finally {
    fs.closeSync(fd);
  }

  return events;
}

export function readClaudeOtelEventsForSession(sessionId: string, spoolDir = getClaudeOtelSpoolDir()): ClaudeOtelEvent[] {
  const events: ClaudeOtelEvent[] = [];
  for (const file of listClaudeOtelSpoolFiles(spoolDir)) {
    events.push(...readJsonlEventsForSession<ClaudeOtelEvent>(file, sessionId));
  }
  return events;
}

export function readOtelTraceEventsForSession(sessionId: string, spoolDir = getOtelTraceSpoolDir()): OtelTraceEvent[] {
  const events: OtelTraceEvent[] = [];
  for (const file of listOtelTraceSpoolFiles(spoolDir)) {
    events.push(...readJsonlEventsForSession<OtelTraceEvent>(file, sessionId));
  }
  return events;
}

export function readNewLinesSince<T = any>(
  file: string,
  cursor: SpoolCursor = { bytes: 0 },
): SpoolReadResult<T> {
  let stat: Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return { events: [], nextCursor: { bytes: cursor.bytes || 0 }, lineCount: 0, parseErrors: 0 };
  }

  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return { events: [], nextCursor: { bytes: cursor.bytes || 0 }, lineCount: 0, parseErrors: 0 };
  }

  const start = (cursor.bytes || 0) > stat.size ? 0 : Math.max(0, cursor.bytes || 0);
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const decoder = new StringDecoder('utf8');
  const events: T[] = [];
  let lineCount = 0;
  let parseErrors = 0;
  let nextBytes = start;
  let pending = '';
  let offset = start;

  try {
    while (offset < stat.size) {
      const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
      pending += decoder.write(buffer.subarray(0, bytesRead));
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';

      for (const line of lines) {
        nextBytes += Buffer.byteLength(line, 'utf8') + 1;
        if (!line.trim()) continue;
        lineCount += 1;
        try {
          events.push(JSON.parse(line));
        } catch {
          parseErrors += 1;
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  return {
    events,
    nextCursor: { bytes: nextBytes },
    lineCount,
    parseErrors,
  };
}
