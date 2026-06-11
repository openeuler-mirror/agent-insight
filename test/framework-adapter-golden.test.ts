import test from "node:test"
import assert from "node:assert/strict"
import { normalizeClaudeCodeInteractionsForStorage } from "../src/lib/shared/interaction-content"
import {
  extractSkillsWithVersionsFromClaudeSession,
  extractSkillsWithVersionsFromOpenClawSession,
  extractSkillsWithVersionsFromOpencodeSession,
  normalizeInteractions,
} from "../src/lib/shared/interaction-utils"
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

test("framework skill extraction golden: opencode", () => {
  const normalized = normalizeInteractions(opencodeSkillMessages)
  assert.deepEqual(extractSkillsWithVersionsFromOpencodeSession(normalized), opencodeExpectedSkills)
})

test("framework skill extraction golden: claude", () => {
  const normalized = normalizeInteractions(claudeSkillMessages)
  assert.deepEqual(extractSkillsWithVersionsFromClaudeSession(normalized), claudeExpectedSkills)
})

test("framework skill extraction golden: openclaw", () => {
  const normalized = normalizeInteractions(openclawSkillMessages)
  assert.deepEqual(extractSkillsWithVersionsFromOpenClawSession(normalized), openclawExpectedSkills)
})

test("framework storage normalization golden: claude", () => {
  assert.deepEqual(normalizeClaudeCodeInteractionsForStorage(claudeStorageInput), claudeStorageExpected)
})
