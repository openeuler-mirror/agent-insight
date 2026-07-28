import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  getOtelSpoolConsumerForTest,
  startOtelSpoolConsumer,
  stopOtelSpoolConsumer,
} from "@/lib/ingest/otel-consumer/consumer"
import type { SpoolSource } from "@/lib/ingest/otel-consumer/sources"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await wait(5)
  }
}

/** 造一个 spool 目录，每个 session 一个文件，返回文件列表。 */
function makeSpool(prefix: string, sessionIds: string[]): { dir: string; files: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const dayDir = path.join(dir, new Date().toISOString().slice(0, 10))
  fs.mkdirSync(dayDir, { recursive: true })
  const files = sessionIds.map((sid) => {
    const file = path.join(dayDir, `${sid}.jsonl`)
    fs.writeFileSync(file, `{"sessionId":"${sid}"}\n`, "utf8")
    return file
  })
  return { dir, files }
}

function makeSource(dir: string, files: string[], onAggregate?: (sessionId: string) => void): SpoolSource {
  return {
    id: "test-source",
    spoolDir: () => dir,
    listFiles: () => files,
    aggregate: (sessionId) => {
      onAggregate?.(sessionId)
      return {
        sessionId,
        eventCount: 1,
        record: { task_id: sessionId, user: "test-user", query: "q", framework: "test", final_result: "done" },
      }
    },
    defaultSkipEvaluation: () => true,
  }
}

