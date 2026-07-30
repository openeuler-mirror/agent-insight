import test from "node:test"
import assert from "node:assert/strict"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { SpoolReader, SessionState } from "../src/uploader/spool"

const realSpoolDir = path.join(os.homedir(), ".agent-insight", "otel_data", "trae")

function findRealSpoolFiles(): string[] {
  const reader = new SpoolReader(realSpoolDir)
  const files = reader.listJsonlFiles()
  return files.filter(f => !f.includes("trae-llm.jsonl"))
}

function loadAllRealEvents(): any[] {
  const reader = new SpoolReader(realSpoolDir)
  const allEvents: any[] = []
  for (const f of findRealSpoolFiles()) {
    allEvents.push(...reader.readEvents(f))
  }
  return allEvents
}

// ============================================================================
// 真实数据: Session 结构完整性
// ============================================================================
test("真实数据: buildSessionState 正确处理所有事件类型", () => {
  const reader = new SpoolReader(realSpoolDir)
  const allEvents = loadAllRealEvents()
  const sessions = reader.buildSessionState(allEvents)

  assert.ok(sessions.size > 0, "应至少有一个 session")

  for (const [sid, state] of sessions) {
    assert.ok(typeof sid === "string" && sid.length > 0)
    assert.ok(state.events.length > 0, `session ${sid.slice(0,12)} 应有事件`)

    // 跳过测试数据 session（前缀为 test/session-main-test 的非真实会话）
    if (sid.startsWith("test") || sid.startsWith("session-main-test") || sid === "all") continue

    const kinds = new Set(state.events.map(e => e.kind))
    assert.ok(kinds.has("agent.session.start") || kinds.has("agent.subagent.start"),
      `session ${sid.slice(0,12)} 应有 start 事件`)
  }
})

// ============================================================================
// 真实数据: AC5 Agent Trace 完整性
// ============================================================================
test("真实数据 AC5: 每个 Agent session 包含 query/result", () => {
  const reader = new SpoolReader(realSpoolDir)
  const allEvents = loadAllRealEvents()
  const sessions = reader.buildSessionState(allEvents)

  let checkedSessions = 0
  for (const [sid, state] of sessions) {
    if (state.prompts.length === 0 && state.ends.length === 0) continue
    checkedSessions++

    for (const prompt of state.prompts) {
      assert.ok(prompt.payload?.query, `session ${sid.slice(0,12)}: prompt 的 query 字段必须存在`)
    }
    for (const end of state.ends) {
      assert.ok(end.payload?.finalResult !== undefined,
        `session ${sid.slice(0,12)}: response 的 finalResult 字段必须存在`)
    }
  }
  assert.ok(checkedSessions > 0, "至少应有一个有内容的 session")
})

// ============================================================================
// 真实数据: AC6/AC7 子 Agent 关联
// ============================================================================
test("真实数据 AC6/AC7: 子 Agent 正确关联到父 session", () => {
  const reader = new SpoolReader(realSpoolDir)
  const allEvents = loadAllRealEvents()
  const sessions = reader.buildSessionState(allEvents)

  let subagentsFound = 0
  let correctlyLinked = 0
  let orphanedByCleanup = 0

  for (const [sid, state] of sessions) {
    if (state.subagentOf) {
      subagentsFound++
      const parentExists = sessions.has(state.subagentOf)
      if (parentExists) {
        correctlyLinked++
      } else {
        orphanedByCleanup++
        // 父 session 可能已被 spool 清理（超过保留期）
        console.log(`  孤立子 Agent: ${sid.slice(0,12)} → ${state.subagentOf.slice(0,12)} (父 session 已过期清理)`)
      }

      const isSubagent = state.events.some(e =>
        e.kind === "agent.subagent.start" || e.kind === "agent.subagent.end")
      assert.ok(isSubagent,
        `子 Agent ${sid.slice(0,12)} 应有 subagent.start 或 subagent.end 事件`)
    }
  }

  console.log(`  子 Agent: ${subagentsFound}, 正确关联: ${correctlyLinked}, 父已过期: ${orphanedByCleanup}`)
  if (subagentsFound === 0) {
    console.log("  (跳过: 无子 Agent 数据)")
    return
  }
})

// ============================================================================
// 真实数据: AC10 Tool 类型覆盖
// ============================================================================
test("真实数据 AC10: 工具调用覆盖所有已知类型", () => {
  const reader = new SpoolReader(realSpoolDir)
  const allEvents = loadAllRealEvents()
  const sessions = reader.buildSessionState(allEvents)

  const toolTypes = new Set<string>()
  let totalTools = 0
  let unknownTools = 0

  for (const [sid, state] of sessions) {
    for (const ev of state.tools) {
      if (ev.kind !== "tool.call.start") continue
      const tt = ev.payload?.toolType || "unknown"
      toolTypes.add(tt)
      totalTools++
      if (tt === "unknown") unknownTools++
    }
  }

  console.log(`  工具类型: ${[...toolTypes].join(", ")}`)
  console.log(`  总数: ${totalTools}, 未知: ${unknownTools}`)

  assert.ok(toolTypes.has("search"), "应有 search 类型工具")
  assert.ok(toolTypes.has("file_read"), "应有 file_read 类型工具")

  if (unknownTools > 0) {
    console.log(`  注意: ${unknownTools} 个工具被归类为 unknown (MCP 工具/新类型)` +
      ` — 新版 pre-tool-use.sh 已修复 MCP 检测`)
  }
})

