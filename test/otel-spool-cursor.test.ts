import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  appendClaudeOtelEvents,
  appendOtelTraceEvents,
  listClaudeOtelSpoolFiles,
  listOtelTraceSpoolFiles,
  readNewLinesSince,
} from "@/lib/ingest/claude-otel/spool"
import type { ClaudeOtelEvent } from "@/lib/ingest/claude-otel/types"
import type { OtelTraceEvent } from "@/lib/ingest/otel/types"

function claudeEvent(sessionId: string, sequence = 1): ClaudeOtelEvent {
  return {
    receivedAt: "2026-06-17T00:00:00.000Z",
    eventName: "user_prompt_submit",
    sessionId,
    sequence,
    resource: {},
    attributes: {},
  }
}

function traceEvent(sessionId: string, spanId: string): OtelTraceEvent {
  return {
    receivedAt: "2026-06-17T00:00:00.000Z",
    sessionId,
    traceId: `trace-${sessionId}`,
    spanId,
    name: "chat",
    kind: "llm",
    serviceName: "hermes",
    usage: {
      input_tokens: 1,
      output_tokens: 2,
      total_tokens: 3,
    },
    latencyMs: 100,
    startTimeMs: 1000,
    attributes: {},
  }
}

test("OTel spool cursor: reads only newline-committed JSONL rows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-spool-cursor-"))
  try {
    const file = path.join(dir, "events.jsonl")
    const committed = [
      JSON.stringify({ sessionId: "a", value: 1 }),
      JSON.stringify({ sessionId: "b", value: "中文" }),
      JSON.stringify({ sessionId: "a", value: 3 }),
    ].join("\n") + "\n"
    fs.writeFileSync(file, committed + "{\"sessionId\":\"half\"", "utf8")

    const first = readNewLinesSince(file, { bytes: 0 })
    assert.equal(first.events.length, 3)
    assert.equal(first.nextCursor.bytes, Buffer.byteLength(committed))

    fs.appendFileSync(file, "}\n", "utf8")
    const second = readNewLinesSince(file, first.nextCursor)
    assert.equal(second.events.length, 1)
    assert.deepEqual(second.events[0], { sessionId: "half" })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("OTel spool cursor: skips malformed committed rows and still advances", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-spool-cursor-bad-"))
  try {
    const file = path.join(dir, "events.jsonl")
    fs.writeFileSync(file, "{\"sessionId\":\"a\"}\nnot-json\n", "utf8")

    const result = readNewLinesSince(file, { bytes: 0 })
    assert.equal(result.events.length, 1)
    assert.equal(result.parseErrors, 1)
    assert.equal(result.nextCursor.bytes, fs.statSync(file).size)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("OTel spool cursor: restarts when a checkpoint points past a recreated file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-spool-cursor-reset-"))
  try {
    const file = path.join(dir, "events.jsonl")
    fs.writeFileSync(file, "{\"sessionId\":\"new\"}\n", "utf8")

    const result = readNewLinesSince(file, { bytes: 999 })
    assert.equal(result.events.length, 1)
    assert.deepEqual(result.events[0], { sessionId: "new" })
    assert.equal(result.nextCursor.bytes, fs.statSync(file).size)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("OTel spool writer: shards Claude logs and traces by session", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-spool-shards-"))
  try {
    const claudeDir = path.join(dir, "claude")
    const tracesDir = path.join(dir, "traces")

    appendClaudeOtelEvents([
      claudeEvent("session/a", 1),
      claudeEvent("session-a", 2),
      claudeEvent("session-a", 3),
    ], claudeDir)
    appendOtelTraceEvents([
      traceEvent("session-a", "span-a"),
      traceEvent("session-b", "span-b"),
    ], tracesDir)

    const logFiles = listClaudeOtelSpoolFiles(claudeDir)
    const traceFiles = listOtelTraceSpoolFiles(tracesDir)

    assert.equal(logFiles.length, 2)
    assert.equal(traceFiles.length, 2)
    assert.ok(logFiles.every((file) => file.includes(`${path.sep}sessions${path.sep}`)))
    assert.ok(traceFiles.every((file) => file.includes(`${path.sep}sessions${path.sep}`)))
    assert.ok(logFiles.every((file) => path.basename(file) === "logs.jsonl"))
    assert.ok(traceFiles.every((file) => path.basename(file) === "traces.jsonl"))
    assert.ok(!logFiles.some((file) => path.relative(claudeDir, file).split(path.sep).length === 2))
    assert.ok(!traceFiles.some((file) => path.relative(tracesDir, file).split(path.sep).length === 2))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
