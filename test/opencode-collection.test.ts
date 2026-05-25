import test from "node:test"
import assert from "node:assert/strict"
import { extractSkillsWithVersionsFromOpencodeSession, normalizeInteractions } from "../src/lib/shared/interaction-utils"

test("opencode: normalizeInteractions groups into a single turn and preserves assistant request tool calls", () => {
  const messages = [
    { role: "user", content: "Diagnose" },
    {
      role: "assistant",
      content: "Launching subagents",
      tool_calls: [
        {
          id: "call_task_1",
          type: "function",
          function: {
            name: "task",
            arguments: JSON.stringify({
              subagent_type: "kuafu",
              load_skills: ["offline-file-system-fault-diagnosis", { name: "disk-diagnosis-by-log", version: 3 }],
              description: "T1+T2",
            }),
          },
        },
      ],
    },
    {
      role: "assistant",
      content: "Final answer",
      tool_calls: [
        {
          id: "call_skill_1",
          type: "function",
          function: { name: "skill", arguments: JSON.stringify({ name: "some-skill", version: 2 }) },
        },
      ],
    },
  ]

  const normalized = normalizeInteractions(messages as any[])
  assert.equal(normalized.length, 1)
  assert.equal(normalized[0].requestMessages.length, 2)
  assert.equal(normalized[0].responseMessage?.role, "assistant")
  assert.equal(normalized[0].responseMessage?.content, "Final answer")
})

test("opencode: extractSkillsWithVersionsFromOpencodeSession supports skill/load_skill and task.load_skills", () => {
  const messages = [
    { role: "user", content: "Diagnose" },
    {
      role: "assistant",
      content: "Launching subagents",
      tool_calls: [
        {
          id: "call_task_1",
          type: "function",
          function: {
            name: "task",
            arguments: JSON.stringify({
              subagent_type: "kuafu",
              load_skills: ["offline-file-system-fault-diagnosis", { name: "disk-diagnosis-by-log", version: 3 }],
            }),
          },
        },
        {
          id: "call_task_bad_json",
          type: "function",
          function: {
            name: "task",
            arguments: "{not-json}",
          },
        },
      ],
    },
    {
      role: "assistant",
      content: "Final answer",
      tool_calls: [
        {
          id: "call_skill_1",
          type: "function",
          function: { name: "skill", arguments: JSON.stringify({ name: "some-skill", version: 2 }) },
        },
        {
          id: "call_load_skill_1",
          type: "function",
          function: { name: "load_skill", arguments: JSON.stringify({ skill: "another-skill" }) },
        },
      ],
    },
  ]

  const normalized = normalizeInteractions(messages as any[])
  const skills = extractSkillsWithVersionsFromOpencodeSession(normalized)

  assert.deepEqual(skills, [
    { name: "some-skill", version: 2 },
    { name: "another-skill", version: null },
    { name: "offline-file-system-fault-diagnosis", version: null },
    { name: "disk-diagnosis-by-log", version: 3 },
  ])
})

test("opencode: extractSkillsWithVersionsFromOpencodeSession dedupes repeated skill declarations", () => {
  const messages = [
    { role: "user", content: "x" },
    {
      role: "assistant",
      content: "y",
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "skill", arguments: JSON.stringify({ name: "dup-skill", version: 1 }) },
        },
        {
          id: "c2",
          type: "function",
          function: { name: "skill", arguments: JSON.stringify({ name: "dup-skill", version: 2 }) },
        },
        {
          id: "c3",
          type: "function",
          function: {
            name: "task",
            arguments: JSON.stringify({ load_skills: ["dup-skill", "unique-skill"] }),
          },
        },
      ],
    },
  ]

  const normalized = normalizeInteractions(messages as any[])
  const skills = extractSkillsWithVersionsFromOpencodeSession(normalized)
  assert.deepEqual(skills, [
    { name: "dup-skill", version: 1 },
    { name: "unique-skill", version: null },
  ])
})

test("opencode: normalizeInteractions treats opencode role as a user boundary", () => {
  const messages = [
    { role: "user", content: "Top-level user" },
    { role: "assistant", content: "Top-level assistant" },
    { role: "opencode", content: "Child user message (from subagent session)" },
    { role: "subagent", content: "Child assistant message (from subagent session)" },
  ]

  const normalized = normalizeInteractions(messages as any[])
  assert.equal(normalized.length, 2)
  assert.equal(normalized[0].requestMessages.length, 1)
  assert.equal(normalized[0].responseMessage?.content, "Top-level assistant")
  assert.equal(normalized[1].requestMessages.length, 1)
  assert.equal(normalized[1].responseMessage?.content, "Child assistant message (from subagent session)")
})

test("opencode: extractSkillsWithVersionsFromOpencodeSession extracts from subagent role tool calls", () => {
  const messages = [
    { role: "user", content: "x" },
    { role: "assistant", content: "y" },
    {
      role: "opencode",
      content: "child user",
    },
    {
      role: "subagent",
      content: "child assistant",
      tool_calls: [
        {
          id: "call_skill_subagent",
          type: "function",
          function: { name: "skill", arguments: JSON.stringify({ name: "deep-skill", version: 7 }) },
        },
      ],
    },
  ]

  const normalized = normalizeInteractions(messages as any[])
  const skills = extractSkillsWithVersionsFromOpencodeSession(normalized)
  assert.deepEqual(skills, [{ name: "deep-skill", version: 7 }])
})
