/**
 * Backfill QwenPaw traces that were stored without a root USER interaction.
 *
 * Usage:
 *   node --import tsx scripts/backfill-qwenpaw-user-traces.ts
 *   node --import tsx scripts/backfill-qwenpaw-user-traces.ts --apply
 *   node --import tsx scripts/backfill-qwenpaw-user-traces.ts --task-id=qwenpaw-...
 */

import fs from 'node:fs'
import path from 'node:path'

import { getOtelTraceSpoolDir, readOtelTraceEventsForSession } from '@/lib/ingest/otel/spool'
import { aggregateOtelTraceEvents } from '@/lib/ingest/otel/aggregate'
import { saveExecutionRecord } from '@/lib/storage/data-service'
import { prismaRaw } from '@/lib/storage/prisma'
import type { OtelTraceEvent } from '@/lib/ingest/otel/types'

export {}

const APPLY = process.argv.includes('--apply')
const PLACEHOLDER_QUERY = 'qwenpaw session'

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

function parseInteractions(raw: string | null | undefined): any[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function hasRootUser(interactions: any[]): boolean {
  return interactions.some((item) =>
    item &&
    typeof item === 'object' &&
    String(item.role || '').toLowerCase() === 'user' &&
    !item.subagent_session_id &&
    String(item.content || '').trim())
}

function isPlaceholderQuery(query: string | null | undefined): boolean {
  return !String(query || '').trim() || String(query || '').trim().toLowerCase() === PLACEHOLDER_QUERY
}

function collectProcessedFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collectProcessedFiles(fullPath, out)
    } else if (entry.isFile() && /^traces\.jsonl\.processed(?:\.\d+)?$/.test(entry.name)) {
      out.push(fullPath)
    }
  }
  return out
}

function readJsonlForSessions(file: string, sessionIds: Set<string>, bySession: Map<string, OtelTraceEvent[]>): number {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return 0
  }
  let count = 0
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as OtelTraceEvent
      if (!event?.sessionId || !sessionIds.has(event.sessionId)) continue
      const list = bySession.get(event.sessionId) || []
      list.push(event)
      bySession.set(event.sessionId, list)
      count++
    } catch {}
  }
  return count
}

async function main(): Promise<void> {
  const spoolDir = argValue('spool-dir') || getOtelTraceSpoolDir()
  const onlyTaskId = argValue('task-id')
  const executions: Array<{ id: string; taskId: string | null; query: string | null }> =
    await prismaRaw.execution.findMany({
      where: {
        framework: 'qwenpaw',
        isSubagent: false,
        ...(onlyTaskId ? { taskId: onlyTaskId } : {}),
      },
      select: { id: true, taskId: true, query: true },
      orderBy: { timestamp: 'desc' },
    })

  const candidates: Array<{
    executionId: string
    taskId: string
    query: string | null
    interactions: any[]
  }> = []
  for (const execution of executions) {
    if (!execution.taskId) continue
    const session = await prismaRaw.session.findUnique({
      where: { taskId: execution.taskId },
      select: { interactions: true },
    })
    const interactions = parseInteractions(session?.interactions)
    if (!isPlaceholderQuery(execution.query) && hasRootUser(interactions)) continue
    candidates.push({
      executionId: execution.id,
      taskId: execution.taskId,
      query: execution.query,
      interactions,
    })
  }

  const candidateIds = new Set(candidates.map((candidate) => candidate.taskId))
  const processedEvents = new Map<string, OtelTraceEvent[]>()
  const processedFiles = collectProcessedFiles(spoolDir).sort()
  let processedEventCount = 0
  for (const file of processedFiles) {
    processedEventCount += readJsonlForSessions(file, candidateIds, processedEvents)
  }

  const stats = {
    scanned: executions.length,
    candidates: candidates.length,
    updated: 0,
    skipped: 0,
    missingSpool: 0,
    noUser: 0,
  }

  console.log(`[QwenPawBackfill] mode=${APPLY ? 'apply' : 'dry-run'} spool=${spoolDir}`)
  console.log(`[QwenPawBackfill] processedFiles=${processedFiles.length} processedEvents=${processedEventCount}`)

  for (const candidate of candidates) {
    const activeEvents = readOtelTraceEventsForSession(candidate.taskId, spoolDir)
    const events = [...activeEvents, ...(processedEvents.get(candidate.taskId) || [])]
    if (!events.length) {
      stats.missingSpool++
      console.log(`[missing-spool] ${candidate.taskId}`)
      continue
    }

    const record = aggregateOtelTraceEvents(candidate.taskId, events)
    const interactions = Array.isArray(record?.interactions) ? record.interactions : []
    if (!record || record.framework !== 'qwenpaw' || !hasRootUser(interactions) || isPlaceholderQuery(record.query)) {
      stats.noUser++
      console.log(`[no-user] ${candidate.taskId}`)
      continue
    }

    console.log(
      `[${APPLY ? 'update' : 'would-update'}] ${candidate.taskId} ` +
      `query="${candidate.query || ''}" -> "${record.query}" ` +
      `roles=${interactions.map((item: any) => item.role).join(',')}`,
    )

    if (APPLY) {
      await saveExecutionRecord({
        ...record,
        skip_evaluation: true,
        skip_internal_judgment: true,
      } as any)
    }
    stats.updated++
  }

  stats.skipped = stats.candidates - stats.updated - stats.missingSpool - stats.noUser
  console.log(`[QwenPawBackfill] ${JSON.stringify(stats)}`)
  if (!APPLY) console.log('[QwenPawBackfill] dry-run only; pass --apply to write changes.')
  await prismaRaw.$disconnect()
}

main().catch(async (error) => {
  console.error('[QwenPawBackfill] failed:', error)
  try {
    await prismaRaw.$disconnect()
  } catch {}
  process.exit(1)
})
