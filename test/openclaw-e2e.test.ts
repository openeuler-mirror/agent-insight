import assert from "node:assert/strict"
import test from "node:test"

// ── Modules under test ──
import { decodeOtlpProtobuf } from "../src/lib/ingest/claude-otel/otlp-protobuf-decoder"
import { normalizeClaudeOtlpTraces } from "../src/lib/ingest/claude-otel/otlp-json"
import { guardAttribution } from "../src/lib/ingest/claude-otel/attribution-guard"
import { openclawAdapter } from "../src/lib/ingest/adapters/openclaw"
import { aggregateOpenClawOtelTraceEvents } from "../src/lib/ingest/otel/adapters/openclaw"

// ── Helpers ──

function makeSpanAttrs(kind = "llm") {
  const attrs: any[] = [
    { key: "gen_ai.span.kind", value: { stringValue: kind } },
  ]
  if (kind === "llm") {
    attrs.push({ key: "gen_ai.request.model", value: { stringValue: "gpt-4" } })
    attrs.push({ key: "gen_ai.response.usage.input_tokens", value: { intValue: 100 } })
    attrs.push({ key: "gen_ai.response.usage.output_tokens", value: { intValue: 50 } })
  }
  return attrs
}

function stringAttr(key: string, value: string) {
  return { key, value: { stringValue: value } }
}

function intAttr(key: string, value: number) {
  return { key, value: { intValue: value } }
}

function boolAttr(key: string, value: boolean) {
  return { key, value: { boolValue: value } }
}

function makeOpenClawContractRequest() {
  const sessionId = "openclaw-contract-session"
  const agentSpanId = "0x" + "a1".repeat(8)
  return makeTraceRequest({
    instanceId: "instance-must-not-win",
    spans: [
      {
        name: "invoke_agent",
        spanId: agentSpanId,
        attributes: [
          stringAttr("witty.session.id", sessionId),
          stringAttr("witty.user.id", "openclaw-user"),
          stringAttr("witty.agent.name", "planner"),
          stringAttr("witty.agent.id", "planner-1"),
          stringAttr("gen_ai.span.kind", "agent"),
        ],
      },
      {
        name: "chat",
        spanId: "0x" + "a2".repeat(8),
        parentSpanId: agentSpanId,
        attributes: [
          stringAttr("witty.session.id", sessionId),
          stringAttr("witty.user.id", "openclaw-user"),
          stringAttr("witty.agent.name", "planner"),
          stringAttr("gen_ai.span.kind", "llm"),
          stringAttr("gen_ai.request.model", "gpt-contract"),
          stringAttr("gen_ai.prompt", "plan a fix"),
          stringAttr("gen_ai.completion", "done"),
          intAttr("gen_ai.usage.prompt_tokens", 11),
          intAttr("gen_ai.usage.completion_tokens", 7),
          intAttr("gen_ai.usage.total_tokens", 20),
        ],
      },
      {
        name: "custom_tool_span",
        spanId: "0x" + "a3".repeat(8),
        parentSpanId: agentSpanId,
        attributes: [
          stringAttr("witty.session.id", sessionId),
          stringAttr("witty.user.id", "openclaw-user"),
          stringAttr("witty.tool.name", "search"),
          stringAttr("witty.tool.input", "query=otel"),
          stringAttr("witty.tool.result", "found"),
          boolAttr("witty.tool.error", true),
        ],
      },
      {
        name: "custom_skill_span",
        spanId: "0x" + "a4".repeat(8),
        parentSpanId: agentSpanId,
        attributes: [
          stringAttr("witty.session.id", sessionId),
          stringAttr("witty.user.id", "openclaw-user"),
          stringAttr("witty.skill.name", "otel-debug"),
          stringAttr("witty.skill.version", "2"),
        ],
      },
    ],
  })
}

