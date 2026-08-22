import assert from "node:assert/strict"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { Readable } from "node:stream"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const {
  CodexTraceCore,
  HOOK_EVENTS,
  classifyTool,
  normalizeHookInput,
  parseMcpIdentity,
} = require("../scripts/agent-trace-collectors/codex/codex-trace-core.cjs")
const {
  MAX_STDIN_BYTES,
  readStdin,
} = require("../scripts/agent-trace-collectors/codex/hook-handler.cjs")

type CapturedEvent = {
  eventId: string
  spanId: string
  parentSpanId?: string
  kind: string
  name: string
  input?: unknown
  output?: unknown
  usage?: Record<string, number>
  tool?: {
    name?: string
    type?: string
    arguments?: unknown
    result?: unknown
  }
  skill?: {
    name?: string
    version?: string
    triggerMode?: string
  }
  mcp?: {
    serverName: string
    toolName: string
  }
  attributes?: Record<string, unknown>
}

class MemoryWriter {
  events: CapturedEvent[] = []

  async append(event: CapturedEvent) {
    this.events.push(structuredClone(event))
    return event
  }

  async flush() {}
}

function hook(
  eventName: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    hook_event_name: eventName,
    session_id: "session-a",
    turn_id: "turn-a",
    cwd: process.cwd(),
    model: "gpt-test",
    ...overrides,
  }
}

function otlpLogs(eventName: string, attributes: Record<string, unknown>) {
  const av = (value: unknown) => ({ stringValue: String(value) })
  return {
    resourceLogs: [{
      resource: { attributes: [{ key: "service.name", value: av("codex-cli") }] },
      scopeLogs: [{
        scope: { name: "codex-otel", version: "0.145.0" },
        logRecords: [{
          timeUnixNano: "1700000000500000000",
          attributes: Object.entries({ "event.name": eventName, ...attributes })
            .map(([key, value]) => ({ key, value: av(value) })),
        }],
      }],
    }],
  }
}

function createCore() {
  let now = 1_700_000_000_000
  const writer = new MemoryWriter()
  const core = new CodexTraceCore({
    writer,
    now: () => {
      now += 10
      return now
    },
  })
  return { core, writer }
}

function assertAcyclic(events: CapturedEvent[]) {
  const latest = new Map<string, CapturedEvent>()
  for (const event of events) latest.set(event.spanId, event)
  for (const event of latest.values()) {
    if (event.parentSpanId) {
      assert.ok(latest.has(event.parentSpanId), `orphan ${event.spanId}`)
    }
    const visited = new Set<string>()
    let cursor: CapturedEvent | undefined = event
    while (cursor?.parentSpanId) {
      assert.equal(visited.has(cursor.spanId), false, `cycle at ${cursor.spanId}`)
      visited.add(cursor.spanId)
      cursor = latest.get(cursor.parentSpanId)
    }
  }
}

test("Codex Hook normalizer accepts exactly the 11 documented lifecycle events", () => {
  assert.equal(HOOK_EVENTS.length, 11)
  for (const eventName of HOOK_EVENTS) {
    assert.equal(normalizeHookInput(hook(eventName)).hook_event_name, eventName)
  }
  assert.throws(() => normalizeHookInput(hook("Unknown")), /Unsupported/)
  assert.throws(
    () => normalizeHookInput({ hook_event_name: "Stop" }),
    /session_id/,
  )
})

