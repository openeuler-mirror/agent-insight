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

import { deriveOpencodeExecutionFields } from "@/lib/engine/observability/opencode-derived-metrics"

test("opencode: deriveOpencodeExecutionFields is deterministic and prefers top-level assistant final_result", () => {
  const interactions = [
    { role: "user", content: "Q1" },
    {
      role: "assistant",
      content: "Top-level answer",
      model: "gpt-x",
      usage: { input_tokens: 10, output_tokens: 5 },
      timeInfo: { created: "2026-01-01T00:00:00.000Z", completed: "2026-01-01T00:00:01.000Z" },
      tool_calls: [{ state: "success" }, { state: "error" }],
    },
    { role: "opencode", content: "child user" },
    {
      role: "subagent",
      content: "Subagent intermediate output",
      usage: { input_tokens: 3, output_tokens: 4 },
      timeInfo: { created: "2026-01-01T00:00:01.000Z", completed: "2026-01-01T00:00:03.000Z" },
      tool_calls: [{ state: "failed" }],
    },
  ]

  const fields = deriveOpencodeExecutionFields(interactions as any[])

  assert.equal(fields.final_result, "Top-level answer")
  assert.equal(fields.model, "gpt-x")
  assert.equal(fields.tokens, 22)
  assert.equal(fields.input_tokens, 13)
  assert.equal(fields.output_tokens, 9)
  assert.equal(fields.llm_call_count, 2)
  assert.equal(fields.tool_call_count, 3)
  assert.equal(fields.tool_call_error_count, 2)
  assert.equal(fields.latency, 3000)

  const fields2 = deriveOpencodeExecutionFields(interactions as any[])
  assert.deepEqual(fields2, fields)
})

