import assert from "node:assert/strict"
import fsp from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const {
  CodexTraceCore,
  extractOtlpLogRecords,
} = require("../scripts/agent-trace-collectors/codex/codex-trace-core.cjs")
const {
  createRelay,
  listRawFiles,
  replayRawOtel,
} = require("../scripts/agent-trace-collectors/codex/relay.cjs")
const transport = require("../scripts/agent-trace-collectors/shared/trace-transport.cjs")

type CapturedEvent = {
  spanId: string
  parentSpanId?: string
  kind: string
  name: string
  usage?: Record<string, number>
  tool?: {
    name?: string
    arguments?: unknown
    result?: unknown
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

function av(value: unknown): Record<string, unknown> {
  if (typeof value === "boolean") return { boolValue: value }
  if (typeof value === "number") return Number.isInteger(value)
    ? { intValue: String(value) }
    : { doubleValue: value }
  return { stringValue: String(value) }
}

function otlpLogs(
  eventName: string,
  attributes: Record<string, unknown>,
  resource: Record<string, unknown> = {},
) {
  return {
    resourceLogs: [{
      resource: {
        attributes: Object.entries({
          "service.name": "codex-cli",
          ...resource,
        }).map(([key, value]) => ({ key, value: av(value) })),
      },
      scopeLogs: [{
        scope: { name: "codex-otel", version: "0.145.0" },
        logRecords: [{
          timeUnixNano: "1700000000500000000",
          attributes: Object.entries({
            "event.name": eventName,
            ...attributes,
          }).map(([key, value]) => ({ key, value: av(value) })),
        }],
      }],
    }],
  }
}

function hook(eventName: string, overrides: Record<string, unknown> = {}) {
  return {
    hook_event_name: eventName,
    session_id: "session-a",
    turn_id: "turn-a",
    cwd: "D:\\repo",
    model: "gpt-test",
    ...overrides,
  }
}

async function tempDir(t: test.TestContext) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-relay-"))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  return dir
}

function httpJson(
  port: number,
  pathname: string,
  secret: string,
  body: unknown,
) {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const data = JSON.stringify(body)
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(data),
        "x-agent-insight-relay": secret,
      },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk) => chunks.push(chunk))
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8")
        resolve({
          status: response.statusCode || 0,
          body: text ? JSON.parse(text) : {},
        })
      })
    })
    request.on("error", reject)
    request.end(data)
  })
}

test("OTLP log parser preserves resource, scope, body, and event attributes", () => {
  const records = extractOtlpLogRecords(otlpLogs("codex.api_request", {
    "conversation.id": "session-a",
    status_code: 200,
  }, {
    originator: "codex_vscode",
  }))
  assert.equal(records.length, 1)
  assert.equal(records[0].eventName, "codex.api_request")
  assert.equal(records[0].attributes["conversation.id"], "session-a")
  assert.equal(records[0].attributes.originator, "codex_vscode")
  assert.equal(records[0].scope.version, "0.145.0")
})

test("OTel user_prompt uses length metadata without fabricating content", async () => {
  const writer = new MemoryWriter()
  const core = new CodexTraceCore({ writer })
  await core.processOtel(otlpLogs("codex.user_prompt", {
    "conversation.id": "prompt-session",
    "turn.id": "prompt-turn",
    prompt_length: 42,
  }))
  const root = writer.events.find((event) => event.kind === "agent")
  assert.equal(root?.input, "[REDACTED prompt length=42]")
})

