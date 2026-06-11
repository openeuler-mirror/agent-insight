import assert from "node:assert/strict"
import test from "node:test"

import { normalizeClaudeOtlpTraces } from "@/lib/ingest/claude-otel/otlp-json"

const attr = (key: string, value: any) => ({
  key,
  value:
    typeof value === "number"
      ? Number.isInteger(value)
        ? { intValue: value }
        : { doubleValue: value }
      : typeof value === "boolean"
        ? { boolValue: value }
        : { stringValue: String(value) },
})

test("OTel traces: normalizes gen_ai and tool spans into trace events", () => {
  const body = {
    resourceSpans: [{
      resource: {
        attributes: [
          attr("service.name", "opencode"),
          attr("service.instance.id", "instance-a"),
          attr("session.id", "unknown"),
          attr("user.id", "resource-user"),
        ],
      },
      scopeSpans: [{
        spans: [
          {
            traceId: "trace-a",
            spanId: "span-llm",
            name: "chat.completions",
            startTimeUnixNano: "1000000000",
            endTimeUnixNano: "2500000000",
            attributes: [
              attr("gen_ai.request.model", "gpt-test"),
              attr("gen_ai.usage.input_tokens", 11),
              attr("gen_ai.usage.output_tokens", 7),
              attr("gen_ai.prompt", "hello"),
              attr("gen_ai.completion", "done"),
            ],
          },
          {
            traceId: "trace-a",
            spanId: "span-tool",
            parentSpanId: "span-llm",
            name: "tool.call",
            startTimeUnixNano: "3000000000",
            endTimeUnixNano: "3200000000",
            attributes: [
              attr("tool.name", "Read"),
              attr("tool.arguments", "{\"file\":\"README.md\"}"),
            ],
          },
        ],
      }],
    }],
  }

  const events = normalizeClaudeOtlpTraces(body, {
    receivedAt: "2026-06-09T00:00:00.000Z",
    authenticatedUser: "alice",
  })

  assert.equal(events.length, 2)
  assert.equal(events[0].sessionId, "trace-a")
  assert.equal(events[0].serviceName, "opencode")
  assert.equal(events[0].kind, "llm")
  assert.equal(events[0].user, "alice")
  assert.equal(events[0].model, "gpt-test")
  assert.deepEqual(events[0].usage, {
    input_tokens: 11,
    output_tokens: 7,
    reasoning_tokens: undefined,
    total_tokens: 18,
  })
  assert.equal(events[0].latencyMs, 1500)
  assert.equal(events[0].startTimeMs, 1000)
  assert.equal(events[1].kind, "tool")
  assert.equal(events[1].parentSpanId, "span-llm")
})

test("OTel traces: normalizes Hermes llm model and token count attributes", () => {
  const body = {
    resourceSpans: [{
      resource: {
        attributes: [
          attr("service.name", "hermes"),
          attr("service.instance.id", "hermes-instance"),
        ],
      },
      scopeSpans: [{
        spans: [
          {
            traceId: "trace-hermes",
            spanId: "span-api",
            name: "api.GLM-5.1",
            startTimeUnixNano: "1000000000",
            endTimeUnixNano: "2500000000",
            attributes: [
              attr("hermes.session_id", "20260611_103002_288942"),
              attr("llm.model_name", "GLM-5.1"),
              attr("llm.token_count.prompt", 5),
              attr("llm.token_count.completion", 3),
              attr("llm.token_count.reasoning", 2),
              attr("llm.token_count.total", 99),
              attr("input.value", "Which subagents are available?"),
              attr("output.value", "Here are the available subagents."),
            ],
          },
        ],
      }],
    }],
  }

  const events = normalizeClaudeOtlpTraces(body, {
    receivedAt: "2026-06-11T00:00:00.000Z",
  })

  assert.equal(events.length, 1)
  assert.equal(events[0].sessionId, "20260611_103002_288942")
  assert.equal(events[0].serviceName, "hermes")
  assert.equal(events[0].model, "GLM-5.1")
  assert.deepEqual(events[0].usage, {
    input_tokens: 5,
    output_tokens: 3,
    reasoning_tokens: 2,
    total_tokens: 99,
  })
})
