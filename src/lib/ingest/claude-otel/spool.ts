import fs from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import type { ClaudeOtelAppendResult, ClaudeOtelEvent, OtelTraceAppendResult, OtelTraceEvent } from './types';
import { getExistingInsightDir } from '@/lib/agent-insight-paths';
import { visitLegacyEventsForSession } from './legacy-session-index';

export type SpoolCursor = {
  bytes: number;
};

export type SpoolReadResult<T = unknown> = {
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
const TRACE_DEDUPE_INDEX_DIR = '.trace-event-index-v1';
const TRACE_DEDUPE_INDEX_VERSION = 1;
const TRACE_DEDUPE_LOCK_WAIT_MS = 5_000;
const DEFAULT_TRACE_DEDUPE_MAX_IDENTITIES = 100_000;
const DEFAULT_TRACE_DEDUPE_MAX_LINE_BYTES = 16 * 1024 * 1024;

type TraceDedupeSource = {
  path: string;
  size: number;
  mtimeMs: number;
  ino: number;
};

type TraceDedupeIndex = {
  version: 1;
  sources: TraceDedupeSource[];
  hashes: Record<string, string>;
  overflow?: boolean;
};

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

function appendJsonl(file: string, rows: unknown[]): void {
  if (!rows.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  fs.appendFileSync(file, text, 'utf8');
}

function positiveEnvNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function traceDedupeIdentity(event: OtelTraceEvent): string | undefined {
  const eventId = (event as OtelTraceEvent & { eventId?: unknown }).eventId
    ?? event.attributes?.['agent.insight.event_id'];
  const kind = eventId !== undefined && eventId !== null && String(eventId).trim()
    ? 'event'
    : event.spanId
      ? 'span'
      : undefined;
  const id = kind === 'event' ? String(eventId).trim() : event.spanId;
  if (!kind || !id) return undefined;
  const owner = String(event.user || '').trim() || 'anonymous';
  return crypto.createHash('sha256')
    .update([owner, event.sessionId, kind, id].join('\0'))
    .digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 'null' : encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  const entries = Object.keys(object)
    .sort()
    .filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
  return `{${entries.join(',')}}`;
}

function traceSemanticHash(event: OtelTraceEvent): string {
  const semantic = { ...event } as Partial<OtelTraceEvent>;
  delete semantic.receivedAt;
  return crypto.createHash('sha256').update(canonicalJson(semantic)).digest('hex');
}

function traceDedupeIndexFile(spoolDir: string, sessionId: string): string {
  return joinFs(spoolDir, TRACE_DEDUPE_INDEX_DIR, `${safeSessionPathSegment(sessionId)}.json`);
}

function traceDedupeLockDir(spoolDir: string, sessionId: string): string {
  return joinFs(spoolDir, TRACE_DEDUPE_INDEX_DIR, 'locks', `${safeSessionPathSegment(sessionId)}.lock`);
}

type TraceDedupeLockOwner = {
  pid: number;
  hostname: string;
  token: string;
  createdAt: string;
};

type TraceDedupeRecoveryClaim = TraceDedupeLockOwner & {
  expectedOwnerToken: string;
};

function readTraceDedupeLockOwner(lockDir: string): TraceDedupeLockOwner | undefined {
  try {
    const owner = JSON.parse(fs.readFileSync(joinFs(lockDir, 'owner.json'), 'utf8'));
    if (!Number.isInteger(owner?.pid) || owner.pid <= 0 || typeof owner.hostname !== 'string'
      || typeof owner.token !== 'string') return undefined;
    return owner as TraceDedupeLockOwner;
  } catch {
    return undefined;
  }
}

function localProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as { code?: unknown })?.code === 'EPERM';
  }
}

function retireTraceDedupeLock(
  lockDir: string,
  expectedOwnerToken: string | undefined,
  retirementToken: string,
): boolean {
  const owner = readTraceDedupeLockOwner(lockDir);
  if (owner?.token !== expectedOwnerToken || (!owner && expectedOwnerToken !== undefined)) return false;
  const retired = `${lockDir}.retired-${retirementToken}`;
  try {
    fs.renameSync(lockDir, retired);
  } catch {
    return false;
  }
  try { fs.rmSync(retired, { recursive: true, force: true }); } catch {}
  return true;
}

