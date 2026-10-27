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

import { chooseExecutionLabel } from "@/lib/engine/evaluation/label-utils"

test("label: preserves manual label and does not overwrite it with skill-version label", () => {
  const label = chooseExecutionLabel({
    existingLabel: "My Custom Label",
    incomingLabel: undefined,
    skill: "vmcore-analysis",
    skillVersion: 3,
  })
  assert.equal(label, "My Custom Label")
})

test("label: uses incoming label when provided", () => {
  const label = chooseExecutionLabel({
    existingLabel: "Old",
    incomingLabel: "New Label",
    skill: "vmcore-analysis",
    skillVersion: 3,
  })
  assert.equal(label, "New Label")
})

test("label: preserves skill-vx label as manual label", () => {
  const label = chooseExecutionLabel({
    existingLabel: "vmcore-analysis-v1",
    incomingLabel: undefined,
    skill: "vmcore-analysis",
    skillVersion: 3,
  })
  assert.equal(label, "vmcore-analysis-v1")
})

test("label: auto-generates when existing label is 'without-skill'", () => {
  const label = chooseExecutionLabel({
    existingLabel: "without-skill",
    incomingLabel: undefined,
    skill: "vmcore-analysis",
    skillVersion: 3,
  })
  assert.equal(label, "vmcore-analysis-v3")
})

test("label: auto-generates when no existing label", () => {
  const label = chooseExecutionLabel({
    existingLabel: undefined,
    incomingLabel: undefined,
    skill: "vmcore-analysis",
    skillVersion: 3,
  })
  assert.equal(label, "vmcore-analysis-v3")
})

test("label: generates without-skill when no skill", () => {
  const label = chooseExecutionLabel({
    existingLabel: "without-skill",
    incomingLabel: undefined,
    skill: undefined,
    skillVersion: undefined,
  })
  assert.equal(label, "without-skill")
})

test("label: uses v0 as default version when skillVersion is missing", () => {
  const label = chooseExecutionLabel({
    existingLabel: undefined,
    incomingLabel: undefined,
    skill: "my-skill",
    skillVersion: undefined,
  })
  assert.equal(label, "my-skill-v0")
})
