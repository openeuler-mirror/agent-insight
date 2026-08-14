import assert from "node:assert/strict"
import test from "node:test"
import { createRequire } from "node:module"

import { buildAgentCallTree } from "../src/lib/engine/observability/agent-trace"
import { getAdapter } from "../src/lib/ingest/adapters/registry"
import { aggregateOtelTraceEvents } from "../src/lib/ingest/otel/aggregate"
import { getOtelTraceAdapter } from "../src/lib/ingest/otel/adapter-registry"
import { normalizeOtlpTraces } from "../src/lib/ingest/otel/normalize"
import type { OtelTraceEvent } from "../src/lib/ingest/otel/types"

const require = createRequire(import.meta.url)
const { canonicalEventsToOtlp } = require("../scripts/agent-trace-collectors/shared/trace-transport.cjs")

function canonical(overrides: Record<string, unknown>) {
  return {
    framework: "codex",
    sessionId: "codex-session",
    traceId: "a".repeat(32),
    status: "success",
    startTimeMs: 1_700_000_000_000,
    endTimeMs: 1_700_000_000_010,
    ...overrides,
  }
}

function normalize(events: Record<string, unknown>[]) {
  return normalizeOtlpTraces(
    canonicalEventsToOtlp(events, { framework: "codex" }),
    { authenticatedUser: "alice" },
  )
}

test("Codex OTLP adapter matches first-party framework attributes before generic", () => {
  const events = normalize([
    canonical({
      eventId: "agent",
      spanId: "1".repeat(16),
      kind: "agent",
      name: "agent.codex",
      input: "diagnose",
      output: "done",
    }),
  ])
  assert.equal(getOtelTraceAdapter(events).id, "codex")
  assert.equal(getAdapter("codex").descriptor.label, "Codex")
})
test("Codex adapter accepts collector canonical events before OTLP normalization", () => {
  const agent = "c".repeat(16)
  const llm = "d".repeat(16)
  const events = [
    canonical({
      eventId: "raw-agent",
      spanId: agent,
      kind: "agent",
      name: "agent.codex",
      input: "read the current file",
      output: "done",
      endTimeMs: 1_700_000_000_250,
    }),
    canonical({
      eventId: "raw-llm",
      spanId: llm,
      parentSpanId: agent,
      kind: "llm",
      name: "llm.gpt-test",
      output: "done",
      usage: { input: 9, output: 3, reasoning: 2, total: 12 },
    }),
  ] as unknown as OtelTraceEvent[]

  assert.equal(getOtelTraceAdapter(events).id, "codex")
  const record = aggregateOtelTraceEvents("codex-session", events)
  assert.ok(record)
  assert.equal(record.query, "read the current file")
  assert.equal(record.tokens, 12)
  assert.equal(record.input_tokens, 9)
  assert.equal(record.output_tokens, 3)
  assert.equal(record.reasoning_tokens, 2)
  assert.equal(record.latency, 250)
  assert.equal(record.session_merge_strategy, "snapshot-replace")
  assert.equal(record.complete_session_snapshot, true)
})

test("Codex adapter projects the final Hook reply onto the last empty root LLM interaction", () => {
  const agent = "1".repeat(16)
  const firstLlm = "2".repeat(16)
  const tool = "3".repeat(16)
  const finalLlm = "4".repeat(16)
  const finalReply = "FINAL_REPLY_SENTINEL"
  const events = normalize([
    canonical({
      eventId: "final-reply-agent",
      spanId: agent,
      kind: "agent",
      name: "agent.codex",
      input: "inspect then answer",
      output: finalReply,
      startTimeMs: 1_700_000_000_000,
      endTimeMs: 1_700_000_000_500,
    }),
    canonical({
      eventId: "first-llm",
      spanId: firstLlm,
      parentSpanId: agent,
      kind: "llm",
      name: "llm.model-a",
      startTimeMs: 1_700_000_000_010,
      endTimeMs: 1_700_000_000_100,
      usage: { input: 10, output: 2, total: 12 },
    }),
    canonical({
      eventId: "tool",
      spanId: tool,
      parentSpanId: agent,
      kind: "tool",
      name: "tool.exec",
      startTimeMs: 1_700_000_000_110,
      endTimeMs: 1_700_000_000_200,
      tool: { name: "exec", type: "shell", arguments: {}, result: "tool result" },
    }),
    canonical({
      eventId: "final-llm",
      spanId: finalLlm,
      parentSpanId: agent,
      kind: "llm",
      name: "llm.model-a",
      startTimeMs: 1_700_000_000_210,
      endTimeMs: 1_700_000_000_490,
      usage: { input: 20, output: 4, total: 24 },
    }),
  ])

  const record = aggregateOtelTraceEvents("codex-session", events)
  assert.ok(record)
  assert.equal(record.final_result, finalReply)
  assert.equal(record.llm_call_count, 2)
  assert.equal(record.tool_call_count, 1)
  assert.equal(record.interactions.at(-1)?.spanId, finalLlm)
  assert.equal(record.interactions.at(-1)?.content, finalReply)

  const tree = buildAgentCallTree(record.interactions)
  assert.ok(tree)
  assert.equal(tree.events.at(-1)?.kind, "llm")
  assert.equal(tree.events.at(-1)?.summary, finalReply)
})

test("Codex adapter exposes a pure final reply without adding a synthetic LLM count", () => {
  const agent = "5".repeat(16)
  const llm = "6".repeat(16)
  const events = normalize([
    canonical({
      eventId: "pure-agent",
      spanId: agent,
      kind: "agent",
      name: "agent.codex",
      input: "reply only",
      output: "pure reply",
      endTimeMs: 1_700_000_000_300,
    }),
    canonical({
      eventId: "pure-llm",
      spanId: llm,
      parentSpanId: agent,
      kind: "llm",
      name: "llm.model-a",
      startTimeMs: 1_700_000_000_010,
      endTimeMs: 1_700_000_000_290,
      usage: { input: 9, output: 3, total: 12 },
    }),
  ])

  const record = aggregateOtelTraceEvents("codex-session", events)
  assert.ok(record)
  assert.equal(record.llm_call_count, 1)
  assert.equal(record.interactions.length, 2)
  assert.equal(record.interactions[1].content, "pure reply")

  const tree = buildAgentCallTree(record.interactions)
  assert.equal(tree?.stats.llmCalls, 1)
})

