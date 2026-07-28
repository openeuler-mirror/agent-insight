import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { aggregateClaudeOtelEvents } from "@/lib/ingest/claude-otel/aggregator"
import { buildAgentCallTree } from "@/lib/engine/observability/agent-trace"
import { ClaudeParser } from "@/lib/engine/observability/claude-parser"
import { normalizeClaudeOtlpLogs } from "@/lib/ingest/claude-otel/otlp-json"
import { normalizeClaudeCodeInteractionsForStorage } from "@/lib/shared/interaction-content"

const attr = (key: string, value: any) => ({
  key,
  value:
    typeof value === "number"
      ? Number.isInteger(value)
        ? { intValue: value }
        : { doubleValue: value }
      : typeof value === "boolean"
        ? { boolValue: value }
        : { stringValue: String(value) },
})

function logRecord(eventName: string, attrs: Record<string, any>) {
  return {
    body: { stringValue: `claude_code.${eventName}` },
    attributes: [
      attr("event.name", eventName),
      attr("event.timestamp", attrs["event.timestamp"] || "2026-05-11T01:00:00.000Z"),
      attr("event.sequence", attrs["event.sequence"] || 0),
      ...Object.entries(attrs)
        .filter(([k]) => k !== "event.timestamp" && k !== "event.sequence")
        .map(([k, v]) => attr(k, v)),
    ],
  }
}

test("Claude OTel: normalizes OTLP logs and aggregates an execution record", () => {
  const responseBody = JSON.stringify({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [
      { type: "text", text: "done" },
      {
        type: "tool_use",
        id: "toolu_1",
        name: "Read",
        input: { file_path: "README.md" },
      },
    ],
    usage: { input_tokens: 10, output_tokens: 4 },
    stop_reason: "end_turn",
  })

  const body = {
    resourceLogs: [
      {
        resource: {
          attributes: [
            attr("service.name", "claude-code"),
            attr("service.version", "2.1.41"),
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              logRecord("user_prompt", {
                "session.id": "session-a",
                "prompt.id": "prompt-a",
                "event.sequence": 1,
                prompt: "hello",
                "user.id": "user-a",
              }),
              logRecord("api_request", {
                "session.id": "session-a",
                "prompt.id": "prompt-a",
                "event.sequence": 2,
                model: "claude-sonnet-4-6",
                input_tokens: 10,
                output_tokens: 4,
                cache_read_tokens: 3,
                cache_creation_tokens: 2,
                duration_ms: 1200,
                cost_usd: 0.01,
              }),
              logRecord("tool_result", {
                "session.id": "session-a",
                "prompt.id": "prompt-a",
                "event.sequence": 3,
                tool_name: "Read",
                tool_use_id: "toolu_1",
                success: "true",
                duration_ms: 50,
                tool_input: JSON.stringify({ file_path: "README.md" }),
                tool_result: "README contents",
              }),
              logRecord("api_response_body", {
                "session.id": "session-a",
                "prompt.id": "prompt-a",
                "event.sequence": 4,
                model: "claude-sonnet-4-6",
                body: responseBody,
                request_id: "req_1",
              }),
            ],
          },
        ],
      },
    ],
  }

  const events = normalizeClaudeOtlpLogs(body, { authenticatedUser: "alice" })
  assert.equal(events.length, 4)
  assert.equal(events[0].sessionId, "session-a")
  assert.equal(events[0].promptId, "prompt-a")
  assert.equal(events[0].user, "alice")

  const record = aggregateClaudeOtelEvents("session-a", events)
  assert.ok(record)
  assert.equal(record.task_id, "session-a")
  assert.equal(record.framework, "claudecode")
  assert.equal(record.query, "hello")
  assert.equal(record.final_result, "done")
  assert.equal(record.model, "claude-sonnet-4-6")
  assert.equal(record.input_tokens, 10)
  assert.equal(record.output_tokens, 4)
  assert.equal(record.cache_read_input_tokens, 3)
  assert.equal(record.cache_creation_input_tokens, 2)
  assert.equal(record.tokens, 19)
  assert.equal(record.llm_call_count, 1)
  assert.equal(record.tool_call_count, 1)
  assert.equal(record.tool_call_error_count, 0)
  assert.equal(record.interactions?.length, 2)
  assert.equal(typeof record.interactions?.[1]?.content, "string")
  assert.equal(record.interactions?.[1]?.content, "done")
  assert.deepEqual(record.interactions?.[1]?.content_blocks, [
    { type: "text", text: "done" },
    {
      type: "tool_use",
      id: "toolu_1",
      name: "Read",
      input: { file_path: "README.md" },
    },
  ])
  assert.equal(record.interactions?.[1]?.tool_calls?.[0]?.output, "README contents")
  assert.equal(record.interactions?.[1]?.usage.total, 19)
  assert.ok(record.interactions?.[1]?.timeInfo?.created)
  assert.ok(record.interactions?.[1]?.timeInfo?.completed)
})

