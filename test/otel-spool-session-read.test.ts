import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  appendOtelTraceEvents,
  listOtelTraceSpoolFiles,
  listSessionSpoolFiles,
  readOtelTraceEventsForSession,
} from "@/lib/ingest/claude-otel/spool"
import {
  invalidateLegacySessionIndexCache,
  legacySessionIndexPath,
} from "@/lib/ingest/claude-otel/legacy-session-index"

const day = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function event(sessionId: string, spanId: string, extra: Record<string, any> = {}) {
  return {
    receivedAt: new Date().toISOString(),
    sessionId,
    traceId: sessionId,
    spanId,
    name: "span",
    kind: "llm" as const,
    serviceName: "test",
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    latencyMs: 1,
    startTimeMs: 1,
    attributes: {},
    ...extra,
  }
}

function spanIds(events: any[]): string {
  return events.map((e) => e.spanId).sort().join(",")
}

/** 分别用「定向读」和「全量扫」跑一遍，返回两者结果。定向读是本次优化，全量扫是修复前的行为。 */
function bothReads(sessionId: string, dir: string) {
  const previous = process.env.AGENT_INSIGHT_OTEL_SESSION_TARGETED_READ
  try {
    process.env.AGENT_INSIGHT_OTEL_SESSION_TARGETED_READ = "1"
    invalidateLegacySessionIndexCache()
    const targeted = readOtelTraceEventsForSession(sessionId, dir)
    process.env.AGENT_INSIGHT_OTEL_SESSION_TARGETED_READ = "0"
    const full = readOtelTraceEventsForSession(sessionId, dir)
    return { targeted, full }
  } finally {
    if (previous === undefined) delete process.env.AGENT_INSIGHT_OTEL_SESSION_TARGETED_READ
    else process.env.AGENT_INSIGHT_OTEL_SESSION_TARGETED_READ = previous
  }
}

