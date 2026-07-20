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

test("OTel consumer: aggregate cooldown throttles rapid re-aggregation of active sessions", async () => {
  // 线上事故回归:活跃 session 持续追加数据时,每来一批就全量重聚合,
  // 大会话把 CPU 烧满。冷却 = 上轮耗时×factor,期间的触发顺延而非立即执行。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-consumer-cooldown-"))
  stopOtelSpoolConsumer()
  try {
    const dayDir = path.join(dir, new Date().toISOString().slice(0, 10))
    fs.mkdirSync(dayDir, { recursive: true })
    const file = path.join(dayDir, "logs.jsonl")
    fs.writeFileSync(file, "{\"sessionId\":\"session-hot\"}\n", "utf8")

    const callTimes: number[] = []
    const source = makeSource(dir, file, {
      task_id: "session-hot",
      query: "hot",
      framework: "test",
      final_result: "done",
    })

    startOtelSpoolConsumer({
      sources: [source],
      saveExecution: async (data) => {
        callTimes.push(Date.now())
        await wait(40) // 模拟慢聚合(线上是几十 MB 会话的全量 parse+写库)
        return { success: true, record: data }
      },
      shortMs: 10,
      longMs: 10000,
      maxWaitMs: 10000,
      tickMs: 5,
      aggCooldownFactor: 10,
      aggCooldownCapMs: 10000,
      seedOnStart: false,
      log: () => {},
      warn: () => {},
    })

    await wait(80)
    assert.equal(callTimes.length, 1, "第一轮聚合应正常发生")

    // 冷却窗口(约 40ms×10=400ms)内追加新数据:触发被顺延,不得立即重聚合
    fs.appendFileSync(file, "{\"sessionId\":\"session-hot\"}\n", "utf8")
    await wait(120)
    assert.equal(callTimes.length, 1, "冷却期内不应发生第二轮聚合")

    // 冷却结束后顺延的聚合必须发生(最终一致,数据不丢)
    await wait(500)
    assert.ok(callTimes.length >= 2, "冷却结束后应完成顺延的聚合")
    assert.ok(callTimes[1] - callTimes[0] >= 300, `两轮间隔应受冷却约束,实际 ${callTimes[1] - callTimes[0]}ms`)

    // 聚合完成后磁盘 cursor 推进到文件末尾(增量读没有丢数据)
    await wait(100)
    const checkpoint = loadCheckpoint(dir)
    const relPath = toCheckpointRelPath(dir, file)
    assert.equal(checkpoint.files[relPath]?.bytes, fs.statSync(file).size)
  } finally {
    stopOtelSpoolConsumer()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("OTel consumer: global cooldown serializes and throttles aggregates across concurrent sessions", async () => {
  // 线上形态回归:22 个并发活跃会话,per-session 冷却各自 10% 也能叠满单核。
  // 全局闸:聚合全局串行(在途互斥),且任意两轮之间至少歇 上轮耗时×globalFactor。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-consumer-global-"))
  stopOtelSpoolConsumer()
  try {
    const dayDir = path.join(dir, new Date().toISOString().slice(0, 10))
    fs.mkdirSync(dayDir, { recursive: true })
    const fileA = path.join(dayDir, "a.jsonl")
    const fileB = path.join(dayDir, "b.jsonl")
    fs.writeFileSync(fileA, "{\"sessionId\":\"session-a\"}\n", "utf8")
    fs.writeFileSync(fileB, "{\"sessionId\":\"session-b\"}\n", "utf8")

    const calls: Array<{ sid: string; at: number }> = []
    const source: SpoolSource = {
      id: "test-source",
      spoolDir: () => dir,
      listFiles: () => [fileA, fileB],
      aggregate: (sessionId) => ({
        sessionId,
        eventCount: 1,
        record: { task_id: sessionId, query: "q", framework: "test", final_result: "done" },
      }),
      defaultSkipEvaluation: () => true,
    }

    startOtelSpoolConsumer({
      sources: [source],
      saveExecution: async (data) => {
        calls.push({ sid: String(data.task_id), at: Date.now() })
        await wait(40)
        return { success: true, record: data }
      },
      shortMs: 10,
      longMs: 10000,
      maxWaitMs: 10000,
      tickMs: 5,
      aggCooldownFactor: 1,
      aggCooldownCapMs: 10000,
      aggGlobalFactor: 5,
      seedOnStart: false,
      log: () => {},
      warn: () => {},
    })

    // 两个会话几乎同时到期。全局串行 + 全局冷却(≈40ms×5=200ms)下,
    // 第二个会话的首轮必须等第一个结束 + 全局冷却之后。
    await wait(700)
    const bySid = new Set(calls.map((c) => c.sid))
    assert.ok(bySid.has("session-a") && bySid.has("session-b"), "两个会话最终都要完成聚合(不丢数据)")
    assert.ok(calls.length >= 2)
    const firstEnd = calls[0].at + 40
    assert.ok(
      calls[1].at - firstEnd >= 120,
      `第二轮聚合应受全局冷却约束,实际间隔 ${calls[1].at - firstEnd}ms`,
    )
  } finally {
    stopOtelSpoolConsumer()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
