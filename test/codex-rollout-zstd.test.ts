/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Codex 0.164+ 会把冷 rollout 压缩为 `rollout-*.jsonl.zst`，恢复会话时再
 * materialize 回 `.jsonl` 追加。旧 reader 只匹配 `.jsonl`，压缩后的会话完全
 * 不可见；若只补后缀而不做稳定键/记录数游标，又会在压缩或恢复时整段重放。
 *
 * 本文件覆盖：压缩发现、plain/zst 双向迁移不重复、旧 checkpoint 保守跳过、
 * 回填跳过后恢复只上报新 turn，以及 0.166 的 task_complete / 未知类型兼容。
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const zlib = require("node:zlib")
const {
  createDesktopRolloutReader,
  listRolloutFiles,
} = require("../scripts/agent-trace-collectors/codex/rollout-reader.cjs")

const ZSTD_AVAILABLE =
  typeof zlib.zstdCompressSync === "function" && typeof zlib.zstdDecompressSync === "function"

const THREAD = "thread-zstd-1"
const ROLLOUT_NAME = `rollout-2026-11-01T10-00-00-${THREAD}.jsonl`

function timestamp(base: number, offsetSeconds: number): string {
  return new Date(base + offsetSeconds * 1000).toISOString()
}

function turnRecords(base: number, turnId: string, text: string): any[] {
  return [
    {
      timestamp: timestamp(base, 0),
      type: "session_meta",
      payload: { id: THREAD, originator: "Codex Desktop", cli_version: "0.166.0" },
    },
    {
      timestamp: timestamp(base, 1),
      type: "event_msg",
      payload: { type: "task_started", turn_id: turnId },
    },
    {
      timestamp: timestamp(base, 2),
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: turnId,
        item: { type: "UserMessage", content: [{ type: "text", text }] },
      },
    },
    {
      timestamp: timestamp(base, 3),
      type: "token_usage_record",
      payload: { turn_id: turnId, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
    },
    {
      timestamp: timestamp(base, 4),
      type: "event_msg",
      payload: { type: "task_complete", turn_id: turnId, last_agent_message: `done: ${text}` },
    },
  ]
}

function writeJsonl(filePath: string, records: any[]): void {
  fs.writeFileSync(filePath, records.map((record) => JSON.stringify(record)).join("\n") + "\n")
}

function compressFile(filePath: string): void {
  const compressed = zlib.zstdCompressSync(fs.readFileSync(filePath))
  fs.writeFileSync(`${filePath}.zst`, compressed)
  fs.unlinkSync(filePath)
}

function materializeFile(filePath: string): void {
  const decompressed = zlib.zstdDecompressSync(fs.readFileSync(`${filePath}.zst`))
  fs.writeFileSync(filePath, decompressed)
  fs.unlinkSync(`${filePath}.zst`)
}

function createFixture(): {
  root: string
  sessions: string
  stateDir: string
  rolloutPath: string
  reader: any
  events: any[]
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollout-zstd-"))
  const sessions = path.join(root, "sessions")
  const stateDir = path.join(root, "state")
  fs.mkdirSync(sessions, { recursive: true })
  fs.mkdirSync(stateDir, { recursive: true })
  const events: any[] = []
  const reader = createDesktopRolloutReader({
    enabled: true,
    sessionsDir: sessions,
    checkpointPath: path.join(stateDir, "checkpoint.json"),
    backfillAfterMs: 1,
    onEvents: async (batch: any[]) => {
      events.push(...batch)
    },
  })
  return { root, sessions, stateDir, rolloutPath: path.join(sessions, ROLLOUT_NAME), reader, events }
}

function executionIds(events: any[]): string[] {
  return [...new Set(events.filter((event) => event.eventType === "execution_started").map((event) => event.sourceExecutionId))]
}

test("zstd: discovers and parses compressed rollout files", { skip: !ZSTD_AVAILABLE }, async (t) => {
  const fixture = createFixture()
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }))
  writeJsonl(fixture.rolloutPath, turnRecords(Date.now() - 86_400_000, "turn-1", "compressed"))
  compressFile(fixture.rolloutPath)

  const files = await listRolloutFiles(fixture.sessions)
  assert.deepEqual(files, [`${fixture.rolloutPath}.zst`])

  const result = await fixture.reader.scan()
  assert.ok(result.events > 0)
  assert.deepEqual(executionIds(fixture.events), ["turn-1"])
  assert.equal(fixture.events.filter((event) => event.eventType === "execution_completed").length, 1)
})

test("zstd: plain -> compressed does not replay the same records", { skip: !ZSTD_AVAILABLE }, async (t) => {
  const fixture = createFixture()
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }))
  writeJsonl(fixture.rolloutPath, turnRecords(Date.now() - 86_400_000, "turn-1", "one"))

  await fixture.reader.scan()
  const afterPlain = fixture.events.length
  assert.ok(afterPlain > 0)

  compressFile(fixture.rolloutPath)
  const result = await fixture.reader.scan()
  assert.equal(result.events, 0, "compression must not re-emit already-consumed records")
  assert.equal(fixture.events.length, afterPlain)
})

