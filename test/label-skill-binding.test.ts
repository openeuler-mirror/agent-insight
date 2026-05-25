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
