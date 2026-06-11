import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { readNewLinesSince } from "@/lib/ingest/claude-otel/spool"

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
