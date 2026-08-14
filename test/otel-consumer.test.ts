import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { loadCheckpoint, toCheckpointRelPath } from "@/lib/ingest/otel-consumer/checkpoint"
import {
  getOtelSpoolConsumerForTest,
  startOtelSpoolConsumer,
  stopOtelSpoolConsumer,
} from "@/lib/ingest/otel-consumer/consumer"
import type { SpoolSource } from "@/lib/ingest/otel-consumer/sources"
import type { ExecutionRecord } from "@/lib/storage/data-service"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 等条件成立，最多等 timeoutMs。用来替掉"刚好够用"的定长 sleep（整套测试并发跑时会偶发落空）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await wait(5)
  }
}

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

    // 断言的是"快存 + 到点判定两段都会发生"，不是"必须在 90ms 内发生"——定长 sleep 在
    // 机器负载高时会偶发落空（跑全量测试时实测复现）。条件成立即停，仍然只允许各发生一次。
    await waitFor(() =>
      calls.some((call) => call.skip_evaluation === true)
      && calls.some((call) => call.force_judgment === true))
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

test("OTel consumer: poisoned sessions retry from spool and release after recovery", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-consumer-poison-"))
  stopOtelSpoolConsumer()
  try {
    const dayDir = path.join(dir, new Date().toISOString().slice(0, 10))
    fs.mkdirSync(dayDir, { recursive: true })
    const file = path.join(dayDir, "logs.jsonl")
    fs.writeFileSync(file, "{\"sessionId\":\"session-poison\"}\n", "utf8")
    const warnings: unknown[][] = []
    let attempts = 0
    const source = makeSource(dir, file, {
      task_id: "session-poison",
      user: "test-user",
      query: "bad",
      framework: "test",
      final_result: "bad",
    })

    startOtelSpoolConsumer({
      sources: [source],
      saveExecution: async (data) => {
        attempts += 1
        if (attempts === 1) throw new Error("transient failure")
        return { success: true, record: data }
      },
      shortMs: 5,
      longMs: 10,
      maxWaitMs: 20,
      tickMs: 5,
      parkAfter: 1,
      parkedRetryMs: 20,
      maxTrackedSessions: 2,
      seedOnStart: false,
      log: () => {},
      warn: (...args) => { warnings.push(args) },
    })

    await waitFor(() => {
      const state = getOtelSpoolConsumerForTest()
      return Boolean(state && state.sessions.size === 0 && state.pendingFiles.size === 0)
    })
    const state = getOtelSpoolConsumerForTest()
    assert.ok(state)
    assert.equal(state.sessions.size, 0)
    assert.equal(state.pendingFiles.size, 0)
    assert.ok(attempts >= 2)
    assert.ok(JSON.stringify(warnings).includes("poisoned"))
    const checkpoint = loadCheckpoint(dir)
    assert.equal(checkpoint.files[toCheckpointRelPath(dir, file)]?.bytes, fs.statSync(file).size)
  } finally {
    stopOtelSpoolConsumer()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("OTel consumer: session limit chunks a multi-session file without losing records", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-consumer-capacity-"))
  stopOtelSpoolConsumer()
  try {
    const dayDir = path.join(dir, new Date().toISOString().slice(0, 10))
    fs.mkdirSync(dayDir, { recursive: true })
    const file = path.join(dayDir, "logs.jsonl")
    fs.writeFileSync(
      file,
      ["session-a", "session-b", "session-c"]
        .map(sessionId => JSON.stringify({ sessionId }))
        .join("\n") + "\n",
      "utf8",
    )
    const saved = new Set<string>()
    let observedMax = 0
    const source = makeSource(dir, file, {
      task_id: "placeholder",
      user: "test-user",
      query: "capacity",
      framework: "test",
      final_result: "done",
    })

    startOtelSpoolConsumer({
      sources: [source],
      saveExecution: async (data) => {
        saved.add(String(data.task_id))
        return { success: true, record: data }
      },
      shortMs: 5,
      longMs: 10,
      maxWaitMs: 20,
      tickMs: 5,
      maxTrackedSessions: 2,
      seedOnStart: false,
      log: () => {},
      warn: () => {},
    })

    await waitFor(() => {
      const state = getOtelSpoolConsumerForTest()
      observedMax = Math.max(observedMax, state?.sessions.size || 0)
      return saved.size === 3 && state?.pendingFiles.size === 0
    })
    assert.deepEqual([...saved].sort(), ["session-a", "session-b", "session-c"])
    assert.ok(observedMax <= 2)
    const checkpoint = loadCheckpoint(dir)
    assert.equal(checkpoint.files[toCheckpointRelPath(dir, file)]?.bytes, fs.statSync(file).size)
  } finally {
    stopOtelSpoolConsumer()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("OTel consumer: accepts credential-authenticated Qoder traces owned by admin", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-consumer-qoder-admin-"))
  stopOtelSpoolConsumer()
  try {
    const dayDir = path.join(dir, new Date().toISOString().slice(0, 10))
    fs.mkdirSync(dayDir, { recursive: true })
    const file = path.join(dayDir, "traces.jsonl")
    fs.writeFileSync(file, "{\"sessionId\":\"qoder-admin-session\"}\n", "utf8")

    const calls: ExecutionRecord[] = []
    const source = makeSource(dir, file, {
      task_id: "qoder-admin-session",
      user: "admin",
      query: "hello",
      framework: "qoder",
      final_result: "done",
      authenticated_ingest: true,
    })

    startOtelSpoolConsumer({
      sources: [source],
      saveExecution: async (data) => {
        calls.push(data)
        return { success: true, record: data }
      },
      shortMs: 10,
      longMs: 10000,
      maxWaitMs: 10000,
      tickMs: 5,
      seedOnStart: false,
      log: () => {},
      warn: () => {},
    })

    await waitFor(() => calls.length > 0)
    assert.equal(calls[0]?.framework, "qoder")
    assert.equal(calls[0]?.user, "admin")
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
      // user 必填：consumer 的 saveExecution 外面裹了 attribution guard，无归属的记录
      // 会被直接丢弃（防跨用户串数据），夹具漏了它就永远等不到聚合。
      user: "test-user",
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
        // user 必填，理由同上（attribution guard 会丢掉无归属记录）
        record: { task_id: sessionId, user: "test-user", query: "q", framework: "test", final_result: "done" },
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
