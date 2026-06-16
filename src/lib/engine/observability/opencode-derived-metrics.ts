type AnyObj = Record<string, any>

function toMsTimestamp(v: any): number | null {
  if (v == null) return null
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string") {
    const s = v.trim()
    if (!s) return null
    if (/^\d+$/.test(s)) {
      const n = Number(s)
      return Number.isFinite(n) ? n : null
    }
    const t = Date.parse(s)
    return Number.isFinite(t) ? t : null
  }
  return null
}

function usageTotals(u: any) {
  const input = Number(u?.input_tokens ?? u?.input ?? 0) || 0
  const rawOutput = Number(u?.output_tokens ?? u?.output ?? 0) || 0
  const cacheRead = Number(u?.cache?.read ?? u?.cache_read_input_tokens ?? 0) || 0
  const cacheWrite = Number(u?.cache?.write ?? u?.cache_creation_input_tokens ?? 0) || 0
  const reasoning = Number(u?.reasoning ?? u?.reasoning_tokens ?? u?.completion_tokens_details?.reasoning_tokens ?? 0) || 0

  const output =
    u?.reasoning !== undefined && reasoning > 0 && rawOutput < reasoning ? rawOutput + reasoning : rawOutput

  const total =
    u?.total !== undefined
      ? Number(u.total) || 0
      : input + output + cacheRead + cacheWrite

  return {
    total,
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    maxSingleCallTokens: input + output + cacheRead + cacheWrite,
  }
}

export function deriveOpencodeExecutionFields(interactions: AnyObj[]) {
  let totalTokens = 0
  let totalLatencyMs = 0
  let model = ""
  let finalResult = ""
  let agentName = ""

  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCacheReadInputTokens = 0
  let totalCacheCreationInputTokens = 0
  let totalReasoningTokens = 0
  let llmCallCount = 0
  let toolCallCount = 0
  let toolCallErrorCount = 0
  let maxSingleCallTokens = 0

  let firstTs = Number.MAX_SAFE_INTEGER
  let lastTs = 0

  for (const m of interactions || []) {
    if (!m) continue
    const role = m.role
    const isCompletion = role === "assistant" || role === "subagent"

    if (role === "assistant") {
      const c = typeof m.content === "string" ? m.content : ""
      if (c && c.trim()) finalResult = c
      if (typeof m.model === "string" && m.model) model = m.model
      else if (typeof m.modelID === "string" && m.modelID) model = m.modelID
    }

    if (m.agent && typeof m.agent === "string" && !agentName) {
      agentName = m.agent;
    }

    const created = toMsTimestamp(m.timeInfo?.created)
    const completed = toMsTimestamp(m.timeInfo?.completed)
    const ts = toMsTimestamp(m.timestamp)

    if (created) {
      firstTs = Math.min(firstTs, created)
      lastTs = Math.max(lastTs, created)
    }
    if (completed) {
      lastTs = Math.max(lastTs, completed)
    }
    if (ts) {
      firstTs = Math.min(firstTs, ts)
      lastTs = Math.max(lastTs, ts)
    }

    if (!isCompletion) continue

    llmCallCount++

    const u = m.usage
    if (u) {
      const t = usageTotals(u)
      totalTokens += t.total
      totalInputTokens += t.input
      totalOutputTokens += t.output
      totalCacheReadInputTokens += t.cacheRead
      totalCacheCreationInputTokens += t.cacheWrite
      totalReasoningTokens += t.reasoning
      if (t.maxSingleCallTokens > maxSingleCallTokens) maxSingleCallTokens = t.maxSingleCallTokens
    }

    if (Array.isArray(m.tool_calls)) {
      toolCallCount += m.tool_calls.length
      for (const tc of m.tool_calls) {
        if (tc?.state === "error" || tc?.state === "failed") toolCallErrorCount++
      }
    }
  }

  if (firstTs !== Number.MAX_SAFE_INTEGER && lastTs > firstTs) {
    totalLatencyMs = lastTs - firstTs
  }

  return {
    model: model || undefined,
    agentName: agentName || undefined,
    final_result: finalResult || undefined,
    tokens: Math.round(totalTokens),
    latency: totalLatencyMs / 1000,
    input_tokens: Math.round(totalInputTokens),
    output_tokens: Math.round(totalOutputTokens),
    tool_call_count: toolCallCount,
    tool_call_error_count: toolCallErrorCount,
    llm_call_count: llmCallCount,
    cache_read_input_tokens: Math.round(totalCacheReadInputTokens),
    cache_creation_input_tokens: Math.round(totalCacheCreationInputTokens),
    max_single_call_tokens: Math.round(maxSingleCallTokens),
    reasoning_tokens: Math.round(totalReasoningTokens),
  }
}

/**
 * 把若干条 opencode 原生 token 用量对象累加成一份总量，口径与 deriveOpencodeExecutionFields
 * 完全一致（复用 usageTotals）。每条入参形如 assistant message 的 `info.tokens`：
 *   `{ input, output, reasoning, cache: { read, write } }`
 *
 * 用途：流式层（opencode-client.chat）在不额外拉一次 listMessages 的前提下，把本轮真实
 * token 用量直接回收进 chat stats —— 与最终落库的 Execution.tokens 同口径，使
 * DebugJobResult.tokenUsage / 灰度 run.tokenUsage 等成本统计不再恒为 0。
 */
export function sumOpencodeTokenUsages(usages: Array<AnyObj | null | undefined>) {
  let total = 0
  let input = 0
  let output = 0
  let reasoning = 0
  let cacheRead = 0
  let cacheWrite = 0
  for (const u of usages || []) {
    if (!u) continue
    const t = usageTotals(u)
    total += t.total
    input += t.input
    output += t.output
    reasoning += t.reasoning
    cacheRead += t.cacheRead
    cacheWrite += t.cacheWrite
  }
  return {
    total: Math.round(total),
    input: Math.round(input),
    output: Math.round(output),
    reasoning: Math.round(reasoning),
    cacheRead: Math.round(cacheRead),
    cacheWrite: Math.round(cacheWrite),
  }
}

