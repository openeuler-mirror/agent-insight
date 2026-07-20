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
    const sessionFile = path.join(dayDir, "sessions", "session-a", "logs.jsonl")
    fs.writeFileSync(file, "{\"sessionId\":\"a\"}\n", "utf8")
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true })
    fs.writeFileSync(sessionFile, "{\"sessionId\":\"session-a\"}\n", "utf8")

    seedToEof(dir)

    const relPath = toCheckpointRelPath(dir, file)
    const sessionRelPath = toCheckpointRelPath(dir, sessionFile)
    const checkpoint = loadCheckpoint(dir)
    assert.equal(checkpoint.files[relPath]?.bytes, fs.statSync(file).size)
    assert.equal(checkpoint.files[sessionRelPath]?.bytes, fs.statSync(sessionFile).size)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("OTel checkpoint: file cursors can move backward after file recreation and are invalidatable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-checkpoint-cursor-"))
  try {
    saveFileCursor(dir, "2026-06-09/logs.jsonl", { bytes: 100 })
    saveFileCursor(dir, "2026-06-09/logs.jsonl", { bytes: 50 })
    assert.equal(getFileCursor(dir, "2026-06-09/logs.jsonl").bytes, 50)

    saveFileCursor(dir, "2026-06-09/logs.jsonl", { bytes: 150 })
    assert.equal(getFileCursor(dir, "2026-06-09/logs.jsonl").bytes, 150)

    invalidateCursor(dir, "2026-06-09/logs.jsonl")
    assert.equal(getFileCursor(dir, "2026-06-09/logs.jsonl").bytes, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("checkpoint: in-memory cache serves reads and stays coherent with API writes", async () => {
  const { loadCheckpoint, saveFileCursor, invalidateCheckpointCache, checkpointFilePath } = await import("@/lib/ingest/otel-consumer/checkpoint")
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-checkpoint-cache-"))
  try {
    invalidateCheckpointCache(dir)
    saveFileCursor(dir, "a.jsonl", { bytes: 11 })
    assert.equal(loadCheckpoint(dir).files["a.jsonl"]?.bytes, 11)

    // 进程外直写磁盘(模拟运维脚本改游标):缓存感知不到——这是约定行为,重放需重启
    const file = checkpointFilePath(dir)
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"))
    onDisk.files["a.jsonl"].bytes = 0
    fs.writeFileSync(file, JSON.stringify(onDisk), "utf8")
    assert.equal(loadCheckpoint(dir).files["a.jsonl"]?.bytes, 11, "缓存命中,不读磁盘")

    // 失效后读到磁盘新值(重启等价物)
    invalidateCheckpointCache(dir)
    assert.equal(loadCheckpoint(dir).files["a.jsonl"]?.bytes, 0)
  } finally {
    invalidateCheckpointCache(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