test("Codex adapter never assigns the parent final reply to a subagent-only LLM", () => {
  const agent = "7".repeat(16)
  const subagent = "8".repeat(16)
  const subagentLlm = "9".repeat(16)
  const events = normalize([
    canonical({
      eventId: "parent-agent",
      spanId: agent,
      kind: "agent",
      name: "agent.codex",
      input: "delegate then answer",
      output: "parent final reply",
      endTimeMs: 1_700_000_000_500,
    }),
    canonical({
      eventId: "worker",
      spanId: subagent,
      parentSpanId: agent,
      kind: "subagent",
      name: "agent.worker",
      input: "worker task",
      output: "worker result",
      endTimeMs: 1_700_000_000_300,
      attributes: { "codex.agent.name": "worker" },
    }),
    canonical({
      eventId: "worker-llm",
      spanId: subagentLlm,
      parentSpanId: subagent,
      kind: "llm",
      name: "llm.model-a",
      startTimeMs: 1_700_000_000_100,
      endTimeMs: 1_700_000_000_290,
      usage: { input: 7, output: 2, total: 9 },
    }),
  ])

  const record = aggregateOtelTraceEvents("codex-session", events)
  assert.ok(record)
  const childLlm = record.interactions.find((item: { spanId?: string }) => item.spanId === subagentLlm)
  assert.equal(childLlm?.content, "")
  assert.equal(record.interactions.at(-1)?.content, "parent final reply")
  assert.equal(record.interactions.at(-1)?.subagent_session_id, undefined)
  assert.equal(record.llm_call_count, 1)
})

test("Codex adapter never promotes a subagent reply to the root final response", () => {
  const agent = "e".repeat(16)
  const subagent = "f".repeat(16)
  const subagentLlm = "0".repeat(16)
  const events = normalize([
    canonical({
      eventId: "parent-agent-without-output",
      spanId: agent,
      kind: "agent",
      name: "agent.codex",
      input: "delegate only",
      endTimeMs: 1_700_000_000_500,
    }),
    canonical({
      eventId: "worker-with-output",
      spanId: subagent,
      parentSpanId: agent,
      kind: "subagent",
      name: "agent.worker",
      input: "worker task",
      output: "worker result",
      endTimeMs: 1_700_000_000_300,
      attributes: { "codex.agent.name": "worker" },
    }),
    canonical({
      eventId: "worker-llm-with-output",
      spanId: subagentLlm,
      parentSpanId: subagent,
      kind: "llm",
      name: "llm.model-a",
      output: "worker result",
      startTimeMs: 1_700_000_000_100,
      endTimeMs: 1_700_000_000_290,
      usage: { input: 7, output: 2, total: 9 },
    }),
  ])

  const record = aggregateOtelTraceEvents("codex-session", events)
  assert.ok(record)
  assert.equal(record.final_result, "")
  assert.equal(record.interactions.at(-1)?.spanId, subagentLlm)
  assert.equal(record.interactions.at(-1)?.content, "worker result")
  assert.equal(record.interactions.some((item: { name?: string }) => item.name === "llm.final"), false)
})

test("Codex adapter does not duplicate a native subagent reply with a terminal lifecycle reply", () => {
  const agent = "1".repeat(16)
  const subagent = "2".repeat(16)
  const subagentLlm = "3".repeat(16)
  const events = normalize([
    canonical({
      eventId: "native-child-output-root",
      spanId: agent,
      kind: "agent",
      name: "agent.codex",
      input: "delegate one reader",
      endTimeMs: 1_700_000_000_500,
    }),
    canonical({
      eventId: "native-child-output-worker",
      spanId: subagent,
      parentSpanId: agent,
      kind: "subagent",
      name: "agent.reader",
      output: "openEuler",
      endTimeMs: 1_700_000_000_300,
      attributes: { "codex.agent.name": "reader" },
    }),
    canonical({
      eventId: "native-child-output-llm",
      spanId: subagentLlm,
      parentSpanId: subagent,
      kind: "llm",
      name: "llm.model-a",
      output: "openEuler",
      startTimeMs: 1_700_000_000_100,
      endTimeMs: 1_700_000_000_290,
      usage: { input: 7, output: 2, total: 9 },
    }),
    canonical({
      eventId: "native-child-output-tool",
      spanId: "4".repeat(16),
      parentSpanId: subagent,
      kind: "tool",
      name: "tool.Bash",
      tool: { name: "Bash", result: "openEuler" },
    }),
  ])

  const record = aggregateOtelTraceEvents("codex-session", events)
  assert.ok(record)
  assert.equal(record.interactions.filter((item: { name?: string }) => item.name === "llm.subagent.final").length, 0)
  assert.equal(record.interactions.find((item: { spanId?: string }) => item.spanId === subagentLlm)?.content, "openEuler")
  assert.equal(record.llm_call_count, 1)
})

