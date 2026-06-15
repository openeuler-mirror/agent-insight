import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import otlpRoot from "@opentelemetry/otlp-transformer/build/src/generated/root"
import { POST as postOtlpTraces } from "@/app/api/ingest/otel/v1/traces/route"
import { normalizeOtlpTraces } from "@/lib/ingest/otel/normalize"
import { decodeOtlpProtobufBody, decodeOtlpRequest } from "@/lib/ingest/otel/decode"

const traceRequestType = (otlpRoot as any).opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest

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

function buildTraceRequest() {
  return {
    resourceSpans: [{
      resource: {
        attributes: [
          attr("service.name", "hermes"),
          attr("session.id", "unknown"),
          attr("user.id", "resource-user"),
        ],
      },
      scopeSpans: [{
        spans: [
          {
            traceId: Buffer.from("00112233445566778899aabbccddeeff", "hex"),
            spanId: Buffer.from("1021324354657687", "hex"),
            name: "chat.completions",
            startTimeUnixNano: "1000000000",
            endTimeUnixNano: "2500000000",
            attributes: [
              attr("gen_ai.request.model", "gpt-test"),
              attr("gen_ai.usage.input_tokens", 11),
              attr("gen_ai.usage.output_tokens", 7),
            ],
          },
          {
            traceId: Buffer.from("00112233445566778899aabbccddeeff", "hex"),
            spanId: Buffer.from("2031425364758697", "hex"),
            parentSpanId: Buffer.from("1021324354657687", "hex"),
            name: "tool.call",
            startTimeUnixNano: "3000000000",
            endTimeUnixNano: "3200000000",
            attributes: [
              attr("tool.name", "skills_list"),
              attr("tool.arguments", "{\"pattern\":\"*\"}"),
            ],
          },
        ],
      }],
    }],
  }
}

function encodeTraceRequest(body = buildTraceRequest()): Uint8Array {
  return traceRequestType.encode(traceRequestType.create(body)).finish()
}

test("OTLP protobuf decoder converts trace request into JSON-compatible trace object", () => {
  const decoded = decodeOtlpProtobufBody(encodeTraceRequest(), "traces")
  const spans = decoded.resourceSpans[0].scopeSpans[0].spans

  assert.equal(spans[0].traceId, "00112233445566778899aabbccddeeff")
  assert.equal(spans[0].spanId, "1021324354657687")
  assert.equal(spans[1].parentSpanId, "1021324354657687")

  const events = normalizeOtlpTraces(decoded, {
    receivedAt: "2026-06-11T00:00:00.000Z",
    authenticatedUser: "alice",
  })

  assert.equal(events.length, 2)
  assert.equal(events[0].sessionId, "00112233445566778899aabbccddeeff")
  assert.equal(events[0].serviceName, "hermes")
  assert.equal(events[0].kind, "llm")
  assert.equal(events[0].usage.total_tokens, 18)
  assert.equal(events[0].latencyMs, 1500)
  assert.equal(events[1].kind, "tool")
  assert.equal(events[1].parentSpanId, "1021324354657687")
})

test("decodeOtlpRequest accepts OTLP HTTP protobuf trace requests", async () => {
  const req = new Request("http://localhost/v1/traces", {
    method: "POST",
    headers: { "content-type": "application/x-protobuf" },
    body: encodeTraceRequest() as BodyInit,
  })

  const decoded = await decodeOtlpRequest(req, "traces")

  assert.equal(decoded.resourceSpans[0].scopeSpans[0].spans[0].traceId, "00112233445566778899aabbccddeeff")
})

test("OTLP traces route accepts protobuf requests and writes trace spool", async () => {
  const prevSpoolDir = process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-proto-route-"))
  process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR = dir

  try {
    const req = new Request("http://localhost/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: encodeTraceRequest() as BodyInit,
    })

    const res = await postOtlpTraces(req)
    const body = await res.json()

    assert.equal(res.status, 200)
    assert.equal(body.status, "accepted")
    assert.equal(body.received, 2)
    assert.deepEqual(body.sessions, ["00112233445566778899aabbccddeeff"])

    const day = new Date().toISOString().slice(0, 10)
    const spoolFile = path.join(dir, day, "traces.jsonl")
    const lines = fs.readFileSync(spoolFile, "utf8").trim().split("\n")
    assert.equal(lines.length, 2)
  } finally {
    if (prevSpoolDir === undefined) {
      delete process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR
    } else {
      process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR = prevSpoolDir
    }
  }
})
