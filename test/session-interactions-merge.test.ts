import assert from "node:assert/strict"
import test from "node:test"

import { mergeSessionInteractionsMonotonic } from "@/lib/engine/observability/session-interactions-merge"

test("mergeSessionInteractionsMonotonic preserves existing child-session messages even if incoming is longer but missing them", () => {
  const existing = [
    { role: "user", content: "root q", timestamp: "2026-01-01T00:00:00.000Z" },
    {
      role: "subagent",
      subagent_session_id: "ses_baize",
      subagent_name: "baize",
      content: "baize final report",
      timestamp: "2026-01-01T00:01:00.000Z",
    },
    { role: "assistant", content: "root a", timestamp: "2026-01-01T00:02:00.000Z" },
  ]

  const incoming = [
    { role: "user", content: "root q", timestamp: "2026-01-01T00:00:00.000Z" },
    { role: "assistant", content: "root a", timestamp: "2026-01-01T00:02:00.000Z" },
    { role: "assistant", content: "more steps 1", timestamp: "2026-01-01T00:03:00.000Z" },
    { role: "assistant", content: "more steps 2", timestamp: "2026-01-01T00:04:00.000Z" },
    { role: "assistant", content: "more steps 3", timestamp: "2026-01-01T00:05:00.000Z" },
  ]

  const merged = mergeSessionInteractionsMonotonic(existing as any[], incoming as any[])
  assert.ok(merged.some((m: any) => m.subagent_session_id === "ses_baize"))
  assert.ok(merged.length >= incoming.length)
})

test("mergeSessionInteractionsMonotonic never overwrites non-empty content with empty content", () => {
  const existing = [
    { role: "assistant", timestamp: 1, content: "hello" },
  ]
  const incoming = [
    { role: "assistant", timestamp: 1, content: "" },
  ]

  const merged = mergeSessionInteractionsMonotonic(existing as any[], incoming as any[])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].content, "hello")
})

// 回归:Claude Code 跨机补传实跑发现的缺陷。OTel 日志边跑边上报,消费者先聚合出一版
// 「工具调用有 id、没 output」的快照落库;SessionEnd 的补传到达后重聚合,这一版才带上
// output。按 id 去重时若整份保留库里那条旧记录,补传的正文就永远落不了地(实测 DB 里
// output 恒为空,而聚合器直出是有的)。
test("mergeSessionInteractionsMonotonic 用后到的工具输出补全已有的同一次调用", () => {
  const existing = [
    {
      role: "assistant", timestamp: 1, content: "读一下配置",
      tool_calls: [{ id: "toolu_read_1", name: "Read", arguments: '{"file_path":"src/config.ts"}', status: "success" }],
    },
  ]
  const incoming = [
    {
      role: "assistant", timestamp: 1, content: "读一下配置",
      tool_calls: [{ id: "toolu_read_1", name: "Read", output: "export const config = { port: 3000 }" }],
    },
  ]

  const merged = mergeSessionInteractionsMonotonic(existing as any[], incoming as any[])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].tool_calls.length, 1)
  assert.equal(merged[0].tool_calls[0].output, "export const config = { port: 3000 }")
  // 旧记录独有的字段不能因为合并而丢
  assert.equal(merged[0].tool_calls[0].arguments, '{"file_path":"src/config.ts"}')
  assert.equal(merged[0].tool_calls[0].status, "success")
})

test("mergeSessionInteractionsMonotonic 工具输出只增不减:后到的空值/截断版不覆盖完整正文", () => {
  const full = "0123456789".repeat(10)
  const existing = [
    { role: "assistant", timestamp: 1, tool_calls: [{ id: "t1", name: "Bash", output: full, status: "success" }] },
  ]
  const incoming = [
    { role: "assistant", timestamp: 1, tool_calls: [{ id: "t1", name: "Bash", output: "" }] },
  ]
  assert.equal(
    mergeSessionInteractionsMonotonic(existing as any[], incoming as any[])[0].tool_calls[0].output,
    full,
  )

  const truncated = [
    { role: "assistant", timestamp: 1, tool_calls: [{ id: "t1", name: "Bash", output: full.slice(0, 20) }] },
  ]
  assert.equal(
    mergeSessionInteractionsMonotonic(existing as any[], truncated as any[])[0].tool_calls[0].output,
    full,
  )
})

// 回归:排序语义 —— incoming(完整快照)的相对顺序是权威,不能整体按 timestamp 重排。
// 聚合器会刻意把补传合成的子 agent 轮次追加到父轮 task 调用之后(建树认领是顺序敏感的),
// 而这类轮次的 timestamp 常早于 task 调用挂上去的那一轮;按 ts 重排会毁掉认领顺序。
test("mergeSessionInteractionsMonotonic 保 incoming 顺序,existing 独有条目按时间插入", () => {
  const incoming = [
    { role: "user", content: "q", timestamp: "2026-01-01T00:00:00.000Z" },
    { role: "assistant", content: "a", timestamp: "2026-01-01T00:00:08.000Z" },
    // 聚合器刻意放在最后,但时间戳更早
    { role: "subagent", subagent_session_id: "s:t1", content: "sub", timestamp: "2026-01-01T00:00:05.000Z" },
  ]
  const existing = [
    { role: "user", content: "q", timestamp: "2026-01-01T00:00:00.000Z" },
    // incoming 里没有的旧条目(如乱序上传的子会话):按时间插到中间
    { role: "assistant", content: "old-only", timestamp: "2026-01-01T00:00:03.000Z" },
  ]

  const merged = mergeSessionInteractionsMonotonic(existing as any[], incoming as any[])
  assert.deepEqual(
    merged.map((m: any) => m.content),
    ["q", "old-only", "a", "sub"],
    "incoming 顺序原样保留(sub 仍在最后),old-only 按 ts 插进骨架",
  )
})
