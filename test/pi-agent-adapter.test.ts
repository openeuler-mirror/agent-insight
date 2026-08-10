import assert from "node:assert/strict"
import test from "node:test"
import { createRequire } from "node:module"

import { buildAgentCallTree } from "../src/lib/engine/observability/agent-trace"
import { getAdapter } from "../src/lib/ingest/adapters/registry"
import { aggregateOtelTraceEvents } from "../src/lib/ingest/otel/aggregate"
import { getOtelTraceAdapter } from "../src/lib/ingest/otel/adapter-registry"
import { normalizeOtlpTraces } from "../src/lib/ingest/otel/normalize"
import { computeOwnSkills } from "../src/lib/storage/data-service"

const require = createRequire(import.meta.url)
const { canonicalEventsToOtlp } = require("../scripts/agent-trace-collectors/shared/trace-transport.cjs")

function canonical(overrides: Record<string, unknown>) {
  return {
    framework: "pi-agent",
    sessionId: "pi-session",
    traceId: "a".repeat(32),
    status: "success",
    startTimeMs: 1_700_000_000_000,
    endTimeMs: 1_700_000_000_010,
    ...overrides,
  }
}

function normalize(events: Record<string, unknown>[]) {
  return normalizeOtlpTraces(
    canonicalEventsToOtlp(events, { framework: "pi-agent" }),
    { authenticatedUser: "alice" },
  )
}

test("Pi OTLP adapter matches first-party framework attributes before generic", () => {
  const events = normalize([
    canonical({
      eventId: "agent",
      spanId: "1".repeat(16),
      kind: "agent",
      name: "agent.pi",
      input: "diagnose",
      output: "done",
    }),
  ])
  assert.equal(getOtelTraceAdapter(events).id, "pi-agent")
  assert.equal(getAdapter("pi-agent").descriptor.label, "Pi Agent")
})

test("Pi adapter aggregates Agent, Skill, LLM, Tool, MCP, and exact leaf usage", () => {
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
      name: "agent.pi",
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
      skill: { name: "fixture", version: "1.0.0", triggerMode: "explicit" },
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
      attributes: {
        "pi.usage.cache_read": 3,
        "pi.usage.cache_write": 1,
      },
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

  const record = aggregateOtelTraceEvents("pi-session", events)
  assert.ok(record)
  assert.equal(record.framework, "pi-agent")
  assert.equal(record.session_merge_strategy, "snapshot-replace")
  assert.equal(record.complete_session_snapshot, true)
  assert.equal(record.query, "diagnose the repository")
  assert.equal(record.final_result, "root result")
  assert.equal(record.model, "model-a")
  assert.equal(record.tokens, 16)
  assert.equal(record.input_tokens, 10)
  assert.equal(record.output_tokens, 6)
  assert.equal(record.reasoning_tokens, 2)
  assert.equal(record.cache_read_input_tokens, 3)
  assert.equal(record.cache_creation_input_tokens, 1)
  assert.equal(record.max_single_call_tokens, 16)
  assert.equal(record.llm_call_count, 1)
  assert.equal(record.tool_call_count, 2)
  assert.equal(record.tool_call_error_count, 1)
  assert.deepEqual(record.invokedSkills, [{ name: "fixture", version: 1 }])
  assert.deepEqual(computeOwnSkills("pi-agent", record.interactions), [{
    name: "fixture",
    version: 1,
  }])
  assert.equal(record.user, "alice")
  assert.equal(record.interactions.some((item: { mcp?: { server_name?: string } }) => item.mcp?.server_name === "fixture"), true)
})

test("Pi adapter registry uses complete snapshot replacement", () => {
  const adapter = getAdapter("pi-agent")
  assert.equal(adapter.sessionMergeStrategy, "snapshot-replace")
})

test("Pi adapter keeps a subagent summary only as a fallback when leaf LLM output exists", () => {
  type Interaction = { spanId?: string; content?: string; usage?: { total?: number } }
  const root = "1".repeat(16)
  const spawn = "2".repeat(16)
  const worker = "3".repeat(16)
  const workerLlm = "4".repeat(16)
  const events = normalize([
    canonical({
      eventId: "root",
      spanId: root,
      kind: "agent",
      name: "agent.pi",
      input: "delegate",
      output: "done",
    }),
    canonical({
      eventId: "spawn",
      spanId: spawn,
      parentSpanId: root,
      kind: "tool",
      name: "tool.subagent",
      tool: { name: "subagent", type: "subagent", arguments: {}, result: "done" },
    }),
    canonical({
      eventId: "worker-summary",
      spanId: worker,
      parentSpanId: spawn,
      kind: "subagent",
      name: "agent.worker",
      input: "read project",
      output: "openEuler",
      usage: { input: 2, output: 1, total: 3 },
      attributes: { "pi.subagent.name": "worker", "pi.subagent.exit_code": 0 },
    }),
    canonical({
      eventId: "worker-final",
      spanId: workerLlm,
      parentSpanId: worker,
      kind: "llm",
      name: "llm.model-a",
      output: "openEuler",
      usage: { input: 4, output: 2, total: 106 },
      attributes: { "pi.usage.cache_read": 100, "pi.usage.cache_write": 0 },
    }),
  ])

  const record = aggregateOtelTraceEvents("pi-session", events)
  assert.ok(record)
  assert.equal(record.tokens, 106)
  assert.equal(record.cache_read_input_tokens, 100)
  const interactions = record.interactions as Interaction[]
  const summary = interactions.find((item) => item.spanId === worker)
  assert.ok(summary)
  assert.equal(summary.content, "")
  assert.equal(summary.usage, undefined)
  const tree = buildAgentCallTree(record.interactions)
  const workerNode = tree?.children.find((node) => node.subagentType === "worker")
  assert.ok(workerNode)
  assert.equal(workerNode?.stats.totalTokens, 106)
  assert.equal(workerNode?.events.filter((event) => event.kind === "llm").length, 1)

  const fallback = aggregateOtelTraceEvents("pi-session", normalize(events.filter((event) => event.spanId !== workerLlm)))
  const fallbackSummary = (fallback?.interactions as Interaction[] | undefined)?.find((item) => item.spanId === worker)
  assert.equal(fallbackSummary?.content, "openEuler")
})

