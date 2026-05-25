import assert from "node:assert/strict"
import test from "node:test"

import { aggregateClaudeOtelEvents } from "@/lib/ingest/claude-otel/aggregator"
import { buildAgentCallTree } from "@/lib/engine/observability/agent-trace"
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
    content: [{ type: "text", text: "done" }],
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
  assert.deepEqual(record.interactions?.[1]?.content_blocks, [{ type: "text", text: "done" }])
  assert.equal(record.interactions?.[1]?.usage.total, 19)
  assert.ok(record.interactions?.[1]?.timeInfo?.created)
  assert.ok(record.interactions?.[1]?.timeInfo?.completed)
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