test("Codex collector joins prompt, Tool lifecycle, and Stop without reading transcript", async () => {
  const { core, writer } = createCore()
  await core.processHook(hook("SessionStart", {
    transcript_path: "must-not-be-opened.jsonl",
  }))
  await core.processHook(hook("UserPromptSubmit", {
    prompt: "inspect the repository",
  }))
  await core.processHook(hook("PreToolUse", {
    tool_name: "Bash",
    tool_use_id: "call-1",
    tool_input: { command: "pwd" },
  }))
  await core.processHook(hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "call-1",
    tool_input: { command: "pwd" },
    tool_response: { output: "/repo", exit_code: 0 },
  }))
  const result = await core.processHook(hook("Stop", {
    last_assistant_message: "inspection complete",
  }))

  assert.equal(result.flush, true)
  const root = writer.events.at(-1)
  const tool = writer.events.find((event) => event.kind === "tool")
  assert.equal(root?.kind, "agent")
  assert.equal(root?.input, "inspect the repository")
  assert.equal(root?.output, "inspection complete")
  assert.equal(tool?.tool?.name, "Bash")
  assert.equal(tool?.tool?.type, "shell")
  assert.equal(tool?.tool?.result?.output, "/repo")
  assertAcyclic(writer.events)
})

test("Codex collector records explicit Skill and nests Tool under it", async () => {
  const { core, writer } = createCore()
  await core.processHook(hook("SessionStart"))
  await core.processHook(hook("UserPromptSubmit", {
    prompt: "$review-code inspect this diff",
  }))
  await core.processHook(hook("PreToolUse", {
    tool_name: "read_file",
    tool_use_id: "read-1",
    tool_input: { path: "README.md" },
  }))
  await core.processHook(hook("PostToolUse", {
    tool_name: "read_file",
    tool_use_id: "read-1",
    tool_response: "done",
  }))

  const skill = writer.events.find((event) => event.kind === "skill")
  const tool = writer.events.find((event) => event.kind === "tool")
  assert.equal(skill?.skill?.name, "review-code")
  assert.equal(skill?.skill?.triggerMode, "explicit")
  assert.equal(tool?.parentSpanId, skill?.spanId)
})

test("Codex collector detects automatic Skill from a public SKILL.md read", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-skill-"))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const skillPath = path.join(dir, "skills", "fixture-skill", "SKILL.md")
  await fsp.mkdir(path.dirname(skillPath), { recursive: true })
  await fsp.writeFile(
    skillPath,
    "---\nname: fixture-skill\nversion: 3.2.1\n---\n\n# Fixture\n",
    "utf8",
  )

  const { core, writer } = createCore()
  await core.processHook(hook("SessionStart"))
  await core.processHook(hook("UserPromptSubmit", { prompt: "use relevant guidance" }))
  await core.processHook(hook("PreToolUse", {
    tool_name: "Bash",
    tool_use_id: "skill-read",
    tool_input: { command: `Get-Content -LiteralPath '${skillPath}' -Raw` },
  }))
  await core.processHook(hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "skill-read",
    tool_response: "source",
  }))
  await core.processHook(hook("PreToolUse", {
    tool_name: "Bash",
    tool_use_id: "ordinary-variable-read",
    tool_input: { command: "Get-Content -LiteralPath $inputFile -Raw" },
  }))

  const skills = writer.events.filter((event) => event.kind === "skill")
  const skill = skills[0]
  const tool = writer.events.find((event) => event.attributes?.["codex.call.id"] === "skill-read")
  assert.equal(skills.length, 1)
  assert.equal(skill?.skill?.name, "fixture-skill")
  assert.equal(skill?.skill?.version, "3.2.1")
  assert.equal(skill?.skill?.triggerMode, "automatic")
  assert.equal(tool?.parentSpanId, skill?.spanId)
})

