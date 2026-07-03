/**
 * jiuwen OTLP ingest: agent-core's OTLP exporter pushes spans in BATCHES (the
 * BatchSpanProcessor flushes several times during a run), so we can't one-shot
 * aggregate per POST. We persist spans per TRACE id to a durable disk spool,
 * dedupe by spanId, and re-aggregate on every flush — saveExecutionRecord with the
 * jiuwen adapter's sessionMergeStrategy='snapshot-replace' overwrites, so the record
 * converges to the complete trace as batches arrive.
 *
 * Durability (this is the whole point): spans are appended to disk BEFORE we
 * aggregate, and every re-aggregation reads the FULL accumulation back FROM disk —
 * not from process memory. So a restart (e.g. the OOM that big traces used to
 * trigger) no longer loses the spans collected so far; the next batch (or a manual
 * replay) re-reads the on-disk spool and snapshot-replace overwrites with the
 * complete trace again. Memory stays bounded: each re-aggregation loads only the
 * spans of the touched group, then releases them — the old unbounded in-memory Map
 * is gone. See spool.ts and docs/designs/agents/jiuwenswarm-tracing/durable-span-spool.md.
 *
 * Why key by traceId, not agentteam.session.id: single-agent runs reuse a
 * process-wide session id (the ACP CLI hard-codes "acp_cli_session"), so keying
 * the spool by session id merged separate invocations into one trace. Each run
 * gets a fresh traceId, so we bucket by traceId — and STITCH the multiple trace
 * ids of a genuine multi-trace run (team / task fan-out) back together at save
 * time, grouping by session id only for those runs (which carry team/agent/task
 * spans). The session→buckets relation needed for that stitching is reconstructed
 * from the on-disk session-index (it used to be derived by walking the in-memory
 * Map). aggregate.ts mirrors this: single runs => task_id `jiuwen-<traceId>`,
 * team/fan-out => the session id.
 *
 * Coalescing (perf): re-aggregation is O(session size) per flush, so doing it on
 * EVERY batch made a whole run cost O(N²) — on 10M-token team runs the tail
 * batches took seconds each and, with the exporter draining serially, delayed the
 * completion signal by tens of minutes. Batches now only append to the spool
 * immediately; the expensive read+aggregate+save is throttled per group by
 * JiuwenBatchCoalescer (first batch and completion-signal batches flush at once,
 * the rest coalesce into a trailing flush). See coalesce.ts.
 */
import { saveExecutionRecord, deleteExecutionsByTaskId } from '@/lib/storage/data-service';
import { collectJiuwenSpans, aggregateJiuwenOtlpFromSpans } from './aggregate';
import { JiuwenBatchCoalescer, batchHasEndedTeamRoot } from './coalesce';
import {
  appendJiuwenSpans,
  readJiuwenSessionIndex,
  readJiuwenSpansForKeys,
  pruneJiuwenSpool,
} from './spool';

function coalesceIntervalMs(): number {
  const raw = Number(process.env.AGENT_INSIGHT_JIUWEN_COALESCE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 15_000;
}

/** Resolve one bucket key's aggregation group, read the group's spans back FROM
 *  DISK, re-aggregate, and snapshot-replace into the DB. Returns the saved task_id.
 *  Re-resolves the session index at flush time so a deferred flush picks up any
 *  sibling traces / markers that arrived while it was queued. */
async function flushGroupByKey(key: string, user?: string): Promise<string | null> {
  const { sessionToKeys, multiTraceSessions, keyToSession } = readJiuwenSessionIndex();

  // Stitch sibling traces only when the session is a genuine multi-trace (team /
  // fan-out) run; otherwise this trace stands alone (single agent — never merge
  // separate invocations that happen to share the hard-coded session id).
  const sess = keyToSession.get(key);
  const stitched = !!sess && multiTraceSessions.has(sess);
  const groupKeys = stitched
    ? Array.from(sessionToKeys.get(sess!) ?? new Set([key]))
    : [key];

  const all = readJiuwenSpansForKeys(groupKeys);
  const record = aggregateJiuwenOtlpFromSpans(all, { user });
  if (!record?.task_id) return null;
  await saveExecutionRecord(record);

  // 多 trace（team / fan-out）聚合落库后，清理此前被误判为单 agent 而单独存的孤儿：
  // 早到批次在 team/task 标记到达前会以 jiuwen-<traceId> 存一条，待该 trace 并入本
  // session（sess_…）后这条需删除，否则界面重复出现、且首轮 llm/token 被计两遍。
  // groupKeys 即本 session 的全部 trace id，孤儿 task_id 必为 jiuwen-<key>，可精确定位。
  // 注意：只删 DB 里的孤儿记录，不删桶文件——那些 span 仍是本 session 的数据。
  if (stitched) {
    for (const k of groupKeys) {
      const orphanTaskId = `jiuwen-${k}`;
      if (orphanTaskId !== record.task_id) {
        await deleteExecutionsByTaskId(orphanTaskId, 'jiuwenswarm');
      }
    }
  }
  return record.task_id;
}

const coalescer = new JiuwenBatchCoalescer(
  async (key, user) => {
    try {
      await flushGroupByKey(key, user);
    } catch (error) {
      console.warn(`[jiuwen-ingest] deferred flush failed for ${key}`, error);
    }
  },
  { intervalMs: coalesceIntervalMs() },
);

export async function ingestJiuwenOtlp(
  body: any,
  opts: { user?: string } = {},
): Promise<{ received: number; sessions: string[] }> {
  const spans = collectJiuwenSpans(body);
  if (!spans.length) return { received: 0, sessions: [] };

  // 1) Durably persist this batch's spans to disk BEFORE any processing.
  const { touchedKeys } = appendJiuwenSpans(spans);

  // 2) Group the touched buckets by their coalesce identity (session for stitched
  //    multi-trace runs, traceId otherwise) so one team run throttles as ONE group.
  const { multiTraceSessions, keyToSession } = readJiuwenSessionIndex();
  const groupRep = new Map<string, { key: string; urgent: boolean }>();
  for (const key of touchedKeys) {
    const sess = keyToSession.get(key);
    const groupId = sess && multiTraceSessions.has(sess) ? sess : key;
    const urgent = batchHasEndedTeamRoot(spans, key);
    const existing = groupRep.get(groupId);
    if (!existing) groupRep.set(groupId, { key, urgent });
    else if (urgent && !existing.urgent) groupRep.set(groupId, { key, urgent });
  }

  // 3) Offer each group to the coalescer: first-seen / completion-signal batches
  //    flush (aggregate + save) immediately, the rest coalesce into a trailing
  //    flush. `saved` only reflects immediate flushes — deferred groups land in
  //    the DB when their timer (or the next qualifying batch) fires.
  const saved: string[] = [];
  for (const [groupId, { key, urgent }] of groupRep) {
    const outcome = await coalescer.offer(groupId, { urgent, user: opts.user, repKey: key });
    if (outcome === 'flushed') {
      // flushed via coalescer→flushGroupByKey; recover the task_id for the response
      const sess = keyToSession.get(key);
      const stitched = !!sess && multiTraceSessions.has(sess);
      saved.push(stitched ? sess! : `jiuwen-${key}`);
    }
  }

  // 4) Opportunistic spool retention (throttled to ~once/30min per process).
  pruneJiuwenSpool();

  return { received: spans.length, sessions: saved };
}
