import assert from "node:assert/strict"
import test from "node:test"

import {
  extractObservedAgentNames,
  extractObservedAgentRegistrations,
  getPrimaryObservedAgentName,
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

test("getPrimaryObservedAgentName prefers the main business agent over evaluator tags", () => {
  assert.equal(
    getPrimaryObservedAgentName([
      { role: "assistant", agent: "task-completion-evaluator" },
      { role: "opencode", subagent_name: "Fuxi-Sub (Diagnostic Planner Subagent)" },
      { role: "user", agent: "Xuanyuan (Controller)" },
    ]),
    "Xuanyuan (Controller)",
  )
})

test("getPrimaryObservedAgentName can recover a main agent from interactions when primary is missing", () => {
  assert.equal(
    getPrimaryObservedAgentName([
      { role: "user", agent: "build" },
      { role: "assistant", agent: "build" },
    ]),
    "build",
  )
})
