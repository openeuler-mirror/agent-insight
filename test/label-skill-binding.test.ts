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

import assert from "node:assert/strict"
import test from "node:test"

import { parseLabelSkillVersionBinding } from "@/lib/engine/evaluation/label-skill-binding"

test("label binding: parses <skill>-v<version> and produces skill binding payload", () => {
  const b = parseLabelSkillVersionBinding("vmcore-analysis-v3")
  assert.deepEqual(b, {
    skill: "vmcore-analysis",
    skill_version: 3,
    skills: ["vmcore-analysis"],
    invokedSkills: [{ name: "vmcore-analysis", version: 3 }],
  })
})

test("label binding: ignores non-matching labels", () => {
  assert.equal(parseLabelSkillVersionBinding("My Custom Label"), null)
  assert.equal(parseLabelSkillVersionBinding("without-skill"), null)
})

test("label binding: allows v0", () => {
  const b = parseLabelSkillVersionBinding("vmcore-analysis-v0")
  assert.deepEqual(b, {
    skill: "vmcore-analysis",
    skill_version: 0,
    skills: ["vmcore-analysis"],
    invokedSkills: [{ name: "vmcore-analysis", version: 0 }],
  })
})