test("Hook and native OTel merge exact Token, TTFT, and Tool facts by stable ids", async () => {
  const writer = new MemoryWriter()
  const core = new CodexTraceCore({ writer, now: () => 1_700_000_000_000 })
  await core.processHook(hook("SessionStart"))
  await core.processHook(hook("UserPromptSubmit", { prompt: "inspect" }))
  await core.processHook(hook("PreToolUse", {
    tool_name: "Bash",
    tool_use_id: "call-1",
    tool_input: { command: "pwd" },
  }))
  await core.processHook(hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "call-1",
    tool_response: "hook output",
  }))
  await core.processOtel(otlpLogs("codex.turn_ttft", {
    "conversation.id": "session-a",
    "turn.id": "turn-a",
    duration_ms: 125,
  }))
  await core.processOtel(otlpLogs("codex.tool_result", {
    "conversation.id": "session-a",
    "turn.id": "turn-a",
    tool_name: "Bash",
    call_id: "call-1",
    duration_ms: 50,
    success: true,
    output: "otel output",
  }))
  await core.processOtel(otlpLogs("codex.sse_event", {
    "conversation.id": "session-a",
    "turn.id": "turn-a",
    kind: "response.completed",
    response_id: "response-empty",
    input_token_count: 999,
    output_token_count: 0,
    reasoning_token_count: 0,
  }))
  await core.processOtel(otlpLogs("codex.sse_event", {
    "conversation.id": "session-a",
    "turn.id": "turn-a",
    kind: "response.completed",
    response_id: "response-1",
    input_token_count: 120,
    output_token_count: 30,
    cached_token_count: 40,
    reasoning_token_count: 7,
    total_token_count: 150,
    ttft_ms: 125,
  }))

  const tools = writer.events.filter((event) => event.kind === "tool")
  const llms = writer.events.filter((event) => event.kind === "llm")
  const llm = llms.at(-1)
  assert.equal(tools.length, 2)
  assert.equal(llms.length, 2)
  assert.deepEqual(llms[0]?.usage, {
    input: 999,
    output: 0,
    reasoning: 0,
    total: 999,
  })
  assert.equal(new Set(tools.map((event) => event.spanId)).size, 1)
  assert.equal(tools.at(-1)?.tool?.arguments?.command, "pwd")
  assert.equal(tools.at(-1)?.tool?.result, "otel output")
  assert.deepEqual(llm?.usage, {
    input: 120,
    output: 30,
    reasoning: 7,
    total: 150,
  })
  assert.equal(llm?.attributes?.["codex.ttft_ms"], 125)
  assert.equal(llm?.attributes?.["codex.usage.cache_read"], 40)
})

test("OTel Cloud IDs are preserved only when auth fields actually exist", async () => {
  const writer = new MemoryWriter()
  const core = new CodexTraceCore({ writer })
  await core.processOtel(otlpLogs("codex.sse_event", {
    "conversation.id": "cloud-session",
    kind: "response.completed",
    response_id: "cloud-response",
    input_token_count: 1,
    output_token_count: 2,
    "auth.agent_id": "agent-real",
    "auth.task_id": "task-real",
  }, {
    originator: "codex_vscode",
  }))
  const llm = writer.events.find((event) => event.kind === "llm")
  assert.equal(llm?.attributes?.["codex.cloud.agent_id"], "agent-real")
  assert.equal(llm?.attributes?.["codex.cloud.task_id"], "task-real")

  const writerWithout = new MemoryWriter()
  const coreWithout = new CodexTraceCore({ writer: writerWithout })
  await coreWithout.processOtel(otlpLogs("codex.sse_event", {
    "conversation.id": "no-cloud-session",
    kind: "response.completed",
    input_token_count: 1,
    output_token_count: 1,
  }))
  const absent = writerWithout.events.find((event) => event.kind === "llm")
  assert.equal(absent?.attributes?.["codex.cloud.agent_id"], undefined)
  assert.equal(absent?.attributes?.["codex.cloud.task_id"], undefined)
})

test("IDE events require exactly one active IDE turn with overlapping cwd", async () => {
  const writer = new MemoryWriter()
  const core = new CodexTraceCore({ writer })
  await core.processHook(hook("SessionStart"))
  await core.processHook(hook("UserPromptSubmit", { prompt: "edit" }))
  await core.processOtel(otlpLogs("codex.conversation_starts", {
    "conversation.id": "session-a",
    cwd: "D:\\repo",
    originator: "codex_vscode",
    "terminal.type": "vscode",
  }))
  const attributed = await core.processIdeEvent({
    type: "file_edit",
    eventId: "edit-1",
    workspaceFolders: ["D:\\repo"],
    relativePath: "src/app.ts",
    changes: [{ insertedLength: 4 }],
    cloudAgentId: "manual-agent",
  })
  assert.equal(attributed.attributed, true)
  assert.equal(writer.events.at(-1)?.attributes?.["codex.tool.source"], "ide")
  assert.equal(writer.events.at(-1)?.attributes?.["codex.cloud.agent_id"], "manual-agent")
  assert.equal(writer.events.at(-1)?.attributes?.["codex.cloud.id_source"], "user")

  await core.processHook({
    ...hook("SessionStart"),
    session_id: "session-b",
  })
  await core.processHook({
    ...hook("UserPromptSubmit", { prompt: "another" }),
    session_id: "session-b",
  })
  await core.processOtel(otlpLogs("codex.conversation_starts", {
    "conversation.id": "session-b",
    cwd: "D:\\repo",
    originator: "codex_vscode",
  }))
  const ambiguous = await core.processIdeEvent({
    type: "file_edit",
    workspaceFolders: ["D:\\repo"],
    relativePath: "src/app.ts",
    changes: [],
  })
  assert.equal(ambiguous.attributed, false)
  assert.equal(core.status().unattributed, 1)
})