test("Codex collector preserves three-level SubAgent ancestry", async () => {
  const { core, writer } = createCore()
  await core.processHook(hook("SessionStart"))
  await core.processHook(hook("UserPromptSubmit", { prompt: "delegate" }))
  for (const agent of [
    { id: "agent-a", parent: "root", type: "planner" },
    { id: "agent-b", parent: "agent-a", type: "researcher" },
    { id: "agent-c", parent: "agent-b", type: "reviewer" },
  ]) {
    await core.processHook(hook("SubagentStart", {
      agent_id: agent.id,
      parent_agent_id: agent.parent,
      agent_type: agent.type,
      prompt: agent.type,
    }))
  }
  for (const agent of ["agent-c", "agent-b", "agent-a"]) {
    await core.processHook(hook("SubagentStop", {
      agent_id: agent,
      last_assistant_message: `${agent} done`,
    }))
  }

  const latest = new Map<string, CapturedEvent>()
  for (const event of writer.events) latest.set(event.spanId, event)
  const agents = [...latest.values()].filter((event) => event.kind === "subagent")
  const byName = new Map(agents.map((event) => [event.name, event]))
  assert.equal(byName.get("agent.researcher")?.parentSpanId, byName.get("agent.planner")?.spanId)
  assert.equal(byName.get("agent.reviewer")?.parentSpanId, byName.get("agent.researcher")?.spanId)
  assertAcyclic(writer.events)
})

test("Codex collector gives five sibling SubAgents unique stable spans", async () => {
  const { core, writer } = createCore()
  await core.processHook(hook("SessionStart"))
  await core.processHook(hook("UserPromptSubmit", { prompt: "fan out" }))
  for (let index = 0; index < 5; index += 1) {
    await core.processHook(hook("SubagentStart", {
      agent_id: `worker-${index}`,
      parent_agent_id: "root",
      agent_type: `worker-${index}`,
    }))
    await core.processHook(hook("SubagentStop", {
      agent_id: `worker-${index}`,
      last_assistant_message: `result-${index}`,
    }))
  }
  const spans = writer.events
    .filter((event) => event.kind === "subagent")
    .map((event) => event.spanId)
  assert.equal(new Set(spans).size, 5)
  assertAcyclic(writer.events)
})

test("Tool classifier and MCP identity use explicit public names", () => {
  assert.equal(classifyTool("Bash"), "shell")
  assert.equal(classifyTool("apply_patch"), "apply_patch")
  assert.equal(classifyTool("FileSearch"), "file_search")
  assert.equal(classifyTool("CodeInterpreter"), "code_interpreter")
  assert.equal(classifyTool("mcp__filesystem__read_file"), "mcp")
  assert.deepEqual(parseMcpIdentity("mcp__filesystem__read_file"), {
    serverName: "filesystem",
    toolName: "read_file",
  })
  assert.deepEqual(parseMcpIdentity("mcp__fixture__lookup", {
    serverName: "fixture",
    toolName: "mcp__fixturelookup",
  }), {
    serverName: "fixture",
    toolName: "lookup",
  })
  assert.equal(parseMcpIdentity("custom-tool"), undefined)
})

test("Hook stdin parser enforces the 1 MiB boundary", async () => {
  const valid = Readable.from([Buffer.from(JSON.stringify(hook("Stop")))])
  assert.equal((await readStdin(MAX_STDIN_BYTES, valid)).hook_event_name, "Stop")
  const oversized = Readable.from([Buffer.alloc(MAX_STDIN_BYTES + 1, 0x61)])
  await assert.rejects(() => readStdin(MAX_STDIN_BYTES, oversized), /exceeds 1 MiB/)
})

test("Codex collector output is deterministic for stable Hook identifiers", async () => {
  const run = async () => {
    const { core, writer } = createCore()
    await core.processHook(hook("SessionStart", { timestamp_ms: 1000 }))
    await core.processHook(hook("UserPromptSubmit", {
      timestamp_ms: 1010,
      prompt: "same",
    }))
    await core.processHook(hook("Stop", {
      timestamp_ms: 1100,
      last_assistant_message: "same result",
    }))
    return writer.events.map((event) => ({
      eventId: event.eventId,
      spanId: event.spanId,
      parentSpanId: event.parentSpanId,
      kind: event.kind,
    }))
  }
  assert.deepEqual(await run(), await run())
})