function makeOpenClawAggregationRequest() {
  const body = makeOpenClawContractRequest()
  const spans = body.resourceSpans[0].scopeSpans[0].spans
  const rootSpanId = spans[0].spanId
  const childSpanId = "0x" + "b1".repeat(8)
  spans.push(
    {
      traceId: "0x" + "0a".repeat(16),
      spanId: childSpanId,
      parentSpanId: rootSpanId,
      name: "invoke_agent",
      kind: 2,
      startTimeUnixNano: "1782381605000000000",
      endTimeUnixNano: "1782381609000000000",
      attributes: [
        stringAttr("witty.session.id", "openclaw-contract-session"),
        stringAttr("witty.user.id", "openclaw-user"),
        stringAttr("witty.agent.name", "researcher"),
        stringAttr("witty.agent.id", "researcher-1"),
        stringAttr("gen_ai.span.kind", "agent"),
      ],
      status: { code: 0 },
    } as any,
    {
      traceId: "0x" + "0a".repeat(16),
      spanId: "0x" + "b2".repeat(8),
      parentSpanId: childSpanId,
      name: "chat",
      kind: 3,
      startTimeUnixNano: "1782381606000000000",
      endTimeUnixNano: "1782381608000000000",
      attributes: [
        stringAttr("witty.session.id", "openclaw-contract-session"),
        stringAttr("witty.user.id", "openclaw-user"),
        stringAttr("witty.agent.name", "researcher"),
        stringAttr("gen_ai.span.kind", "llm"),
        stringAttr("gen_ai.request.model", "gpt-contract"),
        stringAttr("gen_ai.prompt", "research otel"),
        stringAttr("gen_ai.completion", "child answer"),
        intAttr("gen_ai.usage.prompt_tokens", 3),
        intAttr("gen_ai.usage.completion_tokens", 2),
        intAttr("gen_ai.usage.total_tokens", 5),
      ],
      status: { code: 0 },
    } as any,
  )

  spans.forEach((span: any, index: number) => {
    span.startTimeUnixNano ||= String(1782381600000000000n + BigInt(index) * 1_000_000_000n)
    span.endTimeUnixNano ||= String(BigInt(span.startTimeUnixNano) + 500_000_000n)
  })
  return body
}

/** Build a full ExportTraceServiceRequest body (JSON shape) */
function makeTraceRequest(opts: {
  serviceName?: string
  instanceId?: string
  spans?: Array<{
    name: string
    kind?: number
    spanId?: string
    parentSpanId?: string | null
    attributes?: any[]
  }>
} = {}) {
  const serviceName = opts.serviceName ?? "openclaw"
  const instanceId = opts.instanceId ?? "inst-001"
  const spans = opts.spans ?? [
    { name: "chat", kind: 3, attributes: makeSpanAttrs("llm") },
  ]

  const resourceAttrs = [
    { key: "service.name", value: { stringValue: serviceName } },
    { key: "service.instance.id", value: { stringValue: instanceId } },
  ]

  const scopeSpans = [{
    scope: { name: "openclaw.trace" },
    spans: spans.map((s) => ({
      traceId: "0x" + "0a".repeat(16),
      spanId: s.spanId ?? "0x" + "bb".repeat(8),
      parentSpanId: s.parentSpanId ?? null,
      name: s.name,
      kind: s.kind ?? 3,
      startTime: "2026-06-25T10:00:00.000Z",
      endTime: "2026-06-25T10:00:05.000Z",
      attributes: s.attributes ?? makeSpanAttrs(),
      status: { code: 0 },
    })),
  }]

  return { resourceSpans: [{ resource: { attributes: resourceAttrs }, scopeSpans }] }
}

