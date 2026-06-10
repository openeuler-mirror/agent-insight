import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  getFileCursor,
  invalidateCursor,
  loadCheckpoint,
  saveFileCursor,
  seedToEof,
  toCheckpointRelPath,
} from "@/lib/ingest/otel-consumer/checkpoint"

test("OTel checkpoint: seeds missing checkpoint to current EOF", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-checkpoint-"))
  try {
    const dayDir = path.join(dir, "2026-06-09")
    fs.mkdirSync(dayDir, { recursive: true })
    const file = path.join(dayDir, "logs.jsonl")
    fs.writeFileSync(file, "{\"sessionId\":\"a\"}\n", "utf8")

    seedToEof(dir)

    const relPath = toCheckpointRelPath(dir, file)
    const checkpoint = loadCheckpoint(dir)
    assert.equal(checkpoint.files[relPath]?.bytes, fs.statSync(file).size)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("OTel checkpoint: file cursors are monotonic and invalidatable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-checkpoint-cursor-"))
  try {
    saveFileCursor(dir, "2026-06-09/logs.jsonl", { bytes: 100 })
    saveFileCursor(dir, "2026-06-09/logs.jsonl", { bytes: 50 })
    assert.equal(getFileCursor(dir, "2026-06-09/logs.jsonl").bytes, 100)

    saveFileCursor(dir, "2026-06-09/logs.jsonl", { bytes: 150 })
    assert.equal(getFileCursor(dir, "2026-06-09/logs.jsonl").bytes, 150)

    invalidateCursor(dir, "2026-06-09/logs.jsonl")
    assert.equal(getFileCursor(dir, "2026-06-09/logs.jsonl").bytes, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
