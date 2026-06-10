import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { getFileCursor, saveFileCursor, toCheckpointRelPath } from "@/lib/ingest/otel-consumer/checkpoint"
import { compactProcessedSpoolFiles } from "@/lib/ingest/otel-consumer/retention"

test("OTel retention: archives only historical files fully covered by checkpoint", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-retention-"))
  try {
    const oldDir = path.join(dir, "2026-05-01")
    const newDir = path.join(dir, "2026-06-09")
    fs.mkdirSync(oldDir, { recursive: true })
    fs.mkdirSync(newDir, { recursive: true })
    const oldFile = path.join(oldDir, "logs.jsonl")
    const unprocessedOldFile = path.join(oldDir, "traces.jsonl")
    const newFile = path.join(newDir, "logs.jsonl")
    fs.writeFileSync(oldFile, "{\"sessionId\":\"a\"}\n", "utf8")
    fs.writeFileSync(unprocessedOldFile, "{\"sessionId\":\"b\"}\n", "utf8")
    fs.writeFileSync(newFile, "{\"sessionId\":\"c\"}\n", "utf8")

    const oldRelPath = toCheckpointRelPath(dir, oldFile)
    saveFileCursor(dir, oldRelPath, { bytes: fs.statSync(oldFile).size })

    const result = compactProcessedSpoolFiles(
      dir,
      [oldFile, unprocessedOldFile, newFile],
      7,
      new Date("2026-06-09T12:00:00.000Z"),
    )

    assert.equal(result.archived, 1)
    assert.equal(fs.existsSync(oldFile), false)
    assert.equal(fs.existsSync(`${oldFile}.processed`), true)
    assert.equal(fs.existsSync(unprocessedOldFile), true)
    assert.equal(fs.existsSync(newFile), true)
    assert.equal(getFileCursor(dir, oldRelPath).bytes, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
