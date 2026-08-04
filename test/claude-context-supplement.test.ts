import assert from "node:assert/strict"
import test from "node:test"

import { aggregateClaudeOtelEvents } from "@/lib/ingest/claude-otel/aggregator"
import { buildAgentCallTree } from "@/lib/engine/observability/agent-trace"
import { MAX_CONTEXT_ITEMS, buildContextSupplementEvents } from "@/lib/ingest/claude-otel/context-supplement"
import type { ClaudeOtelEvent } from "@/lib/ingest/claude-otel/types"

const SESSION = "sess-ctx-1"

function event(eventName: string, attributes: Record<string, any>, overrides: Partial<ClaudeOtelEvent> = {}): ClaudeOtelEvent {
  return {
    receivedAt: "2026-07-29T10:00:10.000Z",
    eventName,
    eventTimestamp: "2026-07-29T10:00:00.000Z",
    sequence: 0,
    sessionId: SESSION,
    promptId: "prompt-1",
    resource: {},
    attributes,
    ...overrides,
  }
}

/** 跨机部署实况:请求/响应体都只有 body_ref,且指向服务端根本不存在的客户端路径。 */
function crossMachineEvents(): ClaudeOtelEvent[] {
  return [
    event("user_prompt", { prompt: "今天星期几" }, { sequence: 0 }),
    event("api_request_body", { body_ref: "/client-only/claude_raw_bodies/abc.request.json", body_length: 120000 }, { sequence: 1 }),
    event("api_request", { input_tokens: 10, output_tokens: 4, cost_usd: 0.001, duration_ms: 900, model: "claude-sonnet-4-6" }, { sequence: 2 }),
    event("api_response_body", { body_ref: "/client-only/claude_raw_bodies/abc.response.json", body_length: 900 }, { sequence: 3 }),
    event("assistant_response", { response: "今天是星期三", model: "claude-sonnet-4-6" }, { sequence: 4 }),
  ]
}

function supplement(kind: string, text: string, extra: Record<string, any> = {}, sequence = 9): ClaudeOtelEvent {
  return event("context_supplement", { kind, text, ...extra }, { sequence, eventTimestamp: "2026-07-29T10:00:05.000Z" })
}

test("补传:跨机读不到 body_ref 时,system prompt 由客户端补传补上", () => {
  const record = aggregateClaudeOtelEvents(SESSION, [
    ...crossMachineEvents(),
    supplement("system_prompt", "You are Claude Code. 项目规范如下……"),
  ])

  assert.ok(record)
  const interactions = record!.interactions as any[]
  const system = interactions.filter((item) => item.role === "system")
  assert.equal(system.length, 1)
  assert.equal(system[0].content, "You are Claude Code. 项目规范如下……")
  assert.equal(system[0].system_prompt_source, "client-supplement")
  // 兜底路径的回复正文不受影响
  assert.equal(interactions.filter((item) => item.role === "assistant").length, 1)
})

test("补传:root 与两个子 Agent 的 system prompt 分别落到自己的 scope", () => {
  const { events: supplementEvents } = buildContextSupplementEvents(
    SESSION,
    [
      { kind: "system_prompt", text: "root system", hash: "sys-root" },
      { kind: "system_prompt", text: "child system", hash: "sys-child-1", toolUseId: "call_child_1", agentType: "general-purpose" },
      { kind: "system_prompt", text: "child system", hash: "sys-child-2", toolUseId: "call_child_2", agentType: "general-purpose" },
      {
        kind: "subagent_map",
        toolUseId: "call_child_1",
        text: JSON.stringify({ toolUseId: "call_child_1", agentType: "general-purpose", messageUuids: ["uuid-child-1"], toolUseIds: [] }),
      },
      {
        kind: "subagent_map",
        toolUseId: "call_child_2",
        text: JSON.stringify({ toolUseId: "call_child_2", agentType: "general-purpose", messageUuids: ["uuid-child-2"], toolUseIds: [] }),
      },
    ],
    { receivedAt: "2026-07-29T10:00:10.000Z", maxTextChars: 64_000 },
  )
  assert.equal(supplementEvents[1].attributes.tool_use_id, "call_child_1")
  assert.equal(supplementEvents[1].attributes.agent_type, "general-purpose")

  const record = aggregateClaudeOtelEvents(SESSION, [
    event("user_prompt", { prompt: "让两个子 Agent 做计算" }, { sequence: 0 }),
    event("api_request", { input_tokens: 10, output_tokens: 2 }, { sequence: 1 }),
    event("assistant_response", { response: "开始分派", query_source: "repl_main_thread", "message.uuid": "uuid-root" }, { sequence: 2 }),
    event("tool_result", {
      tool_name: "Agent",
      tool_use_id: "call_child_1",
      success: "true",
      tool_input: JSON.stringify({ prompt: "计算 3+3" }),
    }, { sequence: 3 }),
    event("assistant_response", { response: "6", query_source: "repl_main_thread", "message.uuid": "uuid-child-1" }, { sequence: 4 }),
    event("tool_result", {
      tool_name: "Agent",
      tool_use_id: "call_child_2",
      success: "true",
      tool_input: JSON.stringify({ prompt: "计算 4×5" }),
    }, { sequence: 5 }),
    event("assistant_response", { response: "20", query_source: "repl_main_thread", "message.uuid": "uuid-child-2" }, { sequence: 6 }),
    ...supplementEvents,
  ])

  assert.ok(record)
  const interactions = record!.interactions as any[]
  const systems = interactions.filter((item) => item.role === "system")
  assert.equal(systems.length, 3)
  assert.equal(systems.find((item) => !item.subagent_session_id)?.content, "root system")
  assert.deepEqual(
    systems.filter((item) => item.subagent_session_id).map((item) => item.subagent_session_id).sort(),
    [`${SESSION}:call_child_1`, `${SESSION}:call_child_2`],
  )

  const parentCalls = interactions.flatMap((item) => item.role === "assistant" ? item.tool_calls || [] : [])
  assert.deepEqual(
    parentCalls.map((call: any) => JSON.parse(call.arguments).subagent_type),
    ["general-purpose", "general-purpose"],
  )
  const tree = buildAgentCallTree(interactions)!
  assert.equal(tree.children.length, 2)
  assert.ok(tree.children.every((child) => child.subagentType === "general-purpose"))
  assert.ok(tree.children.every((child) => child.systemPrompts?.[0]?.text === "child system"))
  assert.ok(tree.events.filter((item) => item.kind === "task").every((item) => item.spawnedChildId))
})

