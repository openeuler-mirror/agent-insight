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
