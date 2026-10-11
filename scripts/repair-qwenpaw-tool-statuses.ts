/**
 * Repair one QwenPaw trace whose normal async-generator closure was recorded
 * as a tool error by older AgentInsight middleware.
 *
 * Usage:
 *   node --import tsx scripts/repair-qwenpaw-tool-statuses.ts \
 *     --task-id=<trace-id> --session-file=<qwenpaw-session.json>
 *   node --import tsx scripts/repair-qwenpaw-tool-statuses.ts \
 *     --task-id=<trace-id> --session-file=<qwenpaw-session.json> --apply
 *
 * The default is dry-run. It never rewrites old spool rows: corrected copies
 * with the same span ID are appended, then the normal snapshot aggregation
 * selects the latest copy.
 */

import fs from 'node:fs'

import { aggregateOtelTraceEvents } from '@/lib/ingest/otel/aggregate'
import { appendOtelTraceEvents, getOtelTraceSpoolDir, readOtelTraceEventsForSession } from '@/lib/ingest/otel/spool'
import { saveExecutionRecord } from '@/lib/storage/data-service'
import type { OtelTraceEvent } from '@/lib/ingest/otel/types'
import { prismaRaw } from '@/lib/storage/prisma'

const APPLY = process.argv.includes('--apply')
const FAILURE_STATES = new Set(['error', 'failed', 'denied', 'interrupted', 'cancelled'])

type SessionToolResult = { name: string; state: string }

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

function normalizedName(value: unknown): string {
  return String(value || '').trim().replace(/^tool\./i, '').toLowerCase()
}

function eventToolName(event: OtelTraceEvent): string {
  return normalizedName(event.attributes?.['tool.name'] || event.name)
}

function isToolSpan(event: OtelTraceEvent): boolean {
  return String(event.attributes?.['gen_ai.span.kind'] || event.attributes?.['openinference.span.kind'] || '')
    .toUpperCase() === 'TOOL'
}

function responseState(value: unknown): string {
  const state = String(value || 'success').trim().toLowerCase()
  return ({ ok: 'success', completed: 'success', failure: 'failed', canceled: 'cancelled' } as Record<string, string>)[state] || state
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(outputText).join('\n')
  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>
    return outputText(item.text ?? item.content ?? '')
  }
  return String(value ?? '')
}

function legacyExitCode(value: unknown): number | undefined {
  const match = /\bexit\s+code\s+(-?\d+)\b/i.exec(outputText(value))
  return match ? Number(match[1]) : undefined
}

function collectSessionToolResults(value: unknown, out: SessionToolResult[] = []): SessionToolResult[] {
  if (Array.isArray(value)) {
    for (const item of value) collectSessionToolResults(item, out)
    return out
  }
  if (!value || typeof value !== 'object') return out
  const item = value as Record<string, unknown>
  if (item.type === 'tool_result') {
    out.push({ name: normalizedName(item.name), state: responseState(item.state) })
    return out
  }
  for (const child of Object.values(item)) collectSessionToolResults(child, out)
  return out
}

function latestToolSpans(events: OtelTraceEvent[]): OtelTraceEvent[] {
  const latest = new Map<string, OtelTraceEvent>()
  for (const event of events) {
    if (!isToolSpan(event) || !event.spanId) continue
    const previous = latest.get(event.spanId)
    if (!previous || Date.parse(event.receivedAt) >= Date.parse(previous.receivedAt)) latest.set(event.spanId, event)
  }
  return [...latest.values()].sort((left, right) => left.startTimeMs - right.startTimeMs)
}

