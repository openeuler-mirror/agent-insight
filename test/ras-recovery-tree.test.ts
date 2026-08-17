import assert from "node:assert/strict"
import test from "node:test"

import type { AgentEvent, AgentNode } from "@/lib/engine/observability/agent-trace"
import {
  alignInteractionsToRasAnchors,
  applyRasRecoveryTree,
  buildRasRecoveryEvent,
} from "@/lib/ingest/ras/recovery-tree"
import type { RasTraceMarker } from "@/lib/ingest/ras/trace-markers"

function event(partial: Partial<AgentEvent> & Pick<AgentEvent, "kind">): AgentEvent {
  return {
    interaction: { role: partial.kind === "user" ? "user" : "assistant", content: "x" },
    interactionIndex: 0,
    startedAt: 1000,
    ...partial,
  }
}

function root(events: AgentEvent[], children: AgentNode[] = []): AgentNode {
  return {
    id: "root",
    agentName: "agent",
    subagentType: null,
    sessionId: "TOP",
    parentId: null,
    depth: 0,
    interactionIndices: [],
    events,
    children,
    stats: {
      interactions: events.length,
      llmCalls: 0,
      toolCalls: 0,
      skillCalls: 0,
      taskCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
  }
}

const marker: RasTraceMarker = {
  id: "anomaly-1",
  ts: 2000,
  kind: "llm_thinking_loop",
  label: "思考循环",
  severity: "medium",
  summary: "similar_clauses",
  callId: "call_function_1",
  deliveryMessageIds: ["msg_notice", "msg_steer"],
  actions: [
    { type: "abort_stream" },
    { type: "emit_notice", message: "notice" },
    { type: "push_steering", message: "steer" },
  ],
  actionResults: [
    { action: "emit_notice", ok: true, message: "notice", ts: 2100, deliveryMessageId: "msg_notice" },
    { action: "push_steering", ok: true, message: "steer", ts: 2200, deliveryMessageId: "msg_steer" },
  ],
}

test("applyRasRecoveryTree: one ras node, strips deliveries, anchors after call_id", () => {
  const tree = root([
    event({ kind: "user", startedAt: 500 }),
    event({ kind: "skill", name: "skill", toolCallId: "call_function_1", startedAt: 1500 }),
    event({
      kind: "user",
      startedAt: 2100,
      interaction: { role: "user", content: "notice", messageID: "msg_notice" },
    }),
    event({
      kind: "user",
      startedAt: 2200,
      interaction: { role: "user", content: "steer", messageID: "msg_steer" },
    }),
  ])

  const next = applyRasRecoveryTree(tree, [marker])
  const kinds = next.events.map((item) => item.kind)
  assert.deepEqual(kinds, ["user", "skill", "ras"])
  assert.equal(next.events.filter((item) => item.kind === "ras").length, 1)
  assert.equal(
    (next.events.find((item) => item.kind === "ras")?.args as { rasMarkerId?: string })?.rasMarkerId,
    "anomaly-1",
  )
})

test("applyRasRecoveryTree: prefers messageId over stale callId (LLM after skill)", () => {
  const llmMarker: RasTraceMarker = {
    ...marker,
    callId: "call_function_1",
    messageId: "msg_loop",
    ts: 3000,
  }
  const tree = root([
    event({ kind: "skill", name: "skill", toolCallId: "call_function_1", startedAt: 1500 }),
    event({
      kind: "llm",
      name: "loop",
      startedAt: 2500,
      interaction: { role: "assistant", content: "loop text", messageID: "msg_loop" },
    }),
  ])
  const next = applyRasRecoveryTree(tree, [llmMarker])
  assert.deepEqual(
    next.events.map((item) => item.kind),
    ["skill", "llm", "ras"],
  )
})

test("applyRasRecoveryTree: does not duplicate ras into skill child when unmatched", () => {
  const llmOnly: RasTraceMarker = {
    ...marker,
    callId: undefined,
    messageId: "msg_loop",
    ts: 3000,
  }
  const skillChild = root(
    [
      event({ kind: "skill", name: "skill", toolCallId: "call_skill", startedAt: 1500 }),
    ],
  )
  skillChild.id = "skill-child"
  const tree = root(
    [
      event({
        kind: "llm",
        startedAt: 2500,
        interaction: { role: "assistant", content: "loop", messageID: "msg_loop" },
      }),
    ],
    [skillChild],
  )
  const next = applyRasRecoveryTree(tree, [llmOnly])
  assert.equal(next.events.filter((item) => item.kind === "ras").length, 1)
  assert.equal(next.children[0].events.filter((item) => item.kind === "ras").length, 0)
})

test("applyRasRecoveryTree: keeps ras after matched LLM when ras wall-clock is earlier", () => {
  const llmMarker: RasTraceMarker = {
    ...marker,
    callId: undefined,
    messageId: "xiaoo-msg-loop",
    ts: 2000,
  }
  const tree = root([
    event({
      kind: "skill",
      name: "skill",
      toolCallId: "call_function_1",
      startedAt: 1000,
    }),
    event({
      kind: "llm",
      name: "loop",
      // xiaoo often stamps completion time after mid-stream RAS
      startedAt: 5000,
      interaction: { role: "assistant", content: "loop text", messageID: "xiaoo-msg-loop" },
    }),
  ])
  const next = applyRasRecoveryTree(tree, [llmMarker])
  assert.deepEqual(
    next.events.map((item) => item.kind),
    ["skill", "llm", "ras"],
  )
})

test("alignInteractionsToRasAnchors: stamps missing messageID onto text assistant", () => {
  const aligned = alignInteractionsToRasAnchors(
    [
      { role: "assistant", content: "", tool_calls: [{ id: "c1" }] },
      { role: "assistant", content: "looping text here" },
    ],
    [{ ...marker, messageId: "xiaoo-msg-1", channel: "llm_output", callId: undefined }],
  )
  assert.equal(aligned[0].messageID, undefined)
  assert.equal(aligned[1].messageID, "xiaoo-msg-1")
})

test("alignInteractionsToRasAnchors: prefers assistant at or before marker.ts over later recovery", () => {
  const aligned = alignInteractionsToRasAnchors(
    [
      { role: "assistant", content: "looping", timestamp: "2026-08-17T06:30:35.000Z" },
      { role: "user", content: "notice" },
      { role: "assistant", content: "recovery done", timestamp: "2026-08-17T06:30:43.000Z" },
    ],
    [{
      ...marker,
      messageId: "msg_loop",
      channel: "llm_output",
      callId: undefined,
      ts: Date.parse("2026-08-17T06:30:42.000Z"),
    }],
  )
  assert.equal(aligned[0].messageID, "msg_loop")
  assert.equal(aligned[2].messageID, undefined)
})

test("alignInteractionsToRasAnchors: leaves interactions alone when messageID already matches", () => {
  const aligned = alignInteractionsToRasAnchors(
    [
      { role: "assistant", content: "loop", messageID: "msg_loop" },
      { role: "assistant", content: "recovery", messageID: "msg_recovery" },
    ],
    [{ ...marker, messageId: "msg_loop", channel: "llm_output", callId: undefined }],
  )
  assert.equal(aligned[0].messageID, "msg_loop")
  assert.equal(aligned[1].messageID, "msg_recovery")
})

test("applyRasRecoveryTree: after time-window align, ras sits between loop and recovery", () => {
  const llmMarker: RasTraceMarker = {
    ...marker,
    callId: undefined,
    messageId: "msg_loop",
    channel: "llm_output",
    ts: 2000,
    deliveryMessageIds: [],
    actionResults: [],
  }
  const aligned = alignInteractionsToRasAnchors(
    [
      { role: "assistant", content: "loop body", timestamp: 1500 },
      { role: "assistant", content: "recovery body", timestamp: 3000 },
    ],
    [llmMarker],
  )
  assert.equal(aligned[0].messageID, "msg_loop")
  const tree = root([
    event({
      kind: "llm",
      startedAt: 1500,
      interaction: { role: "assistant", content: "loop body", messageID: aligned[0].messageID },
    }),
    event({
      kind: "llm",
      startedAt: 3000,
      interaction: { role: "assistant", content: "recovery body", messageID: aligned[1].messageID },
    }),
  ])
  const next = applyRasRecoveryTree(tree, [llmMarker])
  assert.deepEqual(
    next.events.map((item) => item.kind),
    ["llm", "ras", "llm"],
  )
})

test("buildRasRecoveryEvent embeds marker id", () => {
  const built = buildRasRecoveryEvent(marker)
  assert.equal(built.kind, "ras")
  assert.equal((built.args as { rasMarkerId: string }).rasMarkerId, "anomaly-1")
})

test("applyRasRecoveryTree: strips notice/steer USER by exact text when delivery ids missing", () => {
  const orphan: RasTraceMarker = {
    ...marker,
    deliveryMessageIds: [],
    actionResults: [
      { action: "emit_notice", ok: true, message: "notice body", ts: 2100 },
      { action: "push_steering", ok: true, message: "steer body", ts: 2200 },
    ],
  }
  const tree = root([
    event({ kind: "user", startedAt: 500, interaction: { role: "user", content: "real user" } }),
    event({ kind: "skill", name: "skill", toolCallId: "call_function_1", startedAt: 1500 }),
    event({
      kind: "user",
      startedAt: 2100,
      interaction: { role: "user", content: "notice body", messageID: "orphan_notice" },
    }),
    event({
      kind: "user",
      startedAt: 2200,
      interaction: { role: "user", content: "steer body" },
    }),
  ])
  const next = applyRasRecoveryTree(tree, [orphan])
  assert.deepEqual(
    next.events.map((item) => item.kind),
    ["user", "skill", "ras"],
  )
  assert.equal(next.events[0].interaction?.content, "real user")
})

test("applyRasRecoveryTree: strips USER by notice text when interaction lacks messageID", () => {
  const withIds: RasTraceMarker = {
    ...marker,
    deliveryMessageIds: ["msg_notice", "msg_steer"],
    actionResults: [
      { action: "emit_notice", ok: true, message: "检测到思考循环异常，已执行恢复操作", ts: 2100, deliveryMessageId: "msg_notice" },
      { action: "push_steering", ok: true, message: "<system-reminder>\nsteer\n</system-reminder>", ts: 2200, deliveryMessageId: "msg_steer" },
    ],
  }
  const tree = root([
    event({ kind: "user", startedAt: 500, interaction: { role: "user", content: "real prompt" } }),
    event({ kind: "skill", name: "skill", toolCallId: "call_function_1", startedAt: 1500 }),
    event({
      kind: "user",
      startedAt: 2100,
      interaction: { role: "user", content: "检测到思考循环异常，已执行恢复操作" },
    }),
    event({
      kind: "user",
      startedAt: 2200,
      interaction: { role: "user", content: "<system-reminder>\nsteer\n</system-reminder>" },
    }),
  ])
  const next = applyRasRecoveryTree(tree, [withIds])
  assert.deepEqual(
    next.events.map((item) => item.kind),
    ["user", "skill", "ras"],
  )
  assert.equal(next.events[0].interaction?.content, "real prompt")
})