test("Codex adapter orders a subagent outcome after its child activity", () => {
  const agent = "c".repeat(16)
  const subagent = "d".repeat(16)
  const childLlm = "e".repeat(16)
  const events = normalize([
    canonical({
      eventId: "ordered-root",
      spanId: agent,
      kind: "agent",
      name: "agent.codex",
      input: "delegate one read",
      startTimeMs: 1_700_000_000_000,
      endTimeMs: 1_700_000_000_900,
    }),
    canonical({
      eventId: "ordered-child",
      spanId: subagent,
      parentSpanId: agent,
      kind: "subagent",
      name: "agent.read_project",
      output: "openEuler",
      startTimeMs: 1_700_000_000_300,
      endTimeMs: 1_700_000_000_800,
      attributes: { "codex.agent.name": "read_project" },
    }),
    canonical({
      eventId: "ordered-child-llm",
      spanId: childLlm,
      parentSpanId: subagent,
      kind: "llm",
      name: "llm.gpt-test",
      startTimeMs: 1_700_000_000_400,
      endTimeMs: 1_700_000_000_700,
      usage: { input: 8, output: 2, total: 10 },
    }),
    canonical({
      eventId: "ordered-child-tool",
      spanId: "9".repeat(16),
      parentSpanId: subagent,
      kind: "tool",
      name: "tool.Bash",
      startTimeMs: 1_700_000_000_450,
      endTimeMs: 1_700_000_000_650,
      tool: { name: "Bash", result: "openEuler" },
    }),
  ])

  const record = aggregateOtelTraceEvents("codex-session", events)
  assert.ok(record)
  const childInteractions = record.interactions.filter((item: { subagent_session_id?: string }) =>
    item.subagent_session_id === subagent)
  assert.equal(childInteractions.at(-1)?.spanId, `${subagent}:output`)
  assert.equal(childInteractions.at(-1)?.name, "llm.subagent.final")
  assert.equal(childInteractions.at(-1)?.content, "openEuler")
  assert.equal(childInteractions.some((item: { spanId?: string }) => item.spanId === subagent), false)
})

test("Codex adapter emits a terminal subagent reply after overlapping native work", () => {
  const agent = "a".repeat(16)
  const subagent = "b".repeat(16)
  const childLlm = "c".repeat(16)
  const overlappingLlm = "e".repeat(16)
  const childTool = "d".repeat(16)
  const events = normalize([
    canonical({
      eventId: "terminal-order-root",
      spanId: agent,
      kind: "agent",
      name: "agent.codex",
      input: "delegate then write",
      startTimeMs: 1_700_000_000_000,
      endTimeMs: 1_700_000_020_000,
    }),
    canonical({
      eventId: "terminal-order-child",
      spanId: subagent,
      parentSpanId: agent,
      kind: "subagent",
      name: "agent.read_project",
      output: "openEuler",
      startTimeMs: 1_700_000_001_000,
      endTimeMs: 1_700_000_018_000,
      attributes: { "codex.agent.name": "read_project" },
    }),
    canonical({
      eventId: "terminal-order-llm",
      spanId: childLlm,
      parentSpanId: subagent,
      kind: "llm",
      name: "llm.gpt-test",
      startTimeMs: 1_700_000_002_000,
      endTimeMs: 1_700_000_017_000,
      usage: { input: 8, output: 2, total: 10 },
    }),
    canonical({
      eventId: "terminal-order-tool",
      spanId: childTool,
      parentSpanId: subagent,
      kind: "tool",
      name: "tool.Bash",
      startTimeMs: 1_700_000_003_000,
      endTimeMs: 1_700_000_005_000,
      tool: { name: "Bash", result: "openEuler" },
    }),
    canonical({
      eventId: "terminal-order-overlap",
      spanId: overlappingLlm,
      parentSpanId: subagent,
      kind: "llm",
      name: "llm.gpt-test",
      startTimeMs: 1_700_000_004_000,
      endTimeMs: 1_700_000_017_500,
      usage: { input: 9, output: 1, total: 10 },
    }),
  ])

  const record = aggregateOtelTraceEvents("codex-session", events)
  assert.ok(record)
  const childInteractions = record.interactions.filter((item: { subagent_session_id?: string }) =>
    item.subagent_session_id === subagent)
  assert.ok(childInteractions.findIndex((item: { spanId?: string }) => item.spanId === childTool) >= 0)
  assert.ok(childInteractions.findIndex((item: { spanId?: string }) => item.spanId === childTool) < childInteractions.length - 1)
  assert.equal(childInteractions.at(-1)?.spanId, `${subagent}:output`)
  assert.equal(childInteractions.at(-1)?.name, "llm.subagent.final")
  assert.equal(childInteractions.at(-1)?.content, "openEuler")
  assert.equal(childInteractions.at(-1)?.timeInfo?.created,
    new Date(1_700_000_018_000).toISOString())
  assert.equal(childInteractions.filter((item: { name?: string }) => item.name === "llm.subagent.final").length, 1)
  assert.equal(childInteractions.find((item: { spanId?: string }) => item.spanId === childLlm)?.content, "")
  assert.equal(childInteractions.find((item: { spanId?: string }) => item.spanId === overlappingLlm)?.content, "")
  assert.equal(record.llm_call_count, 2)

  const tree = buildAgentCallTree(record.interactions)
  const childNode = tree?.children.find((node) => node.sessionId === subagent)
  assert.ok(childNode)
  assert.equal(childNode?.events.at(-1)?.summary, "openEuler")
  assert.equal(childNode?.events.at(-1)?.usage, undefined)
})

test("Codex adapter keeps a delayed pre-worker LLM on the root", () => {
  const agent = "f".repeat(16)
  const subagent = "a".repeat(16)
  const delayedRootLlm = "b".repeat(16)
  const childLlm = "c".repeat(16)
  const events = normalize([
    canonical({
      eventId: "late-root-agent",
      spanId: agent,
      kind: "agent",
      name: "agent.codex",
      input: "plan then delegate",
      startTimeMs: 1_700_000_000_000,
      endTimeMs: 1_700_000_001_000,
    }),
    canonical({
      eventId: "late-root-child",
      spanId: subagent,
      parentSpanId: agent,
      kind: "subagent",
      name: "agent.read_project",
      output: "openEuler",
      startTimeMs: 1_700_000_000_300,
      endTimeMs: 1_700_000_000_900,
      attributes: { "codex.agent.name": "read_project" },
    }),
    canonical({
      eventId: "late-root-llm",
      spanId: delayedRootLlm,
      parentSpanId: subagent,
      kind: "llm",
      name: "llm.gpt-test",
      startTimeMs: 1_700_000_000_000,
      endTimeMs: 1_700_000_000_450,
      usage: { input: 20, output: 4, total: 24 },
    }),
    canonical({
      eventId: "late-root-child-llm",
      spanId: childLlm,
      parentSpanId: subagent,
      kind: "llm",
      name: "llm.gpt-test",
      startTimeMs: 1_700_000_000_500,
      endTimeMs: 1_700_000_000_800,
      usage: { input: 8, output: 2, total: 10 },
    }),
  ])

  const record = aggregateOtelTraceEvents("codex-session", events)
  assert.ok(record)
  const rootLlm = record.interactions.find((item: { spanId?: string }) => item.spanId === delayedRootLlm)
  const childLlmInteraction = record.interactions.find((item: { spanId?: string }) => item.spanId === childLlm)
  assert.equal(rootLlm?.subagent_session_id, undefined)
  assert.equal(childLlmInteraction?.subagent_session_id, subagent)
})