function repairedEvent(event: OtelTraceEvent, response: SessionToolResult, receivedAt: string): OtelTraceEvent {
  const attrs = { ...event.attributes }
  const name = eventToolName(event)
  const output = attrs['tool.output'] ?? attrs['tool.result'] ?? attrs['skill.output'] ?? attrs['mcp.result']
  const exitCode = name === 'execute_shell_command' ? legacyExitCode(output) : undefined
  const failedByState = FAILURE_STATES.has(response.state)
  const failed = failedByState || (exitCode !== undefined && exitCode !== 0)

  attrs['tool.status'] = failed ? 'error' : 'success'
  delete attrs['error.message']
  delete attrs['exception.message']
  if (exitCode !== undefined) attrs['tool.exit_code'] = exitCode
  else delete attrs['tool.exit_code']

  return { ...event, receivedAt, attributes: attrs }
}

function equivalentStatus(left: OtelTraceEvent, right: OtelTraceEvent): boolean {
  const keys = ['tool.status', 'tool.exit_code', 'error.message', 'exception.message']
  return keys.every((key) => left.attributes?.[key] === right.attributes?.[key])
}

async function main(): Promise<void> {
  const taskId = argValue('task-id')
  const sessionFile = argValue('session-file')
  const spoolDir = argValue('spool-dir') || getOtelTraceSpoolDir()
  if (!taskId || !sessionFile) {
    throw new Error('Usage requires --task-id=<trace-id> and --session-file=<qwenpaw-session.json>.')
  }

  let session: unknown
  try {
    session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read QwenPaw session file: ${sessionFile}; ${String(error)}`)
  }

  const spans = latestToolSpans(readOtelTraceEventsForSession(taskId, spoolDir))
  const responses = collectSessionToolResults(session)
  if (!spans.length) throw new Error(`No tool spans found for ${taskId}.`)
  if (spans.length !== responses.length) {
    throw new Error(`Refusing partial repair: ${spans.length} tool spans but ${responses.length} session results.`)
  }
  for (let index = 0; index < spans.length; index += 1) {
    const spanName = eventToolName(spans[index])
    const responseName = responses[index].name
    if (spanName !== responseName) {
      throw new Error(`Refusing partial repair at index ${index}: span=${spanName} session=${responseName}.`)
    }
  }

  const receivedAt = new Date().toISOString()
  const corrected = spans.map((span, index) => repairedEvent(span, responses[index], receivedAt))
  const changed = corrected.filter((event, index) => !equivalentStatus(spans[index], event))
  const failures = corrected.filter((event) => event.attributes['tool.status'] === 'error')

  console.log(`[QwenPawStatusRepair] mode=${APPLY ? 'apply' : 'dry-run'} task=${taskId}`)
  console.log(`[QwenPawStatusRepair] matched=${spans.length} changes=${changed.length} failures=${failures.length}`)
  for (const event of corrected) {
    const original = spans.find((span) => span.spanId === event.spanId)!
    if (equivalentStatus(original, event)) continue
    console.log(`[would-repair] ${event.spanId} ${eventToolName(event)} ${original.attributes['tool.status']} -> ${event.attributes['tool.status']}`)
  }
  if (!APPLY || changed.length === 0) {
    console.log(!APPLY ? '[QwenPawStatusRepair] dry-run only; pass --apply to write changes.' : '[QwenPawStatusRepair] already repaired; no writes needed.')
    return
  }

  appendOtelTraceEvents(changed, spoolDir)
  const record = aggregateOtelTraceEvents(taskId, readOtelTraceEventsForSession(taskId, spoolDir))
  if (!record || record.framework !== 'qwenpaw') throw new Error(`Reaggregation failed for ${taskId}.`)
  if (record.tool_call_error_count !== failures.length) {
    throw new Error(`Refusing database update: expected ${failures.length} failures, aggregated ${record.tool_call_error_count}.`)
  }
  await saveExecutionRecord({ ...record, skip_evaluation: true, skip_internal_judgment: true } as any)
  console.log(`[QwenPawStatusRepair] repaired=${changed.length} persistedFailures=${record.tool_call_error_count}`)
}

main().catch(async (error) => {
  console.error('[QwenPawStatusRepair] failed:', error)
  try { await prismaRaw.$disconnect() } catch {}
  process.exit(1)
}).finally(async () => {
  try { await prismaRaw.$disconnect() } catch {}
})

