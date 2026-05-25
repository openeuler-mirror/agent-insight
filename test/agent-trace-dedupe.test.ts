import assert from "node:assert/strict"
import test from "node:test"

import { buildAgentCallTree } from "../src/lib/engine/observability/agent-trace"

test("agent trace: duplicate tool calls with the same id render once", () => {
  const tree = buildAgentCallTree([
    { role: "user", content: "diagnose", timestamp: 1 },
    {
      role: "assistant",
      content: "starting",
      timestamp: 2,
      tool_calls: [
        {
          id: "call_task_1",
          type: "function",
          function: {
            name: "task",
            arguments: JSON.stringify({
              subagent_type: "fuxi-sub",
              description: "构建文件系统故障诊断计划",
            }),
          },
          state: "running",
        },
        {
          id: "call_task_1",
          type: "function",
          function: {
            name: "task",
            arguments: JSON.stringify({
              subagent_type: "fuxi-sub",
              description: "构建文件系统故障诊断计划",
            }),
          },
          state: "success",
          output: "<task_metadata>\nsession_id: ses_child\n</task_metadata>",
        },
      ],
    },
  ] as any)

  assert.ok(tree)
  assert.equal(tree!.events.filter((e) => e.kind === "task").length, 1)
  assert.equal(tree!.stats.taskCalls, 1)
})

test("agent trace: ISO timestamps produce finite durations", () => {
  const tree = buildAgentCallTree([
    {
      role: "user",
      content: "diagnose",
      timestamp: "2026-04-30T04:30:57.000Z",
    },
    {
      role: "assistant",
      content: "done",
      timestamp: "2026-04-30T04:31:02.000Z",
      timeInfo: {
        created: "2026-04-30T04:31:02.000Z",
        completed: "2026-04-30T04:31:04.500Z",
      },
      usage: { total: 10 },
    },
  ] as any)

  assert.ok(tree)
  assert.equal(Number.isFinite(tree!.stats.durationMs), true)
  assert.equal(tree!.stats.durationMs, 7500)
  assert.equal(tree!.events[1].startedAt, Date.parse("2026-04-30T04:31:02.000Z"))
  assert.equal(tree!.events[1].completedAt, Date.parse("2026-04-30T04:31:04.500Z"))
})
