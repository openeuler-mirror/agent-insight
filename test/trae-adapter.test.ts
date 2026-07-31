import test from "node:test"
import assert from "node:assert/strict"
import { traeAdapter } from "../src/lib/ingest/adapters/trae"
import { extractSkillsWithVersionsFromTraeSession, normalizeInteractions } from "../src/lib/shared/interaction-utils"
import { getAdapter, listFrameworks } from "../src/lib/ingest/adapters/registry"

// ============================================================================
// Adapter 注册测试
// ============================================================================
test("AC36: traeAdapter is registered in adapter registry", () => {
  const adapter = getAdapter("trae")
  assert.equal(adapter.descriptor.id, "trae")
  assert.equal(adapter.descriptor.label, "TRAE AI IDE")
  assert.equal(adapter.descriptor.onboard, "plugin")
})

test("AC36: traeAdapter aliases work correctly", () => {
  assert.equal(getAdapter("trae-cn").descriptor.id, "trae")
  assert.equal(getAdapter("trae-ide").descriptor.id, "trae")
  assert.equal(getAdapter("trae-ai").descriptor.id, "trae")
})

test("AC36: traeAdapter is listed in frameworks", () => {
  const frameworks = listFrameworks()
  const traeFramework = frameworks.find(f => f.id === "trae")
  assert.ok(traeFramework)
  assert.equal(traeFramework.label, "TRAE AI IDE")
})

// ============================================================================
// AC8: Skill 提取测试
// ============================================================================
test("AC8: extractSkillsWithVersionsFromTraeSession extracts skills correctly", () => {
  const traeMessages = [
    { role: "user", content: "Run code review" },
    {
      role: "assistant",
      content: "Starting code review",
      tool_calls: [
        {
          id: "call_skill_1",
          type: "function",
          function: {
            name: "skill",
            arguments: JSON.stringify({ name: "code-review", version: 1.2 }),
          },
        },
        {
          id: "call_skill_2",
          type: "function",
          function: {
            name: "load_skill",
            arguments: JSON.stringify({ skill: "security-scan" }),
          },
        },
        {
          id: "call_tool",
          type: "function",
          function: {
            name: "Read",
            arguments: JSON.stringify({ file: "src/main.ts" }),
          },
        },
        {
          id: "call_bad_name",
          type: "function",
          function: {
            name: "skill",
            arguments: JSON.stringify({ name: "bad skill name" }),
          },
        },
      ],
    },
  ]

  const normalized = normalizeInteractions(traeMessages)
  const skills = extractSkillsWithVersionsFromTraeSession(normalized)

  assert.equal(skills.length, 2)
  assert.ok(skills.find(s => s.name === "code-review" && s.version === 1.2))
  assert.ok(skills.find(s => s.name === "security-scan" && s.version === null))
})

test("AC8/AC36: traeAdapter.extractSkills uses extractSkillsWithVersionsFromTraeSession", () => {
  const messages = [
    { role: "user", content: "Analyze code" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_skill",
          type: "function",
          function: {
            name: "skill",
            arguments: JSON.stringify({ name: "code-analyzer", version: "3" }),
          },
        },
      ],
    },
  ]

  const normalized = normalizeInteractions(messages)
  const skills = traeAdapter.extractSkills!(normalized)

  assert.equal(skills.length, 1)
  assert.equal(skills[0].name, "code-analyzer")
  assert.equal(skills[0].version, 3)
})

// ============================================================================
// Adapter capabilities 测试
// ============================================================================
test("AC36: traeAdapter declares correct capabilities", () => {
  assert.ok(traeAdapter.capabilities)
  assert.equal(traeAdapter.capabilities?.skills, true)
  assert.equal(traeAdapter.capabilities?.subagentTree, true)
})

// ============================================================================
// Session merge strategy 测试
// ============================================================================
test("AC36: traeAdapter uses snapshot-replace merge strategy", () => {
  assert.equal(traeAdapter.sessionMergeStrategy, "snapshot-replace")
})