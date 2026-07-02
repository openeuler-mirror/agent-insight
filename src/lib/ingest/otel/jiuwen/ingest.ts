/**
 * jiuwen OTLP ingest: agent-core's OTLP exporter pushes spans in BATCHES (the
 * BatchSpanProcessor flushes several times during a run), so we can't one-shot
 * aggregate per POST. We persist spans per TRACE id to a durable disk spool,
 * dedupe by spanId, and re-aggregate on every batch — saveExecutionRecord with the
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
 */
import { saveExecutionRecord, deleteExecutionsByTaskId } from '@/lib/storage/data-service';
import { collectJiuwenSpans, aggregateJiuwenOtlpFromSpans } from './aggregate';
import {
  appendJiuwenSpans,
  readJiuwenSessionIndex,
  readJiuwenSpansForKeys,
  pruneJiuwenSpool,
} from './spool';

export async function ingestJiuwenOtlp(
  body: any,
  opts: { user?: string } = {},
): Promise<{ received: number; sessions: string[] }> {
  const spans = collectJiuwenSpans(body);
  if (!spans.length) return { received: 0, sessions: [] };

  // 1) Durably persist this batch's spans to disk BEFORE any processing.
  const { touchedKeys } = appendJiuwenSpans(spans);

  // 2) Rebuild the session→buckets / multi-trace view from the lightweight on-disk
  //    index. This replaces the old "walk the whole in-memory Map" step and, unlike
  //    it, survives a restart.
  const { sessionToKeys, multiTraceSessions, keyToSession } = readJiuwenSessionIndex();

  // 3) For each touched bucket, resolve its aggregation group, read that group's
  //    spans back FROM DISK, re-aggregate, and snapshot-replace into the DB.
  const saved: string[] = [];
  const doneGroups = new Set<string>();
  for (const key of touchedKeys) {
    // Stitch sibling traces only when the session is a genuine multi-trace (team /
    // fan-out) run; otherwise this trace stands alone (single agent — never merge
    // separate invocations that happen to share the hard-coded session id).
    const sess = keyToSession.get(key);
    const stitched = !!sess && multiTraceSessions.has(sess);
    const groupKeys = stitched
      ? Array.from(sessionToKeys.get(sess!) ?? new Set([key]))
      : [key];

    const groupId = groupKeys.slice().sort().join('|');
    if (doneGroups.has(groupId)) continue;
    doneGroups.add(groupId);

    const all = readJiuwenSpansForKeys(groupKeys);
    const record = aggregateJiuwenOtlpFromSpans(all, { user: opts.user });
    if (record?.task_id) {
      await saveExecutionRecord(record);
      saved.push(record.task_id);

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
    }
  }

  // 4) Opportunistic spool retention (throttled to ~once/30min per process).
  pruneJiuwenSpool();

  return { received: spans.length, sessions: saved };
}
