import assert from "node:assert/strict"
import test from "node:test"

import { buildAgentCallTree } from "../src/lib/engine/observability/agent-trace"
import { buildFaultPathSteps } from "../src/lib/engine/observability/fault-path"

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

test("agent trace: content blocks are converted to text before building events", () => {
  const tree = buildAgentCallTree([
    { role: "user", content: [{ type: "text", text: "diagnose" }], timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 },
  ] as any)

  assert.ok(tree)
  assert.equal(tree!.events[0]?.summary, "diagnose")
  assert.equal(tree!.events[1]?.summary, "done")
})

test("agent trace: parallel same-type task calls create separate child nodes", () => {
  const tree = buildAgentCallTree([
    { role: "user", content: "diagnose", timestamp: 1 },
    {
      role: "assistant",
      agent: "Root",
      content: "dispatch",
      timestamp: 2,
      tool_calls: [
        {
          id: "task_1",
          type: "function",
          function: {
            name: "task",
            arguments: JSON.stringify({
              subagent_type: "general",
              description: "first branch",
            }),
          },
          state: "success",
        },
        {
          id: "task_2",
          type: "function",
          function: {
            name: "task",
            arguments: JSON.stringify({
              subagent_type: "general",
              description: "second branch",
            }),
          },
          state: "success",
        },
      ],
    },
    {
      role: "subagent",
      agent: "general",
      subagent_name: "general",
      subagent_session_id: "ses_child_1",
      content: "first result",
      timestamp: 3,
    },
    {
      role: "subagent",
      agent: "general",
      subagent_name: "general",
      subagent_session_id: "ses_child_2",
      content: "second result",
      timestamp: 4,
    },
  ] as any)

  assert.ok(tree)
  assert.equal(tree!.stats.taskCalls, 2)
  assert.equal(tree!.children.length, 2)
  assert.deepEqual(tree!.children.map((child) => child.sessionId), ["ses_child_1", "ses_child_2"])
  assert.equal(tree!.events.find((event) => (event as any)._toolCallId === "task_1")?.spawnedChildId, tree!.children[0].id)
  assert.equal(tree!.events.find((event) => (event as any)._toolCallId === "task_2")?.spawnedChildId, tree!.children[1].id)
})

test("agent trace: tool-only assistant turn (empty content) still emits an llm event from reasoning", () => {
  // In opencode a tool-calling turn carries its chain-of-thought in `reasoning`
  // parts while `content` (text parts only) is empty. Each such turn is one LLM
  // call and must surface as an llm event so the timeline shows the LLM step and
  // the tool call nests under it.
  const tree = buildAgentCallTree([
    { role: "user", content: "go", timestamp: 1 },
    {
      role: "assistant",
      content: "",
      timestamp: 2,
      parts: [
        { type: "reasoning", text: "I should read the file first." },
        { type: "tool", tool: "read", callID: "c1", state: { status: "success" } },
      ],
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ file_path: "a.ts" }) },
          state: "success",
        },
      ],
    },
    { role: "assistant", content: "done", timestamp: 3 },
  ] as any)

  assert.ok(tree)
  const llm = tree!.events.filter((e) => e.kind === "llm")
  const tool = tree!.events.filter((e) => e.kind === "tool")
  // One llm per assistant turn (reasoning-only + final text) and one tool call.
  assert.equal(llm.length, 2)
  assert.equal(tool.length, 1)
  assert.equal(tree!.stats.llmCalls, 2)
  // The reasoning text becomes the llm event summary when content is empty.
  assert.equal(llm[0].summary, "I should read the file first.")
})

test("fault path: tool-only llm step exposes its tool-call summary as output", () => {
  const steps = buildFaultPathSteps([
    { role: "user", content: "go", timestamp: 1 },
    {
      role: "assistant",
      content: "",
      timestamp: 2,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ file_path: "a.ts" }) },
          state: "success",
          output: "file contents",
        },
      ],
    },
  ] as any, "zh")

  const llmStep = steps.find((step) => step.kind === "llm")
  assert.equal(llmStep?.rawOutput, "1 个工具调用: read")
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
