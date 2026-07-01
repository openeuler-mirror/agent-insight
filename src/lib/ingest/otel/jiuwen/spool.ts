/**
 * jiuwen span 的持久化 spool（替代原来的内存 Map）。
 *
 * 为什么存在：jiuwen 的 OTLP exporter 分批推 span，我们「每批重新聚合全量 span」再
 * snapshot-replace 覆盖落库——所以「全量」必须可靠保存。原实现把全量只攒在内存 Map 里，
 * 进程因大 trace 撑爆内存而重启时，攒了一半的 span 连同 Map 一起丢，随后残缺的批次又把库里
 * 记录整条覆盖 → 永久丢数据。本模块把 span 落到磁盘 JSONL（处理前先落久），重启后仍可读回
 * 重聚合出完整 trace。设计与对照见 docs/designs/agents/jiuwenswarm-tracing/durable-span-spool.md。
 *
 * 布局：
 *   otel_data/jiuwen/buckets/<traceKey>.jsonl   每行一个 JiuwenSpan（按 traceId 分桶）
 *   otel_data/jiuwen/session-index.jsonl        每行 {key, session, marker}，记录跨 trace 缝合
 *                                               所需的 session→buckets 关系与「多 trace 标记」
 *
 * 单 agent 一条 trace 一个桶；team/fan-out 的多条 trace 在再聚合阶段按 agentteam.session.id
 * 缝合（沿用 ingest 原逻辑），靠 session-index 找齐兄弟桶——这份索引取代了原来「遍历整个内存
 * Map」那一步，且重启后仍在。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getExistingInsightDir } from '@/lib/agent-insight-paths';
import type { JiuwenSpan } from './aggregate';

export function getJiuwenSpoolDir(): string {
  return (
    process.env.AGENT_INSIGHT_JIUWEN_SPOOL_DIR ||
    path.join(getExistingInsightDir(), 'otel_data', 'jiuwen')
  );
}

function bucketsDir(): string {
  return path.join(getJiuwenSpoolDir(), 'buckets');
}

function sessionIndexFile(): string {
  return path.join(getJiuwenSpoolDir(), 'session-index.jsonl');
}

// ── span 分类 / 分桶（从 ingest.ts 平移，供 spool 与 ingest 共用）─────────────

/** 分桶键：优先 traceId（单 agent 一条 trace 一桶），退而用 session，再退到常量。 */
export function traceKeyFor(s: JiuwenSpan): string {
  return s.traceId || spanSession(s) || 'jiuwen';
}

export function spanSession(s: JiuwenSpan): string | undefined {
  const sid = s.attrs['agentteam.session.id'];
  return sid ? String(sid) : undefined;
}

/** 多 trace run（team / fan-out）的标记 span：其 span 需按 session 跨 trace 缝合。 */
export function isMultiTraceSpan(s: JiuwenSpan): boolean {
  return (
    s.name.startsWith('team.') ||
    s.name.startsWith('tool.task') ||
    (s.name.startsWith('agent.') && s.name.includes('.task_iteration.'))
  );
}

// ── 文件名安全化 ─────────────────────────────────────────────────────────────

// traceId 是 hex，安全；session 兜底可能含异常字符，需净化（并对碰撞加哈希后缀）。
function safeBucketSegment(key: string): string {
  const raw = String(key || 'jiuwen').trim() || 'jiuwen';
  const sanitized =
    raw
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 120) || 'bucket';
  if (sanitized === raw && raw !== '.' && raw !== '..' && raw.length <= 120) {
    return raw;
  }
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 10);
  return `${sanitized}-${hash}`;
}

function bucketFile(key: string): string {
  return path.join(bucketsDir(), `${safeBucketSegment(key)}.jsonl`);
}

function appendJsonl(file: string, rows: any[]): void {
  if (!rows.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(file, text, 'utf8');
}

function readJsonlRows<T = any>(file: string): T[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // 容忍半截行 / 损坏行
    }
  }
  return out;
}

// ── 写入 ─────────────────────────────────────────────────────────────────────

// 进程内去重，避免同一 (key,session[,marker]) 在每批都往 index 追加一行而无限膨胀。
// 重启后这两个 Set 清空，可能重复追加几行——prune 会在重写时去重，无碍正确性。
const appendedPairs = new Set<string>(); // `${key}\u0000${session}`
const markerPairs = new Set<string>(); // 已写过 marker=true 的 (key,session)

export type AppendResult = { touchedKeys: string[] };