test("Pi adapter preserves three-level SubAgent ancestry and five parallel siblings", () => {
  const rootAgent = "1".repeat(16)
  const rootTool = "2".repeat(16)
  const levelOne = "3".repeat(16)
  const nestedTool = "4".repeat(16)
  const levelTwo = "5".repeat(16)
  const nestedToolTwo = "6".repeat(16)
  const levelThree = "7".repeat(16)
  const parallelTool = "8".repeat(16)
  const rootSkill = "e".repeat(16)
  const childSkill = "f".repeat(16)
  const parallel = Array.from({ length: 5 }, (_, index) => (index + 9).toString(16).repeat(16))
  const events = [
    canonical({
      eventId: "root",
      spanId: rootAgent,
      kind: "agent",
      name: "agent.pi",
      input: "delegate",
      output: "done",
    }),
    canonical({
      eventId: "root-skill",
      spanId: rootSkill,
      parentSpanId: rootAgent,
      kind: "skill",
      name: "skill.root",
      skill: { name: "root-skill", version: "1" },
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
      attributes: { "pi.subagent.name": "level-one", "pi.subagent.exit_code": 0 },
    }),
    canonical({
      eventId: "child-skill",
      spanId: childSkill,
      parentSpanId: levelOne,
      kind: "skill",
      name: "skill.child",
      skill: { name: "child-skill", version: "2" },
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
      attributes: { "pi.subagent.name": "level-two", "pi.subagent.exit_code": 0 },
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
      attributes: { "pi.subagent.name": "level-three", "pi.subagent.exit_code": 0 },
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
      attributes: { "pi.subagent.name": `worker-${index}`, "pi.subagent.exit_code": 0 },
    })),
  ]

  const record = aggregateOtelTraceEvents("pi-session", normalize(events))
  assert.ok(record)
  assert.deepEqual(record.agents, ["pi-agent", "level-one", "level-two", "level-three", "worker-0", "worker-1", "worker-2", "worker-3", "worker-4"])
  const tree = buildAgentCallTree(record.interactions)
  assert.ok(tree)
  const levelOneNode = tree.children.find((node) => node.subagentType === "level-one")
  assert.equal(levelOneNode?.agentName, "level-one")
  assert.equal(levelOneNode?.children[0]?.agentName, "level-two")
  assert.equal(levelOneNode?.children[0]?.subagentType, "level-two")
  assert.equal(levelOneNode?.children[0]?.children[0]?.agentName, "level-three")
  assert.equal(levelOneNode?.children[0]?.children[0]?.subagentType, "level-three")
  const workers = tree.children.filter((node) => node.subagentType?.startsWith("worker-"))
  assert.equal(workers.length, 5)
  assert.ok(workers.every((node, index) => node.agentName === `worker-${index}`))
  assert.equal(new Set(workers.map((node) => node.sessionId)).size, 5)
  const delegated = record.interactions.filter((item: any) => item.role === "subagent")
  assert.ok(delegated.every((item: any) => item.agent === item.subagent_name))
  assert.ok(delegated.some((item: any) => item.subagent_name === "worker-0"))
  assert.deepEqual(computeOwnSkills("pi-agent", record.interactions).map((skill) => skill.name), ["root-skill"])
})

test("Pi adapter output is deterministic for the same canonical structure", () => {
  const source = [
    canonical({
      eventId: "agent",
      spanId: "1".repeat(16),
      kind: "agent",
      name: "agent.pi",
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
  const first = aggregateOtelTraceEvents("pi-session", normalize(source))
  const second = aggregateOtelTraceEvents("pi-session", normalize(source))
  assert.deepEqual(first, second)
})

test("Pi adapter latency uses the root agent span, not the whole session span", () => {
  // 模拟旧 bug：同一 session 多个 agent 任务（sessionId 覆盖前），首尾跨多任务
  const events = normalize([
    canonical({
      eventId: "agent-1",
      spanId: "1".repeat(16),
      kind: "agent",
      name: "agent.pi",
      input: "first task",
      output: "first result",
      startTimeMs: 1_700_000_000_000,
      endTimeMs: 1_700_000_000_100,
    }),
    canonical({
      eventId: "agent-2",
      spanId: "2".repeat(16),
      kind: "agent",
      name: "agent.pi",
      input: "second task",
      output: "second result",
      startTimeMs: 1_700_000_010_000,
      endTimeMs: 1_700_000_010_100,
    }),
  ])
  const record = aggregateOtelTraceEvents("pi-session", events)
  assert.ok(record)
  // latency 应为根 agent（第一个）的跨度 100ms，而非整个 session 的 10100ms
  assert.equal(record.latency, 100)
})