test("Claude OTel: maps tool_result blocks from request body refs onto tool call output", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-otel-body-ref-"))
  const requestBodyPath = path.join(dir, "request.json")
  const responseBody = JSON.stringify({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [
      { type: "text", text: "I'll read it." },
      {
        type: "tool_use",
        id: "toolu_body_ref",
        name: "Read",
        input: { file_path: "README.md" },
      },
    ],
    usage: { input_tokens: 10, output_tokens: 4 },
    stop_reason: "tool_use",
  })
  fs.writeFileSync(requestBodyPath, JSON.stringify({
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_body_ref",
            name: "Read",
            input: { file_path: "README.md" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_body_ref",
            content: "README contents from body_ref",
          },
        ],
      },
    ],
  }))

  const events = normalizeClaudeOtlpLogs({
    resourceLogs: [{
      scopeLogs: [{
        logRecords: [
          logRecord("user_prompt", {
            "session.id": "session-body-ref",
            "prompt.id": "prompt-body-ref",
            "event.sequence": 1,
            prompt: "read the file",
          }),
          logRecord("api_response_body", {
            "session.id": "session-body-ref",
            "prompt.id": "prompt-body-ref",
            "event.sequence": 2,
            model: "claude-sonnet-4-6",
            body: responseBody,
          }),
          logRecord("tool_result", {
            "session.id": "session-body-ref",
            "prompt.id": "prompt-body-ref",
            "event.sequence": 3,
            tool_name: "Read",
            tool_use_id: "toolu_body_ref",
            success: "true",
            duration_ms: 50,
            tool_input: JSON.stringify({ file_path: "README.md" }),
            tool_result_size_bytes: "29",
          }),
          logRecord("api_request_body", {
            "session.id": "session-body-ref",
            "prompt.id": "prompt-body-ref",
            "event.sequence": 4,
            body_ref: requestBodyPath,
          }),
        ],
      }],
    }],
  })

  const record = aggregateClaudeOtelEvents("session-body-ref", events)
  assert.ok(record)
  assert.equal(record.interactions?.[1]?.tool_calls?.[0]?.output, "README contents from body_ref")
})

