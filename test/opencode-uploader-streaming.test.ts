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

import assert from "node:assert/strict"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test, { before } from "node:test"

let uploader: typeof import("../scripts/opencode_uploader_client.js")

before(async () => {
  process.env.AGENT_INSIGHT_UPLOADER_NO_MAIN = "1"
  uploader = await import("../scripts/opencode_uploader_client.js")
})

function deltaRecord(index: number) {
  return {
    kind: "event",
    sessionID: "sess-1",
    t: 1_700_000_000_000 + index,
    payload: {
      type: "message.part.delta",
      event: {
        type: "message.part.delta",
        id: `ev-${index}`,
        properties: {
          messageID: "msg-1",
          sessionID: "sess-1",
          partID: "part-1",
          field: "text",
          delta: `chunk-${index};`,
        },
      },
    },
  }
}

async function writeSpool(t: test.TestContext, count: number) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-insight-uploader-"))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, "2026-11-19", "session-1.jsonl")
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const lines = [
    JSON.stringify({
      kind: "plugin.start",
      sessionID: "sess-1",
      t: 1_700_000_000_000,
      payload: { pid: 4242, cwd: "/tmp/work" },
    }),
  ]
  for (let i = 0; i < count; i += 1) lines.push(JSON.stringify(deltaRecord(i)))
  lines.push("{broken json")
  await fsp.writeFile(file, lines.join("\n") + "\n", "utf8")
  return file
}

function parseWhole(file: string) {
  return fs.readFileSync(file, "utf8").split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
}

test("streaming reader yields the same records as whole-file parsing", async (t) => {
  const file = await writeSpool(t, 500)
  const streamed: Record<string, unknown>[] = []
  const count = await uploader.forEachJsonlRecord(file, (record: Record<string, unknown>) => {
    streamed.push(record)
  })
  const whole = parseWhole(file)

  assert.equal(count, streamed.length)
  assert.equal(streamed.length, whole.length)
  assert.deepEqual(streamed.map((r) => r.kind), whole.map((r: Record<string, unknown>) => r.kind))
  assert.equal(streamed[1].__sourceFile, file)
  assert.equal(streamed[1].__pluginPid, 4242)
  assert.equal(streamed[1].__pluginCwd, path.resolve("/tmp/work"))
})

test("streaming ingestion produces the same state as buildState(records)", async (t) => {
  const file = await writeSpool(t, 300)

  const builder = uploader.createStateBuilder()
  const count = await uploader.forEachJsonlRecord(file, builder.ingest)
  const streamed = builder.finish()
  const batched = uploader.buildState(parseWhole(file))

  assert.equal(count, parseWhole(file).length)
  assert.deepEqual([...streamed.sessions.keys()], [...batched.sessions.keys()])
  assert.deepEqual([...streamed.partDeltas.entries()], [...batched.partDeltas.entries()])
  assert.equal(streamed.sessionRecordCounts.get("sess-1"), batched.sessionRecordCounts.get("sess-1"))
})

async function writeSessionSpool(dir: string, name: string, sessionID: string) {
  const file = path.join(dir, name)
  const lines = [
    JSON.stringify({
      kind: "plugin.start",
      sessionID,
      t: 1_700_000_000_000,
      payload: { pid: 4242, cwd: "/tmp/work" },
    }),
    JSON.stringify({
      kind: "event",
      sessionID,
      t: 1_700_000_000_001,
      payload: {
        type: "message.part.delta",
        event: {
          type: "message.part.delta",
          id: `ev-${sessionID}`,
          properties: {
            messageID: `msg-${sessionID}`,
            sessionID,
            partID: `part-${sessionID}`,
            field: "text",
            delta: "chunk;",
          },
        },
      },
    }),
  ]
  await fsp.writeFile(file, lines.join("\n") + "\n", "utf8")
  return file
}

// A spool file can disappear between the directory listing and the read (plugin
// rotation, external cleanup) — the window spans the whole preceding batch, so
// it is minutes wide on a GB-scale spool, not a millisecond race. One missing
// file must not take the rest of the batch down with it.
test("an unreadable spool file does not prevent the rest of the batch from being read", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-insight-batch-"))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))

  const first = await writeSessionSpool(dir, "a.jsonl", "sess-a")
  const vanished = await writeSessionSpool(dir, "b.jsonl", "sess-b")
  const last = await writeSessionSpool(dir, "c.jsonl", "sess-c")
  await fsp.unlink(vanished)

  const builder = uploader.createStateBuilder()
  const { totalRecords, unreadableFiles } =
    await uploader.ingestJsonlBatch([first, vanished, last], builder)
  const state = builder.finish()

  assert.equal(unreadableFiles.size, 1, "exactly the removed file should be unreadable")
  assert.ok(unreadableFiles.has(path.resolve(vanished)))
  assert.equal(totalRecords, 4, "both readable files contributed their records")
  assert.ok(state.sessions.has("sess-a"), "files before the missing one still ingest")
  assert.ok(state.sessions.has("sess-c"), "files after the missing one still ingest")
  assert.ok(!state.sessions.has("sess-b"))
})

// The settled guard in forEachJsonlRecord: a failed read must surface as a
// rejection, never as "0 records" success. Without it a `close` that beats
// `error` silently marks the file as empty and it is never retried.
test("a missing spool file rejects instead of resolving zero records", async () => {
  const missing = path.join(os.tmpdir(), "agent-insight-missing-never-exists.jsonl")
  await fsp.rm(missing, { force: true })

  await assert.rejects(
    () => uploader.forEachJsonlRecord(missing, () => {}),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  )
})

// A spool line can be valid JSON without being a record. A stray scalar or
// array used to blow up when `__sourceFile` was attached to a primitive,
// throwing a TypeError that aborted the whole upload run.
test("non-object JSON lines are skipped instead of aborting the read", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-insight-scalars-"))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, "mixed.jsonl")
  const lines = [
    JSON.stringify({
      kind: "plugin.start",
      sessionID: "sess-1",
      t: 1_700_000_000_000,
      payload: { pid: 4242, cwd: "/tmp/work" },
    }),
    "true",
    "123",
    '"just a string"',
    "[1,2,3]",
    "null",
    JSON.stringify({
      kind: "event",
      sessionID: "sess-1",
      t: 1_700_000_000_001,
      payload: {
        type: "message.part.delta",
        event: {
          type: "message.part.delta",
          id: "ev-1",
          properties: {
            messageID: "msg-1",
            sessionID: "sess-1",
            partID: "part-1",
            field: "text",
            delta: "chunk;",
          },
        },
      },
    }),
  ]
  await fsp.writeFile(file, lines.join("\n") + "\n", "utf8")

  const builder = uploader.createStateBuilder()
  const count = await uploader.forEachJsonlRecord(file, builder.ingest)
  const state = builder.finish()

  assert.equal(count, 2, "only the two real records should be ingested")
  assert.ok(state.sessions.has("sess-1"), "valid records after the junk lines still land")
})

