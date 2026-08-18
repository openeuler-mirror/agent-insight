/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createRequire } from "node:module"
import { PassThrough } from "node:stream"

const require = createRequire(import.meta.url)
const {
  classifyCodexSource,
} = require("../scripts/agent-trace-collectors/codex/source-classifier.cjs")
const {
  createCodexLifecycleReducer,
} = require("../scripts/agent-trace-collectors/codex/lifecycle-reducer.cjs")
const {
  createDesktopRolloutReader,
  recordsToLifecycleEvents,
} = require("../scripts/agent-trace-collectors/codex/rollout-reader.cjs")
const {
  createAppServerProtocolObserver,
  forwardJsonLines,
} = require("../scripts/agent-trace-collectors/codex/app-server-proxy.cjs")
const {
  createRelay,
} = require("../scripts/agent-trace-collectors/codex/relay.cjs")
const {
  aggregateCodexTraceEvents,
} = require("../src/lib/ingest/otel/adapters/codex.ts")
const { CodexTraceCore } = require("../scripts/agent-trace-collectors/codex/codex-trace-core.cjs")

class MemoryWriter {
  events: Array<Record<string, any>> = []

  async append(event: Record<string, any>) {
    this.events.push(structuredClone(event))
    return event
  }

  async flush() {}
}

function event(type: string, payload: Record<string, unknown>) {
  return { type: "event_msg", timestamp_ms: 1_700_000_000_000, payload: { type, ...payload } }
}

test("Codex source classification prioritizes Desktop and App Server evidence", () => {
  assert.equal(classifyCodexSource({ originator: "Codex Desktop", source: "exec" }).sourceKind, "desktop")
  assert.equal(classifyCodexSource({ clientName: "agent-insight-app-server", originator: "Codex Desktop" }).sourceKind, "app_server")
  assert.equal(classifyCodexSource({ originator: "codex_vscode" }).sourceKind, "ide")
  assert.equal(classifyCodexSource({ originator: "codex_tui" }).sourceKind, "cli")
  assert.equal(classifyCodexSource({ originator: "mystery" }).sourceKind, "unknown")
})

test("same source turn steer appends a phase without creating another execution", () => {
  const reducer = createCodexLifecycleReducer()
  const base = {
    source: "app_server",
    sourceKind: "desktop",
    sourceThreadId: "thread-1",
    provenance: { direct: true, confidence: "direct" },
  }
  reducer.apply({ ...base, eventId: "start", eventType: "execution_started", sourceExecutionId: "turn-1", timestampMs: 100 })
  reducer.apply({ ...base, eventId: "input-1", eventType: "user_input_accepted", sourceExecutionId: "turn-1", inputKind: "initial", timestampMs: 101, payload: { content: "initial" } })
  reducer.apply({ ...base, eventId: "input-2", eventType: "user_input_accepted", sourceExecutionId: "turn-1", inputKind: "steer", timestampMs: 200, clientMessageId: "msg-2", payload: { content: "focus on the failing test" } })
  const snapshot = reducer.snapshot()
  assert.equal(snapshot.executions.length, 1)
  assert.equal(snapshot.executions[0].query, "initial")
  assert.deepEqual(snapshot.executions[0].inputs.map((input: any) => input.input_kind), ["initial", "steer"])
  assert.deepEqual(snapshot.executions[0].phases.map((phase: any) => phase.inputKind), ["initial", "steer"])
})

test("interrupt followed by a new Desktop task creates two executions and a transition", () => {
  const reducer = createCodexLifecycleReducer()
  const base = { source: "desktop_rollout", sourceKind: "desktop", sourceThreadId: "thread-2", provenance: { direct: true, confidence: "direct" } }
  reducer.apply({ ...base, eventId: "a-start", eventType: "execution_started", sourceExecutionId: "task-a", timestampMs: 100 })
  reducer.apply({ ...base, eventId: "a-input", eventType: "user_input_accepted", sourceExecutionId: "task-a", timestampMs: 101, payload: { content: "build the feature" } })
  reducer.apply({ ...base, eventId: "a-stop", eventType: "execution_interrupted", sourceExecutionId: "task-a", timestampMs: 200, payload: { reason: "interrupted" } })
  reducer.apply({ ...base, eventId: "b-start", eventType: "execution_started", sourceExecutionId: "task-b", timestampMs: 201 })
  const snapshot = reducer.snapshot()
  assert.equal(snapshot.executions.length, 2)
  assert.equal(snapshot.executions.find((item: any) => item.sourceExecutionId === "task-a").status, "interrupted")
  assert.equal(snapshot.transitions.length, 1)
  assert.equal(snapshot.transitions[0].kind, "interrupt_followed_by_execution")
})