// 客户端与服务端不同机时(远端部署 / 容器 / 不同用户),body_ref 指向的是客户端本机磁盘,
// 服务端读不到 —— 此前整条助手消息都产不出来,trace 只剩 user,`trace_completed_at`
// 永远推不出来,前端一直显示"执行中"。兜底应从 assistant_response 事件取回正文,
// 并且工具调用不能跟着一起消失。
test("Claude OTel: falls back to assistant_response when body_ref is unreachable", () => {
  const unreachable = path.join(os.tmpdir(), "claude-otel-absent-on-this-host", "abc.response.json")
  const sid = "session-crossmachine"
  const common = { "session.id": sid, "prompt.id": "prompt-x" }
  const body = {
    resourceLogs: [
      {
        resource: { attributes: [attr("service.name", "claude-code")] },
        scopeLogs: [
          {
            logRecords: [
              logRecord("user_prompt", { ...common, "event.sequence": 1, prompt: "读一下 README" }),
              logRecord("api_request", {
                ...common,
                "event.sequence": 2,
                model: "claude-sonnet-4-6",
                input_tokens: 12,
                output_tokens: 5,
                duration_ms: 900,
              }),
              logRecord("assistant_response", {
                ...common,
                "event.sequence": 3,
                response: "我来读一下 README。",
                query_source: "repl_main_thread",
                model: "claude-sonnet-4-6",
              }),
              logRecord("api_response_body", {
                ...common,
                "event.sequence": 4,
                model: "claude-sonnet-4-6",
                body_ref: unreachable,
              }),
              logRecord("tool_result", {
                ...common,
                "event.sequence": 5,
                tool_name: "Read",
                tool_use_id: "toolu_x",
                success: "true",
                duration_ms: 40,
                tool_input: JSON.stringify({ file_path: "README.md" }),
                tool_result: "README contents",
              }),
              logRecord("api_request", {
                ...common,
                "event.sequence": 6,
                model: "claude-sonnet-4-6",
                input_tokens: 20,
                output_tokens: 8,
                duration_ms: 700,
              }),
              logRecord("assistant_response", {
                ...common,
                "event.sequence": 7,
                response: "README 讲的是安装方式。",
                query_source: "repl_main_thread",
                model: "claude-sonnet-4-6",
              }),
              logRecord("api_response_body", {
                ...common,
                "event.sequence": 8,
                model: "claude-sonnet-4-6",
                body_ref: unreachable,
              }),
              // 生成会话标题是内部 LLM 调用,不属于对话内容
              logRecord("assistant_response", {
                ...common,
                "event.sequence": 9,
                response: '{"title": "读 README"}',
                query_source: "generate_session_title",
                model: "claude-sonnet-4-6",
              }),
            ],
          },
        ],
      },
    ],
  }

  const events = normalizeClaudeOtlpLogs(body, { authenticatedUser: "alice" })
  const record = aggregateClaudeOtelEvents(sid, events)
  assert.ok(record)
  assert.deepEqual((record.interactions ?? []).map((m: any) => m.role), ["user", "assistant", "assistant"])
  assert.equal(record.interactions?.[1]?.content, "我来读一下 README。")
  assert.equal(record.interactions?.[2]?.content, "README 讲的是安装方式。")
  assert.equal(record.final_result, "README 讲的是安装方式。")
  // usage 从配对的 api_request 事件取,两轮各自对上
  assert.equal(record.interactions?.[1]?.usage?.total, 17)
  assert.equal(record.interactions?.[2]?.usage?.total, 28)
  // 工具调用挂在发起它的那一轮助手消息上,不能因为读不到 body 就整个丢掉
  assert.equal(record.tool_call_count, 1)
  assert.equal(record.interactions?.[1]?.tool_calls?.length, 1)
  assert.equal(record.interactions?.[1]?.tool_calls?.[0]?.name, "Read")
  assert.equal(record.interactions?.[1]?.tool_calls?.[0]?.output, "README contents")
})