test("Codex adapter keeps an existing final LLM reply without duplicating it", () => {
  const agent = "a".repeat(16)
  const llm = "b".repeat(16)
  const events = normalize([
    canonical({
      eventId: "existing-agent-reply",
      spanId: agent,
      kind: "agent",
      name: "agent.codex",
      input: "answer once",
      output: "already visible",
      endTimeMs: 1_700_000_000_300,
    }),
    canonical({
      eventId: "existing-llm-reply",
      spanId: llm,
      parentSpanId: agent,
      kind: "llm",
      name: "llm.model-a",
      output: "already visible",
      startTimeMs: 1_700_000_000_010,
      endTimeMs: 1_700_000_000_290,
      usage: { input: 9, output: 3, total: 12 },
    }),
  ])

  const record = aggregateOtelTraceEvents("codex-session", events)
  assert.ok(record)
  assert.equal(record.interactions.length, 2)
  assert.equal(record.interactions[1].spanId, llm)
  assert.equal(record.interactions[1].content, "already visible")
})

test("Codex adapter never promotes a Tool result to the task final reply", () => {
  const agent = "c".repeat(16)
  const tool = "d".repeat(16)
  const events = normalize([
    canonical({
      eventId: "tool-only-agent",
      spanId: agent,
      kind: "agent",
      name: "agent.codex",
      input: "run the tool",
      endTimeMs: 1_700_000_000_300,
    }),
    canonical({
      eventId: "tool-only-result",
      spanId: tool,
      parentSpanId: agent,
      kind: "tool",
      name: "tool.exec",
      startTimeMs: 1_700_000_000_010,
      endTimeMs: 1_700_000_000_290,
      tool: { name: "exec", type: "shell", arguments: {}, result: "tool result only" },
    }),
  ])

  const record = aggregateOtelTraceEvents("codex-session", events)
  assert.ok(record)
  assert.equal(record.final_result, "")
  assert.equal(record.interactions.some((item: { name?: string }) => item.name === "llm.final"), false)
})

test("Codex adapter merges one physical shell call reported with different Hook and OTel ids", () => {
  const agent = "1".repeat(16)
  const hookTool = "2".repeat(16)
  const otelTool = "3".repeat(16)
  const events = normalize([
    canonical({
      eventId: "dual-shell-agent",
      spanId: agent,
      kind: "agent",
      name: "agent.codex",
      input: "read one file",
      output: "done",
      startTimeMs: 1_700_000_000_000,
      endTimeMs: 1_700_000_005_000,
    }),
    canonical({
      eventId: "dual-shell-hook",
      spanId: hookTool,
      parentSpanId: agent,
      kind: "tool",
      name: "tool.shell_command",
      startTimeMs: 1_700_000_001_000,
      endTimeMs: 1_700_000_004_000,
      tool: {
        name: "shell_command",
        type: "shell",
        arguments: { command: "Get-Content demo-input.json" },
        result: "Exit code: 0\nOutput:\nopenEuler",
      },
      attributes: {
        "codex.call.id": "exec-hook-id",
        "codex.tool.source": "hook",
      },
    }),
    canonical({
      eventId: "dual-shell-otel",
      spanId: otelTool,
      parentSpanId: agent,
      kind: "tool",
      name: "tool.exec",
      startTimeMs: 1_700_000_000_900,
      endTimeMs: 1_700_000_004_800,
      tool: {
        name: "exec",
        type: "custom",
        result: "Script completed\nExit code: 0\nOutput:\nopenEuler",
      },
      attributes: {
        "codex.call.id": "call-otel-id",
        "codex.tool.source": "otel",
      },
    }),
  ])

  const record = aggregateOtelTraceEvents("codex-session", events)
  assert.ok(record)
  assert.equal(record.tool_call_count, 1)
  const tools = record.interactions.filter((item: { tool_calls?: unknown[] }) => item.tool_calls?.length)
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, "tool.shell_command")
  assert.equal(tools[0].tool_calls[0].function.arguments.includes("Get-Content"), true)
})

