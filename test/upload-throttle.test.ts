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

import { createPerKeyThrottle } from "@/lib/ingest/upload-throttle"

test("createPerKeyThrottle: runs immediately then throttles to at most once per interval, last wins", async () => {
  const throttle = createPerKeyThrottle(30)
  const seen: number[] = []

  throttle.run("k", () => seen.push(1))
  throttle.run("k", () => seen.push(2))
  throttle.run("k", () => seen.push(3))

  await new Promise((r) => setTimeout(r, 80))
  assert.deepEqual(seen, [1, 3])
})

