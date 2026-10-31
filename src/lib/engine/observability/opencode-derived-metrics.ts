/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { deriveExecutionTiming } from './execution-timing'

type AnyObj = Record<string, any>

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

export function deriveOpencodeExecutionFields(interactions: AnyObj[], sessionId?: string) {
  let totalTokens = 0
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

  return {
    model: model || undefined,
    agentName: agentName || undefined,
    final_result: finalResult || undefined,
    tokens: Math.round(totalTokens),
    latency: deriveExecutionTiming(interactions, sessionId).activeDurationMs ?? 0,
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

