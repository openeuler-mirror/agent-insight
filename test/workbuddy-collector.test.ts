import assert from "node:assert/strict"
import test from "node:test"
import { createRequire } from "node:module"

import { normalizeClaudeOtlpTraces } from "@/lib/ingest/claude-otel/otlp-json"
import { aggregateOtelTraceEvents } from "@/lib/ingest/otel/aggregate"
import { getOtelTraceAdapter } from "@/lib/ingest/otel/adapter-registry"

const require = createRequire(import.meta.url)
const { mapWorkBuddyTrace, normalizeUsage } = require("../scripts/workbuddy-collector/mapper.cjs")
const { canonicalEventsToOtlp } = require("../scripts/agent-trace-collectors/shared/trace-transport.cjs")

/** 构造一条贴近真实结构的 WorkBuddy trace（trace + agent/generation/function/custom spans）。 */
function workbuddyTrace(overrides: {
  traceId: string
  start: string
  prompt: string
  model?: string
  completion?: string
  usage?: Record<string, unknown>
  tool?: { name: string; input: unknown; output: unknown }
}) {
  const usage = overrides.usage ?? {
    prompt_tokens: 500,
    completion_tokens: 120,
    total_tokens: 620,
    prompt_tokens_details: { cached_tokens: 448 },
    completion_tokens_details: { reasoning_tokens: 88 },
  }
  const spans: any[] = [
    {
      traceId: overrides.traceId,
      spanId: `${overrides.traceId}-agent`,
      parentId: null,
      name: "cli",
      type: "agent",
      startedAt: overrides.start,
      endedAt: overrides.start,
      status: "ok",
      agentName: "cli",
    },
    { traceId: overrides.traceId, spanId: `${overrides.traceId}-mcp1`, parentId: null, name: "mcp_tools", type: "custom", startedAt: overrides.start, endedAt: overrides.start, status: "ok" },
    {
      traceId: overrides.traceId,
      spanId: `${overrides.traceId}-gen`,
      parentId: `${overrides.traceId}-agent`,
      name: "generation",
      type: "generation",
      startedAt: overrides.start,
      endedAt: overrides.start,
      status: "ok",
      toolInput: JSON.stringify([
        { role: "system", content: "system prompt" },
        { role: "user", content: [{ type: "text", text: overrides.prompt }] },
      ]),
      toolOutput: JSON.stringify([
        {
          id: "resp-1",
          model: overrides.model ?? "hy4-preview",
          object: "chat.completion",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: overrides.completion ?? "done" } }],
          usage,
        },
      ]),
    },
  ]
  if (overrides.tool) {
    spans.push({
      traceId: overrides.traceId,
      spanId: `${overrides.traceId}-fn`,
      parentId: `${overrides.traceId}-gen`,
      name: overrides.tool.name,
      type: "function",
      startedAt: overrides.start,
      endedAt: overrides.start,
      status: "ok",
      toolName: overrides.tool.name,
      toolInput: JSON.stringify(overrides.tool.input),
      toolOutput: JSON.stringify(overrides.tool.output),
    })
  }
  return {
    trace: {
      traceId: overrides.traceId,
      name: "Agent workflow",
      startedAt: overrides.start,
      endedAt: overrides.start,
      status: "ok",
      spanCount: spans.length,
      totalTokens: 0,
    },
    spans,
  }
}

/** 采集端到服务端全链路：mapper → canonicalEventsToOtlp → normalize → aggregate。 */
function roundTrip(docs: any[], sessionId: string, enrichment: Record<string, unknown> = {}) {
  const canonical = docs.flatMap((doc) => mapWorkBuddyTrace(doc, { sessionId, ...enrichment }))
  const otlp = canonicalEventsToOtlp(canonical, { framework: "workbuddy" })
  const events = normalizeClaudeOtlpTraces(otlp, { receivedAt: "2026-09-06T00:00:00.000Z" })
  return { canonical, events, record: aggregateOtelTraceEvents(sessionId, events) }
}

test("normalizeUsage: 从模型响应精确提取 input/output/reasoning/cache", () => {
  const usage = normalizeUsage({
    prompt_tokens: 513,
    completion_tokens: 1105,
    total_tokens: 1618,
    prompt_tokens_details: { cached_tokens: 448 },
    completion_tokens_details: { reasoning_tokens: 1087 },
  })
  assert.equal(usage.input, 513)
  assert.equal(usage.output, 1105)
  assert.equal(usage.total, 1618)
  assert.equal(usage.reasoning, 1087)
  assert.equal(usage.cache, 448)
})