test("session 定向读与全量扫结果必须一致：纯分片 / 纯 legacy / 跨格式边界", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spool-session-read-"))
  try {
    // 新格式分片：三个 session
    appendOtelTraceEvents([
      event("sess-shard-only", "s1"),
      event("sess-shard-only", "s2"),
      event("sess-boundary", "b-new"),
      event("sess-other", "o1"),
    ] as any, dir)

    // 旧格式整日平铺文件：混着多个 session，其中 sess-boundary 跨了格式边界
    const legacyFile = path.join(dir, day(), "traces.jsonl")
    fs.writeFileSync(legacyFile, [
      JSON.stringify(event("sess-legacy-only", "l1")),
      JSON.stringify(event("sess-boundary", "b-old-1")),
      JSON.stringify(event("sess-other", "o-old")),
      JSON.stringify(event("sess-boundary", "b-old-2")),
      JSON.stringify(event("sess-legacy-only", "l2")),
    ].join("\n") + "\n", "utf8")

    for (const [sessionId, expected] of [
      ["sess-shard-only", "s1,s2"],
      ["sess-legacy-only", "l1,l2"],
      ["sess-boundary", "b-new,b-old-1,b-old-2"],
    ] as const) {
      const { targeted, full } = bothReads(sessionId, dir)
      assert.equal(spanIds(targeted), spanIds(full), `${sessionId}: 两种读法结果必须一致`)
      assert.equal(spanIds(targeted), expected, `${sessionId}: 事件集合不对`)
    }

    // 分片存在时也绝不能跳过 legacy —— 跨边界会话的早期 span 只在 legacy 里
    const boundary = listSessionSpoolFiles(dir, "traces.jsonl", "sess-boundary")
    assert.equal(boundary.shards.length, 1)
    assert.equal(boundary.legacy.length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("需要 sanitize/hash 的 sessionId 也能被定向命中", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spool-session-safe-"))
  try {
    const weird = "会话/带斜杠 和空格::" + "x".repeat(120)
    appendOtelTraceEvents([event(weird, "w1"), event(weird, "w2")] as any, dir)
    const { targeted, full } = bothReads(weird, dir)
    assert.equal(spanIds(targeted), "w1,w2")
    assert.equal(spanIds(targeted), spanIds(full))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("legacy 旁路索引：只线性扫一次，之后按 byte range 定点读", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spool-legacy-index-"))
  try {
    const dayDir = path.join(dir, day())
    fs.mkdirSync(dayDir, { recursive: true })
    const legacyFile = path.join(dayDir, "traces.jsonl")
    const lines: string[] = []
    for (let i = 0; i < 300; i += 1) {
      lines.push(JSON.stringify(event(`sess-${i % 30}`, `sp-${i}`, { attributes: { pad: "填充".repeat(50) } })))
    }
    fs.writeFileSync(legacyFile, lines.join("\n") + "\n", "utf8")
    const fileSize = fs.statSync(legacyFile).size

    // 统计从 legacy 文件真实读了多少字节
    const realReadSync = fs.readSync
    let bytesRead = 0
    ;(fs as any).readSync = (fd: number, buffer: any, offset: number, length: number, position: number | null) => {
      const n = (realReadSync as any)(fd, buffer, offset, length, position)
      bytesRead += n
      return n
    }

    try {
      invalidateLegacySessionIndexCache()
      bytesRead = 0
      const first = readOtelTraceEventsForSession("sess-7", dir)
      const firstScan = bytesRead
      assert.equal(first.length, 10)
      assert.ok(firstScan >= fileSize, `首次要线性扫一遍建索引，实际读 ${firstScan} / 文件 ${fileSize}`)

      invalidateLegacySessionIndexCache() // 清进程内缓存，强制走磁盘上的索引
      bytesRead = 0
      const second = readOtelTraceEventsForSession("sess-7", dir)
      const secondScan = bytesRead
      assert.equal(spanIds(second), spanIds(first))
      assert.ok(secondScan < fileSize / 2, `第二次应按 range 定点读，实际读 ${secondScan} / 文件 ${fileSize}`)

      // 追加后只索引新增字节
      fs.appendFileSync(legacyFile, JSON.stringify(event("sess-7", "sp-new")) + "\n", "utf8")
      invalidateLegacySessionIndexCache()
      bytesRead = 0
      const third = readOtelTraceEventsForSession("sess-7", dir)
      assert.equal(third.length, 11)
      assert.ok(bytesRead < fileSize / 2, `追加后只该补扫增量，实际读 ${bytesRead}`)
    } finally {
      ;(fs as any).readSync = realReadSync
    }

    // 索引旁路文件不能被 spool 发现当成待消费数据
    assert.ok(fs.existsSync(legacySessionIndexPath(legacyFile)), "索引文件应已生成")
    const discovered = listOtelTraceSpoolFiles(dir)
    assert.ok(discovered.every((f) => !f.includes("session-index")), "索引文件不得出现在文件发现结果里")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("legacy 索引：截断/替换/损坏都能安全重建，不丢事件", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spool-legacy-rebuild-"))
  try {
    const dayDir = path.join(dir, day())
    fs.mkdirSync(dayDir, { recursive: true })
    const legacyFile = path.join(dayDir, "traces.jsonl")

    fs.writeFileSync(legacyFile, [
      JSON.stringify(event("sess-a", "a1")),
      JSON.stringify(event("sess-b", "b1")),
      JSON.stringify(event("sess-a", "a2")),
    ].join("\n") + "\n", "utf8")
    invalidateLegacySessionIndexCache()
    assert.equal(spanIds(readOtelTraceEventsForSession("sess-a", dir)), "a1,a2")

    // 文件被整体替换成更短的内容：旧 offset 全部作废，必须重建
    fs.writeFileSync(legacyFile, JSON.stringify(event("sess-a", "a9")) + "\n", "utf8")
    invalidateLegacySessionIndexCache()
    assert.equal(spanIds(readOtelTraceEventsForSession("sess-a", dir)), "a9", "截断后应重建索引")

    // 索引文件损坏：静默重建，不抛错
    fs.writeFileSync(legacySessionIndexPath(legacyFile), "{ 这不是 json", "utf8")
    invalidateLegacySessionIndexCache()
    assert.equal(spanIds(readOtelTraceEventsForSession("sess-a", dir)), "a9", "索引损坏后应重建")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("legacy 索引：多字节 UTF-8 与写到一半的末行不会错位丢事件", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spool-legacy-utf8-"))
  try {
    const dayDir = path.join(dir, day())
    fs.mkdirSync(dayDir, { recursive: true })
    const legacyFile = path.join(dayDir, "traces.jsonl")

    fs.writeFileSync(legacyFile, [
      JSON.stringify(event("sess-cn", "c1", { attributes: { text: "中文内容🚀带表情" } })),
      JSON.stringify(event("sess-other", "o1", { attributes: { text: "另一个会话的中文" } })),
      JSON.stringify(event("sess-cn", "c2", { attributes: { text: "第二条中文" } })),
    ].join("\n") + "\n", "utf8")

    // 末行写了一半（没有换行符）
    const partial = JSON.stringify(event("sess-cn", "c3", { attributes: { text: "写到一半的中" } }))
    fs.appendFileSync(legacyFile, partial.slice(0, partial.length - 10), "utf8")

    invalidateLegacySessionIndexCache()
    assert.equal(spanIds(readOtelTraceEventsForSession("sess-cn", dir)), "c1,c2", "半行不应产生事件，也不应破坏前面的 offset")

    // 补完这一行后应该能读到
    fs.appendFileSync(legacyFile, partial.slice(partial.length - 10) + "\n", "utf8")
    invalidateLegacySessionIndexCache()
    assert.equal(spanIds(readOtelTraceEventsForSession("sess-cn", dir)), "c1,c2,c3", "补完的行下次应被索引到")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