test("relay durably appends raw OTel before acknowledging and advances raw checkpoint", async (t) => {
  const dir = await tempDir(t)
  const uploader = new MemoryUploader()
  const relay = await createRelay({
    config: {
      apiKey: "test-key",
      endpoint: "http://127.0.0.1:1/api/ingest/otel/v1/traces",
      installSecret: "relay-secret",
      relayPort: 43191,
      uploadIntervalMs: 300_000,
      homeDir: dir,
    },
    stateDir: dir,
    uploader,
    port: 0,
  })
  const address = await relay.start()
  t.after(() => relay.stop().catch(() => {}))

  const payload = otlpLogs("codex.sse_event", {
    "conversation.id": "session-relay",
    kind: "response.completed",
    input_token_count: 3,
    output_token_count: 4,
    "user.email": "collector-test@example.invalid",
    "user.account_id": "account-sensitive",
    "auth.token": "sk-collector-sensitive-value",
  })
  const response = await httpJson(address.port, "/v1/logs", "relay-secret", payload)
  assert.equal(response.status, 200)
  const [rawPath] = await listRawFiles(dir)
  assert.ok(rawPath)
  const canonicalPath = path.join(dir, "2023-11-14", "events.jsonl")
  assert.equal((await fsp.stat(rawPath)).isFile(), true)
  assert.equal((await fsp.stat(canonicalPath)).isFile(), true)
  const rawSource = await fsp.readFile(rawPath, "utf8")
  assert.doesNotMatch(rawSource, /collector-test@example\.invalid/)
  assert.doesNotMatch(rawSource, /account-sensitive/)
  assert.doesNotMatch(rawSource, /sk-collector-sensitive-value/)
  assert.match(rawSource, /\[REDACTED\]/)
  const checkpoint = await transport.readCheckpoint(path.join(dir, "raw-checkpoint.json"))
  assert.equal(
    checkpoint.files[path.relative(dir, rawPath).replaceAll(path.sep, "/")].bytes,
    (await fsp.stat(rawPath)).size,
  )
})

test("relay rejects unauthenticated loopback writers", async (t) => {
  const dir = await tempDir(t)
  const relay = await createRelay({
    config: {
      apiKey: "test-key",
      endpoint: "http://127.0.0.1:1/api/ingest/otel/v1/traces",
      installSecret: "right-secret",
      relayPort: 43191,
      uploadIntervalMs: 300_000,
      homeDir: dir,
    },
    stateDir: dir,
    uploader: new MemoryUploader(),
    port: 0,
  })
  const address = await relay.start()
  t.after(() => relay.stop().catch(() => {}))
  const response = await httpJson(
    address.port,
    "/hook",
    "wrong-secret",
    hook("SessionStart"),
  )
  assert.equal(response.status, 401)
})

test("relay continues processing raw OTel after a prior queue failure", async (t) => {
  const dir = await tempDir(t)
  let attempts = 0
  const core = {
    async processOtel() {
      attempts += 1
      if (attempts === 1) throw new Error("fixture processing failure")
    },
    snapshot() {
      return { version: 1 }
    },
    status() {
      return { version: 1 }
    },
  }
  const relay = await createRelay({
    config: {
      apiKey: "test-key",
      endpoint: "http://127.0.0.1:1/api/ingest/otel/v1/traces",
      installSecret: "relay-secret",
      relayPort: 43191,
      uploadIntervalMs: 300_000,
      homeDir: dir,
    },
    stateDir: dir,
    core,
    writer: new MemoryWriter(),
    uploader: new MemoryUploader(),
    port: 0,
  })
  const address = await relay.start()
  t.after(() => relay.stop().catch(() => {}))

  const first = await httpJson(address.port, "/v1/logs", "relay-secret", { first: true })
  const second = await httpJson(address.port, "/v1/logs", "relay-secret", { second: true })
  assert.equal(first.status, 500)
  assert.equal(second.status, 200)
  assert.equal(attempts, 2)
})

test("raw replay processes only complete JSONL lines and leaves a torn tail", async (t) => {
  const dir = await tempDir(t)
  const filePath = path.join(dir, "2026-07-27", "raw-otel.jsonl")
  await transport.appendJsonl(filePath, {
    payload: otlpLogs("codex.conversation_starts", {
      "conversation.id": "replay-session",
    }),
  })
  await fsp.appendFile(filePath, "{\"payload\":", "utf8")
  const writer = new MemoryWriter()
  const core = new CodexTraceCore({ writer })
  const replayed = await replayRawOtel(dir, core)
  assert.equal(replayed, 1)
  assert.equal(writer.events.length, 1)
  const checkpoint = await transport.readCheckpoint(path.join(dir, "raw-checkpoint.json"))
  assert.ok(checkpoint.files["2026-07-27/raw-otel.jsonl"].bytes < (await fsp.stat(filePath)).size)
})
