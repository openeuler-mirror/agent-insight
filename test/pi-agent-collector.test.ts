import assert from "node:assert/strict"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const {
  PiTraceCollector,
  classifyTool,
  loadCollectorConfig,
  parseMcpIdentity,
  skillVersion,
} = require("../scripts/agent-trace-collectors/pi-agent/lib/pi-trace-core.cjs")

type CapturedEvent = {
  kind: string
  spanId: string
  parentSpanId?: string
  tool?: { name?: string }
  usage?: {
    input: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
  skill?: {
    version?: string
    triggerMode?: string
  }
  attributes?: Record<string, unknown>
}

class MemoryWriter {
  events: CapturedEvent[] = []

  async append(event: CapturedEvent) {
    this.events.push(event)
    return event
  }

  async flush() {}
}

class MemoryUploader {
  started = 0
  stopped = 0
  flushed = 0

  start() {
    this.started += 1
  }

  stop() {
    this.stopped += 1
  }

  async flushOnce() {
    this.flushed += 1
    return { acquired: true, uploadedEvents: 0 }
  }
}

async function fixtureSkill(t: test.TestContext, frontmatter = "") {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-skill-"))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, "SKILL.md")
  await fsp.writeFile(
    filePath,
    `---\nname: fixture-skill\n${frontmatter}---\n\n# Fixture\n\nUse this skill.\n`,
    "utf8",
  )
  return { name: "fixture-skill", filePath, baseDir: dir }
}

function collector(writer = new MemoryWriter(), uploader = new MemoryUploader()) {
  let now = 1_700_000_000_000
  const instance = new PiTraceCollector({
    config: {
      enabled: true,
      apiKey: "key",
      endpoint: "http://127.0.0.1/otel",
      homeDir: os.tmpdir(),
      uploadIntervalMs: 300_000,
      shutdownTimeoutMs: 100,
    },
    writer,
    uploader,
    now: () => {
      now += 10
      return now
    },
  })
  instance.startSession("session-a")
  return { instance, writer, uploader }
}

function context() {
  return {
    sessionManager: { getSessionId: () => "session-a" },
    model: { id: "model-a", provider: "provider-a" },
  }
}

function assistant(overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
    provider: "provider-a",
    model: "model-a",
    usage: {
      input: 10,
      output: 6,
      reasoning: 2,
      cacheRead: 3,
      cacheWrite: 1,
      totalTokens: 16,
    },
    stopReason: "stop",
    timestamp: 1_700_000_000_020,
    ...overrides,
  }
}

function assertAcyclic(events: CapturedEvent[]) {
  const byId = new Map(events.map((event) => [event.spanId, event]))
  for (const event of events) {
    if (event.parentSpanId) assert.ok(byId.has(event.parentSpanId), `orphan ${event.spanId}`)
    const visited = new Set<string>()
    let cursor = event
    while (cursor?.parentSpanId) {
      assert.equal(visited.has(cursor.spanId), false, `cycle at ${cursor.spanId}`)
      visited.add(cursor.spanId)
      cursor = byId.get(cursor.parentSpanId)
    }
  }
}

test("Pi collector records explicit Skill, exact native usage, Tool ownership, and settled flush", async (t) => {
  const skill = await fixtureSkill(t, "version: 2.4.0\n")
  const { instance, writer, uploader } = collector()
  instance.recordInput("/skill:fixture-skill inspect this")
  instance.beginAgent({
    prompt: "inspect this",
    systemPromptOptions: { skills: [skill] },
  }, context())
  instance.beginTool({
    toolCallId: "tool-1",
    toolName: "bash",
    args: { command: "pwd" },
  })
  instance.endTool({
    toolCallId: "tool-1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "ok" }] },
    isError: false,
  })
  instance.recordMessage(assistant())
  instance.recordAgentEnd({ messages: [assistant()] })
  await instance.settleAgent()

  assert.deepEqual(writer.events.map((event) => event.kind).sort(), ["agent", "llm", "skill", "tool"])
  const skillEvent = writer.events.find((event) => event.kind === "skill")
  const toolEvent = writer.events.find((event) => event.kind === "tool")
  const llmEvent = writer.events.find((event) => event.kind === "llm")
  assert.ok(skillEvent)
  assert.ok(toolEvent)
  assert.ok(llmEvent)
  assert.equal(skillEvent.skill.version, "2.4.0")
  assert.equal(skillEvent.skill.triggerMode, "explicit")
  assert.equal(toolEvent.parentSpanId, skillEvent.spanId)
  assert.equal(llmEvent.parentSpanId, skillEvent.spanId)
  assert.deepEqual(llmEvent.usage, {
    input: 10,
    output: 6,
    reasoning: 2,
    cacheRead: 3,
    cacheWrite: 1,
    total: 16,
  })
  assert.equal(uploader.flushed, 1)
  assertAcyclic(writer.events)
})

test("Pi collector detects automatic Skill invocation from a loaded SKILL.md read", async (t) => {
  const skill = await fixtureSkill(t)
  const expectedHash = await skillVersion(skill)
  const { instance, writer } = collector()
  instance.recordInput("use the relevant guidance")
  instance.beginAgent({
    prompt: "use the relevant guidance",
    systemPromptOptions: { skills: [skill] },
  }, context())
  instance.beginTool({
    toolCallId: "read-skill",
    toolName: "read",
    args: { path: skill.filePath },
  })
  instance.endTool({
    toolCallId: "read-skill",
    toolName: "read",
    result: { content: [{ type: "text", text: "skill source" }] },
    isError: false,
  })
  await instance.settleAgent()

  const skillEvent = writer.events.find((event) => event.kind === "skill")
  const readEvent = writer.events.find((event) => event.tool?.name === "read")
  assert.ok(skillEvent)
  assert.ok(readEvent)
  assert.equal(skillEvent.skill.triggerMode, "automatic")
  assert.equal(skillEvent.skill.version, expectedHash)
  assert.equal(readEvent.parentSpanId, skillEvent.spanId)
})