test("补传:Claude 内部 assistant response 全部隐藏且普通响应保留", () => {
  const internalSources = [
    "generate_session_title",
    "prompt_suggestion",
    "prompt_suggestion_generate",
    "away_summary",
    "agent_summary",
  ]
  const record = aggregateClaudeOtelEvents(SESSION, [
    event("user_prompt", { prompt: "真实问题" }, { sequence: 0 }),
    ...internalSources.map((querySource, index) => event(
      "assistant_response",
      { response: `内部内容 ${querySource}`, query_source: querySource },
      { sequence: index + 1, promptId: `internal-${index}` },
    )),
    event(
      "assistant_response",
      { response: "真实回答", query_source: "repl_main_thread" },
      { sequence: 20, promptId: "normal" },
    ),
  ])

  assert.ok(record)
  const assistants = (record!.interactions as any[]).filter((item) => item.role === "assistant")
  assert.deepEqual(assistants.map((item) => item.content), ["真实回答"])
  assert.equal(record!.final_result, "真实回答")
})

test("补传:已进入 spool 的带公共前缀标题 system prompt 仍会被服务端隐藏", () => {
  const internalTitleSystem = [
    "x-anthropic-billing-header: cc_version=2.1.220.de9; cc_entrypoint=cli;",
    "You are Claude Code, Anthropic's official CLI for Claude.",
    "Generate a concise, sentence-case title (3-7 words) for this conversation.",
  ].join("\n")
  const record = aggregateClaudeOtelEvents(SESSION, [
    ...crossMachineEvents(),
    supplement("system_prompt", internalTitleSystem, {}, 5),
    supplement("system_prompt", "真实 root system", {}, 6),
  ])

  const systems = (record!.interactions as any[]).filter((item) => item.role === "system")
  assert.deepEqual(systems.map((item) => item.content), ["真实 root system"])
})

test("补传:没有补传时,跨机 trace 依旧只有 user + assistant(证明回归基线)", () => {
  const record = aggregateClaudeOtelEvents(SESSION, crossMachineEvents())
  const roles = (record!.interactions as any[]).map((item) => item.role)
  assert.deepEqual(roles, ["user", "assistant"])
})

test("补传:真实请求体里的 system 永远优先,补传不覆盖也不重复", () => {
  const inlineBody = JSON.stringify({
    model: "claude-sonnet-4-6",
    system: [{ type: "text", text: "真实 system prompt" }],
    messages: [],
  })
  const responseBody = JSON.stringify({
    id: "msg_1",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text: "ok" }],
    usage: { input_tokens: 3, output_tokens: 1 },
  })

  const record = aggregateClaudeOtelEvents(SESSION, [
    event("user_prompt", { prompt: "hi" }, { sequence: 0 }),
    event("api_request_body", { body: inlineBody }, { sequence: 1 }),
    event("api_request", { input_tokens: 3, output_tokens: 1 }, { sequence: 2 }),
    event("api_response_body", { body: responseBody }, { sequence: 3 }),
    supplement("system_prompt", "补传 system prompt"),
  ])

  const system = (record!.interactions as any[]).filter((item) => item.role === "system")
  assert.equal(system.length, 1)
  assert.equal(system[0].content, "真实 system prompt")
  assert.equal(system[0].system_prompt_source, undefined)
})

