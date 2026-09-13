import assert from "node:assert/strict"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const repair = require("../scripts/repair-goal-plus-pi-spool.cjs")

async function tempDir(t: test.TestContext) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "goal-plus-spool-repair-"))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  return dir
}

function jsonLine(value: Record<string, unknown>, ending = "\n") {
  return `${JSON.stringify(value)}${ending}`
}

function collectorEvent(overrides: Record<string, unknown> = {}) {
  return {
    framework: "pi-agent",
    sessionId: "goal-plus:source:session-a",
    eventId: "event-a",
    spanId: "span-a",
    status: "running",
    output: "first",
    ...overrides,
  }
}

function serverEvent(overrides: Record<string, unknown> = {}) {
  return {
    receivedAt: "2026-01-01T00:00:00.000Z",
    sessionId: "goal-plus:source:session-a",
    spanId: "span-a",
    serviceName: "pi-agent",
    attributes: {
      "agent.insight.framework": "pi-agent",
      "agent.insight.event_id": "event-a",
      "tool.outcome": "running",
    },
    ...overrides,
  }
}

test("collector dry-run keeps only the last semantic version in its projection", async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, "events.jsonl")
  const nonTargetOne = `  ${JSON.stringify({ framework: "codex", sessionId: "goal-plus:other", eventId: "keep-a" })}  \r\n`
  const first = jsonLine(collectorEvent())
  const exactDuplicate = jsonLine({
    output: "first",
    status: "running",
    spanId: "span-a",
    eventId: "event-a",
    sessionId: "goal-plus:source:session-a",
    framework: "pi-agent",
  })
  const latest = jsonLine(collectorEvent({ status: "success", output: "latest" }))
  const secondKey = jsonLine(collectorEvent({ eventId: "event-b", spanId: "span-b", output: "second" }))
  const ordinaryPi = jsonLine(collectorEvent({ sessionId: "ordinary-pi", eventId: "keep-b" }))
  const goalWithoutPi = jsonLine(collectorEvent({ framework: "other", eventId: "keep-c" }))
  await fsp.writeFile(file, nonTargetOne + first + exactDuplicate + latest + secondKey + ordinaryPi + goalWithoutPi)

  const report = await repair.dryRunFile(file, "collector")

  assert.equal(report.mode, "dry-run")
  assert.equal(report.applied, false)
  assert.equal(report.targetRows, 4)
  assert.equal(report.uniqueTargetKeys, 2)
  assert.equal(report.exactDuplicateRows, 1)
  assert.equal(report.semanticRevisionRows, 1)
  assert.equal(report.removableTargetRows, 2)
  assert.equal(report.duplicateRate, 0.5)
  assert.equal(report.nonTargetRows, 3)
  assert.equal(report.safeToApply, true)
  assert.equal(
    report.projectedBytes,
    Buffer.byteLength(nonTargetOne + latest + secondKey + ordinaryPi + goalWithoutPi),
  )
  assert.equal(await fsp.readFile(file, "utf8"), nonTargetOne + first + exactDuplicate + latest + secondKey + ordinaryPi + goalWithoutPi)
})

test("default CLI invocation is a zero-write dry-run", async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, "events.jsonl")
  const original = jsonLine(collectorEvent()) + jsonLine(collectorEvent())
  await fsp.writeFile(file, original)
  const before = (await fsp.readdir(dir)).sort()
  let output = ""

  const result = await repair.run(
    ["--kind", "collector", "--path", file, "--json"],
    { stdout: { write: (text: string) => { output += text } } },
  )

  assert.equal(result.mode, "dry-run")
  assert.match(output, /"mode": "dry-run"/)
  assert.equal(await fsp.readFile(file, "utf8"), original)
  assert.deepEqual((await fsp.readdir(dir)).sort(), before)
})

