import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { appendOtelTraceEvents } from "@/lib/ingest/claude-otel/spool"
import { aggregateOtelTraceEvents, aggregateOtelTraceSession } from "@/lib/ingest/claude-otel/traces-aggregator"
import type { OtelTraceEvent } from "@/lib/ingest/claude-otel/types"

function traceEvent(overrides: Partial<OtelTraceEvent>): OtelTraceEvent {
  return {
    receivedAt: "2026-06-09T00:00:00.000Z",
    sessionId: "session-a",
    traceId: "trace-a",
    spanId: "span-a",
    name: "span",
    kind: "llm",
    serviceName: "opencode",
    user: "alice",
    model: "gpt-test",
    usage: {
      input_tokens: 1,
      output_tokens: 2,
      total_tokens: 3,
    },
    latencyMs: 100,
    startTimeMs: 1000,
    attributes: {},
    ...overrides,
  }
}

test("OTel traces: aggregates trace spool events into one execution record", () => {
  const events = [
    traceEvent({
      spanId: "span-tool",
      kind: "tool",
      name: "tool.call",
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 20,
      startTimeMs: 1200,
      attributes: { "tool.name": "Read", "tool.arguments": "{\"file\":\"README.md\"}" },
    }),
    traceEvent({
      spanId: "span-llm",
      name: "chat",
      usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      latencyMs: 1500,
      startTimeMs: 1500,
      attributes: { "gen_ai.prompt": "hello", "gen_ai.completion": "done" },
    }),
    traceEvent({
      spanId: "span-llm",
      name: "chat",
      usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      latencyMs: 1500,
      startTimeMs: 1500,
      attributes: { "gen_ai.prompt": "hello", "gen_ai.completion": "done" },
    }),
  ]

  const record = aggregateOtelTraceEvents("session-a", events)

  assert.ok(record)
  assert.equal(record.task_id, "session-a")
  assert.equal(record.framework, "opencode")
  assert.equal(record.query, "hello")
  assert.equal(record.final_result, "done")
  assert.equal(record.model, "gpt-test")
  assert.equal(record.tokens, 18)
  assert.equal(record.input_tokens, 11)
  assert.equal(record.output_tokens, 7)
  assert.equal(record.latency, 1520)
  assert.equal(record.interactions?.length, 1)
  assert.equal(record.interactions?.[0]?.role, "assistant")
  assert.equal(record.interactions?.[0]?.content, "done")
  assert.equal(record.interactions?.[0]?.usage.total, 18)
  assert.equal(record.interactions?.[0]?.tool_calls?.length, 1)
  assert.equal(record.interactions?.[0]?.tool_calls?.[0]?.function?.name, "Read")
  assert.equal(record.llm_call_count, 1)
  assert.equal(record.tool_call_count, 1)
})

test("OTel traces: aggregateOtelTraceSession reads traces spool files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-trace-agg-"))
  try {
    appendOtelTraceEvents([
      traceEvent({
        spanId: "span-llm",
        attributes: { "gen_ai.prompt": "hello", "gen_ai.completion": "done" },
      }),
    ], dir)

    const result = aggregateOtelTraceSession("session-a", dir)
    assert.equal(result.eventCount, 1)
    assert.equal(result.record?.framework, "opencode")
    assert.equal(result.record?.task_id, "session-a")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
