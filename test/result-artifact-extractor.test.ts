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

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractRecentLlmOutputs } from "../src/lib/engine/evaluation/result-artifact-extractor";

test("extractRecentLlmOutputs returns all available outputs when fewer than max", () => {
  const interactions = Array.from({ length: 11 }, (_, index) => {
    const turn = index + 1;
    return {
      requestMessages: [{ role: "user", content: `request ${turn}` }],
      responseMessage: turn % 2 === 1
        ? { role: "assistant", content: `diagnosis output ${turn}` }
        : {
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name: "bash", arguments: "{}" } }],
          },
    };
  });

  const outputs = extractRecentLlmOutputs(interactions, 10);

  assert.deepEqual(
    outputs.map(output => output.id),
    ["llm-1", "llm-3", "llm-5", "llm-7", "llm-9", "llm-11"],
  );
  assert.deepEqual(
    outputs.map(output => output.output),
    [
      "diagnosis output 1",
      "diagnosis output 3",
      "diagnosis output 5",
      "diagnosis output 7",
      "diagnosis output 9",
      "diagnosis output 11",
    ],
  );
});

test("extractRecentLlmOutputs limits to the latest non-empty LLM outputs", () => {
  const interactions = Array.from({ length: 12 }, (_, index) => ({
    requestMessages: [{ role: "user", content: `request ${index + 1}` }],
    responseMessage: { role: "assistant", content: `output ${index + 1}` },
  }));

  const outputs = extractRecentLlmOutputs(interactions, 3);

  assert.deepEqual(outputs.map(output => output.id), ["llm-10", "llm-11", "llm-12"]);
  assert.deepEqual(outputs.map(output => output.output), ["output 10", "output 11", "output 12"]);
});


test('artifact candidates exclude explicit child input and retain legacy OpenCode outputs', () => {
  const outputs = extractRecentLlmOutputs([
    { role: 'opencode', trace_kind: 'user', content: 'child input', subagent_session_id: 'child' },
    { role: 'subagent', trace_kind: 'llm', content: 'child answer' },
    { role: 'opencode', content: 'legacy answer' },
    { responseMessage: { role: 'assistant', content: 'wrapped answer' } },
  ], 10);
  assert.deepEqual(outputs.map(o => o.output), ['child answer', 'legacy answer', 'wrapped answer']);
  assert.deepEqual(outputs.map(o => o.id), ['llm-1', 'llm-2', 'llm-3']);
});
