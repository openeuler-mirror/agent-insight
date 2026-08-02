import assert from "node:assert/strict"
import test from "node:test"

import { buildAgentCallTree } from "../src/lib/engine/observability/agent-trace"
import { getAdapter } from "../src/lib/ingest/adapters/registry"
import { aggregateOtelTraceEvents } from "../src/lib/ingest/otel/aggregate"
import { getOtelTraceAdapter } from "../src/lib/ingest/otel/adapter-registry"
import { computeOwnSkills } from "../src/lib/storage/data-service"

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

function otelKind(semanticKind: string): string {
  if (semanticKind === "llm") return "llm"
  if (semanticKind === "tool" || semanticKind === "mcp") return "tool"
  if (semanticKind === "skill") return "chain"
  return "agent"
}

function normalize(events: Record<string, unknown>[]) {
  return events.map((event: any) => {
    const semanticKind = String(event.kind || "span")
    const kind = otelKind(semanticKind)
    const attributes = {
      "agent.insight.framework": "codex",
      "agent.insight.kind": semanticKind,
      "agent.insight.event_id": event.eventId,
      "session.id": event.sessionId,
      "input.value": event.input,
      "output.value": event.output,
      "llm.model_name": event.model,
      "llm.provider": event.provider,
      "llm.token_count.prompt": event.usage?.input,
      "llm.token_count.completion": event.usage?.output,
      "llm.token_count.reasoning": event.usage?.reasoning,
      "llm.token_count.total": event.usage?.total,
      "tool.name": event.tool?.name,
      "tool.type": event.tool?.type,
      "tool.arguments": event.tool?.arguments,
      "tool.result": event.tool?.result,
      "tool.outcome": event.status,
      "skill.name": event.skill?.name,
      "skill.version": event.skill?.version,
      "skill.trigger_mode": event.skill?.triggerMode,
      "mcp.server.name": event.mcp?.serverName,
      "mcp.tool.name": event.mcp?.toolName,
      ...(event.attributes || {}),
    }
    return {
      receivedAt: new Date(event.endTimeMs).toISOString(),
      sessionId: event.sessionId,
      traceId: event.traceId,
      spanId: event.spanId,
      parentSpanId: event.parentSpanId,
      name: event.name,
      kind,
      serviceName: "codex",
      user: "alice",
      model: event.model,
      usage: {
        input_tokens: Number(event.usage?.input) || 0,
        output_tokens: Number(event.usage?.output) || 0,
        reasoning_tokens: Number(event.usage?.reasoning) || 0,
        total_tokens: Number(event.usage?.total) || 0,
      },
      latencyMs: Math.max(0, Number(event.endTimeMs) - Number(event.startTimeMs)),
      startTimeMs: Number(event.startTimeMs),
      attributes,
    }
  })
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
  assert.deepEqual(record.invokedSkills, [{ name: "fixture", version: 1 }])
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
  const rootSkill = "e".repeat(16)
  const childSkill = "f".repeat(16)
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
      attributes: { "codex.agent.name": "level-one", "codex.agent.id": "level-one" },
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
  const tree = buildAgentCallTree(record.interactions)
  assert.ok(tree)
  const levelOneNode = tree.children.find((node) => node.agentName === "level-one")
  assert.equal(levelOneNode?.children[0]?.agentName, "level-two")
  assert.equal(levelOneNode?.children[0]?.children[0]?.agentName, "level-three")
  const workers = tree.children.filter((node) => node.agentName.startsWith("worker-"))
  assert.equal(workers.length, 5)
  assert.equal(new Set(workers.map((node) => node.sessionId)).size, 5)
  assert.deepEqual(computeOwnSkills("codex", record.interactions).map((skill) => skill.name), ["root-skill"])
})

test("Codex adapter retains direct SubAgent parents and normalizes failed spawn outcomes", () => {
  const root = "1".repeat(16)
  const parent = "2".repeat(16)
  const child = "3".repeat(16)
  const record = aggregateOtelTraceEvents("codex-session", normalize([
    canonical({ eventId: "root", spanId: root, kind: "agent", name: "agent.codex" }),
    canonical({
      eventId: "parent",
      spanId: parent,
      parentSpanId: root,
      kind: "subagent",
      name: "agent.parent",
      attributes: { "codex.agent.name": "parent" },
    }),
    canonical({
      eventId: "child",
      spanId: child,
      parentSpanId: parent,
      kind: "subagent",
      name: "agent.child",
      status: "Failed",
      attributes: { "codex.agent.name": "child" },
    }),
  ]))
  assert.ok(record)
  const childSpawn = record.interactions.find((item) => item.spanId === `${child}:spawn`)
  assert.equal(childSpawn?.role, "subagent")
  assert.equal(childSpawn?.subagent_session_id, parent)
  assert.equal(childSpawn?.tool_calls?.[0]?.state, "error")

  const tree = buildAgentCallTree(record.interactions)
  assert.equal(tree?.children.find((node) => node.agentName === "parent")?.children[0]?.agentName, "child")
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
