/**
 * jiuwen OTLP ingest: agent-core's OTLP exporter pushes spans in BATCHES (the
 * BatchSpanProcessor flushes several times during a run), so we can't one-shot
 * aggregate per POST. We spool spans per TRACE id, dedupe by spanId, and
 * re-aggregate on every batch — saveExecutionRecord with the jiuwen adapter's
 * sessionMergeStrategy='snapshot-replace' overwrites, so the record converges to
 * the complete trace as batches arrive.
 *
 * Why key by traceId, not agentteam.session.id: single-agent runs reuse a
 * process-wide session id (the ACP CLI hard-codes "acp_cli_session"), so keying
 * the spool by session id merged separate invocations into one trace. Each run
 * gets a fresh traceId, so we bucket by traceId — and STITCH the multiple trace
 * ids of a genuine multi-trace run (team / task fan-out) back together at save
 * time, grouping by session id only for those runs (which carry team/agent/task
 * spans). aggregate.ts mirrors this: single runs => task_id `jiuwen-<traceId>`,
 * team/fan-out => the session id.
 *
 * Prototype note: the spool is in-memory (per dev process). Productionizing
 * would move it to the same durable spool the claude-otel path uses.
 */
import { saveExecutionRecord } from '@/lib/storage/data-service';
import { collectJiuwenSpans, aggregateJiuwenOtlpFromSpans, type JiuwenSpan } from './aggregate';

const spool = new Map<string, Map<string, JiuwenSpan>>(); // traceKey -> spanId -> span

function traceKeyFor(s: JiuwenSpan): string {
  return s.traceId || spanSession(s) || 'jiuwen';
}

function spanSession(s: JiuwenSpan): string | undefined {
  const sid = s.attrs['agentteam.session.id'];
  return sid ? String(sid) : undefined;
}

// Markers of a multi-trace run whose spans must be stitched by session id.
function isMultiTraceSpan(s: JiuwenSpan): boolean {
  return (
    s.name.startsWith('team.') ||
    s.name.startsWith('tool.task') ||
    (s.name.startsWith('agent.') && s.name.includes('.task_iteration.'))
  );
}

function bucketSpans(key: string): JiuwenSpan[] {
  return Array.from(spool.get(key)?.values() ?? []);
}

export async function ingestJiuwenOtlp(
  body: any,
  opts: { user?: string } = {},
): Promise<{ received: number; sessions: string[] }> {
  const spans = collectJiuwenSpans(body);
  if (!spans.length) return { received: 0, sessions: [] };

  const touched = new Set<string>();
  for (const s of spans) {
    if (!s.spanId) continue;
    const key = traceKeyFor(s);
    if (!spool.has(key)) spool.set(key, new Map());
    spool.get(key)!.set(s.spanId, s);
    touched.add(key);
  }

  // Map session id -> its trace keys, and which sessions are multi-trace
  // (team / fan-out). Only those get stitched across trace ids.
  const sessionToKeys = new Map<string, Set<string>>();
  const multiTraceSessions = new Set<string>();
  for (const [key, bucket] of spool) {
    for (const s of bucket.values()) {
      const sess = spanSession(s);
      if (!sess) continue;
      (sessionToKeys.get(sess) ?? sessionToKeys.set(sess, new Set()).get(sess)!).add(key);
      if (isMultiTraceSpan(s)) multiTraceSessions.add(sess);
    }
  }

  const saved: string[] = [];
  const doneGroups = new Set<string>();
  for (const key of touched) {
    // Resolve this trace's aggregation group: stitch sibling traces only when the
    // session is a genuine multi-trace (team / fan-out) run; otherwise this trace
    // stands alone (single agent — never merge separate invocations).
    const sess = bucketSpans(key).map(spanSession).find(Boolean);
    const groupKeys =
      sess && multiTraceSessions.has(sess)
        ? Array.from(sessionToKeys.get(sess) ?? [key])
        : [key];

    const groupId = groupKeys.slice().sort().join('|');
    if (doneGroups.has(groupId)) continue;
    doneGroups.add(groupId);

    const all = groupKeys.flatMap(bucketSpans);
    const record = aggregateJiuwenOtlpFromSpans(all, { user: opts.user });
    if (record?.task_id) {
      await saveExecutionRecord(record);
      saved.push(record.task_id);
    }
  }
  return { received: spans.length, sessions: saved };
}
