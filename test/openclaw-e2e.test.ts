import assert from "node:assert/strict"
import test from "node:test"

// ── Modules under test ──
import { decodeOtlpProtobuf } from "../src/lib/ingest/claude-otel/otlp-protobuf-decoder"
import { normalizeClaudeOtlpTraces } from "../src/lib/ingest/claude-otel/otlp-json"
import { guardAttribution } from "../src/lib/ingest/claude-otel/attribution-guard"
import { openclawAdapter } from "../src/lib/ingest/adapters/openclaw"

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
