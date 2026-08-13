import test from "node:test"
import assert from "node:assert/strict"
import { normalizeClaudeCodeInteractionsForStorage } from "../src/lib/shared/interaction-content"
import {
  extractSkillsWithVersionsFromClaudeSession,
  extractSkillsWithVersionsFromOpenClawSession,
  extractSkillsWithVersionsFromOpencodeSession,
  extractSkillsWithVersionsFromToolInteractions,
  normalizeInteractions,
} from "../src/lib/shared/interaction-utils"
import { getAdapter, listFrameworks, resolveFrameworkId } from "../src/lib/ingest/adapters/registry"
import {
  claudeExpectedSkills,
  claudeSkillMessages,
  claudeStorageExpected,
  claudeStorageInput,
  openclawExpectedSkills,
  openclawSkillMessages,
  opencodeExpectedSkills,
  opencodeSkillMessages,
} from "./fixtures/framework-skill-fixtures"

test("registry resolves framework ids and aliases", () => {
  assert.equal(resolveFrameworkId("opencode"), "opencode")
  assert.equal(resolveFrameworkId("claude"), "claude")
  assert.equal(resolveFrameworkId("claudecode"), "claude")
  assert.equal(resolveFrameworkId("unknown-framework"), "unknown-framework")
  assert.equal(resolveFrameworkId("jiuwen"), "jiuwenswarm")
  assert.equal(resolveFrameworkId("openjiuwen"), "jiuwenswarm")
  assert.equal(resolveFrameworkId("qoder-cli"), "qoder")
  assert.equal(resolveFrameworkId("qoder-cn"), "qoder")
  assert.equal(resolveFrameworkId("qwen-code"), "qwencode")
  assert.equal(resolveFrameworkId(null), "")
  assert.equal(getAdapter("claudecode"), getAdapter("claude"))
})

test("registry exposes the framework descriptor list", () => {
  assert.deepEqual(
    listFrameworks().map((descriptor) => descriptor.id),
    ["opencode", "claude", "codeagent", "qwencode", "openclaw", "hermes", "jiuwenswarm", "langfuse-langgraph", "qoder", "trae", "actrail"],
  )
})

test("registry adapters keep direct references to existing functions", () => {
  assert.equal(getAdapter("opencode").extractSkills, extractSkillsWithVersionsFromOpencodeSession)
  assert.deepEqual(getAdapter("opencode").capabilities, {
    skills: true,
    subagentTree: true,
    skillScope: "agent-tree",
  })
  assert.equal(getAdapter("claude").extractSkills, extractSkillsWithVersionsFromClaudeSession)
  assert.equal(getAdapter("claude").capabilities?.skillScope, "session")
  assert.equal(getAdapter("claude").normalizeForStorage, normalizeClaudeCodeInteractionsForStorage)
  assert.equal(getAdapter("codeagent").extractSkills, extractSkillsWithVersionsFromOpencodeSession)
  assert.equal(getAdapter("codeagent").capabilities?.subagentTree, true)
  assert.equal(getAdapter("qwencode").extractSkills, extractSkillsWithVersionsFromToolInteractions)
  assert.equal(getAdapter("qwencode").capabilities?.subagentTree, true)
  assert.equal(getAdapter("qwencode").sessionMergeStrategy, "snapshot-replace")
  assert.equal(getAdapter("openclaw").extractSkills, extractSkillsWithVersionsFromOpenClawSession)
  assert.equal(getAdapter("openclaw").capabilities?.subagentTree, true)
  assert.equal(getAdapter("openclaw").capabilities?.skillScope, "session")
  assert.equal(getAdapter("jiuwen").capabilities?.subagentTree, undefined)
  assert.equal(getAdapter("qoder").capabilities?.subagentTree, true)
  assert.equal(getAdapter("qoder").capabilities?.skillScope, "agent-tree")
  assert.equal(getAdapter("qoder").capabilities?.allowSnapshotShrink, true)
})

test("registry adapters match golden skill extraction outputs", () => {
  assert.deepEqual(
    getAdapter("opencode").extractSkills?.(normalizeInteractions(opencodeSkillMessages)),
    opencodeExpectedSkills,
  )
  assert.deepEqual(
    getAdapter("claudecode").extractSkills?.(normalizeInteractions(claudeSkillMessages)),
    claudeExpectedSkills,
  )
  assert.deepEqual(
    getAdapter("openclaw").extractSkills?.(normalizeInteractions(openclawSkillMessages)),
    openclawExpectedSkills,
  )
})

test("registry adapters match golden storage normalization output", () => {
  assert.deepEqual(getAdapter("claude").normalizeForStorage?.(claudeStorageInput), claudeStorageExpected)
})

test("registry fallback adapter is inert", () => {
  const adapter = getAdapter("unknown-framework")
  assert.equal(adapter.descriptor.id, "unknown")
  assert.equal(adapter.extractSkills?.([]), undefined)
  assert.equal(adapter.normalizeForStorage?.([]), undefined)
})