test("Codex adapter merges a child shell's direct-id alias before its native exec wrapper", () => {
  const agent = "8".repeat(16)
  const subagent = "9".repeat(16)
  const hookTool = "a".repeat(16)
  const directOtelTool = "b".repeat(16)
  const wrapperOtelTool = "c".repeat(16)
  const events = normalize([
    canonical({
      eventId: "child-shell-agent",
      spanId: agent,
      kind: "agent",
      name: "agent.codex",
      input: "delegate one read",
      output: "openEuler",
      startTimeMs: 1_700_000_000_000,
      endTimeMs: 1_700_000_006_000,
    }),
    canonical({
      eventId: "child-shell-worker",
      spanId: subagent,
      parentSpanId: agent,
      kind: "subagent",
      name: "agent.worker",
      input: "read project",
      output: "openEuler",
      startTimeMs: 1_700_000_000_500,
      endTimeMs: 1_700_000_005_500,
      attributes: { "codex.agent.name": "worker" },
    }),
    canonical({
      eventId: "child-shell-hook",
      spanId: hookTool,
      parentSpanId: subagent,
      kind: "tool",
      name: "tool.Bash",
      startTimeMs: 1_700_000_001_000,
      endTimeMs: 1_700_000_004_000,
      tool: {
        name: "Bash",
        arguments: { command: "Get-Content demo-input.json" },
        result: "Exit code: 0\nOutput:\nopenEuler",
      },
      attributes: {
        "codex.call.id": "exec-shared-id",
        "codex.tool.source": "hook",
      },
    }),
    canonical({
      eventId: "child-shell-direct-otel",
      spanId: directOtelTool,
      parentSpanId: subagent,
      kind: "tool",
      name: "tool.shell_command",
      startTimeMs: 1_700_000_001_050,
      endTimeMs: 1_700_000_004_100,
      tool: { name: "shell_command", result: "Exit code: 0\nOutput:\nopenEuler" },
      attributes: {
        "codex.call.id": "exec-shared-id",
        "codex.tool.source": "otel",
      },
    }),
    canonical({
      eventId: "child-shell-wrapper-otel",
      spanId: wrapperOtelTool,
      parentSpanId: subagent,
      kind: "tool",
      name: "tool.exec",
      startTimeMs: 1_700_000_000_900,
      endTimeMs: 1_700_000_004_800,
      tool: {
        name: "exec",
        result: "Script completed\nExit code: 0\nOutput:\nopenEuler",
      },
      attributes: {
        "codex.call.id": "call-wrapper-id",
        "codex.tool.source": "otel",
      },
    }),
  ])

  const record = aggregateOtelTraceEvents("codex-session", events)
  assert.ok(record)
  assert.equal(record.tool_call_count, 1)
  const childTools = record.interactions.filter((item: { subagent_name?: string; tool_calls?: unknown[] }) =>
    item.subagent_name === "worker" && item.tool_calls?.length)
  assert.equal(childTools.length, 1)
  assert.equal(childTools[0].name, "tool.Bash")
})

test("Codex adapter keeps ambiguous parallel Hook and OTel shell candidates separate", () => {
  const agent = "4".repeat(16)
  const events = normalize([
    canonical({
      eventId: "ambiguous-shell-agent",
      spanId: agent,
      kind: "agent",
      name: "agent.codex",
      input: "run two parallel commands",
      startTimeMs: 1_700_000_000_000,
      endTimeMs: 1_700_000_005_000,
    }),
    ...["5", "6"].map((digit, index) => canonical({
      eventId: `ambiguous-hook-${index}`,
      spanId: digit.repeat(16),
      parentSpanId: agent,
      kind: "tool" as const,
      name: "tool.shell_command",
      startTimeMs: 1_700_000_001_000 + index * 50,
      endTimeMs: 1_700_000_004_000 + index * 50,
      tool: { name: "shell_command", result: "same output" },
      attributes: {
        "codex.call.id": `exec-hook-${index}`,
        "codex.tool.source": "hook",
      },
    })),
    canonical({
      eventId: "ambiguous-otel",
      spanId: "7".repeat(16),
      parentSpanId: agent,
      kind: "tool",
      name: "tool.exec",
      startTimeMs: 1_700_000_000_900,
      endTimeMs: 1_700_000_004_800,
      tool: { name: "exec", result: "same output" },
      attributes: {
        "codex.call.id": "call-otel-ambiguous",
        "codex.tool.source": "otel",
      },
    }),
  ])

  const record = aggregateOtelTraceEvents("codex-session", events)
  assert.ok(record)
  assert.equal(record.tool_call_count, 3)
})

test("Codex adapter latency covers the whole turn rather than only the root lifecycle", () => {
  const root = "a".repeat(16)
  const tool = "b".repeat(16)
  const record = aggregateOtelTraceEvents("latency-session", normalize([
    canonical({
      sessionId: "latency-session",
      eventId: "root",
      spanId: root,
      kind: "agent",
      name: "agent.codex",
      input: "read fixture",
      startTimeMs: 1_700_000_000_000,
      endTimeMs: 1_700_000_002_943,
    }),
    canonical({
      sessionId: "latency-session",
      eventId: "tool",
      spanId: tool,
      parentSpanId: root,
      kind: "tool",
      name: "tool.exec",
      startTimeMs: 1_700_000_011_000,
      endTimeMs: 1_700_000_218_000,
      tool: { name: "exec", type: "shell", arguments: {}, result: "ok" },
    }),
  ]))
  assert.equal(record?.latency, 218_000)
})

test("Codex adapter supplies the trace start together with trace completion", () => {
  const startedAt = 1_700_000_000_000
  const endedAt = 1_700_000_005_000
  const record = aggregateOtelTraceEvents("session-time-order", normalize([
    canonical({
      sessionId: "session-time-order",
      eventId: "root",
      spanId: "e".repeat(16),
      kind: "agent",
      name: "agent.codex",
      input: "inspect times",
      startTimeMs: startedAt,
      endTimeMs: endedAt,
    }),
  ]))
  assert.equal(record?.trace_started_at?.toISOString(), new Date(startedAt).toISOString())
  assert.equal(record?.trace_completed_at?.toISOString(), new Date(endedAt).toISOString())
})

