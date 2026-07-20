import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { loadCheckpoint, toCheckpointRelPath } from "@/lib/ingest/otel-consumer/checkpoint"
import { startOtelSpoolConsumer, stopOtelSpoolConsumer } from "@/lib/ingest/otel-consumer/consumer"
import type { SpoolSource } from "@/lib/ingest/otel-consumer/sources"
import type { ExecutionRecord } from "@/lib/storage/data-service"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function makeSource(dir: string, file: string, record: ExecutionRecord): SpoolSource {
  return {
    id: "test-source",
    spoolDir: () => dir,
    listFiles: () => [file],
    aggregate: (sessionId) => ({
      sessionId,
      eventCount: 1,
      record: { ...record, task_id: sessionId },
    }),
    defaultSkipEvaluation: () => true,
  }
}

test("OTel consumer: runs one loop, fast-saves, evaluates, and advances checkpoint", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-consumer-"))
  stopOtelSpoolConsumer()
  try {
    const dayDir = path.join(dir, new Date().toISOString().slice(0, 10))
    fs.mkdirSync(dayDir, { recursive: true })
    const file = path.join(dayDir, "logs.jsonl")
    fs.writeFileSync(file, "{\"sessionId\":\"session-a\"}\n", "utf8")

    const calls: ExecutionRecord[] = []
    const source = makeSource(dir, file, {
      task_id: "session-a",
      user: "test-user",
      query: "hello",
      framework: "test",
      final_result: "done",
    })

    startOtelSpoolConsumer({
      sources: [source],
      saveExecution: async (data) => {
        calls.push(data)
        return { success: true, record: data }
      },
      shortMs: 10,
      longMs: 30,
      maxWaitMs: 80,
      tickMs: 5,
      seedOnStart: false,
      log: () => {},
      warn: () => {},
    })
    startOtelSpoolConsumer({
      sources: [source],
      saveExecution: async (data) => {
        calls.push(data)
        return { success: true, record: data }
      },
      shortMs: 10,
      longMs: 30,
      maxWaitMs: 80,
      tickMs: 5,
      seedOnStart: false,
      log: () => {},
      warn: () => {},
    })

    await wait(90)
    stopOtelSpoolConsumer()

    assert.equal(calls.filter((call) => call.skip_evaluation === true).length, 1)
    assert.equal(calls.filter((call) => call.force_judgment === true).length, 1)

    const relPath = toCheckpointRelPath(dir, file)
    const checkpoint = loadCheckpoint(dir)
    assert.equal(checkpoint.files[relPath]?.bytes, fs.statSync(file).size)
  } finally {
    stopOtelSpoolConsumer()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