/** 把一批 span 落盘（按 traceKey 分桶），并维护 session-index。返回本批触及的桶键。 */
export function appendJiuwenSpans(spans: JiuwenSpan[]): AppendResult {
  if (!spans.length) return { touchedKeys: [] };

  const byBucket = new Map<string, JiuwenSpan[]>();
  // (key,session) -> 本批是否见到 marker span
  const pairMarker = new Map<string, { key: string; session: string; marker: boolean }>();

  for (const s of spans) {
    if (!s.spanId) continue;
    const key = traceKeyFor(s);
    (byBucket.get(key) ?? byBucket.set(key, []).get(key)!).push(s);

    const session = spanSession(s);
    if (session) {
      const ks = `${key}\u0000${session}`;
      const prev = pairMarker.get(ks);
      const marker = isMultiTraceSpan(s);
      if (prev) prev.marker = prev.marker || marker;
      else pairMarker.set(ks, { key, session, marker });
    }
  }

  // 写 span 桶文件
  for (const [key, bucketSpans] of byBucket) {
    appendJsonl(bucketFile(key), bucketSpans);
  }

  // 写 session-index（带进程内去重；marker 由 false→true 时补一行）
  const indexRows: Array<{ key: string; session: string; marker: boolean }> = [];
  for (const [ks, { key, session, marker }] of pairMarker) {
    if (!appendedPairs.has(ks)) {
      appendedPairs.add(ks);
      if (marker) markerPairs.add(ks);
      indexRows.push({ key, session, marker });
    } else if (marker && !markerPairs.has(ks)) {
      markerPairs.add(ks);
      indexRows.push({ key, session, marker: true });
    }
  }
  appendJsonl(sessionIndexFile(), indexRows);

  return { touchedKeys: Array.from(byBucket.keys()) };
}

// ── 读取（再聚合用）──────────────────────────────────────────────────────────

export type SessionIndex = {
  sessionToKeys: Map<string, Set<string>>;
  multiTraceSessions: Set<string>;
  keyToSession: Map<string, string>;
};

/** 从 session-index 重建「session→buckets / 多 trace session / key→session」视图。 */
export function readJiuwenSessionIndex(): SessionIndex {
  const sessionToKeys = new Map<string, Set<string>>();
  const multiTraceSessions = new Set<string>();
  const keyToSession = new Map<string, string>();

  for (const row of readJsonlRows<{ key?: string; session?: string; marker?: boolean }>(
    sessionIndexFile(),
  )) {
    const key = row?.key;
    const session = row?.session;
    if (!key || !session) continue;
    (sessionToKeys.get(session) ?? sessionToKeys.set(session, new Set()).get(session)!).add(key);
    if (row.marker) multiTraceSessions.add(session);
    if (!keyToSession.has(key)) keyToSession.set(key, session);
  }

  return { sessionToKeys, multiTraceSessions, keyToSession };
}

/** 读回给定桶（一个聚合组）的全部 span，按 spanId 去重。 */
export function readJiuwenSpansForKeys(keys: string[]): JiuwenSpan[] {
  const dedup = new Map<string, JiuwenSpan>();
  for (const key of keys) {
    for (const s of readJsonlRows<JiuwenSpan>(bucketFile(key))) {
      if (s?.spanId) dedup.set(s.spanId, s);
    }
  }
  return Array.from(dedup.values());
}

// ── 过期清理（节流触发）──────────────────────────────────────────────────────

function retentionDays(): number {
  const raw = process.env.AGENT_INSIGHT_JIUWEN_SPOOL_RETENTION_DAYS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 7;
}

const PRUNE_THROTTLE_MS = 30 * 60 * 1000; // 每进程最多每 30 分钟清一次
let lastPruneAt = 0;

/**
 * 删除 mtime 超过保留期的桶文件，并重写 session-index（剔除已失效的 key + 去重）。
 * 默认每进程最多每 30 分钟跑一次，开销可忽略。
 */
export function pruneJiuwenSpool(now: number = Date.now()): void {
  if (now - lastPruneAt < PRUNE_THROTTLE_MS) return;
  lastPruneAt = now;

  const cutoff = now - retentionDays() * 24 * 60 * 60 * 1000;
  const dir = bucketsDir();
  const surviving = new Set<string>(); // 仍存在的 safeBucketSegment

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return; // 桶目录还不存在，没什么可清
  }

  for (const name of entries) {
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) {
        fs.rmSync(full, { force: true });
      } else {
        surviving.add(name.replace(/\.jsonl$/, ''));
      }
    } catch {
      // 删/读失败就跳过这条
    }
  }

  rewriteSessionIndex(surviving);
}

// 重写 session-index：只保留桶文件仍存在的 key，并按 (key,session) 去重（marker 取 OR）。
function rewriteSessionIndex(survivingSegments: Set<string>): void {
  const file = sessionIndexFile();
  const rows = readJsonlRows<{ key?: string; session?: string; marker?: boolean }>(file);
  if (!rows.length) return;

  const merged = new Map<string, { key: string; session: string; marker: boolean }>();
  for (const row of rows) {
    const key = row?.key;
    const session = row?.session;
    if (!key || !session) continue;
    if (!survivingSegments.has(safeBucketSegment(key))) continue; // 桶已被清，丢弃索引行
    const ks = `${key}\u0000${session}`;
    const prev = merged.get(ks);
    if (prev) prev.marker = prev.marker || !!row.marker;
    else merged.set(ks, { key, session, marker: !!row.marker });
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const text = Array.from(merged.values())
      .map((r) => JSON.stringify(r))
      .join('\n');
    fs.writeFileSync(tmp, text ? text + '\n' : '', 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // 重写失败不致命：索引仍可用（只是略大 / 含失效行），下次再试
  }
}
