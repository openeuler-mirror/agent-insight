import fs from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { ClaudeOtelAppendResult, ClaudeOtelEvent, OtelTraceAppendResult, OtelTraceEvent } from './types';
import { getExistingInsightDir } from '@/lib/agent-insight-paths';
import { readLegacyEventsForSession } from './legacy-session-index';

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

/**
 * Runtime filesystem join. Prefer over ``path.join(dynamic…)`` so Turbopack
 * (Next 16) does not treat the call as a project-root file glob and emit
 * "Overly broad patterns … matches N files" during ``next build``.
 */
function joinFs(base: string, ...rest: string[]): string {
  let out = String(base || '').replace(/[/\\]+$/, '');
  for (const part of rest) {
    const clean = String(part ?? '').replace(/^[/\\]+|[/\\]+$/g, '');
    if (clean) out = `${out}${path.sep}${clean}`;
  }
  return out;
}

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
  return joinFs(spoolDir, dayString(), 'sessions', safeSessionPathSegment(sessionId), fileName);
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

/** 当前写入所用的日期段(= 落盘目录的第一层)。tick 分层扫描要用它区分"当天"和"历史"。 */
export function currentSpoolDay(): string {
  return dayString();
}

export function listClaudeOtelSpoolFilesForDay(day: string, spoolDir = getClaudeOtelSpoolDir()): string[] {
  const out: string[] = [];
  collectJsonlSpoolFiles(path.join(spoolDir, day), 'logs.jsonl', out);
  return out.sort();
}

export function listOtelTraceSpoolFilesForDay(day: string, spoolDir = getOtelTraceSpoolDir()): string[] {
  const out: string[] = [];
  collectJsonlSpoolFiles(path.join(spoolDir, day), 'traces.jsonl', out);
  return out.sort();
}

export type SessionSpoolFiles = {
  /** `<day>/sessions/<safe-session>/<fileName>` —— 只含这个 session 的数据,整读即可。 */
  shards: string[];
  /** 分片改造之前的整日平铺文件,里面混着所有 session,要走 byte-range 索引。 */
  legacy: string[];
};

function sessionTargetedReadEnabled(): boolean {
  return process.env.AGENT_INSIGHT_OTEL_SESSION_TARGETED_READ !== '0';
}

/**
 * 按 session 定向列出候选文件,复杂度 O(目录数) 而不是 O(spool 总字节数)。
 *
 * 关键点是遇到名为 `sessions` 的目录时**不 readdir**,直接拼 `<sessions>/<segment>/<fileName>`
 * 再 stat —— 否则一天有几千个会话目录时,光遍历目录就够慢的。
 * 其余层级照常递归,兼容多一层嵌套的部署形态。
 */
export function listSessionSpoolFiles(spoolDir: string, fileName: string, sessionId: string): SessionSpoolFiles {
  const segment = safeSessionPathSegment(sessionId);
  const shards: string[] = [];
  const legacy: string[] = [];

  const walk = (dir: string): void => {
    let entries: Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'sessions') {
          const target = joinFs(fullPath, segment, fileName);
          try {
            if (fs.statSync(target).isFile()) shards.push(target);
          } catch {}
        } else {
          walk(fullPath);
        }
      } else if (entry.isFile() && entry.name === fileName) {
        legacy.push(fullPath);
      }
    }
  };

  try {
    for (const day of fs.readdirSync(spoolDir, { withFileTypes: true })) {
      if (day.isDirectory()) walk(path.join(spoolDir, day.name));
    }
  } catch {}

  return { shards: shards.sort(), legacy: legacy.sort() };
}

/**
 * 该 session 当前落盘状态的指纹(各候选文件的路径+大小)。
 * 用来判断"上次聚合之后有没有新数据",避免 fast/evaluated 两段对同一份数据重复聚合。
 */
export function statSessionSpool(spoolDir: string, fileName: string, sessionId: string): string {
  const { shards, legacy } = listSessionSpoolFiles(spoolDir, fileName, sessionId);
  const parts: string[] = [];
  for (const file of [...shards, ...legacy]) {
    try {
      parts.push(`${file}:${fs.statSync(file).size}`);
    } catch {
      parts.push(`${file}:missing`);
    }
  }
  return parts.join('|');
}

function readEventsForSession<T extends { sessionId?: string }>(
  spoolDir: string,
  fileName: string,
  sessionId: string,
): T[] {
  if (!sessionTargetedReadEnabled()) {
    const events: T[] = [];
    for (const file of listJsonlSpoolFiles(spoolDir, fileName)) {
      events.push(...readJsonlEventsForSession<T>(file, sessionId));
    }
    return events;
  }

  const { shards, legacy } = listSessionSpoolFiles(spoolDir, fileName, sessionId);
  const events: T[] = [];
  // 分片只含目标 session,整读;仍按 sessionId 过滤一次兜底(路径段做过 sanitize/hash)。
  for (const file of shards) events.push(...readJsonlEventsForSession<T>(file, sessionId));
  // legacy 整日文件不能跳过:跨 6/17 格式边界的长会话,早期 span 只在这里面。
  for (const file of legacy) events.push(...readLegacyEventsForSession<T>(file, sessionId));
  return events;
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
  return readEventsForSession<ClaudeOtelEvent>(spoolDir, 'logs.jsonl', sessionId);
}

export function readOtelTraceEventsForSession(sessionId: string, spoolDir = getOtelTraceSpoolDir()): OtelTraceEvent[] {
  return readEventsForSession<OtelTraceEvent>(spoolDir, 'traces.jsonl', sessionId);
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

  const start = (cursor.bytes || 0) > stat.size ? 0 : Math.max(0, cursor.bytes || 0);
  // 没有新字节就别开文件。consumer 每秒对每个 spool 文件都调一次,几千个文件时
  // 这一个 open+close 就是每秒上万次无用系统调用(实测占 tick 开销的 8/9)。
  if (start >= stat.size) {
    return { events: [], nextCursor: { bytes: start }, lineCount: 0, parseErrors: 0 };
  }

  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return { events: [], nextCursor: { bytes: cursor.bytes || 0 }, lineCount: 0, parseErrors: 0 };
  }

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
