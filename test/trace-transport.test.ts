import assert from "node:assert/strict"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const transport = require("../scripts/agent-trace-collectors/shared/trace-transport.cjs")

async function tempDir(t: test.TestContext) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-insight-transport-"))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  return dir
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    framework: "pi-agent",
    sessionId: "session-a",
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    eventId: "event-a",
    kind: "llm",
    name: "llm.test",
    startTimeMs: 1_700_000_000_000,
    endTimeMs: 1_700_000_000_100,
    input: "hello",
    output: "world",
    model: "test-model",
    usage: { input: 3, output: 4, total: 7 },
    ...overrides,
  }
}

test("transport derives stable API-key-isolated paths and identifiers", () => {
  const one = transport.collectorStateDir("pi-agent", "key-one", "/home/test")
  const two = transport.collectorStateDir("pi-agent", "key-two", "/home/test")
  assert.notEqual(one, two)
  assert.match(one, /pi-agent[\\/][0-9a-f]{12}$/)
  assert.equal(transport.stableTraceId("s", "x"), transport.stableTraceId("s", "x"))
  assert.equal(transport.stableTraceId("s", "x").length, 32)
  assert.equal(transport.stableSpanId("s", "x").length, 16)
  assert.throws(() => transport.collectorStateDir("../codex", "key", "/home/test"))
})

test("transport redacts recursively before Unicode code-point truncation", () => {
  const redacted = transport.redactValue({
    api_key: "secret-value",
    nested: {
      Authorization: "Bearer abc.def.ghi",
      text: "token sk-test_123456789012345 more",
    },
  })
  assert.equal(redacted.api_key, "[REDACTED]")
  assert.equal(redacted.nested.Authorization, "[REDACTED]")
  assert.doesNotMatch(redacted.nested.text, /sk-test/)
  const otlp = transport.redactValue({
    attributes: [
      { key: "user.email", value: { stringValue: "collector@example.invalid" } },
      { key: "input_token_count", value: { intValue: "123" } },
    ],
  })
  assert.equal(otlp.attributes[0].value.stringValue, "[REDACTED]")
  assert.equal(otlp.attributes[1].value.intValue, "123")

  const unicode = "🙂".repeat(2001)
  const truncated = transport.truncateCodePoints(unicode, 2000)
  assert.equal(Array.from(truncated.slice(0, 4000)).length, 2000)
  assert.match(truncated, /\[TRUNCATED original_chars=2001\]$/)
})

test("JSONL cursor consumes only complete lines and leaves a torn tail", async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, "events.jsonl")
  await transport.appendJsonl(file, { id: 1 })
  await transport.appendJsonl(file, { id: 2 })
  await fsp.appendFile(file, "{\"id\":3", "utf8")

  const batch = await transport.readJsonlBatch(file, 0)
  assert.deepEqual(batch.events, [{ id: 1 }, { id: 2 }])
  assert.equal(batch.tornTailBytes, Buffer.byteLength("{\"id\":3"))

  await fsp.appendFile(file, "}\n", "utf8")
  const finalBatch = await transport.readJsonlBatch(file, batch.nextOffset)
  assert.deepEqual(finalBatch.events, [{ id: 3 }])
})

test("atomic checkpoint replacement preserves the latest valid document", async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, "uploader-checkpoint.json")
  await transport.atomicWriteJson(file, { version: 1, files: { a: { bytes: 10 } } })
  await transport.atomicWriteJson(file, { version: 1, files: { a: { bytes: 20 } } })
  assert.equal((await transport.readCheckpoint(file)).files.a.bytes, 20)
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")).length, 0)
})

test("process lock prevents concurrent uploaders and verifies ownership on release", async (t) => {
  const dir = await tempDir(t)
  const lockPath = path.join(dir, "uploader.lock")
  const first = await transport.acquireProcessLock(lockPath)
  assert.ok(first)
  assert.equal(await transport.acquireProcessLock(lockPath), null)
  assert.equal(await transport.releaseProcessLock({ ...first, token: "wrong" }), false)
  assert.equal(await transport.releaseProcessLock(first), true)
  assert.ok(await transport.acquireProcessLock(lockPath))
})

