import assert from "node:assert/strict"
import test from "node:test"

import {
  extractObservedAgentNames,
  extractObservedAgentRegistrations,
} from "@/lib/engine/observability/agent-registration"

test("extractObservedAgentRegistrations includes opencode subagent names", () => {
  const interactions = [
    { role: "assistant", agent: "Xuanyuan (Controller)", content: "spawn fuxi" },
    {
      role: "subagent",
      subagent_name: "Fuxi-Sub (Diagnostic Planner Subagent)",
      subagent_session_id: "ses_child",
      content: "plan",
    },
    {
      role: "opencode",
      subagent_name: "Fuxi-Sub (Diagnostic Planner Subagent)",
      subagent_session_id: "ses_child",
      content: "child user",
    },
  ]

  assert.deepEqual(
    extractObservedAgentRegistrations(interactions, "Xuanyuan (Controller)"),
    [
      { name: "Xuanyuan (Controller)", agentType: "main" },
      { name: "Fuxi-Sub (Diagnostic Planner Subagent)", agentType: "subagent" },
    ],
  )
})

test("extractObservedAgentNames returns subagent_name for trace filtering", () => {
  assert.deepEqual(
    extractObservedAgentNames([
      { role: "subagent", subagent_name: "Fuxi-Sub (Diagnostic Planner Subagent)" },
    ]),
    ["Fuxi-Sub (Diagnostic Planner Subagent)"],
  )
})