test("补传:hook additionalContext 落成独立 role,按内容去重", () => {
  const record = aggregateClaudeOtelEvents(SESSION, [
    ...crossMachineEvents(),
    supplement("hook_context", "注入的上下文", { hook_event: "UserPromptSubmit", hook_name: "UserPromptSubmit", content_hash: "h1" }, 5),
    // 同一份内容重复上传(客户端重试 / 重复触发)不应重复出现
    supplement("hook_context", "注入的上下文", { hook_event: "UserPromptSubmit", hook_name: "UserPromptSubmit", content_hash: "h1" }, 6),
    supplement("hook_context", "另一段上下文", { hook_event: "SessionStart", content_hash: "h2" }, 7),
  ])

  const hooks = (record!.interactions as any[]).filter((item) => item.role === "hook_context")
  assert.equal(hooks.length, 2)
  assert.equal(hooks[0].hook_event, "UserPromptSubmit")
  assert.equal(hooks[0].hook_context_length, "注入的上下文".length)
  assert.equal(hooks[1].hook_event, "SessionStart")
  // 用户输入口径不被污染
  assert.equal(record!.query, "今天星期几")
})

test("补传:只有补传事件时不凭空造 trace", () => {
  const record = aggregateClaudeOtelEvents(SESSION, [
    supplement("system_prompt", "孤儿补传"),
    supplement("hook_context", "孤儿上下文", { hook_event: "SessionStart" }),
  ])
  assert.equal(record, null)
})

test("补传:跨机工具输出补回到那次调用上", () => {
  const record = aggregateClaudeOtelEvents(SESSION, [
    ...crossMachineEvents(),
    event("tool_result", {
      tool_name: "Read",
      tool_use_id: "toolu_1",
      success: "true",
      duration_ms: 12,
      tool_input: JSON.stringify({ file_path: "README.md" }),
      tool_result_size_bytes: "29",  // 只有大小,没有正文 —— 跨机的真实形状
    }, { sequence: 6 }),
    supplement("tool_output", "README 的内容", { tool_use_id: "toolu_1" }, 7),
  ])

  const calls = (record!.interactions as any[]).flatMap((item) => item.tool_calls || [])
  const read = calls.find((call: any) => call.id === "toolu_1")
  assert.ok(read)
  assert.equal(read.output, "README 的内容")
  assert.equal(record!.tool_call_count, 1)
})

test("补传:同机能读到请求体时,工具输出仍以真身为准", () => {
  const requestBodyWithToolResult = JSON.stringify({
    model: "claude-sonnet-4-6",
    system: [{ type: "text", text: "真实 system" }],
    messages: [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "真实输出" }] }] },
    ],
  })

  const responseWithToolUse = JSON.stringify({
    id: "msg_1",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "README.md" } }],
    usage: { input_tokens: 5, output_tokens: 2 },
  })

  const record = aggregateClaudeOtelEvents(SESSION, [
    event("user_prompt", { prompt: "hi" }, { sequence: 0 }),
    event("api_request_body", { body: requestBodyWithToolResult }, { sequence: 1 }),
    event("api_response_body", { body: responseWithToolUse }, { sequence: 2 }),
    event("tool_result", { tool_name: "Read", tool_use_id: "toolu_1", success: "true", tool_result_size_bytes: "4" }, { sequence: 3 }),
    supplement("tool_output", "补传输出", { tool_use_id: "toolu_1" }, 4),
  ])

  const calls = (record!.interactions as any[]).flatMap((item) => item.tool_calls || [])
  assert.equal(calls.find((call: any) => call.id === "toolu_1")?.output, "真实输出")
})

test("补传:Task 调用的输出补上后,跨机也能长出子 agent 节点", () => {
  const record = aggregateClaudeOtelEvents(SESSION, [
    ...crossMachineEvents(),
    event("tool_result", {
      tool_name: "Agent",
      tool_use_id: "toolu_task_1",
      success: "true",
      duration_ms: 5000,
      tool_input: JSON.stringify({ subagent_type: "Explore", prompt: "去找一下配置在哪" }),
    }, { sequence: 6 }),
    supplement("tool_output", "配置在 src/config.ts", { tool_use_id: "toolu_task_1" }, 7),
  ])

  const interactions = record!.interactions as any[]
  const subagent = interactions.find((item) => item.role === "subagent")
  assert.ok(subagent, "应补出子 agent 那一轮")
  assert.equal(subagent.content, "配置在 src/config.ts")
  assert.equal(subagent.subagent_name, "explore")
  assert.equal(subagent.subagent_source, "client-supplement")

  const tree = buildAgentCallTree(interactions)
  assert.ok(tree)
  assert.equal(tree!.children.length, 1)
  assert.equal(tree!.children[0].agentName, "explore")
  assert.equal(tree!.stats.taskCalls, 1)
  // 子节点里应能看到子 agent 的产出
  assert.ok(tree!.children[0].events.some((event) => (event.summary || "").includes("配置在 src/config.ts")))
})

