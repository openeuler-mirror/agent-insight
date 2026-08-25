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
  createCollector,
  isSubagentWorkerProcess,
  loadCollectorConfig,
  parseMcpIdentity,
  skillVersion,
} = require("../scripts/agent-trace-collectors/pi-agent/lib/pi-trace-core.cjs")

type CapturedEvent = {
  eventId?: string
  kind: string
  spanId: string
  parentSpanId?: string
  status?: string
  startTimeMs?: number
  endTimeMs?: number
  output?: string
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

  assert.deepEqual(writer.events.map((event) => event.kind).sort(), ["agent", "llm", "skill", "skill", "tool"])
  const skillEvents = writer.events.filter((event) => event.kind === "skill")
  const skillStart = skillEvents.find((event) => event.status === "running")
  const skillEvent = skillEvents.find((event) => event.status === "success")
  const toolEvent = writer.events.find((event) => event.kind === "tool")
  const llmEvent = writer.events.find((event) => event.kind === "llm")
  assert.ok(skillStart)
  assert.ok(skillEvent)
  assert.ok(toolEvent)
  assert.ok(llmEvent)
  assert.equal(skillEvent.skill.version, "2.4.0")
  assert.equal(skillEvent.skill.triggerMode, "explicit")
  assert.match(skillEvent.output || "", /Skill: fixture-skill/)
  assert.match(skillEvent.output || "", /# Fixture/)
  assert.doesNotMatch(skillEvent.output || "", /^answer$/)
  assert.equal(skillStart.eventId, skillEvent.eventId)
  assert.equal(skillStart.spanId, skillEvent.spanId)
  assert.equal(skillStart.startTimeMs, skillStart.endTimeMs)
  assert.ok(writer.events.indexOf(skillStart) < writer.events.indexOf(toolEvent))
  await Promise.resolve()
  assert.ok(uploader.flushed >= 1)
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
  // Skill 的 running 快照和最终聚合快照都应各触发一次上传。
  assert.ok(uploader.flushed >= 2)
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

  const skillEvent = writer.events.find((event) => event.kind === "skill" && event.status === "success")
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

test("Pi collector derives a distinct session id per agent task within one Pi session", async (t) => {
  const { instance, writer } = collector()
  // 任务 1
  instance.recordInput("task one")
  instance.beginAgent({ prompt: "task one", systemPromptOptions: {} }, context())
  instance.recordMessage(assistant())
  instance.recordAgentEnd({ messages: [assistant()] })
  await instance.settleAgent()
  // 任务 2
  instance.recordInput("task two")
  instance.beginAgent({ prompt: "task two", systemPromptOptions: {} }, context())
  instance.recordMessage(assistant())
  instance.recordAgentEnd({ messages: [assistant()] })
  await instance.settleAgent()

  const agentEvents = writer.events.filter((event) => event.kind === "agent")
  assert.equal(agentEvents.length, 2)
  const sessions = agentEvents.map((event) => event.sessionId)
  assert.notEqual(sessions[0], sessions[1])
  assert.match(sessions[0], /session-a__task\d+/)
  assert.match(sessions[1], /session-a__task\d+/)
  // 每个任务的 agent 事件归属各自 session
  assert.equal(agentEvents[0].sessionId, sessions[0])
  assert.equal(agentEvents[1].sessionId, sessions[1])
})

test("isSubagentWorkerProcess detects only delegation worker processes", () => {
  // subagent/skill 扩展 spawn 的 worker：--mode json -p --no-session "Task: <task>"
  assert.equal(
    isSubagentWorkerProcess(["pi", "--mode", "json", "-p", "--no-session", "Task: read the file"]),
    true,
  )
  assert.equal(
    isSubagentWorkerProcess([
      "pi", "--mode", "json", "--print", "--no-session",
      "--model", "deepseek-v4-pro", "--tools", "read,write",
      "Task: compute the checksum",
    ]),
    true,
  )
  // 交互 TUI：不应命中
  assert.equal(isSubagentWorkerProcess(["pi"]), false)
  // 演示 text 模式（--print 但无 --mode json）：不应命中
  assert.equal(
    isSubagentWorkerProcess(["pi", "--print", "--no-session", "read the file"]),
    false,
  )
  // json 模式但没有 "Task: " 前缀 message：不应命中
  assert.equal(
    isSubagentWorkerProcess(["pi", "--mode", "json", "-p", "--no-session", "read the file"]),
    false,
  )
  // 缺 --no-session：不应命中
  assert.equal(
    isSubagentWorkerProcess(["pi", "--mode", "json", "-p", "Task: read the file"]),
    false,
  )
})

test("createCollector skips collection inside a subagent worker process", () => {
  const base = {
    config: {
      enabled: true,
      apiKey: "key",
      endpoint: "http://127.0.0.1/otel",
      homeDir: os.tmpdir(),
      uploadIntervalMs: 300_000,
      shutdownTimeoutMs: 100,
    },
  }
  assert.equal(
    createCollector({ ...base, argv: ["pi", "--mode", "json", "-p", "--no-session", "Task: read the file"] }),
    null,
  )
  // 正常进程不受影响
  assert.ok(createCollector({ ...base, argv: ["pi"] }) instanceof PiTraceCollector)
})

test("Pi collector derives worker subagent LLM spans with non-zero durations", async () => {
  const { instance, writer } = collector()
  instance.recordInput("delegate")
  instance.beginAgent({ prompt: "delegate", systemPromptOptions: { skills: [] } }, context())
  instance.beginTool({ toolCallId: "sub-1", toolName: "subagent", args: { task: "worker" } })
  instance.endTool({
    toolCallId: "sub-1",
    toolName: "subagent",
    isError: false,
    result: {
      content: [{ type: "text", text: "done" }],
      details: {
        results: [{
          agent: "worker",
          task: "worker",
          exitCode: 0,
          model: "model-a",
          usage: { input: 5, output: 2, totalTokens: 7 },
          messages: [
            assistant({ content: [{ type: "text", text: "first" }], timestamp: 1_700_000_000_100 }),
            {
              role: "toolResult",
              toolCallId: "t-1",
              toolName: "read",
              content: [{ type: "text", text: "file" }],
              timestamp: 1_700_000_000_500,
            },
            assistant({ content: [{ type: "text", text: "second" }], timestamp: 1_700_000_001_000 }),
          ],
        }],
      },
    },
  })
  await instance.settleAgent()

  const subagentEvent = writer.events.find((e) => e.kind === "subagent")
  assert.ok(subagentEvent, "subagent event exists")
  // worker 子代理下的 LLM span：parentSpanId 指向 subagent span
  const workerLlm = writer.events.filter((e) => e.kind === "llm" && e.parentSpanId === subagentEvent.spanId)
  assert.equal(workerLlm.length, 2)
  // 第一条：从 subagent span 起点（首条消息 timestamp 之前）到第一条 assistant 完成
  assert.ok(workerLlm[0].startTimeMs != null && workerLlm[0].endTimeMs != null)
  assert.ok((workerLlm[0].endTimeMs! - workerLlm[0].startTimeMs!) > 0, "first worker LLM should have non-zero duration")
  // 第二条：从第一条 assistant 完成到第二条 assistant 完成
  assert.equal(workerLlm[1].startTimeMs, 1_700_000_000_100)
  assert.equal(workerLlm[1].endTimeMs, 1_700_000_001_000)
  assert.ok((workerLlm[1].endTimeMs! - workerLlm[1].startTimeMs!) === 900, "second worker LLM duration spans gap")
  assert.deepEqual(workerLlm.map((event) => event.attributes), [
    { "pi.usage.cache_read": 3, "pi.usage.cache_write": 1 },
    { "pi.usage.cache_read": 3, "pi.usage.cache_write": 1 },
  ])
  // 整体与 subagent span 对齐：最后一条 end 不应超过 subagent span 的 end
  assert.ok((workerLlm[1].endTimeMs!) <= (subagentEvent.endTimeMs!), "last LLM end within subagent span")
})