test("Pi collector recursively reconstructs three-level SubAgents and nested Tool/LLM spans", async () => {
  const { instance, writer } = collector()
  instance.recordInput("delegate")
  instance.beginAgent({ prompt: "delegate", systemPromptOptions: { skills: [] } }, context())
  instance.beginTool({ toolCallId: "root-sub", toolName: "subagent", args: { task: "root" } })
  instance.endTool({
    toolCallId: "root-sub",
    toolName: "subagent",
    isError: false,
    result: {
      content: [{ type: "text", text: "done" }],
      details: {
        results: [{
          agent: "level-one",
          task: "one",
          step: 1,
          exitCode: 0,
          model: "model-a",
          usage: { input: 5, output: 2, totalTokens: 7 },
          messages: [
            assistant({ timestamp: 100 }),
            {
              role: "toolResult",
              toolCallId: "nested-sub-1",
              toolName: "subagent",
              content: [{ type: "text", text: "nested" }],
              isError: false,
              timestamp: 110,
              details: {
                results: [{
                  agent: "level-two",
                  task: "two",
                  step: 1,
                  exitCode: 0,
                  messages: [
                    assistant({ timestamp: 120 }),
                    {
                      role: "toolResult",
                      toolCallId: "nested-sub-2",
                      toolName: "subagent",
                      content: [{ type: "text", text: "nested again" }],
                      isError: false,
                      timestamp: 130,
                      details: {
                        results: [{
                          agent: "level-three",
                          task: "three",
                          step: 1,
                          exitCode: 0,
                          messages: [assistant({ timestamp: 140 })],
                        }],
                      },
                    },
                  ],
                }],
              },
            },
          ],
        }],
      },
    },
  })
  await instance.settleAgent()

  assert.deepEqual(
    writer.events.filter((event) => event.kind === "subagent").map((event) => event.attributes?.["pi.subagent.name"]),
    ["level-one", "level-two", "level-three"],
  )
  assert.equal(new Set(writer.events.map((event) => event.spanId)).size, writer.events.length)
  assertAcyclic(writer.events)
})

test("Pi collector gives five parallel SubAgent results stable unique siblings", async () => {
  const run = async () => {
    const { instance, writer } = collector()
    instance.recordInput("parallel")
    instance.beginAgent({ prompt: "parallel", systemPromptOptions: { skills: [] } }, context())
    instance.beginTool({ toolCallId: "parallel-tool", toolName: "subagent", args: {} })
    instance.endTool({
      toolCallId: "parallel-tool",
      toolName: "subagent",
      isError: false,
      result: {
        details: {
          results: Array.from({ length: 5 }, (_, index) => ({
            agent: `worker-${index}`,
            task: `task-${index}`,
            exitCode: 0,
            messages: [assistant({ timestamp: 100 + index })],
          })),
        },
      },
    })
    await instance.settleAgent()
    return writer.events.filter((event) => event.kind === "subagent")
  }

  const first = await run()
  const second = await run()
  assert.equal(first.length, 5)
  assert.equal(new Set(first.map((event) => event.spanId)).size, 5)
  assert.equal(new Set(first.map((event) => event.parentSpanId)).size, 1)
  assert.deepEqual(first.map((event) => event.spanId), second.map((event) => event.spanId))
})

test("Tool classifier and MCP parser preserve explicit framework semantics", () => {
  assert.equal(classifyTool("bash"), "shell")
  assert.equal(classifyTool("read"), "file")
  assert.equal(classifyTool("web_search"), "search")
  assert.equal(classifyTool("subagent"), "subagent")
  assert.equal(classifyTool("mcp__github__search_code"), "mcp")
  assert.deepEqual(parseMcpIdentity("mcp__github__search_code"), {
    serverName: "github",
    toolName: "search_code",
  })
  assert.deepEqual(parseMcpIdentity("custom", {}, {
    details: { metadata: { serverName: "fixture", toolName: "lookup" } },
  }), {
    serverName: "fixture",
    toolName: "lookup",
  })
  assert.equal(parseMcpIdentity("custom"), null)
})

test("collector config honors environment precedence and remains disabled without a key", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-config-"))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const configPath = path.join(dir, "config.json")
  await fsp.writeFile(configPath, JSON.stringify({
    apiKey: "file-key",
    endpoint: "http://file-endpoint",
  }))

  const config = loadCollectorConfig({
    configPath,
    homeDir: dir,
    env: {
      AGENT_INSIGHT_API_KEY: "env-key",
      AGENT_INSIGHT_OTLP_ENDPOINT: "http://env-endpoint",
    },
  })
  assert.equal(config.enabled, true)
  assert.equal(config.apiKey, "env-key")
  assert.equal(config.endpoint, "http://env-endpoint")

  const disabled = loadCollectorConfig({
    configPath: path.join(dir, "missing.json"),
    homeDir: dir,
    env: {},
  })
  assert.equal(disabled.enabled, false)
})