function claimAndRetireDeadLocalTraceDedupeLock(
  lockDir: string,
  expectedOwnerToken: string,
  retirementToken: string,
): boolean {
  const claimFile = joinFs(lockDir, 'recovery-claim.json');
  const claim: TraceDedupeRecoveryClaim = {
    pid: process.pid,
    hostname: os.hostname(),
    token: retirementToken,
    expectedOwnerToken,
    createdAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(claimFile, JSON.stringify(claim), { flag: 'wx' });
  } catch (error: unknown) {
    if ((error as { code?: unknown })?.code === 'EEXIST') {
      try {
        const existing = JSON.parse(fs.readFileSync(claimFile, 'utf8')) as Partial<TraceDedupeRecoveryClaim>;
        if (existing.hostname === claim.hostname && Number.isInteger(existing.pid)
          && Number(existing.pid) > 0 && !localProcessIsAlive(Number(existing.pid))) {
          const confirmed = JSON.parse(fs.readFileSync(claimFile, 'utf8')) as Partial<TraceDedupeRecoveryClaim>;
          if (confirmed.token === existing.token) fs.unlinkSync(claimFile);
        }
      } catch {}
    }
    return false;
  }

  let retired = false;
  try {
    const owner = readTraceDedupeLockOwner(lockDir);
    if (owner?.token !== expectedOwnerToken || localProcessIsAlive(owner.pid)) return false;
    const confirmedClaim = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
    if (confirmedClaim?.token !== retirementToken
      || confirmedClaim?.expectedOwnerToken !== expectedOwnerToken) return false;
    const retiredDir = `${lockDir}.retired-${retirementToken}`;
    fs.renameSync(lockDir, retiredDir);
    retired = true;
    try { fs.rmSync(retiredDir, { recursive: true, force: true }); } catch {}
    return true;
  } catch {
    return false;
  } finally {
    if (!retired) {
      try {
        const claim = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
        if (claim?.token === retirementToken) fs.unlinkSync(claimFile);
      } catch {}
    }
  }
}

function traceDedupeSources(spoolDir: string, sessionId: string): TraceDedupeSource[] {
  const { shards, legacy } = listSessionSpoolFiles(spoolDir, 'traces.jsonl', sessionId);
  const sources: TraceDedupeSource[] = [];
  for (const file of [...shards, ...legacy].sort()) {
    try {
      const stat = fs.statSync(file);
      sources.push({
        path: path.relative(spoolDir, file),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ino: Number(stat.ino) || 0,
      });
    } catch {}
  }
  return sources;
}

function sameTraceDedupeSources(left: TraceDedupeSource[], right: TraceDedupeSource[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((source, index) => {
    const other = right[index];
    return source.path === other?.path && source.size === other.size
      && source.mtimeMs === other.mtimeMs && source.ino === other.ino;
  });
}

function readTraceDedupeIndex(file: string): TraceDedupeIndex | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value?.version !== TRACE_DEDUPE_INDEX_VERSION || !Array.isArray(value.sources)
      || !value.hashes || typeof value.hashes !== 'object') return undefined;
    return value as TraceDedupeIndex;
  } catch {
    return undefined;
  }
}

function persistTraceDedupeIndex(file: string, index: TraceDedupeIndex): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(index), 'utf8');
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

function rebuildTraceDedupeIndex(
  spoolDir: string,
  sessionId: string,
  sources = traceDedupeSources(spoolDir, sessionId),
): TraceDedupeIndex {
  const maxIdentities = positiveEnvNumber(
    'AGENT_INSIGHT_OTEL_DEDUPE_MAX_IDENTITIES',
    DEFAULT_TRACE_DEDUPE_MAX_IDENTITIES,
  );
  const hashes: Record<string, string> = {};
  let identityCount = 0;
  let overflow = false;

  visitEventsForSession<OtelTraceEvent>(spoolDir, 'traces.jsonl', sessionId, (event) => {
    const identity = traceDedupeIdentity(event);
    if (!identity) return;
    if (!(identity in hashes)) {
      if (identityCount >= maxIdentities) {
        overflow = true;
        return;
      }
      identityCount += 1;
    }
    hashes[identity] = traceSemanticHash(event);
  }, { maxLineBytes: DEFAULT_TRACE_DEDUPE_MAX_LINE_BYTES });

  return {
    version: TRACE_DEDUPE_INDEX_VERSION,
    sources,
    hashes,
    ...(overflow ? { overflow: true } : {}),
  };
}

