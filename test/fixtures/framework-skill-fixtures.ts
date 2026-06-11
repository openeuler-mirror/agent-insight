import type { InvokedSkill } from "../../src/lib/shared/interaction-utils"

export const opencodeSkillMessages = [
  { role: "user", content: "Diagnose the session" },
  {
    role: "assistant",
    content: "Preparing subagents",
    tool_calls: [
      {
        id: "call_task",
        type: "function",
        function: {
          name: "task",
          arguments: JSON.stringify({
            load_skills: [
              "task-skill",
              { name: "versioned-task-skill", version: "3" },
              { name: "bad skill name" },
              "main-skill",
            ],
          }),
        },
      },
      {
        id: "call_bad_json",
        type: "function",
        function: {
          name: "skill",
          arguments: "{bad-json}",
        },
      },
    ],
  },
  {
    role: "user",
    content: "This user-side tool call should be ignored",
    tool_calls: [
      {
        id: "call_user_skill",
        type: "function",
        function: {
          name: "skill",
          arguments: JSON.stringify({ name: "ignored-user-skill" }),
        },
      },
    ],
  },
  {
    role: "assistant",
    content: "Done",
    tool_calls: [
      {
        id: "call_skill",
        type: "function",
        function: {
          name: "skill",
          arguments: JSON.stringify({ name: "main-skill", version: 2 }),
        },
      },
      {
        id: "call_load_skill",
        type: "function",
        function: {
          name: "load_skill",
          arguments: JSON.stringify({ skill: "secondary-skill" }),
        },
      },
      {
        id: "call_invalid",
        type: "function",
        function: {
          name: "skill",
          arguments: JSON.stringify({ name: "bad skill name" }),
        },
      },
    ],
  },
]

export const opencodeExpectedSkills: InvokedSkill[] = [
  { name: "task-skill", version: null },
  { name: "versioned-task-skill", version: 3 },
  { name: "main-skill", version: null },
  { name: "secondary-skill", version: null },
]

export const claudeSkillMessages = [
  { role: "user", content: "Diagnose the session" },
  {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        name: "skill",
        input: { name: "claude-request-skill", version: "5" },
      },
      {
        type: "tool_use",
        name: "not_a_skill",
        input: { name: "ignored-tool" },
      },
    ],
  },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Working" },
      {
        type: "tool_use",
        name: "load_skill",
        input: { skill: "claude-response-skill", version: 4 },
      },
      {
        type: "tool_use",
        name: "skill",
        input: { name: "bad skill name" },
      },
      {
        type: "tool_result",
        name: "skill",
        input: { name: "ignored-result" },
      },
    ],
  },
]

export const claudeExpectedSkills: InvokedSkill[] = [
  { name: "claude-response-skill", version: 4 },
  { name: "claude-request-skill", version: 5 },
]

export const openclawSkillMessages = [
  { role: "user", content: "Diagnose the session" },
  {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        name: "skill",
        arguments: { name: "openclaw-request-skill", version: "7" },
      },
    ],
  },
  {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        name: "load_skill",
        arguments: { skill: "openclaw-response-skill" },
      },
      {
        type: "tool_use",
        name: "skill",
        arguments: { name: "ignored-claude-shape" },
      },
      {
        type: "toolCall",
        name: "skill",
        arguments: { name: "bad skill name" },
      },
    ],
  },
]

export const openclawExpectedSkills: InvokedSkill[] = [
  { name: "openclaw-response-skill", version: null },
  { name: "openclaw-request-skill", version: 7 },
]

const claudeContentBlocks = [
  { type: "text", text: "hello " },
  { type: "tool_use", name: "skill", input: { name: "claude-storage-skill" } },
  { type: "text", text: "world" },
]

const claudeResponseBlocks = [{ type: "text", text: "done" }]
const claudeRequestBlocks = [{ type: "text", text: "ask" }]

export const claudeStorageInput = [
  {
    role: "assistant",
    content: claudeContentBlocks,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "nested message" }],
    },
    responseMessage: {
      role: "assistant",
      content: claudeResponseBlocks,
    },
    requestMessages: [
      {
        role: "user",
        content: claudeRequestBlocks,
      },
      {
        role: "assistant",
        content: "already text",
      },
    ],
  },
]

export const claudeStorageExpected = [
  {
    role: "assistant",
    content: "hello world",
    content_blocks: claudeContentBlocks,
    message: {
      role: "assistant",
      content: "nested message",
      content_blocks: [{ type: "text", text: "nested message" }],
    },
    responseMessage: {
      role: "assistant",
      content: "done",
      content_blocks: claudeResponseBlocks,
    },
    requestMessages: [
      {
        role: "user",
        content: "ask",
        content_blocks: claudeRequestBlocks,
      },
      {
        role: "assistant",
        content: "already text",
      },
    ],
  },
]