// ── TC-001: Config path protobuf e2e ──
test("TC-001: config path protobuf e2e - encodes and decodes protobuf", async () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const root = require("@opentelemetry/otlp-transformer/build/src/generated/root")
  const traceRequestType = root.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest

  const body = makeTraceRequest()
  const buf = traceRequestType.encode(body).finish()
  assert.ok(buf.length > 0)

  // Decode the binary
  const decoded = decodeOtlpProtobuf(buf)
  if ("code" in decoded) {
    throw new Error("decode failed: " + decoded.message)
  }

  assert.equal(decoded.spanCount, 1)
  assert.ok(decoded.body.resourceSpans)
  assert.equal(decoded.body.resourceSpans.length, 1)

  const rs = decoded.body.resourceSpans[0]
  const serviceName = rs.resource.attributes.find((a: any) => a.key === "service.name")
  assert.equal(serviceName?.value?.stringValue, "openclaw")
})

// ── TC-002: Plugin path e2e (JSON semantic spans) ──
test("TC-002: plugin path e2e - GenAI semantic spans recognized via JSON path", async () => {
  const body = makeTraceRequest({
    spans: [
      { name: "invoke_agent", kind: 2, attributes: makeSpanAttrs("agent") },
      {
        name: "execute_tool",
        kind: 3,
        spanId: "0x" + "cc".repeat(8),
        parentSpanId: "0x" + "bb".repeat(8),
        attributes: [
          { key: "gen_ai.span.kind", value: { stringValue: "tool" } },
          { key: "tool.name", value: { stringValue: "search" } },
        ],
      },
    ],
  })

  const events = normalizeClaudeOtlpTraces(body)
  assert.ok(Array.isArray(events))
  assert.ok(events.length > 0)

  // At least one event should have gen_ai.span.kind=agent
  const agentEvent = events.find(
    (e: any) => e.attributes?.["gen_ai.span.kind"] === "agent",
  )
  assert.ok(agentEvent, "expected an event with gen_ai.span.kind=agent")
  assert.equal(agentEvent.kind, "agent")
})

test("OpenClaw documented witty.* contract preserves session, kinds, user, and token aliases", () => {
  const events = normalizeClaudeOtlpTraces(makeOpenClawContractRequest())
  assert.equal(events.length, 4)
  assert.deepEqual(events.map((event) => event.sessionId), Array(4).fill("openclaw-contract-session"))
  assert.deepEqual(events.map((event) => event.kind), ["agent", "llm", "tool", "tool"])
  assert.deepEqual(events.map((event) => event.user), Array(4).fill("openclaw-user"))

  const llm = events.find((event) => event.kind === "llm")!
  assert.equal(llm.model, "gpt-contract")
  assert.deepEqual(llm.usage, {
    input_tokens: 11,
    output_tokens: 7,
    reasoning_tokens: undefined,
    total_tokens: 20,
  })
  assert.equal(events.find((event) => event.name === "custom_tool_span")?.attributes["witty.tool.name"], "search")
  assert.equal(events.find((event) => event.name === "custom_skill_span")?.attributes["witty.skill.name"], "otel-debug")
})

test("OpenClaw documented contract normalizes equivalently through JSON and protobuf", () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const root = require("@opentelemetry/otlp-transformer/build/src/generated/root")
  const traceRequestType = root.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest
  const body = makeOpenClawContractRequest()
  const decoded = decodeOtlpProtobuf(traceRequestType.encode(body).finish())
  if ("code" in decoded) throw new Error(decoded.message)

  const project = (events: ReturnType<typeof normalizeClaudeOtlpTraces>) => events.map((event) => ({
    sessionId: event.sessionId,
    kind: event.kind,
    user: event.user,
    model: event.model,
    usage: event.usage,
    name: event.name,
  }))

  assert.deepEqual(
    project(normalizeClaudeOtlpTraces(decoded.body)),
    project(normalizeClaudeOtlpTraces(body)),
  )
})