test("multi-turn session emits one root execution for each user prompt", async (t) => {
  const writer = new MemoryWriter()
  const core = new CodexTraceCore({ writer, now: () => 1_700_000_000_000 })
  await core.processHook(hook("SessionStart", { session_id: "multi-turn", timestamp_ms: 100 }))
  await core.processHook(hook("UserPromptSubmit", {
    session_id: "multi-turn",
    turn_id: "turn-1",
    prompt: "first prompt",
    timestamp_ms: 200,
  }))
  await core.processHook(hook("Stop", {
    session_id: "multi-turn",
    turn_id: "turn-1",
    last_assistant_message: "first done",
    timestamp_ms: 250,
  }))
  await core.processHook(hook("UserPromptSubmit", {
    session_id: "multi-turn",
    turn_id: "turn-2",
    prompt: "second prompt",
    timestamp_ms: 300,
  }))
  await core.processHook(hook("Stop", {
    session_id: "multi-turn",
    turn_id: "turn-2",
    last_assistant_message: "done",
    timestamp_ms: 400,
  }))

  const roots = writer.events.filter((event) => event.kind === "agent")
  const byExecution = new Map<string, CapturedEvent[]>()
  for (const root of roots) {
    const current = byExecution.get(root.sessionId!) || []
    current.push(root)
    byExecution.set(root.sessionId!, current)
  }
  assert.deepEqual([...byExecution.keys()].sort(), [
    "multi-turn:turn:turn-1",
    "multi-turn:turn:turn-2",
  ])
  assert.equal(byExecution.get("multi-turn:turn:turn-1")?.at(-1)?.input, "first prompt")
  assert.equal(byExecution.get("multi-turn:turn:turn-2")?.at(-1)?.input, "second prompt")
})

test("SessionEnd does not extend an already completed earlier turn", async () => {
  const { core, writer } = createCore()
  await core.processHook(hook("UserPromptSubmit", {
    session_id: "session-end-boundary",
    turn_id: "turn-1",
    prompt: "first prompt",
    timestamp_ms: 100,
  }))
  await core.processHook(hook("Stop", {
    session_id: "session-end-boundary",
    turn_id: "turn-1",
    last_assistant_message: "first done",
    timestamp_ms: 200,
  }))
  await core.processHook(hook("UserPromptSubmit", {
    session_id: "session-end-boundary",
    turn_id: "turn-2",
    prompt: "second prompt",
    timestamp_ms: 300,
  }))
  await core.processHook(hook("SessionEnd", {
    session_id: "session-end-boundary",
    turn_id: undefined,
    last_assistant_message: "second done",
    timestamp_ms: 900,
  }))

  const roots = writer.events.filter((event) => event.kind === "agent")
  const first = roots.filter((event) => event.sessionId === "session-end-boundary:turn:turn-1").at(-1)
  const second = roots.filter((event) => event.sessionId === "session-end-boundary:turn:turn-2").at(-1)
  assert.equal(first?.endTimeMs, 200)
  assert.equal(second?.endTimeMs, 900)
})

test("LLM spans inside a subagent attach to the subagent span, not root", async (t) => {
  const { core, writer } = createCore()
  await core.processHook(hook("SessionStart"))
  await core.processHook(hook("UserPromptSubmit", { prompt: "delegate" }))
  await core.processHook(hook("SubagentStart", {
    agent_id: "worker-1",
    parent_agent_id: "root",
    agent_type: "worker",
    prompt: "read file",
  }))
  // subagent 内的 LLM（OTel sse_event）
  await core.processOtel({
    resourceLogs: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "codex-cli" } }] },
      scopeLogs: [{
        scope: { name: "codex-otel", version: "0.145.0" },
        logRecords: [{
          timeUnixNano: "1700000009500000000",
          attributes: Object.entries({
            "event.name": "codex.sse_event",
            "conversation.id": "session-a",
            "turn.id": "turn-a",
            kind: "response.completed",
            response_id: "sub-llm-1",
            input_token_count: 10,
            output_token_count: 5,
            total_token_count: 15,
          }).map(([key, value]) => ({ key, value: { stringValue: String(value) } })),
        }],
      }],
    }],
  })
  await core.processHook(hook("SubagentStop", {
    agent_id: "worker-1",
    last_assistant_message: "done",
  }))

  const subagent = writer.events.find((event) => event.kind === "subagent")
  const llm = writer.events.find((event) => event.kind === "llm")
  assert.ok(subagent, "subagent event exists")
  assert.ok(llm, "llm event exists")
  assert.equal(llm.parentSpanId, subagent.spanId, "subagent LLM attaches to subagent span")
})

