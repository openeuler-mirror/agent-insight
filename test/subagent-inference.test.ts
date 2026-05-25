import assert from "node:assert/strict"
import test from "node:test"

import { inferSubagentNamesFromInteractions } from "@/lib/engine/observability/subagent-inference"

test("inferSubagentNamesFromInteractions fills subagent_name from nearest preceding task subagent_type", () => {
  const interactions = [
    { role: "assistant", content: "top", tool_calls: [{ function: { name: "task", arguments: "{\"subagent_type\":\"dayu\"}" } }] },
    { role: "opencode", content: "child user" },
    { role: "subagent", content: "child assistant" },
  ]

  const out = inferSubagentNamesFromInteractions(interactions as any[])
  assert.equal(out[2].subagent_name, "dayu")
})

