import assert from "node:assert/strict"
import test from "node:test"

import {
  extractObservedAgentNames,
  extractObservedAgentRegistrations,
  getAgentDisplayName,
  getAgentNodeDisplayLabel,
  getFrameworkPrimaryAgentName,
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

test("Pi keeps the root fallback while registering a delegated profile as its own Agent", () => {
  const interactions = [
    { role: "assistant", agent: "pi-agent", content: "delegate" },
    { role: "subagent", agent: "worker", subagent_name: "worker", content: "done" },
  ]

  assert.equal(getFrameworkPrimaryAgentName("codex"), "codex")
  assert.equal(getFrameworkPrimaryAgentName("pi-agent"), "pi-agent")
  assert.equal(getAgentDisplayName("codex"), "Codex")
  assert.equal(getAgentDisplayName("pi-agent"), "Pi")
  assert.equal(getAgentNodeDisplayLabel("pi-agent", "worker"), "Pi · worker")
  assert.equal(getAgentNodeDisplayLabel("worker", "worker"), "worker")
  assert.equal(getAgentNodeDisplayLabel("codex", "Memory Agent"), "Codex · Memory Agent")
  assert.deepEqual(
    extractObservedAgentRegistrations(interactions, "pi-agent"),
    [
      { name: "pi-agent", agentType: "main" },
      { name: "worker", agentType: "subagent" },
    ],
  )
  assert.deepEqual(
    extractObservedAgentNames(interactions, "pi-agent"),
    ["pi-agent", "worker"],
  )
  assert.deepEqual(
    extractObservedAgentNames([
      { role: "subagent", agent: "worker", subagent_name: "worker" },
    ], "worker"),
    ["worker"],
  )
})

test("Codex can exclude delegated roles from platform Agent registration", () => {
  const interactions = [
    { role: "assistant", agent: "codex", content: "delegate" },
    { role: "subagent", agent: "default", subagent_name: "default", content: "done" },
  ]
  assert.deepEqual(
    extractObservedAgentRegistrations(interactions, "codex", { includeSubagents: false }),
    [{ name: "codex", agentType: "main" }],
  )
  assert.deepEqual(
    extractObservedAgentNames(interactions, "codex", { includeSubagents: false }),
    ["codex"],
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
