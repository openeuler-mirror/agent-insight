import { canonicalExperimentAgentName } from '@/lib/engine/experiment/agent-identity'

function hasUsableTraceInteractions(value: string | null | undefined): boolean {
  if (!value) return false
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) && parsed.length > 0
  } catch {
    return false
  }
}

/** Require an actual business response, not just prompts or an empty assistant shell. */
export function isFiBusinessTraceUsable(input: {
  platform: string
  agent: string
  executionAgent?: string | null
  interactions?: string | null
  endTime?: Date | string | null
}): boolean {
  const expected = canonicalExperimentAgentName(input.platform, input.agent)
  const actual = canonicalExperimentAgentName(input.platform, input.executionAgent || '')
  if (!expected || !actual || actual === 'ras-judge' || actual !== expected || !input.endTime) return false
  if (!hasUsableTraceInteractions(input.interactions)) return false
  const messages = JSON.parse(input.interactions!) as Array<Record<string, unknown>>
  return messages.some((message) => {
    if (!message || typeof message !== 'object') return false
    const role = String(message.role || '').trim().toLowerCase()
    if (role !== 'assistant' && role !== 'opencode') return false
    if (typeof message.content === 'string' && message.content.trim()) return true
    if ([message.tool_calls, message.toolCalls].some((calls) => Array.isArray(calls) && calls.length)) return true
    const parts = Array.isArray(message.parts) ? message.parts : message.content
    return Array.isArray(parts) && parts.some((part) => part && typeof part === 'object' && (
      (typeof part.text === 'string' && part.text.trim())
      || (['tool', 'tool-call', 'tool_call'].includes(String(part.type)) && (part.callID || part.id))
    ))
  })
}



export const FI_TRACE_ARRIVAL_GRACE_MS = 180_000

/** Terminal collect results have a finite window for the independent trace uploader. */
export function isFiTraceWaitExpired(status: string, updatedAt: Date | string | number, graceMs = FI_TRACE_ARRIVAL_GRACE_MS): boolean {
  if (!['completed', 'judge_skipped', 'failed', 'stopped'].includes(status)) return false
  const updated = new Date(updatedAt).getTime()
  return Number.isFinite(updated) && Date.now() - updated >= graceMs
}