test("补传:同机已经有子 agent 归属时,补传不再重复造一份", () => {
  const responseWithTask = JSON.stringify({
    id: "msg_1",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [
      { type: "text", text: "我让子 agent 去查" },
      { type: "tool_use", id: "toolu_task_1", name: "Agent", input: { subagent_type: "Explore", prompt: "查一下" } },
    ],
    usage: { input_tokens: 5, output_tokens: 2 },
  })
  const subagentResponse = JSON.stringify({
    id: "msg_2",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text: "子 agent 的真实回复" }],
    usage: { input_tokens: 2, output_tokens: 1 },
  })

  const record = aggregateClaudeOtelEvents(SESSION, [
    event("user_prompt", { prompt: "查一下" }, { sequence: 0 }),
    event("api_response_body", { body: responseWithTask }, { sequence: 1 }),
    event("api_response_body", { body: subagentResponse }, { sequence: 2 }),
    event("tool_result", { tool_name: "Agent", tool_use_id: "toolu_task_1", success: "true" }, { sequence: 3 }),
    supplement("tool_output", "补传的子 agent 输出", { tool_use_id: "toolu_task_1" }, 4),
  ])

  const subagents = (record!.interactions as any[]).filter((item) => item.role === "subagent")
  assert.equal(subagents.length, 1)
  assert.equal(subagents[0].subagent_source, undefined)  // 真身那条,不是补传
})

test("补传端点:限额与字段映射(超长截断 / 非法 kind 丢弃 / 条数封顶)", () => {
  const receivedAt = "2026-07-29T10:00:10.000Z"
  const { events, truncated } = buildContextSupplementEvents(
    SESSION,
    [
      { kind: "system_prompt", text: "x".repeat(50), hash: "h", capturedAt: "2026-07-29T09:59:00.000Z" },
      { kind: "hook_context", text: "ctx", hookEvent: "SessionStart", hookName: "n" },
      { kind: "tool_output", text: "不支持的 kind" },
      { kind: "system_prompt", text: "   " },
      { kind: "system_prompt" },
    ],
    { receivedAt, maxTextChars: 10 },
  )

  assert.equal(events.length, 2)
  assert.equal(truncated, 1)
  assert.equal(events[0].attributes.text.length, 10)
  assert.equal(events[0].attributes.truncated, true)
  assert.equal(events[0].eventTimestamp, "2026-07-29T09:59:00.000Z")
  // 归属不由补传决定:事件不带 user
  assert.equal(events[0].user, undefined)
  assert.equal(events[1].attributes.hook_event, "SessionStart")
  assert.equal(events[1].eventTimestamp, receivedAt)  // 没给 capturedAt 就落到收单时间

  const many = buildContextSupplementEvents(
    SESSION,
    Array.from({ length: MAX_CONTEXT_ITEMS + 50 }, () => ({ kind: "hook_context", text: "ctx" })),
    { receivedAt, maxTextChars: 100 },
  )
  assert.equal(many.events.length, MAX_CONTEXT_ITEMS)

  assert.deepEqual(buildContextSupplementEvents(SESSION, "not-an-array", { receivedAt, maxTextChars: 100 }).events, [])
})

test("补传:hook 上下文挂到节点上,不进时间线事件", () => {
  const record = aggregateClaudeOtelEvents(SESSION, [
    ...crossMachineEvents(),
    supplement("system_prompt", "补传 system"),
    supplement("hook_context", "注入的上下文", { hook_event: "UserPromptSubmit", hook_name: "my-hook" }, 5),
  ])

  const tree = buildAgentCallTree(record!.interactions as any[])
  assert.ok(tree)
  assert.equal(tree!.hookContexts?.length, 1)
  assert.equal(tree!.hookContexts?.[0].hookEvent, "UserPromptSubmit")
  assert.equal(tree!.hookContexts?.[0].hookName, "my-hook")
  assert.equal(tree!.systemPrompts?.length, 1)
  // hook 上下文不是模型的一步动作:不能出现在事件流里(否则 LLM/工具计数失真)
  assert.equal(tree!.events.some((event) => (event as any).interaction?.role === "hook_context"), false)
})
