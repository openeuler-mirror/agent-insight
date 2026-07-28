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
    tool_name: "read_file",
    tool_use_id: "skill-read",
    tool_input: { path: skillPath },
  }))
  await core.processHook(hook("PostToolUse", {
    tool_name: "read_file",
    tool_use_id: "skill-read",
    tool_response: "source",
  }))

  const skill = writer.events.find((event) => event.kind === "skill")
  const tool = writer.events.find((event) => event.tool?.name === "read_file")
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