function withTraceDedupeLock<T>(spoolDir: string, sessionId: string, action: () => T): T {
  const lockDir = traceDedupeLockDir(spoolDir, sessionId);
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const waitMs = positiveEnvNumber(
    'AGENT_INSIGHT_OTEL_DEDUPE_LOCK_WAIT_MS',
    TRACE_DEDUPE_LOCK_WAIT_MS,
  );
  const deadline = Date.now() + waitMs;
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  const owner: TraceDedupeLockOwner = {
    pid: process.pid,
    hostname: os.hostname(),
    token: crypto.randomBytes(16).toString('hex'),
    createdAt: new Date().toISOString(),
  };

  while (true) {
    try {
      fs.mkdirSync(lockDir);
      try {
        fs.writeFileSync(joinFs(lockDir, 'owner.json'), JSON.stringify(owner), 'utf8');
      } catch (error) {
        try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
        throw error;
      }
      break;
    } catch (error: unknown) {
      if ((error as { code?: unknown })?.code !== 'EEXIST') throw error;
      const currentOwner = readTraceDedupeLockOwner(lockDir);
      const ownerIsLiveLocally = currentOwner?.hostname === owner.hostname
        && localProcessIsAlive(currentOwner.pid);
      const ownerIsDeadLocally = currentOwner?.hostname === owner.hostname
        && !ownerIsLiveLocally;
      if (ownerIsDeadLocally && currentOwner) {
        if (!claimAndRetireDeadLocalTraceDedupeLock(lockDir, currentOwner.token, owner.token)) continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for OTel trace spool lock for session ${sessionId}`);
      }
      Atomics.wait(waiter, 0, 0, 10);
    }
  }

  try {
    return action();
  } finally {
    const currentOwner = readTraceDedupeLockOwner(lockDir);
    if (currentOwner?.token === owner.token) {
      retireTraceDedupeLock(lockDir, owner.token, owner.token);
    }
  }
}

export function appendJsonlBySession<T extends { sessionId?: string }>(spoolDir: string, fileName: string, events: T[]): void {
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
    if (entry.isDirectory() && entry.name === TRACE_DEDUPE_INDEX_DIR) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsonlSpoolFiles(fullPath, fileName, out);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl') && (!fileName || entry.name === fileName)) {
      out.push(fullPath);
    }
  }
}

export function listJsonlSpoolFiles(spoolDir: string, fileName?: string): string[] {
  const out: string[] = [];
  try {
    const days = fs.readdirSync(spoolDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== TRACE_DEDUPE_INDEX_DIR);
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
  if (events.length === 0) {
    return { events, dirtySessionIds: [], deduplicatedEvents: 0, rejectedEvents: 0 };
  }
  const groups = new Map<string, OtelTraceEvent[]>();
  for (const event of events) {
    const sessionId = typeof event.sessionId === 'string' && event.sessionId.trim()
      ? event.sessionId
      : 'unknown';
    const group = groups.get(sessionId);
    if (group) group.push(event);
    else groups.set(sessionId, [event]);
  }

  const appended: OtelTraceEvent[] = [];
  const dirtySessionIds: string[] = [];
  let deduplicatedEvents = 0;
  let rejectedEvents = 0;
  for (const [sessionId, rows] of groups) {
    if (!sessionId.startsWith('goal-plus:')) {
      appendJsonl(sessionSpoolFile(spoolDir, 'traces.jsonl', sessionId), rows);
      for (const row of rows) appended.push(row);
      dirtySessionIds.push(sessionId);
      continue;
    }
    withTraceDedupeLock(spoolDir, sessionId, () => {
      const indexFile = traceDedupeIndexFile(spoolDir, sessionId);
      const sources = traceDedupeSources(spoolDir, sessionId);
      let index = readTraceDedupeIndex(indexFile);
      if (!index || !sameTraceDedupeSources(index.sources, sources)) {
        index = rebuildTraceDedupeIndex(spoolDir, sessionId, sources);
      }

      const maxIdentities = positiveEnvNumber(
        'AGENT_INSIGHT_OTEL_DEDUPE_MAX_IDENTITIES',
        DEFAULT_TRACE_DEDUPE_MAX_IDENTITIES,
      );
      let identityCount = Object.keys(index.hashes).length;
      const accepted: OtelTraceEvent[] = [];
      let rejectedForIdentityLimit = 0;
      for (const event of rows) {
        const identity = traceDedupeIdentity(event);
        if (!identity) {
          accepted.push(event);
          continue;
        }
        const semanticHash = traceSemanticHash(event);
        if (index.hashes[identity] === semanticHash) {
          deduplicatedEvents += 1;
          continue;
        }
        if (!(identity in index.hashes)) {
          if (identityCount >= maxIdentities) {
            index.overflow = true;
            rejectedForIdentityLimit += 1;
            rejectedEvents += 1;
            continue;
          }
          identityCount += 1;
        }
        accepted.push(event);
        index.hashes[identity] = semanticHash;
      }

      if (rejectedForIdentityLimit > 0) {
        console.warn('[OTel] Rejected trace events after session identity limit', {
          sessionId,
          rejectedEvents: rejectedForIdentityLimit,
          maximum: maxIdentities,
        });
      }

      if (accepted.length > 0) {
        appendJsonl(sessionSpoolFile(spoolDir, 'traces.jsonl', sessionId), accepted);
        for (const event of accepted) appended.push(event);
        dirtySessionIds.push(sessionId);
      }
      index.sources = traceDedupeSources(spoolDir, sessionId);
      persistTraceDedupeIndex(indexFile, index);
    });
  }
  return { events: appended, dirtySessionIds, deduplicatedEvents, rejectedEvents };
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

export type SessionSpoolFileName = 'logs.jsonl' | 'traces.jsonl' | 'events.jsonl';

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
export function listSessionSpoolFiles(
  spoolDir: string,
  fileName: SessionSpoolFileName,
  sessionId: string,
): SessionSpoolFiles {
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
      if (entry.isDirectory() && entry.name === TRACE_DEDUPE_INDEX_DIR) continue;
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
      if (day.isDirectory() && day.name !== TRACE_DEDUPE_INDEX_DIR) walk(path.join(spoolDir, day.name));
    }
  } catch {}

  return { shards: shards.sort(), legacy: legacy.sort() };
}

/**
 * 该 session 当前落盘状态的指纹(各候选文件的路径+大小)。
 * 用来判断"上次聚合之后有没有新数据",避免 fast/evaluated 两段对同一份数据重复聚合。
 */
export function statSessionSpool(spoolDir: string, fileName: SessionSpoolFileName, sessionId: string): string {
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

export type SessionSpoolVisitResult = {
  lineCount: number;
  eventCount: number;
  parseErrors: number;
  oversizedLines: number;
};

export type SessionSpoolVisitOptions = {
  maxLineBytes?: number;
  onOversizedLine?: (lineBytes: number, file: string) => void;
};

function emptyVisitResult(): SessionSpoolVisitResult {
  return { lineCount: 0, eventCount: 0, parseErrors: 0, oversizedLines: 0 };
}

function mergeVisitResult(target: SessionSpoolVisitResult, source: SessionSpoolVisitResult): void {
  target.lineCount += source.lineCount;
  target.eventCount += source.eventCount;
  target.parseErrors += source.parseErrors;
  target.oversizedLines += source.oversizedLines;
}

function visitJsonlEventsForSession<T extends { sessionId?: string }>(
  file: string,
  sessionId: string,
  visitor: (event: T, lineBytes: number) => void,
  options: SessionSpoolVisitOptions = {},
): SessionSpoolVisitResult {
  const result = emptyVisitResult();
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return result;
  }

  const maxLineBytes = options.maxLineBytes ?? Number.POSITIVE_INFINITY;
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let skippingOversized = false;

  const processLine = (line: string): void => {
    if (!line.trim()) return;
    result.lineCount += 1;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (lineBytes > maxLineBytes) {
      result.oversizedLines += 1;
      options.onOversizedLine?.(lineBytes, file);
      return;
    }
    let event: T;
    try {
      event = JSON.parse(line);
    } catch {
      result.parseErrors += 1;
      return;
    }
    if (event?.sessionId === sessionId) {
      result.eventCount += 1;
      visitor(event, lineBytes);
    }
  };

  const consume = (text: string): void => {
    if (skippingOversized) {
      const newline = text.indexOf('\n');
      if (newline < 0) return;
      skippingOversized = false;
      text = text.slice(newline + 1);
    }

    pending += text;
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      processLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
    }

    if (Buffer.byteLength(pending, 'utf8') > maxLineBytes) {
      result.lineCount += 1;
      result.oversizedLines += 1;
      options.onOversizedLine?.(Buffer.byteLength(pending, 'utf8'), file);
      pending = '';
      skippingOversized = true;
    }
  };

  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      consume(decoder.write(buffer.subarray(0, bytesRead)));
    }
    consume(decoder.end());
    if (!skippingOversized && pending.trim()) processLine(pending);
  } finally {
    fs.closeSync(fd);
  }
  return result;
}

/**
 * 逐行访问指定 session 的事件。聚合器使用这个入口在 JSON.parse 后立刻归并，
 * 大量重复行不会先膨胀成同等数量的 JavaScript 对象数组。
 */
export function visitEventsForSession<T extends { sessionId?: string }>(
  spoolDir: string,
  fileName: SessionSpoolFileName,
  sessionId: string,
  visitor: (event: T, lineBytes: number) => void,
  options: SessionSpoolVisitOptions = {},
): SessionSpoolVisitResult {
  const result = emptyVisitResult();
  if (!sessionTargetedReadEnabled()) {
    for (const file of listJsonlSpoolFiles(spoolDir, fileName)) {
      mergeVisitResult(result, visitJsonlEventsForSession(file, sessionId, visitor, options));
    }
    return result;
  }

  const { shards, legacy } = listSessionSpoolFiles(spoolDir, fileName, sessionId);
  for (const file of shards) {
    mergeVisitResult(result, visitJsonlEventsForSession(file, sessionId, visitor, options));
  }
  for (const file of legacy) {
    const legacyResult = visitLegacyEventsForSession<T>(file, sessionId, visitor, {
      maxLineBytes: options.maxLineBytes,
      onOversizedLine: (lineBytes) => options.onOversizedLine?.(lineBytes, file),
    });
    mergeVisitResult(result, legacyResult);
  }
  return result;
}

export function readEventsForSession<T extends { sessionId?: string }>(
  spoolDir: string,
  fileName: SessionSpoolFileName,
  sessionId: string,
): T[] {
  const events: T[] = [];
  visitEventsForSession<T>(spoolDir, fileName, sessionId, (event) => {
    events.push(event);
  });
  return events;
}

export function readClaudeOtelEventsForSession(sessionId: string, spoolDir = getClaudeOtelSpoolDir()): ClaudeOtelEvent[] {
  return readEventsForSession<ClaudeOtelEvent>(spoolDir, 'logs.jsonl', sessionId);
}

export function readOtelTraceEventsForSession(sessionId: string, spoolDir = getOtelTraceSpoolDir()): OtelTraceEvent[] {
  return readEventsForSession<OtelTraceEvent>(spoolDir, 'traces.jsonl', sessionId);
}

export function readNewLinesSince<T = unknown>(
  file: string,
  cursor: SpoolCursor = { bytes: 0 },
  maxLines = Number.POSITIVE_INFINITY,
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
  let reachedLimit = false;

  try {
    while (offset < stat.size && !reachedLimit) {
      const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
      pending += decoder.write(buffer.subarray(0, bytesRead));
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';

      for (const line of lines) {
        if (lineCount >= maxLines) {
          reachedLimit = true;
          break;
        }
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