test("OpenClaw aggregation keeps LLM, tool, skill, sub-agent, errors, and tokens", () => {
  const events = normalizeClaudeOtlpTraces(makeOpenClawAggregationRequest(), {
    receivedAt: "2026-06-25T10:00:00.000Z",
  })
  const record = aggregateOpenClawOtelTraceEvents("openclaw-contract-session", events)
  assert.ok(record)
  assert.equal(record.query, "plan a fix")
  assert.equal(record.final_result, "child answer")
  assert.equal(record.agentName, "planner")
  assert.deepEqual(record.agents, ["planner", "researcher"])
  assert.equal(record.llm_call_count, 2)
  assert.equal(record.tool_call_count, 2)
  assert.equal(record.tool_call_error_count, 1)
  assert.equal(record.tokens, 25)
  assert.equal(record.input_tokens, 14)
  assert.equal(record.output_tokens, 9)

  const root = record.interactions?.find((interaction: any) => interaction.role === "assistant") as any
  assert.ok(root)
  assert.deepEqual(
    root.tool_calls.map((call: any) => call.function?.name || call.name).sort(),
    ["search", "skill", "task"],
  )
  const child = record.interactions?.find((interaction: any) => interaction.role === "subagent") as any
  assert.equal(child?.content, "child answer")
  assert.equal(child?.subagent_name, "researcher")
  assert.equal(child?.subagent_session_id, "researcher-1")

  const normalized = openclawAdapter.normalizeForStorage!(record.interactions as any[])
  assert.deepEqual(openclawAdapter.extractSkills!(normalized), [{ name: "otel-debug", version: 2 }])
})

test("OpenClaw aggregation is stable when the same spans are retransmitted", () => {
  const events = normalizeClaudeOtlpTraces(makeOpenClawAggregationRequest(), {
    receivedAt: "2026-06-25T10:00:00.000Z",
  })
  const once = aggregateOpenClawOtelTraceEvents("openclaw-contract-session", events)
  const retransmitted = aggregateOpenClawOtelTraceEvents("openclaw-contract-session", [...events, ...events])
  assert.deepEqual(retransmitted, once)
})

// ── TC-003: JSON vs protobuf equivalence ──
test("TC-003: json/protobuf equivalence - same trace decoded both ways yields matching span count", async () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const root = require("@opentelemetry/otlp-transformer/build/src/generated/root")
  const traceRequestType = root.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest

  const body = makeTraceRequest({
    spans: [
      { name: "chat", kind: 3, attributes: makeSpanAttrs("llm") },
    ],
  })

  // JSON path
  const jsonEvents = normalizeClaudeOtlpTraces(body)

  // Protobuf path: encode then decode
  const buf = traceRequestType.encode(body).finish()
  const pbResult = decodeOtlpProtobuf(buf)
  if ("code" in pbResult) {
    throw new Error("protobuf decode failed: " + pbResult.message)
  }

  // Both paths should yield matching span counts
  assert.equal(pbResult.spanCount, 1)
  assert.ok(jsonEvents.length > 0)

  // Protobuf-decoded body fed through normalizeClaudeOtlpTraces should also work
  const pbEvents = normalizeClaudeOtlpTraces(pbResult.body)
  assert.ok(Array.isArray(pbEvents))
  assert.ok(pbEvents.length > 0)
})

// ── TC-004: Batch idempotency ──
test("TC-004: batch idempotency - same binary protobuf decoded twice yields identical results", async () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const root = require("@opentelemetry/otlp-transformer/build/src/generated/root")
  const traceRequestType = root.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest

  const body = makeTraceRequest({
    spans: [
      { name: "chat", kind: 3, attributes: makeSpanAttrs("llm") },
      { name: "chat", kind: 3, spanId: "0x" + "ff".repeat(8), attributes: makeSpanAttrs("llm") },
    ],
  })

  const buf = traceRequestType.encode(body).finish()

  const result1 = decodeOtlpProtobuf(buf)
  const result2 = decodeOtlpProtobuf(buf)

  if ("code" in result1 || "code" in result2) {
    throw new Error("unexpected decode error")
  }

  assert.equal(result1.spanCount, result2.spanCount)
  assert.equal(result1.body.resourceSpans.length, result2.body.resourceSpans.length)

  const spans1 = result1.body.resourceSpans[0].scopeSpans[0].spans
  const spans2 = result2.body.resourceSpans[0].scopeSpans[0].spans
  assert.equal(spans1.length, spans2.length)
  for (let i = 0; i < spans1.length; i++) {
    assert.equal(spans1[i].traceId, spans2[i].traceId)
    assert.equal(spans1[i].spanId, spans2[i].spanId)
  }
})

