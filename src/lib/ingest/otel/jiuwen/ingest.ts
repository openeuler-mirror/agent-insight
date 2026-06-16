/**
 * jiuwen OTLP ingest: agent-core's OTLP exporter pushes spans in BATCHES (the
 * BatchSpanProcessor flushes several times during a run), so we can't one-shot
 * aggregate per POST. We spool spans per session (agentteam.session.id, falling
 * back to traceId), dedupe by spanId, and re-aggregate the full accumulation on
 * every batch — saveExecutionRecord with the jiuwen adapter's
 * sessionMergeStrategy='snapshot-replace' overwrites, so the record converges to
 * the complete trace as batches arrive.
 *
 * Prototype note: the spool is in-memory (per dev process). Productionizing
 * would move it to the same durable spool the claude-otel path uses.
 */
import { saveExecutionRecord } from '@/lib/storage/data-service';
import { collectJiuwenSpans, aggregateJiuwenOtlpFromSpans, type JiuwenSpan } from './aggregate';

const spool = new Map<string, Map<string, JiuwenSpan>>(); // sessionId -> spanId -> span
const traceToSession = new Map<string, string>();

function sessionKeyFor(s: JiuwenSpan): string {
  const sid = s.attrs['agentteam.session.id'];
  if (sid) return String(sid);
  if (s.traceId && traceToSession.has(s.traceId)) return traceToSession.get(s.traceId)!;
  return s.traceId || 'jiuwen';
}

export async function ingestJiuwenOtlp(
  body: any,
  opts: { user?: string } = {},
): Promise<{ received: number; sessions: string[] }> {
  const spans = collectJiuwenSpans(body);
  if (!spans.length) return { received: 0, sessions: [] };

  // learn traceId -> session from spans that carry the session attr
  for (const s of spans) {
    const sid = s.attrs['agentteam.session.id'];
    if (sid && s.traceId) traceToSession.set(s.traceId, String(sid));
  }

  const touched = new Set<string>();
  for (const s of spans) {
    if (!s.spanId) continue;
    const key = sessionKeyFor(s);
    if (!spool.has(key)) spool.set(key, new Map());
    spool.get(key)!.set(s.spanId, s);
    touched.add(key);
  }

  const saved: string[] = [];
  for (const key of touched) {
    const all = Array.from(spool.get(key)!.values());
    const record = aggregateJiuwenOtlpFromSpans(all, { user: opts.user });
    if (record?.task_id) {
      await saveExecutionRecord(record);
      saved.push(record.task_id);
    }
  }
  return { received: spans.length, sessions: saved };
}
