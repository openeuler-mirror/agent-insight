import assert from "node:assert/strict"
import test from "node:test"
import { decodeOtlpProtobuf } from "@/lib/ingest/claude-otel/otlp-protobuf-decoder"

/**
 * 构造一个简单的 ExportTraceServiceRequest 的 protobuf 字节流。
 * 使用与 otlp-transformer 相同的 protobuf root 进行编码。
 */
function makeProtobufTraceBody(overrides?: {
  traceId?: string
  spanId?: string
  parentSpanId?: string
  name?: string
  kind?: number
  model?: string
  serviceName?: string
  sessionId?: string
  toolName?: string
  extraSpans?: number
  extraResourceSpans?: number
}): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const root = require("@opentelemetry/otlp-transformer/build/src/generated/root")
  const traceReqType = root.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest

  const traceId = Buffer.from(overrides?.traceId || "0af7651916cd43dd8448eb211c80319c", "hex")
  const spanId = Buffer.from(overrides?.spanId || "b7ad6b7169203331", "hex")
  const parentSpanId = overrides?.parentSpanId
    ? Buffer.from(overrides.parentSpanId, "hex")
    : undefined

  const makeSpan = (idx: number) => ({
    traceId,
    spanId: Buffer.from(overrides?.spanId || `b7ad6b71692033${String(idx).padStart(2, "0")}`, "hex"),
    ...(parentSpanId ? { parentSpanId } : {}),
    name: overrides?.name || `span-${idx}`,
    kind: overrides?.kind ?? 1,
    startTimeUnixNano: String(1000000000 + idx * 1000000),
    endTimeUnixNano: String(2000000000 + idx * 1000000),
    attributes: [
      { key: "gen_ai.request.model", value: { stringValue: overrides?.model || "gpt-4" } },
      ...(overrides?.sessionId
        ? [{ key: "session.id", value: { stringValue: overrides.sessionId } }]
        : []),
      ...(overrides?.toolName
        ? [{ key: "tool.name", value: { stringValue: overrides.toolName } }]
        : []),
    ],
  })

  const spanCount = (overrides?.extraSpans ?? 0) + 1
  const spans = Array.from({ length: spanCount }, (_, i) => makeSpan(i))

  const resourceSpanCount = (overrides?.extraResourceSpans ?? 0) + 1
  const resourceSpans = Array.from({ length: resourceSpanCount }, () => ({
    resource: {
      attributes: [
        { key: "service.name", value: { stringValue: overrides?.serviceName || "openclaw" } },
      ],
    },
    scopeSpans: [
      {
        scope: { name: "test-scope" },
        spans,
      },
    ],
  }))

  const msg = traceReqType.fromObject({ resourceSpans })
  return Buffer.from(traceReqType.encode(msg).finish())
}

test("decodeOtlpProtobuf: decodes valid protobuf and returns isomorphic body", () => {
  const buf = makeProtobufTraceBody()
  const result = decodeOtlpProtobuf(buf)

  assert.ok(!("code" in result), "Expected success, got error: " + JSON.stringify(result))
  assert.ok("body" in result)

  const body = (result as { body: Record<string, any> }).body
  assert.ok(body.resourceSpans)
  assert.equal(body.resourceSpans.length, 1)
  assert.equal(body.resourceSpans[0].scopeSpans.length, 1)
  assert.equal(body.resourceSpans[0].scopeSpans[0].spans.length, 1)

  const span = body.resourceSpans[0].scopeSpans[0].spans[0]
  // traceId/spanId 必须是 lowercase hex（不是 base64）
  assert.equal(span.traceId, "0af7651916cd43dd8448eb211c80319c")
  assert.equal(span.spanId, "b7ad6b7169203300")
  assert.equal(span.name, "span-0")
  assert.ok(typeof span.traceId === "string")
  assert.ok(typeof span.spanId === "string")
})

test("decodeOtlpProtobuf: bytes fields are hex not base64", () => {
  const buf = makeProtobufTraceBody({
    traceId: "ffffffffffffffffffffffffffffffff",
    spanId: "eeeeeeeeeeeeeeee",
  })
  const result = decodeOtlpProtobuf(buf)
  assert.ok(!("code" in result))
  const body = (result as { body: Record<string, any> }).body
  const span = body.resourceSpans[0].scopeSpans[0].spans[0]
  assert.equal(span.traceId, "ffffffffffffffffffffffffffffffff")
  assert.equal(span.spanId, "eeeeeeeeeeeeeeee")
})

test("decodeOtlpProtobuf: rejects body exceeding size limit", () => {
  const buf = Buffer.alloc(100)
  const result = decodeOtlpProtobuf(buf, { maxBytes: 50 })
  assert.ok("code" in result)
  const err = result as { code: string; status: number }
  assert.equal(err.code, "TOO_LARGE")
  assert.equal(err.status, 413)
})

test("decodeOtlpProtobuf: rejects too many spans", () => {
  const buf = makeProtobufTraceBody({ extraSpans: 10 })
  const result = decodeOtlpProtobuf(buf, { maxSpans: 5 })
  assert.ok("code" in result)
  const err = result as { code: string; status: number }
  assert.equal(err.code, "TOO_MANY_SPANS")
  assert.equal(err.status, 400)
})

test("decodeOtlpProtobuf: rejects invalid bytes", () => {
  const buf = Buffer.from([0x00, 0x01, 0x02, 0xff])
  const result = decodeOtlpProtobuf(buf)
  assert.ok("code" in result)
  const err = result as { code: string }
  assert.equal(err.code, "DECODE_FAILED")
})

test("decodeOtlpProtobuf: respects parentSpanId hex encoding", () => {
  const buf = makeProtobufTraceBody({
    parentSpanId: "aaaaaaaaaaaaaaaa",
  })
  const result = decodeOtlpProtobuf(buf)
  assert.ok(!("code" in result))
  const body = (result as { body: Record<string, any> }).body
  const span = body.resourceSpans[0].scopeSpans[0].spans[0]
  assert.equal(span.parentSpanId, "aaaaaaaaaaaaaaaa")
})

test("decodeOtlpProtobuf: handles multiple resourceSpans", () => {
  const buf = makeProtobufTraceBody({ extraResourceSpans: 2 })
  const result = decodeOtlpProtobuf(buf)
  assert.ok(!("code" in result))
  const body = (result as { body: Record<string, any> }).body
  assert.equal(body.resourceSpans.length, 3)
})

test("decodeOtlpProtobuf: returns correct spanCount", () => {
  const buf = makeProtobufTraceBody({ extraSpans: 4 })
  const result = decodeOtlpProtobuf(buf)
  assert.ok(!("code" in result))
  const succ = result as { spanCount: number }
  assert.equal(succ.spanCount, 5)
})