test("Codex adapter aggregates Agent, Skill, LLM, Tool, MCP, and exact leaf usage", () => {
  const agent = "1".repeat(16)
  const skill = "2".repeat(16)
  const llm = "3".repeat(16)
  const tool = "4".repeat(16)
  const mcp = "5".repeat(16)
  const events = normalize([
    canonical({
      eventId: "agent",
      spanId: agent,
      kind: "agent",
      name: "agent.codex",
      input: "diagnose the repository",
      output: "root result",
      endTimeMs: 1_700_000_000_500,
    }),
    canonical({
      eventId: "skill",
      spanId: skill,
      parentSpanId: agent,
      kind: "skill",
      name: "skill.fixture",
      output: "Skill: fixture\n# Fixture output",
      skill: { name: "fixture", version: "3", triggerMode: "explicit" },
    }),
    canonical({
      eventId: "llm",
      spanId: llm,
      parentSpanId: skill,
      kind: "llm",
      name: "llm.model-a",
      input: "diagnose the repository",
      output: "I will inspect it",
      model: "model-a",
      provider: "provider-a",
      usage: { input: 10, output: 6, reasoning: 2, total: 16 },
    }),
    canonical({
      eventId: "tool",
      spanId: tool,
      parentSpanId: skill,
      kind: "tool",
      name: "tool.bash",
      tool: { name: "bash", type: "shell", arguments: { command: "pwd" }, result: "ok" },
    }),
    canonical({
      eventId: "mcp",
      spanId: mcp,
      parentSpanId: skill,
      kind: "mcp",
      name: "tool.mcp__fixture__lookup",
      status: "error",
      tool: {
        name: "mcp__fixture__lookup",
        type: "mcp",
        arguments: { query: "x" },
        result: "failed",
      },
      mcp: { serverName: "fixture", toolName: "lookup" },
    }),
  ])

  const record = aggregateOtelTraceEvents("codex-session", events)
  assert.ok(record)
  assert.equal(record.framework, "codex")
  assert.equal(record.query, "diagnose the repository")
  assert.equal(record.final_result, "root result")
  assert.equal(record.model, "model-a")
  assert.equal(record.tokens, 16)
  assert.equal(record.input_tokens, 10)
  assert.equal(record.output_tokens, 6)
  assert.equal(record.reasoning_tokens, 2)
  assert.equal(record.cache_read_input_tokens, undefined)
  assert.equal(record.max_single_call_tokens, 16)
  assert.equal(record.llm_call_count, 1)
  assert.equal(record.tool_call_count, 2)
  assert.equal(record.tool_call_error_count, 1)
  assert.deepEqual(record.invokedSkills, [{ name: "fixture", version: 3 }])
  const skillInteraction = record.interactions.find((item: { tool_calls?: Array<{ function?: { name?: string } }> }) =>
    item.tool_calls?.[0]?.function?.name === "skill")
  assert.match(String(skillInteraction?.tool_calls?.[0]?.output || ""), /# Fixture output/)
  assert.equal(record.user, "alice")
  assert.equal(record.interactions.some((item: { mcp?: { server_name?: string } }) => item.mcp?.server_name === "fixture"), true)
})

test("Codex adapter preserves three-level SubAgent ancestry and five parallel siblings", () => {
  const rootAgent = "1".repeat(16)
  const rootTool = "2".repeat(16)
  const levelOne = "3".repeat(16)
  const nestedTool = "4".repeat(16)
  const levelTwo = "5".repeat(16)
  const nestedToolTwo = "6".repeat(16)
  const levelThree = "7".repeat(16)
  const parallelTool = "8".repeat(16)
  const parallel = Array.from({ length: 5 }, (_, index) => (index + 9).toString(16).repeat(16))
  const events = [
    canonical({
      eventId: "root",
      spanId: rootAgent,
      kind: "agent",
      name: "agent.codex",
      input: "delegate",
      output: "done",
    }),
    canonical({
      eventId: "root-tool",
      spanId: rootTool,
      parentSpanId: rootAgent,
      kind: "tool",
      name: "tool.subagent",
      tool: { name: "subagent", type: "subagent", arguments: {}, result: "done" },
    }),
    canonical({
      eventId: "level-one",
      spanId: levelOne,
      parentSpanId: rootTool,
      kind: "subagent",
      name: "agent.level-one",
      input: "one",
      output: "one done",
      attributes: { "codex.agent.name": "level-one", "codex.agent.id": "level-one" },
    }),
    canonical({
      eventId: "nested-tool",
      spanId: nestedTool,
      parentSpanId: levelOne,
      kind: "tool",
      name: "tool.subagent",
      tool: { name: "subagent", type: "subagent", arguments: {}, result: "done" },
    }),
    canonical({
      eventId: "level-two",
      spanId: levelTwo,
      parentSpanId: nestedTool,
      kind: "subagent",
      name: "agent.level-two",
      input: "two",
      output: "two done",
      attributes: { "codex.agent.name": "level-two", "codex.agent.id": "level-two" },
    }),
    canonical({
      eventId: "nested-tool-two",
      spanId: nestedToolTwo,
      parentSpanId: levelTwo,
      kind: "tool",
      name: "tool.subagent",
      tool: { name: "subagent", type: "subagent", arguments: {}, result: "done" },
    }),
    canonical({
      eventId: "level-three",
      spanId: levelThree,
      parentSpanId: nestedToolTwo,
      kind: "subagent",
      name: "agent.level-three",
      input: "three",
      output: "three done",
      attributes: { "codex.agent.name": "level-three", "codex.agent.id": "level-three" },
    }),
    canonical({
      eventId: "parallel-tool",
      spanId: parallelTool,
      parentSpanId: rootAgent,
      kind: "tool",
      name: "tool.subagent",
      tool: { name: "subagent", type: "subagent", arguments: {}, result: "done" },
    }),
    ...parallel.map((spanId, index) => canonical({
      eventId: `parallel-${index}`,
      spanId,
      parentSpanId: parallelTool,
      kind: "subagent",
      name: `agent.worker-${index}`,
      input: `task-${index}`,
      output: `result-${index}`,
      attributes: { "codex.agent.name": `worker-${index}`, "codex.agent.id": `worker-${index}` },
    })),
  ]

  const record = aggregateOtelTraceEvents("codex-session", normalize(events))
  assert.ok(record)
  assert.deepEqual(record.agents, ["codex", "level-one", "level-two", "level-three", "worker-0", "worker-1", "worker-2", "worker-3", "worker-4"])
  const tree = buildAgentCallTree(record.interactions)
  assert.ok(tree)
  const levelOneNode = tree.children.find((node) => node.sessionId === levelOne)
  assert.equal(levelOneNode?.agentName, "level-one")
  assert.equal(levelOneNode?.subagentType, "level-one")
  assert.equal(levelOneNode?.children[0]?.sessionId, levelTwo)
  assert.equal(levelOneNode?.children[0]?.agentName, "level-two")
  assert.equal(levelOneNode?.children[0]?.children[0]?.sessionId, levelThree)
  const workers = tree.children.filter((node) => parallel.includes(node.sessionId))
  assert.equal(workers.length, 5)
  assert.equal(workers.every((node, index) => node.agentName === `worker-${index}`), true)
  assert.equal(new Set(workers.map((node) => node.sessionId)).size, 5)
})

test("Codex adapter uses spawn_agent task_name for a runtime-default child", () => {
  const root = "1".repeat(16)
  const spawn = "2".repeat(16)
  const child = "3".repeat(16)
  const events = normalize([
    canonical({
      eventId: "named-root",
      spanId: root,
      kind: "agent",
      name: "agent.codex",
      input: "delegate a named worker",
    }),
    canonical({
      eventId: "named-spawn",
      spanId: spawn,
      parentSpanId: root,
      kind: "tool",
      name: "tool.collaborationspawn_agent",
      tool: {
        name: "collaborationspawn_agent",
        type: "custom",
        arguments: { task_name: "named_worker_alpha", message: "return ALPHA_OK" },
        result: JSON.stringify({ task_name: "/root/named_worker_alpha" }),
      },
      attributes: { "codex.conversation.id": "conversation-named" },
    }),
    canonical({
      eventId: "runtime-default-child",
      spanId: child,
      parentSpanId: root,
      kind: "subagent",
      name: "agent.default",
      input: "return ALPHA_OK",
      output: "ALPHA_OK",
      attributes: {
        "codex.conversation.id": "conversation-named",
        "codex.agent.name": "default",
        "codex.agent.id": "child-runtime-id",
      },
    }),
  ])

  const record = aggregateOtelTraceEvents("codex-session", events)
  assert.ok(record)
  const tree = buildAgentCallTree(record.interactions)
  assert.ok(tree)
  const childNode = tree.children.find((node) => node.sessionId === child)
  assert.equal(childNode?.agentName, "named_worker_alpha")
  assert.equal(childNode?.subagentType, "named_worker_alpha")
})

test("Codex adapter preserves a non-default runtime child name", () => {
  const root = "4".repeat(16)
  const spawn = "5".repeat(16)
  const child = "6".repeat(16)
  const events = normalize([
    canonical({
      eventId: "runtime-named-root",
      spanId: root,
      kind: "agent",
      name: "agent.codex",
      input: "delegate a reviewer",
    }),
    canonical({
      eventId: "runtime-named-spawn",
      spanId: spawn,
      parentSpanId: root,
      kind: "tool",
      name: "tool.collaborationspawn_agent",
      tool: {
        name: "collaborationspawn_agent",
        type: "custom",
        arguments: { task_name: "display_task_name", message: "review" },
      },
      attributes: { "codex.conversation.id": "conversation-runtime" },
    }),
    canonical({
      eventId: "runtime-named-child",
      spanId: child,
      parentSpanId: root,
      kind: "subagent",
      name: "agent.code_reviewer",
      input: "review",
      output: "reviewed",
      attributes: {
        "codex.conversation.id": "conversation-runtime",
        "codex.agent.name": "code_reviewer",
        "codex.agent.id": "runtime-child-id",
      },
    }),
  ])

  const record = aggregateOtelTraceEvents("codex-session", events)
  assert.ok(record)
  const tree = buildAgentCallTree(record.interactions)
  assert.ok(tree)
  const childNode = tree.children.find((node) => node.sessionId === child)
  assert.equal(childNode?.agentName, "code_reviewer")
  assert.equal(childNode?.subagentType, "code_reviewer")
})

test("Codex adapter keeps Memory Agent under its user root and includes child tokens", () => {
  const root = "a".repeat(16)
  const memory = "b".repeat(16)
  // Lexically before its parent on purpose: parent-before-child ordering must
  // still attach its usage to Memory Agent despite equal timestamps.
  const memoryLlm = "0".repeat(16)
  const executionId = "conversation-a:turn:user-turn"
  const events = normalize([
    canonical({
      sessionId: executionId,
      eventId: "root",
      spanId: root,
      kind: "agent",
      name: "agent.codex",
      input: "implement the feature",
      output: "complete",
      endTimeMs: 1_700_000_000_300,
      attributes: {
        "codex.execution.id": executionId,
        "codex.conversation.id": "conversation-a",
        "codex.turn.id": "user-turn",
      },
    }),
    canonical({
      sessionId: executionId,
      eventId: "memory-agent",
      spanId: memory,
      parentSpanId: root,
      kind: "subagent",
      name: "agent.Memory Agent",
      input: "## Memory Writing Agent: Phase 2 (Consolidation)",
      output: "memory stored",
      endTimeMs: 1_700_000_000_250,
      attributes: {
        "codex.agent.name": "Memory Agent",
        "codex.subagent.implicit": "true",
        "codex.conversation.id": "memory-otel-session",
      },
    }),
    canonical({
      sessionId: executionId,
      eventId: "memory-llm",
      spanId: memoryLlm,
      parentSpanId: memory,
      kind: "llm",
      name: "llm.gpt-test",
      model: "gpt-test",
      usage: { input: 20, output: 7, total: 27 },
    }),
  ])

  const record = aggregateOtelTraceEvents(executionId, events)
  assert.ok(record)
  assert.equal(record.task_id, executionId)
  assert.equal(record.tokens, 27)
  assert.deepEqual(record.agents, ["codex", "Memory Agent"])
  const tree = buildAgentCallTree(record.interactions)
  assert.ok(tree)
  assert.equal(tree.children[0]?.agentName, "Memory Agent")
  assert.equal(tree.children[0]?.subagentType, "memory agent")
  assert.equal(tree.children[0]?.sessionId, memory)
  assert.equal(tree.stats.totalTokens, 0)
  assert.equal(tree.children[0]?.stats.totalTokens, 27)
})

test("Codex adapter keeps separate user execution ids out of each other's root record", () => {
  const first = "conversation-a:turn:first"
  const second = "conversation-a:turn:second"
  const events = normalize([
    canonical({
      sessionId: first,
      eventId: "first-root",
      spanId: "d".repeat(16),
      kind: "agent",
      name: "agent.codex",
      input: "first prompt",
    }),
    canonical({
      sessionId: first,
      eventId: "first-llm",
      spanId: "e".repeat(16),
      parentSpanId: "d".repeat(16),
      kind: "llm",
      name: "llm.gpt-test",
      usage: { input: 10, output: 2, total: 12 },
    }),
    canonical({
      sessionId: second,
      eventId: "second-root",
      spanId: "f".repeat(16),
      kind: "agent",
      name: "agent.codex",
      input: "second prompt",
    }),
    canonical({
      sessionId: second,
      eventId: "second-llm",
      spanId: "1".repeat(16),
      parentSpanId: "f".repeat(16),
      kind: "llm",
      name: "llm.gpt-test",
      usage: { input: 30, output: 4, total: 34 },
    }),
  ])

  const firstRecord = aggregateOtelTraceEvents(first, events)
  const secondRecord = aggregateOtelTraceEvents(second, events)
  assert.equal(firstRecord?.query, "first prompt")
  assert.equal(firstRecord?.tokens, 12)
  assert.equal(secondRecord?.query, "second prompt")
  assert.equal(secondRecord?.tokens, 34)
})

test("Codex adapter suppresses an unresolved automatic unit instead of listing it as a root", () => {
  const pending = "pending:memory-session:turn:memory-turn"
  const events = normalize([
    canonical({
      sessionId: pending,
      eventId: "pending-memory",
      spanId: "2".repeat(16),
      kind: "agent",
      name: "agent.Memory Agent",
      input: "## Memory Writing Agent: Phase 2 (Consolidation)",
      attributes: { "codex.association.pending": "true" },
    }),
  ])
  assert.equal(aggregateOtelTraceEvents(pending, events), null)
})

test("Codex adapter skips an empty lifecycle and names real untitled work without Codex Session", () => {
  const root = "1".repeat(16)
  const empty = aggregateOtelTraceEvents("empty-session", normalize([
    canonical({
      sessionId: "empty-session",
      eventId: "session-start",
      spanId: root,
      kind: "agent",
      name: "agent.codex",
      startTimeMs: 1_700_000_000_000,
      endTimeMs: 1_700_000_002_943,
    }),
  ]))
  assert.equal(empty, null)

  const redactedLifecycle = aggregateOtelTraceEvents("redacted-session", normalize([
    canonical({
      sessionId: "redacted-session",
      eventId: "session-start-redacted",
      spanId: "3".repeat(16),
      kind: "agent",
      name: "agent.codex",
      input: "[REDACTED]",
      startTimeMs: 1_700_000_000_000,
      endTimeMs: 1_700_000_002_943,
    }),
  ]))
  assert.equal(redactedLifecycle, null)

  const untitled = aggregateOtelTraceEvents("tool-session", normalize([
    canonical({
      sessionId: "tool-session",
      eventId: "session-start",
      spanId: root,
      kind: "agent",
      name: "agent.codex",
      endTimeMs: 1_700_000_000_000,
    }),
    canonical({
      sessionId: "tool-session",
      eventId: "tool",
      spanId: "2".repeat(16),
      parentSpanId: root,
      kind: "tool",
      name: "tool.shell",
      tool: { name: "shell", type: "shell", arguments: {}, result: "ok" },
    }),
  ]))
  assert.ok(untitled)
  assert.equal(untitled.query, "Codex tool: shell")
})

test("Codex adapter output is deterministic for the same canonical structure", () => {
  const source = [
    canonical({
      eventId: "agent",
      spanId: "1".repeat(16),
      kind: "agent",
      name: "agent.codex",
      input: "same",
      output: "same result",
    }),
    canonical({
      eventId: "llm",
      spanId: "2".repeat(16),
      parentSpanId: "1".repeat(16),
      kind: "llm",
      name: "llm.model",
      output: "same result",
      usage: { input: 1, output: 2, total: 3 },
    }),
  ]
  const first = aggregateOtelTraceEvents("codex-session", normalize(source))
  const second = aggregateOtelTraceEvents("codex-session", normalize(source))
  assert.deepEqual(first, second)
})

test("Codex aggregation keeps the latest snapshot for a stable span id", () => {
  const spanId = "f".repeat(16)
  const events = normalize([
    canonical({
      eventId: "root",
      spanId,
      kind: "agent",
      name: "agent.codex",
      input: "query",
      endTimeMs: 1_700_000_000_010,
    }),
    canonical({
      eventId: "root",
      spanId,
      kind: "agent",
      name: "agent.codex",
      input: "query",
      output: "final",
      endTimeMs: 1_700_000_000_500,
    }),
  ])
  const record = aggregateOtelTraceEvents("codex-session", events)
  assert.equal(record?.final_result, "final")
})

test("Codex adapter projects native cache token usage", () => {
  const events = normalize([
    canonical({
      eventId: "agent",
      spanId: "1".repeat(16),
      kind: "agent",
      name: "agent.codex",
      input: "inspect",
    }),
    canonical({
      eventId: "llm",
      spanId: "2".repeat(16),
      parentSpanId: "1".repeat(16),
      kind: "llm",
      name: "llm.model",
      usage: { input: 12, output: 3, total: 15 },
      attributes: { "codex.usage.cache_read": 5 },
    }),
  ])
  const record = aggregateOtelTraceEvents("codex-session", events)
  assert.equal(record?.cache_read_input_tokens, 5)
  assert.equal(record?.max_single_call_tokens, 15)
})

test("Codex tree keeps usage for textless LLM turns", () => {
  const record = aggregateOtelTraceEvents("textless-llm", normalize([
    canonical({ sessionId: "textless-llm", eventId: "agent", spanId: "1".repeat(16), kind: "agent", name: "agent.codex", input: "inspect", output: "done" }),
    canonical({
      sessionId: "textless-llm", eventId: "llm", spanId: "2".repeat(16), parentSpanId: "1".repeat(16), kind: "llm", name: "llm.model",
      usage: { input: 120, output: 4, reasoning: 2, total: 126 },
    }),
  ]))
  assert.ok(record, "textless fixture did not aggregate")
  const tree = buildAgentCallTree(record.interactions)
  const llm = tree?.events.find((event) => event.kind === "llm")
  assert.equal(llm?.usage?.total, 126)
  assert.equal(tree?.stats.totalTokens, 126)
})
