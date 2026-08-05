/**
 * One-shot backfill: FI activated runs → RasAnomalyEvent for 可靠性观测.
 * Usage:
 *   DATABASE_URL=file:... npx tsx scripts/backfill-fi-ras-bridge.ts
 * Optional:
 *   FI_RAS_BRIDGE_USER=you@example.com  — attribute events to this user (visibility)
 *   FI_RAS_BRIDGE_RUN_IDS=id1,id2       — limit to these Insight runIds
 */
import { prisma } from '../src/lib/storage/prisma'
import { bridgeFiCollectToRas } from '../src/lib/fault-injection/ras-bridge'
import type { CollectPayload } from '../src/lib/fault-injection/engine'

async function main() {
  const userOverride = process.env.FI_RAS_BRIDGE_USER || null
  const onlyIds = (process.env.FI_RAS_BRIDGE_RUN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const runs = await prisma.faultInjectionRun.findMany({
    where: {
      faultActivated: true,
      ...(onlyIds.length ? { runId: { in: onlyIds } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })

  console.log(`found ${runs.length} activated FI runs`)
  let written = 0
  for (const run of runs) {
    if (!run.sessionTaskId) {
      console.log(`skip ${run.runId}: no sessionTaskId`)
      continue
    }
    const request = JSON.parse(run.requestJson || '{}') as { model?: string | null }
    const payload: CollectPayload = {
      runId: run.runId,
      taskId: run.sessionTaskId,
      framework: run.platform,
      fault: run.fault,
      injectionMethod: run.injectionMethod || undefined,
      faultActivated: Boolean(run.faultActivated),
      faultActivatedAt: run.faultActivatedAt?.getTime() ?? null,
      interactions: [],
      markers: JSON.parse(run.markersJson || '[]'),
      injectionEvidence: JSON.parse(run.injectionEvidenceJson || '{}'),
    }
    // Skip stub payloads
    const evidence = payload.injectionEvidence || {}
    const runtime = evidence.runtime as { stub?: boolean } | undefined
    if (runtime?.stub || String(payload.taskId).startsWith('fi-session-')) {
      console.log(`skip ${run.runId}: stub/dry-run`)
      continue
    }

    const user = userOverride || run.user
    const result = await bridgeFiCollectToRas({
      insightRunId: run.runId,
      user,
      payload,
      outcome: run.outcome,
      judgeSkipped: run.status === 'judge_skipped' || run.status === 'dry_run',
    })
    console.log(
      `${run.runId} → taskId=${run.sessionTaskId} user=${user} written=${result.written}` +
        (result.skippedReason ? ` (${result.skippedReason})` : '') +
        (request.model ? ` model=${request.model}` : ''),
    )
    written += result.written
  }
  console.log(`done, total written=${written}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