test("collector apply preserves non-target bytes, backs up without overwrite, and only recommends a mapped checkpoint", async (t) => {
  const dir = await tempDir(t)
  const stateDir = path.join(dir, "api-hash")
  const dayDir = path.join(stateDir, "2026-01-01")
  const file = path.join(dayDir, "events.jsonl")
  await fsp.mkdir(dayDir, { recursive: true })

  const nonTargetOne = ` ${JSON.stringify({ framework: "pi-agent", sessionId: "ordinary-pi", eventId: "keep-1" })}\r\n`
  const oldTarget = jsonLine(collectorEvent({ output: "old" }))
  const nonTargetTwo = "\n"
  const newTarget = jsonLine(collectorEvent({ status: "success", output: "new" }))
  const secondTarget = jsonLine(collectorEvent({ eventId: "event-b", spanId: "span-b", output: "second" }))
  const nonTargetThree = jsonLine({ framework: "codex", sessionId: "goal-plus:source:session-a", eventId: "keep-3" })
  const original = nonTargetOne + oldTarget + nonTargetTwo + newTarget + secondTarget + nonTargetThree
  const expected = nonTargetOne + nonTargetTwo + newTarget + secondTarget + nonTargetThree
  await fsp.writeFile(file, original)

  const cursorBytes = Buffer.byteLength(nonTargetOne + oldTarget + nonTargetTwo)
  const checkpoint = {
    version: 1,
    files: {
      "2026-01-01/events.jsonl": { bytes: cursorBytes, lastEventId: "event-a" },
      "2025-12-31/events.jsonl": { bytes: 99, lastEventId: "unrelated" },
    },
  }
  const checkpointPath = path.join(stateDir, "uploader-checkpoint.json")
  const checkpointText = `${JSON.stringify(checkpoint, null, 2)}\n`
  await fsp.writeFile(checkpointPath, checkpointText)

  const now = new Date("2026-01-02T03:04:05.006Z")
  const occupiedBackup = `${file}.bak.20260102T030405006Z`
  await fsp.writeFile(occupiedBackup, "existing-backup")

  const report = await repair.compactFile(file, "collector", {
    confirmWritersStopped: true,
    now,
  })

  assert.equal(report.applied, true)
  assert.equal(report.backup, `${occupiedBackup}-1`)
  assert.equal(await fsp.readFile(file, "utf8"), expected)
  assert.equal(await fsp.readFile(report.backup, "utf8"), original)
  assert.equal(await fsp.readFile(occupiedBackup, "utf8"), "existing-backup")
  assert.equal(await fsp.readFile(checkpointPath, "utf8"), checkpointText)
  assert.equal(report.checkpoint.modifiedByTool, false)
  assert.equal(report.checkpoint.status, "stale-after-apply")
  assert.equal(report.checkpoint.untouchedEntries, 1)
  assert.equal(
    report.checkpoint.suggestedCursorBytes,
    Buffer.byteLength(nonTargetOne + nonTargetTwo),
  )
  assert.match(report.checkpoint.recommendation, /preserve all other entries/)
})

test("server mode ignores receivedAt for duplicate statistics and retains the last raw revision", async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, "traces.jsonl")
  const first = jsonLine(serverEvent())
  const receivedAgain = jsonLine(serverEvent({
    receivedAt: "2026-01-01T00:01:00.000Z",
  }))
  const latest = jsonLine(serverEvent({
    receivedAt: "2026-01-01T00:02:00.000Z",
    attributes: {
      "agent.insight.framework": "pi-agent",
      "agent.insight.event_id": "event-a",
      "tool.outcome": "success",
    },
  }))
  const spanFallback = jsonLine(serverEvent({
    spanId: "span-b",
    attributes: { "agent.insight.framework": "pi-agent", "tool.outcome": "success" },
  }))
  const ordinaryPi = jsonLine(serverEvent({ sessionId: "ordinary-pi", spanId: "keep" }))
  const otherFramework = jsonLine(serverEvent({
    spanId: "keep-other",
    attributes: { "agent.insight.framework": "codex" },
  }))
  await fsp.writeFile(file, first + receivedAgain + latest + spanFallback + ordinaryPi + otherFramework)

  const report = await repair.dryRunFile(file, "server")

  assert.equal(report.targetRows, 4)
  assert.equal(report.uniqueTargetKeys, 2)
  assert.equal(report.exactDuplicateRows, 1)
  assert.equal(report.semanticRevisionRows, 1)
  assert.equal(report.removableTargetRows, 2)
  assert.equal(report.nonTargetRows, 2)

  const applied = await repair.compactFile(file, "server", { confirmWritersStopped: true })
  assert.equal(applied.applied, true)
  assert.equal(await fsp.readFile(file, "utf8"), latest + spanFallback + ordinaryPi + otherFramework)
  assert.equal(applied.checkpoint.modifiedByTool, false)
})

test("server mode never merges matching event identities from different users", async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, "traces.jsonl")
  const alice = jsonLine(serverEvent({ user: "alice" }))
  const bob = jsonLine(serverEvent({ user: "bob" }))
  await fsp.writeFile(file, alice + bob)

  const report = await repair.dryRunFile(file, "server")

  assert.equal(report.targetRows, 2)
  assert.equal(report.uniqueTargetKeys, 2)
  assert.equal(report.removableTargetRows, 0)
  const applied = await repair.compactFile(file, "server", { confirmWritersStopped: true })
  assert.equal(applied.applied, false)
  assert.equal(await fsp.readFile(file, "utf8"), alice + bob)
})