test("normalizeUsage: 无 usage 返回 undefined（不编造 0）", () => {
  assert.equal(normalizeUsage(undefined), undefined)
  assert.equal(normalizeUsage({}), undefined)
})

test("WorkBuddy round-trip: 单轮 trace 聚合出精确 token 与工具调用", () => {
  const doc = workbuddyTrace({
    traceId: "trace-1",
    start: "2026-09-06T00:00:01.000Z",
    prompt: "你好",
    completion: "你好，有什么可以帮你？",
    tool: { name: "Read", input: { file_path: "README.md" }, output: { title: "Read 3 lines", content: "hello" } },
  })
  const { events, record } = roundTrip([doc], "sess-1", {
    mode: "craft",
    sessionTotals: { used: 620, size: 300000 },
  })

  // 命中 workbuddy adapter（而非 generic 兜底）
  assert.equal(getOtelTraceAdapter(events)?.id, "workbuddy")

  assert.ok(record)
  assert.equal(record.task_id, "sess-1")
  assert.equal(record.framework, "workbuddy")
  assert.equal(record.model, "hy4-preview")
  assert.equal(record.query, "你好")
  assert.equal(record.final_result, "你好，有什么可以帮你？")
  // 精确逐轮 token（来自 generation.toolOutput.usage）
  assert.equal(record.tokens, 620)
  assert.equal(record.input_tokens, 500)
  assert.equal(record.output_tokens, 120)
  assert.equal(record.reasoning_tokens, 88)
  assert.equal(record.cache_read_input_tokens, 448)
  // 会话级上下文占用快照（来自 D4），与逐轮 token 分开表达
  assert.equal(record.context_window_limit, 300000)
  assert.equal(record.workbuddy_session_context_tokens, 620)
  assert.equal(record.context_window_source, "workbuddy_local_sqlite")
  // 交互：user → assistant(带工具调用)
  assert.equal(record.interactions?.[0]?.role, "user")
  assert.equal(record.interactions?.[0]?.content, "你好")
  const assistant = record.interactions?.find((i: any) => i.role === "assistant")
  assert.ok(assistant)
  assert.equal(assistant.tool_calls?.length, 1)
  assert.equal(assistant.tool_calls?.[0]?.function?.name, "Read")
  assert.equal(record.llm_call_count, 1)
  assert.equal(record.tool_call_count, 1) // mcp_tools 噪声 span 不计入
})

test("WorkBuddy round-trip: 多条 trace 归并为一个多轮会话", () => {
  const t1 = workbuddyTrace({ traceId: "trace-a", start: "2026-09-06T00:00:01.000Z", prompt: "第一轮问题", completion: "第一轮回答" })
  const t2 = workbuddyTrace({ traceId: "trace-b", start: "2026-09-06T00:01:00.000Z", prompt: "第二轮问题", completion: "第二轮回答", usage: { prompt_tokens: 700, completion_tokens: 80, total_tokens: 780 } })
  const { record } = roundTrip([t1, t2], "sess-multi", { sessionTotals: { used: 780, size: 200000 } })

  assert.ok(record)
  // 首轮用户提问作为会话 query
  assert.equal(record.query, "第一轮问题")
  // 两轮用户 + 两轮 assistant
  const users = record.interactions?.filter((i: any) => i.role === "user") ?? []
  const assistants = record.interactions?.filter((i: any) => i.role === "assistant") ?? []
  assert.equal(users.length, 2)
  assert.equal(assistants.length, 2)
  // token 为两轮精确 usage 汇总
  assert.equal(record.tokens, 620 + 780)
  assert.equal(record.llm_call_count, 2)
})

test("WorkBuddy round-trip: generation 缺失 usage 时不编造 token", () => {
  const doc = workbuddyTrace({ traceId: "trace-nousage", start: "2026-09-06T00:00:01.000Z", prompt: "hi", usage: {} as any })
  // 把 toolOutput 的 usage 清空
  const gen = doc.spans.find((s: any) => s.type === "generation")
  gen.toolOutput = JSON.stringify([{ model: "hy4-preview", choices: [{ message: { role: "assistant", content: "ok" } }] }])
  const { record } = roundTrip([doc], "sess-nousage")
  assert.ok(record)
  assert.equal(record.tokens, undefined)
  assert.equal(record.input_tokens, undefined)
  assert.equal(record.output_tokens, undefined)
})