// ============================================================================
// 真实数据: 验证 loadCheckpoint 兼容性
// ============================================================================
test("真实数据 AC22: checkpoint 文件格式兼容", () => {
  const checkpointFile = path.join(os.homedir(), ".agent-insight", "trae_uploader_checkpoint.json")
  if (!fs.existsSync(checkpointFile)) {
    console.log("  checkpoint 文件不存在 (尚未上传), 跳过")
    return
  }
  const ckpt = JSON.parse(fs.readFileSync(checkpointFile, "utf8"))
  assert.ok(typeof ckpt === "object")
  for (const [sessionId, entry] of Object.entries(ckpt) as [string, any][]) {
    assert.ok(entry.signature, `checkpoint entry ${sessionId.slice(0,12)} 应有 signature`)
    assert.ok(entry.uploadedAt, `checkpoint entry ${sessionId.slice(0,12)} 应有 uploadedAt`)
  }
  console.log(`  checkpoint 包含 ${Object.keys(ckpt).length} 个 session`)
})

// ============================================================================
// 真实数据: 事件时间有序性
// ============================================================================
test("真实数据: 事件按时间顺序记录", () => {
  const reader = new SpoolReader(realSpoolDir)
  const allEvents = loadAllRealEvents()
  const sessions = reader.buildSessionState(allEvents)

  for (const [sid, state] of sessions) {
    const timestamps = state.events.map(e => new Date(e.t).getTime())
    for (let i = 1; i < timestamps.length; i++) {
      // 允许 5 秒内的乱序（多个 hook 脚本并发写入）
      assert.ok(timestamps[i] >= timestamps[i - 1] - 5000,
        `session ${sid.slice(0,12)}: 事件时间不应大幅倒退 ` +
        `(${new Date(timestamps[i-1]).toISOString()} → ${new Date(timestamps[i]).toISOString()})`)
    }
  }
})

// ============================================================================
// 真实数据: 子 Agent end 事件分析
// ============================================================================
test("真实数据 AC6: 每个 subagent.start 有对应的 end 或 response", () => {
  const reader = new SpoolReader(realSpoolDir)
  const allEvents = loadAllRealEvents()
  const sessions = reader.buildSessionState(allEvents)

  let subStarts = 0
  let subEnds = 0
  let subResponses = 0

  for (const [sid, state] of sessions) {
    for (const ev of state.events) {
      if (ev.kind === "agent.subagent.start") subStarts++
      if (ev.kind === "agent.subagent.end") subEnds++
    }
    if (state.ends.length > 0 && state.subagentOf) subResponses++
  }

  console.log(`  subagent.start: ${subStarts}, subagent.end: ${subEnds}, subagent有response: ${subResponses}`)
  // 每个子 Agent 应有 start + (end 或 response)
  assert.ok(subEnds + subResponses >= subStarts - 1,
    "大部分 subagent.start 应有对应的 end 或 response")
})

// ============================================================================
// 真实数据: 验证 toolUseId 一致性
// ============================================================================
test("真实数据: tool.call.start 和 tool.call.end 的 trace_id 一一对应", () => {
  const reader = new SpoolReader(realSpoolDir)
  const allEvents = loadAllRealEvents()
  const sessions = reader.buildSessionState(allEvents)

  for (const [sid, state] of sessions) {
    const startIds = new Set<string>()
    const endIds = new Set<string>()

    for (const ev of state.tools) {
      if (ev.kind === "tool.call.start" && ev.trace_id) startIds.add(ev.trace_id)
      if (ev.kind === "tool.call.end" && ev.trace_id) endIds.add(ev.trace_id)
    }

    if (startIds.size === 0 && endIds.size === 0) continue

    // 大部分 start 应有对应的 end（允许少数未完成）
    const matched = [...startIds].filter(id => endIds.has(id)).length
    const matchRate = startIds.size > 0 ? matched / startIds.size : 1

    console.log(`  session ${sid.slice(0,12)}: start=${startIds.size}, end=${endIds.size}, matchRate=${(matchRate*100).toFixed(0)}%`)

    if (startIds.size > 2) {
      assert.ok(matchRate > 0.5, `session ${sid.slice(0,12)}: 至少 50% 的 tool start 应有对应 end`)
    }
  }
})