test("lifecycle reducer emits a thread-only transition snapshot without a third execution", () => {
  const reducer = createCodexLifecycleReducer()
  const base = { source: "desktop_rollout", sourceKind: "desktop", sourceThreadId: "thread-transition", provenance: { direct: true, confidence: "direct" } }
  reducer.apply({ ...base, eventId: "first-start", eventType: "execution_started", sourceExecutionId: "first", timestampMs: 100 })
  reducer.apply({ ...base, eventId: "first-stop", eventType: "execution_interrupted", sourceExecutionId: "first", timestampMs: 200 })
  const next = reducer.apply({ ...base, eventId: "second-start", eventType: "execution_started", sourceExecutionId: "second", timestampMs: 201 })
  assert.equal(reducer.snapshot().executions.length, 2)
  const transition = next.snapshots.find((item: any) => item.eventType === "thread_event_snapshot")
  assert.equal(transition?.payload?.kind, "execution_transition")
  assert.equal(transition?.payload?.previousSourceExecutionId, "first")
  assert.equal(transition?.payload?.nextSourceExecutionId, "second")
})

test("Desktop rollout reader deduplicates compaction signals and preserves torn-tail offset", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-desktop-rollout-"))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const sessions = path.join(root, "sessions")
  const stateDir = path.join(root, "state")
  await fsp.mkdir(sessions, { recursive: true })
  const rollout = path.join(sessions, "rollout-demo.jsonl")
  const records = [
    { type: "session_meta", payload: { id: "desktop-thread", originator: "Codex Desktop", source: "exec", cli_version: "0.146.0" } },
    event("task_started", { turn_id: "task-a" }),
    event("user_message", { turn_id: "task-a", message: "first request" }),
    event("turn_aborted", { turn_id: "task-a", reason: "interrupted" }),
    event("task_started", { turn_id: "task-b" }),
    event("user_message", { turn_id: "task-b", message: "redirected request" }),
    { type: "compacted", timestamp_ms: 1_700_000_000_000, payload: { window_id: "window-2", previous_window_id: "window-1", window_number: 2 } },
    { type: "context_compacted", timestamp_ms: 1_700_000_000_020, payload: {} },
    event("task_complete", { turn_id: "task-b", status: "completed" }),
  ]
  await fsp.writeFile(rollout, `${records.map((item) => JSON.stringify(item)).join("\n")}\n{`, "utf8")
  const collected: any[] = []
  const reader = createDesktopRolloutReader({ enabled: true, sessionsDir: sessions, stateDir, onEvents: async (items: any[]) => collected.push(...items) })
  const first = await reader.scan()
  assert.ok(first.events > 0)
  assert.equal(collected.filter((item) => item.eventType === "context_compaction_completed").length, 2)
  const reducer = createCodexLifecycleReducer()
  for (const item of collected) reducer.apply(item)
  const snapshot = reducer.snapshot()
  assert.equal(snapshot.executions.length, 2)
  assert.equal(snapshot.executions.find((item: any) => item.sourceExecutionId === "task-a").status, "interrupted")
  assert.equal(snapshot.compactions.length, 1)
  const checkpoint = JSON.parse(await fsp.readFile(reader.checkpointPath, "utf8"))
  const before = checkpoint.files["rollout-demo.jsonl"].bytes
  assert.ok(before < (await fsp.stat(rollout)).size)
  await fsp.appendFile(rollout, "}\n", "utf8")
  const second = await reader.scan()
  assert.equal(second.events, 0)
  const after = JSON.parse(await fsp.readFile(reader.checkpointPath, "utf8"))
  assert.equal(after.files["rollout-demo.jsonl"].bytes, (await fsp.stat(rollout)).size)
})