test("Claude OTel: maps Agent tool calls into trace subagent relationships", () => {
  const parentBody = JSON.stringify({
    id: "msg_parent",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [
      { type: "text", text: "dispatch" },
      {
        type: "tool_use",
        id: "toolu_agent_1",
        name: "Agent",
        input: {
          description: "solve",
          prompt: "1+1",
        },
      },
    ],
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 },
    stop_reason: "tool_use",
  })
  const childBody = JSON.stringify({
    id: "msg_child",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text: "2" }],
    usage: { input_tokens: 30, output_tokens: 3 },
    stop_reason: "end_turn",
  })

  const events = normalizeClaudeOtlpLogs({
    resourceLogs: [{
      scopeLogs: [{
        logRecords: [
          logRecord("user_prompt", {
            "session.id": "session-sub",
            "prompt.id": "prompt-sub",
            "event.sequence": 1,
            prompt: "run subagent",
          }),
          logRecord("api_request", {
            "session.id": "session-sub",
            "prompt.id": "prompt-sub",
            "event.sequence": 2,
            model: "claude-sonnet-4-6",
            input_tokens: 100,
            output_tokens: 20,
            cache_read_tokens: 5,
            duration_ms: 2000,
          }),
          logRecord("api_response_body", {
            "session.id": "session-sub",
            "prompt.id": "prompt-sub",
            "event.sequence": 3,
            model: "claude-sonnet-4-6",
            body: parentBody,
          }),
          logRecord("api_request", {
            "session.id": "session-sub",
            "prompt.id": "prompt-sub",
            "event.sequence": 4,
            model: "claude-sonnet-4-6",
            input_tokens: 30,
            output_tokens: 3,
            duration_ms: 800,
          }),
          logRecord("api_response_body", {
            "session.id": "session-sub",
            "prompt.id": "prompt-sub",
            "event.sequence": 5,
            model: "claude-sonnet-4-6",
            body: childBody,
          }),
          logRecord("tool_result", {
            "session.id": "session-sub",
            "prompt.id": "prompt-sub",
            "event.sequence": 6,
            tool_name: "Agent",
            tool_use_id: "toolu_agent_1",
            success: "true",
            duration_ms: 810,
            tool_input: JSON.stringify({ subagent_type: "general-purpose" }),
          }),
        ],
      }],
    }],
  })

  const record = aggregateClaudeOtelEvents("session-sub", events)
  assert.ok(record)
  const parent = record.interactions?.find((item: any) => item.role === "assistant" && item.tool_calls?.length)
  const child = record.interactions?.find((item: any) => item.role === "subagent")
  assert.equal(parent?.agent, "Claude Code")
  assert.equal(parent?.tool_calls?.[0]?.function?.name, "task")
  assert.equal(JSON.parse(parent?.tool_calls?.[0]?.function?.arguments || "{}").subagent_type, "agent")
  assert.equal(parent?.tool_calls?.[0]?.timing?.completed_at, "2026-05-11T01:00:00.000Z")
  assert.equal(child?.agent, "agent")
  assert.equal(child?.subagent_name, "agent")
  assert.equal(child?.subagent_session_id, "session-sub:prompt-sub:agent:toolu_agent_1")
  assert.equal(child?.usage.total, 33)

  const tree = buildAgentCallTree(record.interactions as any[])
  assert.equal(tree?.agentName, "Claude Code")
  assert.equal(tree?.stats.totalTokens, 125)
  assert.equal(tree?.children.length, 1)
  assert.equal(tree?.children[0]?.subagentType, "agent")
  assert.equal(tree?.children[0]?.stats.totalTokens, 33)
})

test("Claude OTel: surfaces the system prompt from api_request_body", () => {
  const systemText = "You are Claude Code. Follow the rules and use tools."
  const responseBody = JSON.stringify({
    id: "msg_sys",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text: "hi" }],
    usage: { input_tokens: 5, output_tokens: 2 },
    stop_reason: "end_turn",
  })
  // Anthropic carries the system prompt at the top level (string OR text-block array),
  // separate from `messages`.
  const requestBody = JSON.stringify({
    model: "claude-sonnet-4-6",
    system: [{ type: "text", text: systemText }],
    messages: [{ role: "user", content: "hello" }],
  })

  const events = normalizeClaudeOtlpLogs({
    resourceLogs: [{
      scopeLogs: [{
        logRecords: [
          logRecord("user_prompt", {
            "session.id": "s-sys",
            "prompt.id": "p-sys",
            "event.sequence": 1,
            prompt: "hello",
          }),
          logRecord("api_request_body", {
            "session.id": "s-sys",
            "prompt.id": "p-sys",
            "event.sequence": 2,
            body: requestBody,
          }),
          logRecord("api_response_body", {
            "session.id": "s-sys",
            "prompt.id": "p-sys",
            "event.sequence": 3,
            model: "claude-sonnet-4-6",
            body: responseBody,
          }),
        ],
      }],
    }],
  })

  const record = aggregateClaudeOtelEvents("s-sys", events)
  assert.ok(record)
  const system = record.interactions?.find((item: any) => item.role === "system")
  assert.ok(system, "expected a system interaction")
  assert.equal(system.content, systemText)
  assert.equal(system.system_prompt_length, systemText.length)

  const tree = buildAgentCallTree(record.interactions as any[])
  assert.equal(tree?.systemPrompts?.length, 1)
  assert.equal(tree?.systemPrompts?.[0]?.text, systemText)
})