test("SubagentStart does not emit an event; SubagentStop emits a single one", async (t) => {
  const { core, writer } = createCore()
  await core.processHook(hook("SessionStart"))
  await core.processHook(hook("UserPromptSubmit", { prompt: "delegate" }))
  await core.processHook(hook("SubagentStart", {
    agent_id: "worker-1",
    parent_agent_id: "root",
    agent_type: "worker",
  }))
  const afterStart = writer.events.filter((event) => event.kind === "subagent")
  assert.equal(afterStart.length, 0, "no subagent event on Start")
  await core.processHook(hook("SubagentStop", {
    agent_id: "worker-1",
    last_assistant_message: "done",
  }))
  const subagents = writer.events.filter((event) => event.kind === "subagent")
  assert.equal(subagents.length, 1, "exactly one subagent event after Stop")
  assert.equal(subagents[0]?.output, "done")
})

test("explicit fork session events flow into the parent TASK instead of a second root", async (t) => {
  const { core, writer } = createCore()
  await core.processHook(hook("SessionStart"))
  await core.processHook(hook("UserPromptSubmit", { prompt: "delegate" }))
  await core.processHook(hook("SubagentStart", {
    agent_id: "fork-session-1",
    parent_agent_id: "root",
    agent_type: "worker",
  }))
  await core.processHook(hook("UserPromptSubmit", {
    session_id: "fork-session-1",
    turn_id: "fork-turn-1",
    prompt: "read one file",
  }))
  await core.processOtel(otlpLogs("codex.sse_event", {
    "conversation.id": "fork-session-1",
    "turn.id": "fork-turn-1",
    kind: "response.completed",
    response_id: "fork-response",
    input_token_count: 10,
    output_token_count: 5,
    total_token_count: 15,
  }))
  await core.processHook(hook("SubagentStop", {
    agent_id: "fork-session-1",
    last_assistant_message: "worker done",
  }))

  const parentExecution = "session-a:turn:turn-a"
  const subagent = writer.events.find((event) => event.kind === "subagent")
  const llm = writer.events.find((event) => event.kind === "llm")
  assert.equal(llm?.sessionId, parentExecution)
  assert.equal(llm?.parentSpanId, subagent?.spanId)
  assert.equal(writer.events.some((event) => event.sessionId === "fork-session-1"), false)
})

test("subagent lifecycle turn ids stay attached to the unique active user turn", async () => {
  const { core, writer } = createCore()
  await core.processHook(hook("SessionStart"))
  await core.processHook(hook("UserPromptSubmit", {
    turn_id: "user-turn",
    prompt: "delegate one worker",
  }))
  await core.processHook(hook("SubagentStart", {
    turn_id: "subagent-lifecycle-turn",
    agent_id: "fork-session-lifecycle",
    parent_agent_id: "root",
    agent_type: "worker",
  }))
  await core.processOtel(otlpLogs("codex.sse_event", {
    "conversation.id": "fork-session-lifecycle",
    "turn.id": "fork-native-turn",
    kind: "response.completed",
    response_id: "fork-lifecycle-response",
    input_token_count: 8,
    output_token_count: 3,
    total_token_count: 11,
  }))
  await core.processHook(hook("SubagentStop", {
    turn_id: "subagent-lifecycle-turn",
    agent_id: "fork-session-lifecycle",
    last_assistant_message: "worker complete",
  }))

  const parentExecution = "session-a:turn:user-turn"
  const root = writer.events.find((event) => event.kind === "agent")
  const subagent = writer.events.find((event) => event.kind === "subagent")
  const llm = writer.events.find((event) => event.kind === "llm")
  assert.equal(root?.sessionId, parentExecution)
  assert.equal(subagent?.sessionId, parentExecution)
  assert.equal(llm?.sessionId, parentExecution)
  assert.equal(llm?.parentSpanId, subagent?.spanId)
  assert.equal(
    writer.events.some((event) => event.sessionId === "session-a:turn:subagent-lifecycle-turn"),
    false,
  )
})