test("Desktop rollout reader preserves ISO-8601 timestamps for lifecycle events", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-desktop-rollout-iso-time-"))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const sessions = path.join(root, "sessions")
  await fsp.mkdir(sessions, { recursive: true })
  const timestamp = "2026-08-16T00:14:28.000Z"
  const rollout = path.join(sessions, "rollout-iso.jsonl")
  const records = [
    { type: "session_meta", timestamp, payload: { id: "iso-thread", originator: "Codex Desktop" } },
    { type: "event_msg", timestamp, payload: { type: "task_started", turn_id: "iso-task" } },
    { type: "event_msg", timestamp, payload: { type: "user_message", turn_id: "iso-task", message: "iso request" } },
    { type: "compacted", timestamp, payload: { window_id: "iso-window", window_number: 1 } },
  ]
  await fsp.writeFile(rollout, `${records.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8")
  const collected: any[] = []
  const reader = createDesktopRolloutReader({
    enabled: true,
    sessionsDir: sessions,
    stateDir: path.join(root, "state"),
    onEvents: async (items: any[]) => collected.push(...items),
  })
  await reader.scan()
  const expected = Date.parse(timestamp)
  assert.ok(collected.length > 0)
  assert.equal(collected.every((item) => item.timestampMs === expected), true)
})

test("disabled Desktop rollout reader does not inspect the sessions directory", async () => {
  const reader = createDesktopRolloutReader({ enabled: false, sessionsDir: path.join(os.tmpdir(), "does-not-exist-codex-sessions") })
  assert.deepEqual(await reader.scan(), { files: 0, events: 0, skipped: true })
})

test("lifecycle snapshots enter the existing Codex event spool with stable source identity", async () => {
  const writer = new MemoryWriter()
  const core = new CodexTraceCore({ writer, now: () => 1_700_000_000_000 })
  const base = { source: "desktop_rollout", sourceKind: "desktop", sourceThreadId: "thread-3", sourceExecutionId: "task-1", provenance: { direct: true, confidence: "direct" } }
  await core.processLifecycleEvent({ ...base, eventId: "start", eventType: "execution_started", timestampMs: 100 })
  await core.processLifecycleEvent({ ...base, eventId: "input", eventType: "user_input_accepted", inputKind: "initial", timestampMs: 101, payload: { content: "inspect" } })
  await core.processLifecycleEvent({ ...base, eventId: "stop", eventType: "execution_interrupted", timestampMs: 200, payload: { reason: "interrupted" } })
  const root = writer.events.filter((event) => event.kind === "agent").at(-1)
  assert.equal(root?.attributes?.["codex.source.kind"], "desktop")
  assert.equal(root?.attributes?.["codex.execution.status"], "interrupted")
  assert.match(root?.attributes?.["codex.input.history"], /inspect/)
})

test("rollout converter ignores unknown records without falling back to generic trace", () => {
  const converted = recordsToLifecycleEvents({ type: "event_msg", payload: { type: "future_record", secret: "token=abc" } }, {
    sourceThreadId: "thread-4", sourceKind: "desktop", unknownRecords: 0,
  })
  assert.equal(converted.events.length, 0)
  assert.equal(converted.context.unknownRecords, 1)
})

test("App Server observer commits steer only after a successful response", async () => {
  const events: any[] = []
  const observer = createAppServerProtocolObserver({ now: () => 500, onEvent: async (item: any) => events.push(item) })
  await observer.observeMessage({ id: 1, method: "initialize", params: { clientInfo: { name: "codex-desktop" } } }, "client")
  await observer.observeMessage({ id: 2, method: "thread/start", params: {} }, "client")
  await observer.observeMessage({ id: 2, result: { thread: { id: "thread-app" } } }, "server")
  await observer.observeMessage({ id: 3, method: "turn/start", params: { threadId: "thread-app", input: "initial" } }, "client")
  await observer.observeMessage({ id: 3, result: { turn: { id: "turn-app" } } }, "server")
  await observer.observeMessage({ id: 4, method: "turn/steer", params: { threadId: "thread-app", expectedTurnId: "turn-app", input: "steer" } }, "client")
  assert.equal(events.filter((item) => item.inputKind === "steer").length, 0)
  await observer.observeMessage({ id: 4, error: { code: -32000, message: "stale turn" } }, "server")
  assert.equal(events.filter((item) => item.inputKind === "steer").length, 0)
  await observer.observeMessage({ id: 5, method: "turn/steer", params: { threadId: "thread-app", expectedTurnId: "turn-app", input: "accepted steer" } }, "client")
  await observer.observeMessage({ id: 5, result: { turn: { id: "turn-app" } } }, "server")
  assert.equal(events.filter((item) => item.inputKind === "steer").length, 1)
  assert.equal(events.filter((item) => item.eventType === "execution_started").length, 1)
  assert.equal(events.every((item) => item.sourceKind === "app_server"), true)
})

test("App Server compaction uses item id and keeps legacy notifications compatible", async () => {
  const events: any[] = []
  const observer = createAppServerProtocolObserver({ now: () => 800, onEvent: async (item: any) => events.push(item) })
  await observer.observeMessage({ method: "item/started", params: { threadId: "thread-c", item: { id: "compact-1", type: "contextCompaction" } } }, "server")
  await observer.observeMessage({ method: "item/completed", params: { threadId: "thread-c", item: { id: "compact-1", type: "contextCompaction" } } }, "server")
  await observer.observeMessage({ method: "thread/compacted", params: { threadId: "thread-c", itemId: "compact-1" } }, "server")
  assert.deepEqual(events.map((item) => item.eventType), ["context_compaction_started", "context_compaction_completed", "context_compaction_completed"])
  assert.equal(observer.diagnostics.protocolErrors, 0)
})

test("server Codex adapter keeps initial query, steer phase, source and compaction timeline", () => {
  const base = {
    receivedAt: new Date(100).toISOString(),
    framework: "codex",
    sessionId: "codex:thread-ui:turn:task-ui",
    traceId: "trace-ui",
    serviceName: "codex",
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    latencyMs: 10,
    startTimeMs: 100,
    attributes: {},
  }
  const record = aggregateCodexTraceEvents("codex:thread-ui:turn:task-ui", [
    {
      ...base,
      spanId: "execution-span",
      kind: "agent",
      name: "agent.codex",
      input: "initial query",
      startTimeMs: 100,
      endTimeMs: 200,
      attributes: {
        "agent.insight.lifecycle": "execution",
        "codex.source.kind": "desktop",
        "codex.source.thread_id": "thread-ui",
        "codex.source.execution_id": "task-ui",
        "codex.execution.status": "interrupted",
        "codex.input.history": JSON.stringify([
          { role: "user", content: "initial query", input_kind: "initial", input_index: 0, phase_id: "phase-0", timestamp: new Date(100).toISOString() },
          { role: "user", content: "steer query", input_kind: "steer", input_index: 1, phase_id: "phase-1", timestamp: new Date(150).toISOString() },
        ]),
      },
    },
    {
      ...base,
      spanId: "compaction-span",
      kind: "span",
      name: "context.compaction",
      startTimeMs: 180,
      endTimeMs: 190,
      attributes: {
        "agent.insight.lifecycle": "compaction",
        "codex.source.kind": "desktop",
        "codex.compaction.item_id": "window-2",
        "codex.compaction.status": "completed",
        "codex.compaction.duration_ms": 10,
      },
    },
  ] as any)
  assert.equal(record?.query, "initial query")
  assert.equal(record?.sourceKind, "desktop")
  assert.equal(record?.executionStatus, "interrupted")
  assert.deepEqual(record?.interactions?.filter((item: any) => item.role === "user").map((item: any) => item.input_kind), ["initial", "steer"])
  assert.equal(record?.interactions?.some((item: any) => item.type === "context_compaction"), true)
  assert.equal(record?.sourceExecutionId, "task-ui")
  assert.equal(record?.traceThread?.sourceThreadId, "thread-ui")
  assert.equal(record?.traceThread?.events?.some((item: any) => item.kind === "input_steer"), true)
})

test("Codex adapter returns compaction as thread-only persistence instead of a fake Execution", () => {
  const result = aggregateCodexTraceEvents("thread-only", [{
    sessionId: "thread-only",
    framework: "codex",
    traceId: "trace-thread-only",
    spanId: "compaction-span",
    kind: "span",
    name: "context.compaction",
    startTimeMs: 100,
    endTimeMs: 250,
    user: "alice",
    attributes: {
      "agent.insight.lifecycle": "compaction",
      "codex.source.kind": "desktop",
      "codex.source.thread_id": "thread-only",
      "codex.compaction.item_id": "window-2",
      "codex.compaction.status": "completed",
      "codex.compaction.duration_ms": 150,
      "codex.compaction.payload": JSON.stringify({ window_id: "window-2", window_number: 2, secret: "removed" }),
    },
  }] as any)
  assert.equal(result?.threadOnly, true)
  assert.equal(result?.task_id, "codex:thread-only:thread-events")
  assert.equal(result?.traceThread?.events?.length, 1)
  assert.equal(result?.traceThread?.events?.[0].kind, "context_compaction")
  assert.equal((result?.traceThread?.events?.[0].payload as any)?.windowNumber, 2)
  assert.equal((result?.traceThread?.events?.[0].payload as any)?.secret, undefined)
})

test("App Server stdio forwarding preserves JSONL bytes while observing lifecycle", async () => {
  const events: any[] = []
  const observer = createAppServerProtocolObserver({ onEvent: async (item: any) => events.push(item) })
  const input = new PassThrough()
  const output = new PassThrough()
  let forwarded = ""
  output.setEncoding("utf8")
  output.on("data", (chunk) => { forwarded += chunk })
  const pending = forwardJsonLines(input, output, "client", observer)
  const lines = [
    JSON.stringify({ id: 1, method: "turn/start", params: { threadId: "thread-forward", input: "hello" } }),
    "not-json-but-still-forwarded",
  ]
  input.end(`${lines.join("\n")}\n`)
  await pending
  assert.equal(forwarded, `${lines.join("\n")}\n`)
  assert.equal(observer.diagnostics.malformed, 1)
  assert.equal(observer.pending.size, 1)
})

test("relay accepts authenticated lifecycle events from the App Server proxy", async (t) => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-lifecycle-relay-"))
  t.after(() => fsp.rm(stateDir, { recursive: true, force: true }))
  const writer = new MemoryWriter()
  const uploader = { start() {}, stop() {}, async flushOnce() { return { uploaded: 0 } } }
  const relay = await createRelay({
    config: {
      enabled: true,
      apiKey: "test-key",
      endpoint: "https://example.invalid/api/ingest/otel/v1/traces",
      installSecret: "test-secret",
      relayPort: 43191,
      uploadIntervalMs: 60_000,
      homeDir: stateDir,
      desktopRolloutIngress: false,
      desktopRolloutScanIntervalMs: 10_000,
    },
    stateDir,
    writer,
    uploader,
    port: 0,
  })
  const address = await relay.start()
  t.after(() => relay.stop())
  const base = `http://127.0.0.1:${address.port}`
  const response = await fetch(`${base}/lifecycle-event`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-insight-relay": "test-secret" },
    body: JSON.stringify({
      eventId: "relay-event",
      eventType: "execution_started",
      source: "app_server",
      sourceKind: "app_server",
      sourceThreadId: "relay-thread",
      sourceExecutionId: "relay-turn",
      timestampMs: 100,
      payload: {},
      provenance: { direct: true, confidence: "direct" },
    }),
  })
  assert.equal(response.status, 200)
  assert.equal(writer.events.some((item) => item.attributes?.["codex.source.kind"] === "app_server"), true)
})

test("server persistence and session API retain Codex source identity and status", async () => {
  const [schema, storage, sessionRoute] = await Promise.all([
    fsp.readFile(path.join(process.cwd(), "prisma", "schema.prisma"), "utf8"),
    fsp.readFile(path.join(process.cwd(), "src", "lib", "storage", "data-service.ts"), "utf8"),
    fsp.readFile(path.join(process.cwd(), "src", "app", "api", "observe", "session", "route.ts"), "utf8"),
  ])
  for (const field of ["sourceExecutionId", "sourceKind", "executionStatus"]) {
    assert.match(schema, new RegExp(`\\b${field}\\s+String\\?`))
    assert.ok(storage.split(`${field}: targetRecord.${field}`).length >= 3, `${field} must be persisted on create and update`)
    assert.match(sessionRoute, new RegExp(`\\b${field}\\b`))
  }
  assert.match(schema, /model TraceThread \{/)
  assert.match(schema, /model TraceThreadEvent \{/)
  assert.match(storage, /threadOnly/)
  assert.match(storage, /traceThreadEvent\.upsert/)
  assert.match(sessionRoute, /thread/)
})