test("OTLP builder maps canonical Pi semantics and usage", () => {
  const payload = transport.canonicalEventsToOtlp([
    event({
      tool: { name: "bash", type: "shell", arguments: { command: "pwd" }, result: "ok" },
      skill: { name: "demo", version: "abc123", triggerMode: "explicit" },
    }),
  ], { framework: "pi-agent" })

  const resource = payload.resourceSpans[0]
  const span = resource.scopeSpans[0].spans[0]
  const attrs = Object.fromEntries(span.attributes.map((item: {
    key: string
    value: Record<string, unknown>
  }) => {
    const value = Object.values(item.value)[0]
    return [item.key, value]
  }))
  assert.equal(attrs["agent.insight.framework"], "pi-agent")
  assert.equal(attrs["llm.token_count.total"], "7")
  assert.equal(attrs["tool.name"], "bash")
  assert.equal(attrs["skill.name"], "demo")
  assert.equal(span.traceId.length, 32)
  assert.equal(span.spanId.length, 16)
})

test("uploader advances checkpoint only after a 2xx response and replays without duplicates", async (t) => {
  const dir = await tempDir(t)
  const writer = new transport.DurableTraceWriter({
    framework: "pi-agent",
    apiKey: "test-key",
    stateDir: dir,
  })
  await writer.append(event({ eventId: "one", spanId: "1".repeat(16) }))
  await writer.append(event({ eventId: "two", spanId: "2".repeat(16) }))

  const statuses = [500, 200]
  const bodies: string[] = []
  const uploader = new transport.DurableTraceUploader({
    framework: "pi-agent",
    apiKey: "test-key",
    endpoint: "http://127.0.0.1/otel",
    stateDir: dir,
    maxRetries: 0,
    fetch: async (_url: string, init: { body: string }) => {
      bodies.push(init.body)
      const status = statuses.shift() ?? 200
      return new Response("", { status })
    },
  })

  await assert.rejects(() => uploader.flushOnce(), /HTTP 500/)
  const checkpointPath = path.join(dir, "uploader-checkpoint.json")
  assert.equal(fs.existsSync(checkpointPath), false)

  const recovered = await uploader.flushOnce()
  assert.equal(recovered.uploadedEvents, 2)
  const checkpoint = await transport.readCheckpoint(checkpointPath)
  const checkpointFiles = Object.values(checkpoint.files) as Array<{ lastEventId?: string }>
  assert.equal(checkpointFiles[0].lastEventId, "two")

  const replay = await uploader.flushOnce()
  assert.equal(replay.uploadedEvents, 0)
  assert.equal(bodies.length, 2)
})

test("backoff is exponential, bounded, and deterministic with injected jitter", () => {
  const values = [0, 1, 2, 3, 4].map((attempt) =>
    transport.computeBackoffMs(attempt, { baseMs: 100, maxMs: 800, jitter: 0, random: () => 0.5 }),
  )
  assert.deepEqual(values, [100, 200, 400, 800, 800])
})

test("retention removes only expired date partitions inside the framework namespace", async (t) => {
  const dir = await tempDir(t)
  const oldFile = path.join(dir, "2026-01-01", "events.jsonl")
  const freshFile = path.join(dir, "2026-01-10", "events.jsonl")
  await transport.appendJsonl(oldFile, { id: "old" })
  await transport.appendJsonl(freshFile, { id: "fresh" })
  const outside = path.join(path.dirname(dir), `${path.basename(dir)}-other`)
  await fsp.mkdir(outside, { recursive: true })
  await fsp.writeFile(path.join(outside, "keep"), "keep")
  t.after(() => fsp.rm(outside, { recursive: true, force: true }))

  const removed = await transport.cleanupRetention(dir, {
    now: Date.parse("2026-01-12T00:00:00.000Z"),
    retentionDays: 5,
  })
  assert.deepEqual(removed, [oldFile])
  assert.equal(fs.existsSync(freshFile), true)
  assert.equal(fs.existsSync(path.join(outside, "keep")), true)
})