test("worker Hook tool events reuse a matching fork call scope", async () => {
  const { core, writer } = createCore()
  await core.processHook(hook("SessionStart"))
  await core.processHook(hook("UserPromptSubmit", {
    turn_id: "user-turn",
    prompt: "delegate one worker",
  }))
  await core.processHook(hook("SubagentStart", {
    turn_id: "worker-lifecycle-turn",
    agent_id: "fork-session-call-scope",
    parent_agent_id: "root",
    agent_type: "worker",
  }))
  await core.processOtel(otlpLogs("codex.tool_result", {
    "conversation.id": "fork-session-call-scope",
    "turn.id": "fork-native-turn",
    tool_name: "shell_command",
    call_id: "shared-worker-call",
    success: true,
    output: "openEuler",
  }))
  await core.processHook(hook("PostToolUse", {
    turn_id: "worker-lifecycle-turn",
    tool_name: "Bash",
    tool_use_id: "shared-worker-call",
    tool_response: { output: "openEuler", exit_code: 0 },
  }))
  await core.processHook(hook("SubagentStop", {
    turn_id: "worker-lifecycle-turn",
    agent_id: "fork-session-call-scope",
    last_assistant_message: "worker complete",
  }))
  await core.processHook(hook("SessionEnd", {
    turn_id: undefined,
    last_assistant_message: "parent complete",
  }))

  const parentExecution = "session-a:turn:user-turn"
  const roots = writer.events.filter((event) => event.kind === "agent")
  const workerTools = writer.events.filter((event) =>
    event.kind === "tool" && event.attributes?.["codex.call.id"] === "shared-worker-call",
  )
  const subagent = writer.events.find((event) => event.kind === "subagent")
  assert.ok(roots.length >= 1)
  assert.ok(roots.every((event) => event.sessionId === parentExecution))
  assert.equal(new Set(roots.map((event) => event.spanId)).size, 1)
  assert.equal(workerTools.length, 2)
  assert.ok(workerTools.every((event) => event.sessionId === parentExecution))
  assert.ok(workerTools.every((event) => event.parentSpanId === subagent?.spanId))
  assert.equal(
    writer.events.some((event) => event.sessionId === "session-a:turn:worker-lifecycle-turn"),
    false,
  )
})

test("worker Hook tool events reuse their lifecycle parent without a shared call id", async () => {
  const { core, writer } = createCore()
  await core.processHook(hook("SessionStart"))
  await core.processHook(hook("UserPromptSubmit", {
    turn_id: "user-turn",
    prompt: "delegate one worker",
  }))
  await core.processHook(hook("SubagentStart", {
    turn_id: "worker-lifecycle-turn",
    agent_id: "fork-session-no-call-id",
    parent_agent_id: "root",
    agent_type: "worker",
  }))
  await core.processHook(hook("PostToolUse", {
    turn_id: "worker-lifecycle-turn",
    tool_name: "Bash",
    tool_response: { output: "openEuler", exit_code: 0 },
  }))
  await core.processHook(hook("SubagentStop", {
    turn_id: "worker-lifecycle-turn",
    agent_id: "fork-session-no-call-id",
    last_assistant_message: "worker complete",
  }))

  const parentExecution = "session-a:turn:user-turn"
  const subagent = writer.events.find((event) => event.kind === "subagent")
  const workerTool = writer.events.find((event) =>
    event.kind === "tool" && event.name === "tool.Bash",
  )
  assert.equal(workerTool?.sessionId, parentExecution)
  assert.equal(workerTool?.parentSpanId, subagent?.spanId)
  assert.equal(
    writer.events.some((event) => event.sessionId === "session-a:turn:worker-lifecycle-turn"),
    false,
  )
})