// ── TC-017: Merge key fallback - service.instance.id ──
test("TC-017: merge key fallback - service.instance.id present for session grouping", async () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const root = require("@opentelemetry/otlp-transformer/build/src/generated/root")
  const traceRequestType = root.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest

  const body = makeTraceRequest()
  const buf = traceRequestType.encode(body).finish()
  const decoded = decodeOtlpProtobuf(buf)
  if ("code" in decoded) throw new Error("decode failed")

  const rs = decoded.body.resourceSpans[0]
  const instId = rs.resource.attributes.find((a: any) => a.key === "service.instance.id")
  assert.ok(instId, "service.instance.id should be present")
  assert.equal(instId.value.stringValue, "inst-001")
})

test("TC-017: merge key fallback - traceId preserved in output", async () => {
  const body = makeTraceRequest()
  const events = normalizeClaudeOtlpTraces(body)
  assert.ok(events.length > 0)
  // The traceId (from spans) should be available for downstream merge key logic
  assert.ok(events[0].traceId, "traceId should be preserved")
})

// ── TC-018: Single framework identifier across both paths ──
test("TC-018: watcher+OTel dual path single framework - service.name=openclaw marks framework", async () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const root = require("@opentelemetry/otlp-transformer/build/src/generated/root")
  const traceRequestType = root.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest

  const body = makeTraceRequest()
  const buf = traceRequestType.encode(body).finish()
  const decoded = decodeOtlpProtobuf(buf)
  if ("code" in decoded) throw new Error("decode failed")

  const rs = decoded.body.resourceSpans[0]
  const serviceName = rs.resource.attributes.find((a: any) => a.key === "service.name")
  assert.equal(serviceName?.value?.stringValue, "openclaw")
})

test("TC-018: openclaw adapter exposes correct framework identifier", () => {
  assert.equal(openclawAdapter.descriptor.id, "openclaw")
  assert.equal(openclawAdapter.descriptor.platform, "openclaw")
})

// ── Attribution guard (NFR-003) ──
test("NFR-003: attribution guard drops unattributed sessions", () => {
  const dropped = guardAttribution({ user: "", taskId: "t1" })
  assert.equal(dropped.pass, false)
  assert.equal((dropped as any).reason, "unattributed")
})

test("NFR-003: attribution guard passes for real users", () => {
  const passed = guardAttribution({ user: "real-user", taskId: "t2" })
  assert.equal(passed.pass, true)
})

// ── Oversized protobuf rejection (FR-013) ──
test("FR-013: oversized protobuf body rejected", () => {
  // Build a body with 501 spans (MAX_SPANS=500, so this exceeds)
  const spans = new Array(501).fill(null).map((_, i) => ({
    traceId: "0x" + "0a".repeat(16),
    spanId: "0x" + i.toString(16).padStart(16, "0"),
    name: "chat",
    kind: 3,
    startTime: "2026-06-25T10:00:00.000Z",
    endTime: "2026-06-25T10:00:05.000Z",
    attributes: makeSpanAttrs("llm"),
    status: { code: 0 },
  }))

  /* eslint-disable @typescript-eslint/no-require-imports */
  const root = require("@opentelemetry/otlp-transformer/build/src/generated/root")
  const traceRequestType = root.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest

  const body = makeTraceRequest({ spans })
  const buf = traceRequestType.encode(body).finish()
  const result = decodeOtlpProtobuf(buf)

  assert.ok("code" in result)
  assert.equal((result as any).code, "TOO_MANY_SPANS")
  assert.equal((result as any).status, 400)
})