test("server mode keeps event and span identities distinct when their values match", async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, "traces.jsonl")
  const eventIdentity = jsonLine(serverEvent({
    spanId: "other-span",
    attributes: {
      "agent.insight.framework": "pi-agent",
      "agent.insight.event_id": "shared-id",
      "tool.outcome": "success",
    },
  }))
  const spanIdentity = jsonLine(serverEvent({
    spanId: "shared-id",
    attributes: {
      "agent.insight.framework": "pi-agent",
      "tool.outcome": "success",
    },
  }))
  await fsp.writeFile(file, eventIdentity + spanIdentity)

  const report = await repair.dryRunFile(file, "server")
  assert.equal(report.uniqueTargetKeys, 2)
  assert.equal(report.removableTargetRows, 0)
  const applied = await repair.compactFile(file, "server", { confirmWritersStopped: true })
  assert.equal(applied.applied, false)
  assert.equal(await fsp.readFile(file, "utf8"), eventIdentity + spanIdentity)
})

test("streaming analysis handles a large duplicate run without retaining every row", async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, "events.jsonl")
  const repeated = jsonLine(collectorEvent())
  await fsp.writeFile(file, repeated.repeat(20_000))

  const scan = await repair.analyzeFile(file, "collector")

  assert.equal(scan.summary.targetRows, 20_000)
  assert.equal(scan.summary.uniqueTargetKeys, 1)
  assert.equal(scan.summary.removableTargetRows, 19_999)
  assert.equal(scan.keys.size, 1)
  assert.equal(scan.keys.values().next().value.lastSemanticHash, repair.semanticHash(collectorEvent()))
})

test("apply refuses malformed or unterminated JSONL without creating repair artifacts", async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, "events.jsonl")
  const valid = jsonLine(collectorEvent())
  await fsp.writeFile(file, `${valid}{"framework":"pi-agent"`)

  const dryRun = await repair.dryRunFile(file, "collector")
  assert.equal(dryRun.malformedRows, 1)
  assert.equal(dryRun.unterminatedRows, 1)
  assert.equal(dryRun.safeToApply, false)
  await assert.rejects(
    () => repair.compactFile(file, "collector", { confirmWritersStopped: true }),
    /Refusing to modify malformed or unterminated JSONL/,
  )
  assert.deepEqual((await fsp.readdir(dir)).sort(), ["events.jsonl"])
})

test("apply requires explicit stopped-writer confirmation and directory discovery stays kind-specific", async (t) => {
  const dir = await tempDir(t)
  const nested = path.join(dir, "nested")
  await fsp.mkdir(nested)
  const collector = path.join(nested, "events.jsonl")
  await fsp.writeFile(collector, jsonLine(collectorEvent()))
  await fsp.writeFile(path.join(nested, "traces.jsonl"), jsonLine(serverEvent()))
  await fsp.writeFile(path.join(nested, "events.jsonl.bak.20260101T000000000Z"), "backup")

  assert.deepEqual(await repair.collectFiles(dir, "collector"), [collector])
  assert.throws(
    () => repair.parseArgs(["--kind", "collector", "--path", dir, "--apply"]),
    /--confirm-writers-stopped/,
  )
  assert.equal(repair.parseArgs(["--kind", "collector", "--path", dir]).apply, false)
  await assert.rejects(
    () => repair.compactFile(collector, "collector"),
    /explicit confirmation/,
  )
})

test("directory apply preflights every file before changing any file", async (t) => {
  const dir = await tempDir(t)
  const firstDir = path.join(dir, "2026-01-01")
  const secondDir = path.join(dir, "2026-01-02")
  await fsp.mkdir(firstDir, { recursive: true })
  await fsp.mkdir(secondDir, { recursive: true })
  const firstFile = path.join(firstDir, "events.jsonl")
  const secondFile = path.join(secondDir, "events.jsonl")
  const firstOriginal = jsonLine(collectorEvent()) + jsonLine(collectorEvent())
  await fsp.writeFile(firstFile, firstOriginal)
  await fsp.writeFile(secondFile, '{"framework":"pi-agent"')

  await assert.rejects(
    () => repair.run([
      "--kind", "collector",
      "--path", dir,
      "--apply",
      "--confirm-writers-stopped",
    ], { stdout: { write: () => undefined } }),
    /Preflight rejected.*before any file was changed/,
  )
  assert.equal(await fsp.readFile(firstFile, "utf8"), firstOriginal)
  assert.deepEqual(
    (await fsp.readdir(firstDir)).filter((name) => name.includes(".bak.")),
    [],
  )
})