test("fork parent correlation survives a relay state restore", async () => {
  const { core } = createCore()
  await core.processHook(hook("UserPromptSubmit", { prompt: "delegate after restart" }))
  await core.processHook(hook("SubagentStart", {
    agent_id: "fork-after-restart",
    parent_agent_id: "root",
    agent_type: "worker",
  }))
  const resumedWriter = new MemoryWriter()
  const resumed = new CodexTraceCore({ writer: resumedWriter, now: () => 1_700_000_000_500 })
  resumed.restore(core.snapshot())
  await resumed.processHook(hook("UserPromptSubmit", {
    session_id: "fork-after-restart",
    turn_id: "fork-turn",
    prompt: "inspect after restart",
  }))
  await resumed.processOtel(otlpLogs("codex.sse_event", {
    "conversation.id": "fork-after-restart",
    "turn.id": "fork-turn",
    kind: "response.completed",
    response_id: "fork-after-restart-response",
    input_token_count: 4,
    output_token_count: 2,
    total_token_count: 6,
  }))
  await resumed.processHook(hook("SubagentStop", {
    agent_id: "fork-after-restart",
    last_assistant_message: "worker complete",
  }))

  const subagent = resumedWriter.events.find((event) => event.kind === "subagent")
  const llm = resumedWriter.events.find((event) => event.kind === "llm")
  assert.equal(subagent?.name, "agent.worker")
  assert.equal(subagent?.sessionId, "session-a:turn:turn-a")
  assert.equal(llm?.parentSpanId, subagent?.spanId)
})

test("automatic Memory Agent Hook and OTel streams merge under one parent execution", async () => {
  const { core, writer } = createCore()
  const memoryPrompt = "## Memory Writing Agent: Phase 2 (Consolidation)\nPersist durable memory."
  await core.processHook(hook("UserPromptSubmit", {
    turn_id: "root-turn",
    prompt: "implement the feature",
    timestamp_ms: 1_700_000_000_100,
  }))
  await core.processHook(hook("Stop", {
    turn_id: "root-turn",
    last_assistant_message: "root complete",
    timestamp_ms: 1_700_000_000_200,
  }))
  await core.processHook(hook("UserPromptSubmit", {
    session_id: "memory-hook-session",
    turn_id: "memory-hook-turn",
    prompt: memoryPrompt,
    timestamp_ms: 1_700_000_000_300,
  }))
  await core.processOtel(otlpLogs("codex.user_prompt", {
    "conversation.id": "memory-otel-session",
    "turn.id": "memory-otel-turn",
    prompt: memoryPrompt,
  }))
  await core.processOtel(otlpLogs("codex.sse_event", {
    "conversation.id": "memory-otel-session",
    "turn.id": "memory-otel-turn",
    kind: "response.completed",
    response_id: "memory-response",
    input_token_count: 9,
    output_token_count: 3,
    total_token_count: 12,
  }))

  const parentExecution = "session-a:turn:root-turn"
  const anchors = writer.events.filter((event) => event.kind === "subagent")
  const anchor = anchors.at(-1)
  const llm = writer.events.find((event) => event.kind === "llm")
  assert.equal(anchor?.name, "agent.Memory Agent")
  assert.equal(anchor?.sessionId, parentExecution)
  assert.equal(llm?.sessionId, parentExecution)
  assert.equal(llm?.parentSpanId, anchor?.spanId)
  assert.equal(anchor?.attributes?.["codex.conversation.id"], "memory-otel-session")
})