test("zstd: materialize + append only emits the new turn", { skip: !ZSTD_AVAILABLE }, async (t) => {
  const fixture = createFixture()
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }))
  const base = Date.now() - 86_400_000
  writeJsonl(fixture.rolloutPath, turnRecords(base, "turn-1", "one"))
  compressFile(fixture.rolloutPath)

  await fixture.reader.scan()
  const afterCompressed = fixture.events.length
  materializeFile(fixture.rolloutPath)
  await fixture.reader.scan()
  assert.equal(fixture.events.length, afterCompressed, "materialization must not replay")

  fs.appendFileSync(
    fixture.rolloutPath,
    turnRecords(Date.now() + 10_000, "turn-2", "two").slice(1).map((record) => JSON.stringify(record)).join("\n") + "\n",
  )
  const result = await fixture.reader.scan()
  assert.ok(result.events > 0)
  assert.deepEqual(executionIds(fixture.events), ["turn-1", "turn-2"])
  assert.deepEqual(
    fixture.events.filter((event) => event.eventType === "execution_completed").map((event) => event.payload.output),
    ["done: one", "done: two"],
  )
})

test("zstd: legacy bytes-only checkpoint skips compressed files until materialized", { skip: !ZSTD_AVAILABLE }, async (t) => {
  const fixture = createFixture()
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }))
  const base = Date.now() - 86_400_000
  writeJsonl(fixture.rolloutPath, turnRecords(base, "turn-1", "one"))
  await fixture.reader.scan()
  const afterPlain = fixture.events.length

  const key = Object.keys(fixture.reader.state.files)[0]
  delete fixture.reader.state.files[key].recordsProcessed
  fs.writeFileSync(
    path.join(fixture.stateDir, "checkpoint.json"),
    JSON.stringify(fixture.reader.state),
  )

  compressFile(fixture.rolloutPath)
  const compressed = await fixture.reader.scan()
  assert.equal(compressed.events, 0)
  assert.equal(fixture.reader.state.legacyCompressedSkipped, 1)
  assert.equal(fixture.events.length, afterPlain)

  materializeFile(fixture.rolloutPath)
  fs.appendFileSync(
    fixture.rolloutPath,
    turnRecords(Date.now() + 10_000, "turn-2", "two").slice(1).map((record) => JSON.stringify(record)).join("\n") + "\n",
  )
  await fixture.reader.scan()
  assert.deepEqual(executionIds(fixture.events), ["turn-1", "turn-2"])
  assert.equal(fixture.events.filter((event) => event.eventType === "execution_completed").length, 2)
})

test("zstd: backfill-skipped compressed file only emits records after the cutoff", { skip: !ZSTD_AVAILABLE }, async (t) => {
  const now = Date.now()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollout-backfill-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sessions = path.join(root, "sessions")
  const stateDir = path.join(root, "state")
  fs.mkdirSync(sessions, { recursive: true })
  fs.mkdirSync(stateDir, { recursive: true })
  const rolloutPath = path.join(sessions, ROLLOUT_NAME)
  const events: any[] = []
  const reader = createDesktopRolloutReader({
    enabled: true,
    sessionsDir: sessions,
    checkpointPath: path.join(stateDir, "checkpoint.json"),
    backfillAfterMs: now,
    onEvents: async (batch: any[]) => {
      events.push(...batch)
    },
  })

  writeJsonl(rolloutPath, turnRecords(now - 86_400_000, "turn-old", "old"))
  compressFile(rolloutPath)
  await reader.scan()
  assert.equal(events.length, 0, "historical compressed sessions must be skipped")

  materializeFile(rolloutPath)
  fs.appendFileSync(
    rolloutPath,
    turnRecords(now + 10_000, "turn-new", "new").slice(1).map((record) => JSON.stringify(record)).join("\n") + "\n",
  )
  await reader.scan()
  assert.deepEqual(executionIds(events), ["turn-new"])
  assert.deepEqual(
    events.filter((event) => event.eventType === "execution_completed").map((event) => event.payload.output),
    ["done: new"],
  )
})

test("0.166: task_complete last_agent_message and turn_complete alias are captured", () => {
  const { recordsToLifecycleEvents } = require("../scripts/agent-trace-collectors/codex/rollout-reader.cjs")
  let context: any = {
    sourceThreadId: THREAD,
    sourceKind: "desktop",
    activeExecutionId: "turn-1",
    activeTaskHadUserInput: true,
    unknownRecords: 0,
    toolNames: new Map(),
  }
  const record = {
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: { type: "turn_complete", turn_id: "turn-1", last_agent_message: "alias output" },
  }
  const result = recordsToLifecycleEvents(record, context)
  context = result.context
  const completed = result.events.find((event: any) => event.eventType === "execution_completed")
  assert.ok(completed)
  assert.equal(completed.payload.output, "alias output")
  assert.equal(context.activeTaskHadUserInput, false)
})

test("0.166: unknown top-level record types are ignored without throwing", () => {
  const { recordsToLifecycleEvents } = require("../scripts/agent-trace-collectors/codex/rollout-reader.cjs")
  const context: any = {
    sourceThreadId: THREAD,
    sourceKind: "desktop",
    activeExecutionId: "turn-1",
    activeTaskHadUserInput: true,
    unknownRecords: 0,
    toolNames: new Map(),
  }
  for (const type of ["dynamic_tools_updated", "world_state", "retained_context", "security_risk_score", "realtime_item"]) {
    const result = recordsToLifecycleEvents({ type, payload: {} }, context)
    assert.deepEqual(result.events, [])
  }
})
