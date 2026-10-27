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
import test from "node:test"

import {
  getPlatformLabel,
  resolveTracePlatform,
} from "@/lib/ingest/ras/platform-label"

test("getPlatformLabel: known platforms", () => {
  assert.equal(getPlatformLabel("xiaoo"), "xiaoO")
  assert.equal(getPlatformLabel("opencode"), "OpenCode")
  assert.equal(getPlatformLabel("openjiuwen"), "openJiuwen")
  assert.equal(getPlatformLabel("qwenpaw"), "QwenPaw")
  assert.equal(getPlatformLabel("qwenpaw"), "QwenPaw")
  assert.equal(getPlatformLabel(""), "—")
})

test("resolveTracePlatform: prefer event platform over execution framework", () => {
  assert.equal(
    resolveTracePlatform({
      eventPlatform: "xiaoo",
      executionFramework: "opencode",
    }),
    "xiaoo",
  )
  assert.equal(
    resolveTracePlatform({
      eventPlatform: null,
      executionFramework: "opencode",
    }),
    "opencode",
  )
  assert.equal(
    resolveTracePlatform({
      eventPlatform: null,
      eventFramework: "hermes",
      executionFramework: null,
    }),
    "hermes",
  )
})
