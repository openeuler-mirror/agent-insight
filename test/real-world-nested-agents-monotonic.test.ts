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

import { mergeSessionInteractionsMonotonic } from "@/lib/engine/observability/session-interactions-merge"

test("nested agents + out-of-order uploads never drop an already-seen child session", () => {
  const base = [
    { role: "user", content: "root question", timestamp: "2026-04-01T00:00:00.000Z" },
    {
      role: "assistant",
      content: "Calling task(subagent_type=kuafu)",
      timestamp: "2026-04-01T00:00:10.000Z",
      tool_calls: [
        {
          type: "function",
          function: { name: "task", arguments: "{\"subagent_type\":\"kuafu\"}" },
          state: "success",
          output: "<task_metadata>\\nsession_id: ses_kuafu\\n</task_metadata>",
        },
      ],
    },
    { role: "subagent", subagent_session_id: "ses_kuafu", subagent_name: "kuafu", content: "kuafu says hi", timestamp: "2026-04-01T00:00:20.000Z" },
    { role: "assistant", content: "Root continues", timestamp: "2026-04-01T00:00:30.000Z" },
  ] as any[]

  const baizeMsg = {
    role: "subagent",
    subagent_session_id: "ses_baize",
    subagent_name: "baize",
    content: "baize final report",
    timestamp: "2026-04-01T00:01:00.000Z",
  }

  const snapWithBaize = mergeSessionInteractionsMonotonic(base, [...base, baizeMsg])
  assert.ok(snapWithBaize.some((m: any) => m.subagent_session_id === baizeMsg.subagent_session_id))

  const longerWithoutBaize = [...base, ...Array.from({ length: 40 }).map((_, i) => ({
    role: "assistant",
    content: `extra-${i}`,
    timestamp: `2026-04-01T00:10:${String(i).padStart(2, "0")}.000Z`,
  }))]

  const merged = mergeSessionInteractionsMonotonic(snapWithBaize, longerWithoutBaize)
  assert.ok(merged.some((m: any) => m.subagent_session_id === baizeMsg.subagent_session_id))
})