test("全局冷却必须有绝对上限：一轮慢聚合不能按倍数把整条流水线冻住", async () => {
  // 2026-07-28 事故的直接回归：旧实现的全局冷却 = 上轮耗时 × factor（只受 5 分钟封顶约束），
  // 线上单轮 51s 直接让所有会话停摆 153s，吞吐塌到 0.3 条/分钟。
  const { dir, files } = makeSpool("otel-gate-cap-", ["session-a", "session-b"])
  stopOtelSpoolConsumer()
  try {
    const calls: number[] = []
    startOtelSpoolConsumer({
      sources: [makeSource(dir, files)],
      saveExecution: async (data) => {
        calls.push(Date.now())
        await wait(60)
        return { success: true, record: data }
      },
      shortMs: 10,
      longMs: 100000,
      maxWaitMs: 100000,
      tickMs: 5,
      aggCooldownFactor: 1,
      aggCooldownCapMs: 100000,
      aggGlobalFactor: 100,      // 不封顶的话：60ms × 100 = 6000ms 全局冻结
      aggGlobalMaxWaitMs: 200,   // 封顶 200ms
      drainBacklog: 1000,        // 关掉排空模式，单独验证封顶这一条
      seedOnStart: false,
      log: () => {},
      warn: () => {},
    })

    await waitFor(() => calls.length >= 2, 8000)
    assert.ok(calls.length >= 2, "两个会话都应完成聚合")
    const gap = calls[1] - calls[0]
    // 阈值给得宽，是为了在全量测试并发跑、机器负载高时也稳定；判别力仍然充足：
    // 不封顶的话这里必然 ≥6000ms。
    assert.ok(gap < 3000, `第二轮不应被倍数冻住，实际间隔 ${gap}ms（不封顶会是 6000ms 以上）`)
    assert.ok(gap >= 200, `封顶之内仍要保留占空比保护，实际间隔 ${gap}ms`)
  } finally {
    stopOtelSpoolConsumer()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("backlog 越过阈值进排空模式：此时不再限流，积压能排空", async () => {
  const sessions = Array.from({ length: 8 }, (_, i) => `session-${i}`)
  const { dir, files } = makeSpool("otel-drain-", sessions)
  stopOtelSpoolConsumer()
  try {
    const calls: string[] = []
    startOtelSpoolConsumer({
      sources: [makeSource(dir, files)],
      saveExecution: async (data) => {
        calls.push(String(data.task_id))
        await wait(20)
        return { success: true, record: data }
      },
      shortMs: 10,
      longMs: 100000,
      maxWaitMs: 100000,
      tickMs: 5,
      aggCooldownFactor: 1,
      aggCooldownCapMs: 100000,
      aggGlobalFactor: 100,     // 非排空模式下每轮之间要歇 min(5000, 20×100=2000)ms
      aggGlobalMaxWaitMs: 5000,
      drainBacklog: 3,          // backlog≥3 即进排空
      seedOnStart: false,
      log: () => {},
      warn: () => {},
    })

    const startedAt = Date.now()
    await waitFor(() => calls.length >= 8, 12000)
    const elapsed = Date.now() - startedAt
    assert.equal(new Set(calls).size, 8, "8 个会话都应处理到")
    assert.ok(elapsed < 6000, `排空模式下不该逐轮限流，实际耗时 ${elapsed}ms（限流则需 14s 以上）`)

    // 排空到低水位后应退出排空模式（滞回），限流保护恢复
    await waitFor(() => (getOtelSpoolConsumerForTest()?.pendingFiles.size ?? 1) === 0, 2000)
    const state = getOtelSpoolConsumerForTest()
    assert.ok(state)
    assert.equal(state!.pendingFiles.size, 0, "backlog 应已排空")
    assert.equal(state!.draining, false, "低水位应退出排空模式，恢复限流保护")
  } finally {
    stopOtelSpoolConsumer()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("数据没变时 evaluated 复用 fast 的聚合快照，且会话处理完会被回收", async () => {
  const { dir, files } = makeSpool("otel-reuse-", ["session-x"])
  stopOtelSpoolConsumer()
  try {
    let aggregateCalls = 0
    const source = makeSource(dir, files, () => { aggregateCalls += 1 })
    // 指纹恒定 = 两次调度之间没有新数据落盘
    source.statSession = () => "constant-signature"

    const saves: any[] = []
    startOtelSpoolConsumer({
      sources: [source],
      saveExecution: async (data) => {
        saves.push(data)
        return { success: true, record: data }
      },
      shortMs: 10,
      longMs: 60,
      maxWaitMs: 500,
      tickMs: 5,
      seedOnStart: false,
      log: () => {},
      warn: () => {},
    })

    await waitFor(() =>
      saves.some((s) => s.skip_evaluation === true) && saves.some((s) => s.force_judgment === true), 4000)

    assert.equal(saves.filter((s) => s.skip_evaluation === true).length, 1, "fast 保存一次")
    assert.equal(saves.filter((s) => s.force_judgment === true).length, 1, "evaluated 保存一次")
    assert.equal(aggregateCalls, 1, `同一份数据只该聚合一次，实际 ${aggregateCalls} 次`)

    await waitFor(() => (getOtelSpoolConsumerForTest()?.sessions.size ?? 1) === 0, 2000)
    assert.equal(getOtelSpoolConsumerForTest()?.sessions.size, 0, "处理完的会话应从内存里摘掉，避免无界增长")
  } finally {
    stopOtelSpoolConsumer()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("有新数据时 evaluated 必须重新聚合，不能复用旧快照", async () => {
  const { dir, files } = makeSpool("otel-resnapshot-", ["session-y"])
  stopOtelSpoolConsumer()
  try {
    let aggregateCalls = 0
    const source = makeSource(dir, files, () => { aggregateCalls += 1 })
    source.statSession = () => `sig-${aggregateCalls}` // 每次指纹都不同 = 一直有新数据

    const saves: any[] = []
    startOtelSpoolConsumer({
      sources: [source],
      saveExecution: async (data) => {
        saves.push(data)
        return { success: true, record: data }
      },
      shortMs: 10,
      longMs: 60,
      maxWaitMs: 500,
      tickMs: 5,
      seedOnStart: false,
      log: () => {},
      warn: () => {},
    })

    await waitFor(() =>
      saves.some((s) => s.skip_evaluation === true) && saves.some((s) => s.force_judgment === true), 4000)
    assert.equal(aggregateCalls, 2, `数据变了就要重新聚合，实际 ${aggregateCalls} 次`)
  } finally {
    stopOtelSpoolConsumer()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
