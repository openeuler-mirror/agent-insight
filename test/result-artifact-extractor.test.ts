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