test("Claude OTel: surfaces thinking blocks as reasoning parts", () => {
  const responseBody = JSON.stringify({
    id: "msg_think",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [
      { type: "thinking", thinking: "Let me reason about this step by step.", signature: "sig" },
      { type: "text", text: "The answer is 4." },
    ],
    usage: { input_tokens: 6, output_tokens: 3 },
    stop_reason: "end_turn",
  })

  const events = normalizeClaudeOtlpLogs({
    resourceLogs: [{
      scopeLogs: [{
        logRecords: [
          logRecord("user_prompt", {
            "session.id": "s-think",
            "prompt.id": "p-think",
            "event.sequence": 1,
            prompt: "what is 2+2?",
          }),
          logRecord("api_response_body", {
            "session.id": "s-think",
            "prompt.id": "p-think",
            "event.sequence": 2,
            model: "claude-sonnet-4-6",
            body: responseBody,
          }),
        ],
      }],
    }],
  })

  const record = aggregateClaudeOtelEvents("s-think", events)
  assert.ok(record)
  const assistant = record.interactions?.find((item: any) => item.role === "assistant")
  assert.ok(assistant, "expected an assistant interaction")
  // visible answer stays as content; thinking is carried separately as a reasoning part
  assert.equal(assistant.content, "The answer is 4.")
  assert.deepEqual(assistant.parts, [
    { type: "reasoning", text: "Let me reason about this step by step." },
  ])
})

test("ClaudeCode interactions: converts content blocks to storage-safe strings", () => {
  const rawBlocks = [{ type: "text", text: "hello" }]
  const normalized = normalizeClaudeCodeInteractionsForStorage([
    {
      role: "assistant",
      content: rawBlocks,
    },
  ])

  assert.equal(normalized[0].content, "hello")
  assert.deepEqual(normalized[0].content_blocks, rawBlocks)
})

test("Claude parser: maps tool_result blocks back onto tool_calls output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-parser-"))
  const file = path.join(dir, "session.jsonl")
  const lines = [
    {
      type: "user",
      sessionId: "claude-session",
      timestamp: "2026-05-11T01:00:00.000Z",
      message: { content: "read the file" },
    },
    {
      type: "assistant",
      sessionId: "claude-session",
      timestamp: "2026-05-11T01:00:01.000Z",
      message: {
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [
          { type: "text", text: "I'll read it." },
          {
            type: "tool_use",
            id: "toolu_read_1",
            name: "Read",
            input: { file_path: "README.md" },
          },
        ],
      },
    },
    {
      type: "user",
      sessionId: "claude-session",
      timestamp: "2026-05-11T01:00:02.000Z",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_read_1",
            content: "README contents",
          },
        ],
      },
      toolUseID: "toolu_read_1",
      toolUseResult: { durationMs: 25 },
    },
    {
      type: "assistant",
      sessionId: "claude-session",
      timestamp: "2026-05-11T01:00:03.000Z",
      message: {
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 8, output_tokens: 2 },
        content: [{ type: "text", text: "done" }],
      },
    },
  ]
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"))

  try {
    const record = await new ClaudeParser().parseFile(file)
    assert.ok(record)
    const assistant = record.interactions.find((item: any) => item.role === "assistant" && item.tool_calls?.length)
    assert.equal(assistant?.tool_calls?.[0]?.output, "README contents")
    assert.equal(assistant?.tool_calls?.[0]?.timing?.duration_ms, 25)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
