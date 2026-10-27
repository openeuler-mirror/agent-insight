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
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { getFileCursor, saveFileCursor, toCheckpointRelPath } from "@/lib/ingest/otel-consumer/checkpoint"
import { compactProcessedSpoolFiles } from "@/lib/ingest/otel-consumer/retention"

test("OTel retention: archives only historical files fully covered by checkpoint", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-retention-"))
  try {
    const oldDir = path.join(dir, "2026-05-01")
    const newDir = path.join(dir, "2026-06-09")
    fs.mkdirSync(oldDir, { recursive: true })
    fs.mkdirSync(newDir, { recursive: true })
    const oldFile = path.join(oldDir, "logs.jsonl")
    const unprocessedOldFile = path.join(oldDir, "traces.jsonl")
    const newFile = path.join(newDir, "logs.jsonl")
    fs.writeFileSync(oldFile, "{\"sessionId\":\"a\"}\n", "utf8")
    fs.writeFileSync(unprocessedOldFile, "{\"sessionId\":\"b\"}\n", "utf8")
    fs.writeFileSync(newFile, "{\"sessionId\":\"c\"}\n", "utf8")

    const oldRelPath = toCheckpointRelPath(dir, oldFile)
    saveFileCursor(dir, oldRelPath, { bytes: fs.statSync(oldFile).size })

    const result = compactProcessedSpoolFiles(
      dir,
      [oldFile, unprocessedOldFile, newFile],
      7,
      new Date("2026-06-09T12:00:00.000Z"),
    )

    assert.equal(result.archived, 1)
    assert.equal(fs.existsSync(oldFile), false)
    assert.equal(fs.existsSync(`${oldFile}.processed`), true)
    assert.equal(fs.existsSync(unprocessedOldFile), true)
    assert.equal(fs.existsSync(newFile), true)
    assert.equal(getFileCursor(dir, oldRelPath).bytes, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