test("automatic Memory Agent fallback never crosses a mismatched workspace", async () => {
  const { core, writer } = createCore()
  const memoryPrompt = "## Memory Writing Agent: Phase 2 (Consolidation)\nPersist durable memory."
  await core.processHook(hook("UserPromptSubmit", {
    session_id: "context-root",
    turn_id: "context-root-turn",
    cwd: "C:\\fixture-workspace",
    prompt: "finish the fixture task",
    timestamp_ms: 1_700_000_000_100,
  }))
  await core.processHook(hook("Stop", {
    session_id: "context-root",
    turn_id: "context-root-turn",
    cwd: "C:\\fixture-workspace",
    timestamp_ms: 1_700_000_000_200,
  }))
  // This unrelated task is the only active root. The memory unit must still
  // attach to the matching recent workspace root, not to this active one.
  await core.processHook(hook("UserPromptSubmit", {
    session_id: "other-workspace",
    turn_id: "other-turn",
    cwd: "C:\\unrelated-workspace",
    prompt: "keep working elsewhere",
    timestamp_ms: 1_700_000_000_300,
  }))
  await core.processHook(hook("UserPromptSubmit", {
    session_id: "memory-context",
    turn_id: "memory-context-turn",
    cwd: "C:\\fixture-workspace",
    prompt: memoryPrompt,
    timestamp_ms: 1_700_000_000_400,
  }))

  const root = writer.events.find((event) =>
    event.kind === "agent" && event.sessionId === "context-root:turn:context-root-turn",
  )
  const memory = writer.events.find((event) =>
    event.kind === "subagent" && event.name === "agent.Memory Agent",
  )
  assert.equal(memory?.sessionId, root?.sessionId)
  assert.equal(memory?.parentSpanId, root?.spanId)
})

test("automatic Memory Agent ignores stale restored open roots", async () => {
  const { core, writer } = createCore()
  const memoryPrompt = "## Memory Writing Agent: Phase 2 (Consolidation)\nPersist durable memory."
  for (const id of ["stale-a", "stale-b"]) {
    await core.processHook(hook("UserPromptSubmit", {
      session_id: id,
      turn_id: `${id}-turn`,
      prompt: `old ${id} task`,
      timestamp_ms: 1_700_000_000_000,
    }))
  }
  await core.processHook(hook("UserPromptSubmit", {
    session_id: "current-root",
    turn_id: "current-turn",
    prompt: "current task",
    timestamp_ms: 1_700_000_500_000,
  }))
  await core.processHook(hook("UserPromptSubmit", {
    session_id: "memory-current",
    turn_id: "memory-turn",
    prompt: memoryPrompt,
    timestamp_ms: 1_700_000_500_100,
  }))

  const memory = writer.events.find((event) =>
    event.kind === "subagent" && event.name === "agent.Memory Agent",
  )
  assert.equal(memory?.sessionId, "current-root:turn:current-turn")
})

test("automatic Memory Agent stays pending when two parent roots are plausible", async () => {
  const { core, writer } = createCore()
  const memoryPrompt = "## Memory Writing Agent: Phase 2 (Consolidation)\nPersist durable memory."
  await core.processHook(hook("UserPromptSubmit", {
    session_id: "root-a",
    turn_id: "turn-a",
    prompt: "first concurrent task",
  }))
  await core.processHook(hook("UserPromptSubmit", {
    session_id: "root-b",
    turn_id: "turn-b",
    prompt: "second concurrent task",
  }))
  await core.processHook(hook("UserPromptSubmit", {
    session_id: "memory-ambiguous",
    turn_id: "memory-turn",
    prompt: memoryPrompt,
  }))

  const memoryRoot = writer.events.at(-1)
  assert.equal(memoryRoot?.attributes?.["codex.association.pending"], "true")
  assert.equal(memoryRoot?.sessionId, "pending:memory-ambiguous:turn:memory-turn")
  assert.equal(memoryRoot?.kind, "agent")
})
