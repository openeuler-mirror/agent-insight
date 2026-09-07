import assert from "node:assert/strict"
import test from "node:test"
import { createRequire } from "node:module"

import { normalizeClaudeOtlpTraces } from "@/lib/ingest/claude-otel/otlp-json"
import { aggregateOtelTraceEvents } from "@/lib/ingest/otel/aggregate"
import { getOtelTraceAdapter } from "@/lib/ingest/otel/adapter-registry"

const require = createRequire(import.meta.url)
const { mapWorkBuddyTrace, normalizeUsage, extractUserQuery } = require("../scripts/workbuddy-collector/mapper.cjs")
const { canonicalEventsToOtlp } = require("../scripts/agent-trace-collectors/shared/trace-transport.cjs")

/** 构造一条贴近真实结构的 WorkBuddy trace（trace + agent/generation/function/custom spans）。 */
function workbuddyTrace(overrides: {
  traceId: string
  start: string
  prompt: string
  model?: string
  completion?: string
  usage?: Record<string, unknown>
  tool?: { name: string; input: unknown; output: unknown }
}) {
  const usage = overrides.usage ?? {
    prompt_tokens: 500,
    completion_tokens: 120,
    total_tokens: 620,
    prompt_tokens_details: { cached_tokens: 448 },
    completion_tokens_details: { reasoning_tokens: 88 },
  }
  const spans: any[] = [
    {
      traceId: overrides.traceId,
      spanId: `${overrides.traceId}-agent`,
      parentId: null,
      name: "cli",
      type: "agent",
      startedAt: overrides.start,
      endedAt: overrides.start,
      status: "ok",
      agentName: "cli",
    },
    { traceId: overrides.traceId, spanId: `${overrides.traceId}-mcp1`, parentId: null, name: "mcp_tools", type: "custom", startedAt: overrides.start, endedAt: overrides.start, status: "ok" },
    {
      traceId: overrides.traceId,
      spanId: `${overrides.traceId}-gen`,
      parentId: `${overrides.traceId}-agent`,
      name: "generation",
      type: "generation",
      startedAt: overrides.start,
      endedAt: overrides.start,
      status: "ok",
      toolInput: JSON.stringify([
        { role: "system", content: "system prompt" },
        { role: "user", content: [{ type: "text", text: overrides.prompt }] },
      ]),
      toolOutput: JSON.stringify([
        {
          id: "resp-1",
          model: overrides.model ?? "hy4-preview",
          object: "chat.completion",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: overrides.completion ?? "done" } }],
          usage,
        },
      ]),
    },
  ]
  if (overrides.tool) {
    spans.push({
      traceId: overrides.traceId,
      spanId: `${overrides.traceId}-fn`,
      parentId: `${overrides.traceId}-gen`,
      name: overrides.tool.name,
      type: "function",
      startedAt: overrides.start,
      endedAt: overrides.start,
      status: "ok",
      toolName: overrides.tool.name,
      toolInput: JSON.stringify(overrides.tool.input),
      toolOutput: JSON.stringify(overrides.tool.output),
    })
  }
  return {
    trace: {
      traceId: overrides.traceId,
      name: "Agent workflow",
      startedAt: overrides.start,
      endedAt: overrides.start,
      status: "ok",
      spanCount: spans.length,
      totalTokens: 0,
    },
    spans,
  }
}

/** 采集端到服务端全链路：mapper → canonicalEventsToOtlp → normalize → aggregate。 */
function roundTrip(docs: any[], sessionId: string, enrichment: Record<string, unknown> = {}) {
  const canonical = docs.flatMap((doc) => mapWorkBuddyTrace(doc, { sessionId, ...enrichment }))
  // 采集器对 WorkBuddy 关闭本地路径脱敏（保留文件路径这一核心观测信号），此处对齐真实行为。
  const otlp = canonicalEventsToOtlp(canonical, { framework: "workbuddy", redactLocalPaths: false })
  const events = normalizeClaudeOtlpTraces(otlp, { receivedAt: "2026-09-06T00:00:00.000Z" })
  return { canonical, events, record: aggregateOtelTraceEvents(sessionId, events) }
}

test("normalizeUsage: 从模型响应精确提取 input/output/reasoning/cache", () => {
  const usage = normalizeUsage({
    prompt_tokens: 513,
    completion_tokens: 1105,
    total_tokens: 1618,
    prompt_tokens_details: { cached_tokens: 448 },
    completion_tokens_details: { reasoning_tokens: 1087 },
  })
  assert.equal(usage.input, 513)
  assert.equal(usage.output, 1105)
  assert.equal(usage.total, 1618)
  assert.equal(usage.reasoning, 1087)
  assert.equal(usage.cache, 448)
})

test("normalizeUsage: 无 usage 返回 undefined（不编造 0）", () => {
  assert.equal(normalizeUsage(undefined), undefined)
  assert.equal(normalizeUsage({}), undefined)
})

test("extractUserQuery: 剥离注入的 system-reminder，取 <user_query> 真实输入", () => {
  const injected = '<system-reminder data-role="user-context">\n<user_info>OS: win32</user_info>\n(6000 chars of context...)\n</system-reminder>\n<user_query>执行父子Agent协同架构_门店看板实例</user_query>'
  assert.equal(extractUserQuery(injected), "执行父子Agent协同架构_门店看板实例")
  // 无 user_query 标签时，剥掉 system-reminder 块
  assert.equal(extractUserQuery("<system-reminder>ctx</system-reminder>\n真实问题"), "真实问题")
  // 无任何标签时原样返回
  assert.equal(extractUserQuery("你好"), "你好")
})

test("WorkBuddy round-trip: USER 节点取 <user_query> 内容，不含 system-reminder", () => {
  const doc = workbuddyTrace({
    traceId: "trace-uq",
    start: "2026-09-07T00:00:01.000Z",
    prompt: '<system-reminder data-role="user-context"><user_info>OS: win32</user_info></system-reminder>\n<user_query>门店看板实例</user_query>',
    completion: "好的",
  })
  const { record } = roundTrip([doc], "sess-uq")
  assert.ok(record)
  assert.equal(record.query, "门店看板实例")
  const user = record.interactions?.find((i: any) => i.role === "user")
  assert.equal(user?.content, "门店看板实例")
  assert.ok(!String(user?.content).includes("system-reminder"))
})

test("WorkBuddy round-trip: 单轮 trace 聚合出精确 token 与工具调用", () => {
  const doc = workbuddyTrace({
    traceId: "trace-1",
    start: "2026-09-06T00:00:01.000Z",
    prompt: "你好",
    completion: "你好，有什么可以帮你？",
    tool: { name: "Read", input: { file_path: "README.md" }, output: { title: "Read 3 lines", content: "hello" } },
  })
  const { events, record } = roundTrip([doc], "sess-1", {
    mode: "craft",
    sessionTotals: { used: 620, size: 300000 },
  })

  // 命中 workbuddy adapter（而非 generic 兜底）
  assert.equal(getOtelTraceAdapter(events)?.id, "workbuddy")

  assert.ok(record)
  assert.equal(record.task_id, "sess-1")
  assert.equal(record.framework, "workbuddy")
  assert.equal(record.model, "hy4-preview")
  assert.equal(record.query, "你好")
  assert.equal(record.final_result, "你好，有什么可以帮你？")
  // 精确逐轮 token（来自 generation.toolOutput.usage）
  assert.equal(record.tokens, 620)
  assert.equal(record.input_tokens, 500)
  assert.equal(record.output_tokens, 120)
  assert.equal(record.reasoning_tokens, 88)
  assert.equal(record.cache_read_input_tokens, 448)
  // 会话级上下文占用快照（来自 D4），与逐轮 token 分开表达
  assert.equal(record.context_window_limit, 300000)
  assert.equal(record.workbuddy_session_context_tokens, 620)
  assert.equal(record.context_window_source, "workbuddy_local_sqlite")
  // 交互：user → assistant(带工具调用)
  assert.equal(record.interactions?.[0]?.role, "user")
  assert.equal(record.interactions?.[0]?.content, "你好")
  const assistant = record.interactions?.find((i: any) => i.role === "assistant")
  assert.ok(assistant)
  assert.equal(assistant.tool_calls?.length, 1)
  assert.equal(assistant.tool_calls?.[0]?.function?.name, "Read")
  assert.equal(record.llm_call_count, 1)
  assert.equal(record.tool_call_count, 1) // mcp_tools 噪声 span 不计入
})

test("WorkBuddy round-trip: 保留真实文件路径（不脱敏为 [LOCAL_PATH]），但密钥仍脱敏", () => {
  const doc = workbuddyTrace({
    traceId: "trace-path",
    start: "2026-09-06T00:00:01.000Z",
    prompt: "读文件",
    tool: {
      name: "Read",
      input: { file_path: "C:\\Users\\Administrator\\.workbuddy\\USER.md", api_key: "sk-abcdef1234567890" },
      output: { content: "hi" },
    },
  })
  const { record } = roundTrip([doc], "sess-path")
  const call = record?.interactions?.find((i: any) => i.tool_calls?.length)?.tool_calls?.[0]
  assert.ok(call)
  // 文件路径完整保留（编码 Agent 的核心信号）
  assert.equal(call.function?.arguments?.file_path, "C:\\Users\\Administrator\\.workbuddy\\USER.md")
  // 但密钥仍被脱敏
  assert.equal(call.function?.arguments?.api_key, "[REDACTED]")
})

test("WorkBuddy round-trip: 多条 trace 归并为一个多轮会话", () => {
  const t1 = workbuddyTrace({ traceId: "trace-a", start: "2026-09-06T00:00:01.000Z", prompt: "第一轮问题", completion: "第一轮回答" })
  const t2 = workbuddyTrace({ traceId: "trace-b", start: "2026-09-06T00:01:00.000Z", prompt: "第二轮问题", completion: "第二轮回答", usage: { prompt_tokens: 700, completion_tokens: 80, total_tokens: 780 } })
  const { record } = roundTrip([t1, t2], "sess-multi", { sessionTotals: { used: 780, size: 200000 } })

  assert.ok(record)
  // 首轮用户提问作为会话 query
  assert.equal(record.query, "第一轮问题")
  // 两轮用户 + 两轮 assistant
  const users = record.interactions?.filter((i: any) => i.role === "user") ?? []
  const assistants = record.interactions?.filter((i: any) => i.role === "assistant") ?? []
  assert.equal(users.length, 2)
  assert.equal(assistants.length, 2)
  // token 为两轮精确 usage 汇总
  assert.equal(record.tokens, 620 + 780)
  assert.equal(record.llm_call_count, 2)
})

test("WorkBuddy: 跳过内部标题生成器 trace（不产生 <session> 污染的 USER 节点）", () => {
  // terminalTitleGenerator 是内部标题生成调用，把首条消息包在 <session> 里喂 LLM。
  const titleGenDoc = {
    trace: { traceId: "trace-title", name: "Agent workflow", startedAt: "2026-09-06T00:00:00.000Z", endedAt: "2026-09-06T00:00:08.000Z", status: "ok" },
    spans: [
      { traceId: "trace-title", spanId: "t-agent", parentId: null, name: "terminalTitleGenerator", type: "agent", startedAt: "2026-09-06T00:00:00.100Z", endedAt: "2026-09-06T00:00:08.000Z", status: "ok", agentName: "terminalTitleGenerator" },
      {
        traceId: "trace-title", spanId: "t-gen", parentId: "t-agent", name: "generation", type: "generation",
        startedAt: "2026-09-06T00:00:00.500Z", endedAt: "2026-09-06T00:00:08.000Z", status: "ok",
        toolInput: JSON.stringify([
          { role: "system", content: "Generate a concise title..." },
          { role: "user", content: [{ type: "text", text: "<session>\n执行父子Agent协同架构_门店看板实例\n</session>" }] },
        ]),
        toolOutput: JSON.stringify([{ model: "hy3", choices: [{ message: { role: "assistant", content: "{\"title\":\"门店看板\"}" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }]),
      },
    ],
  }
  // mapper 直接跳过整条内部 trace
  const events = mapWorkBuddyTrace(titleGenDoc, { sessionId: "sess-title" })
  assert.equal(events.length, 0)

  // 端到端：标题生成器 trace 不产生任何 record（更不会有 <session> 的 USER 节点）
  const { record } = roundTrip([titleGenDoc], "sess-title")
  assert.equal(record, null)
})

test("WorkBuddy: 跳过内部 contentAnalyzer trace（无 <user_query> 的内部子调用）", () => {
  const doc = {
    trace: { traceId: "trace-ca", name: "Agent workflow", startedAt: "2026-09-07T00:00:00.000Z", endedAt: "2026-09-07T00:00:05.000Z", status: "ok" },
    spans: [
      { traceId: "trace-ca", spanId: "ca-agent", parentId: null, name: "contentAnalyzer", type: "agent", startedAt: "2026-09-07T00:00:00.100Z", endedAt: "2026-09-07T00:00:05.000Z", status: "ok", agentName: "contentAnalyzer" },
      {
        traceId: "trace-ca", spanId: "ca-gen", parentId: "ca-agent", name: "generation", type: "generation",
        startedAt: "2026-09-07T00:00:01.000Z", endedAt: "2026-09-07T00:00:04.000Z", status: "ok",
        toolInput: JSON.stringify([{ role: "user", content: [{ type: "text", text: "## Web Content to Analyze\n..." }] }]),
        toolOutput: JSON.stringify([{ model: "hy3", choices: [{ message: { role: "assistant", content: "analysis" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }]),
      },
    ],
  }
  assert.equal(mapWorkBuddyTrace(doc, { sessionId: "sess-ca" }).length, 0)
})

test("WorkBuddy round-trip: cli + 内部子 Agent 混合 trace，根提问取真实 <user_query>", () => {
  const traceId = "trace-mixed"
  const doc = {
    trace: { traceId, name: "Agent workflow", startedAt: "2026-09-07T00:00:00.000Z", endedAt: "2026-09-07T00:00:10.000Z", status: "ok" },
    spans: [
      { traceId, spanId: "m-agent", parentId: null, name: "cli", type: "agent", startedAt: "2026-09-07T00:00:00.100Z", endedAt: "2026-09-07T00:00:10.000Z", status: "ok", agentName: "cli" },
      // 内部 contentAnalyzer 子调用先出现（无 <user_query>），不应被当成用户提问
      {
        traceId, spanId: "m-ca", parentId: "m-agent", name: "generation", type: "generation",
        startedAt: "2026-09-07T00:00:01.000Z", endedAt: "2026-09-07T00:00:02.000Z", status: "ok",
        toolInput: JSON.stringify([{ role: "user", content: [{ type: "text", text: "## Web Content to Analyze\n..." }] }]),
        toolOutput: JSON.stringify([{ model: "hy4-preview", choices: [{ message: { role: "assistant", content: "内部分析" } }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }]),
      },
      // 真实用户轮
      {
        traceId, spanId: "m-cli", parentId: "m-agent", name: "generation", type: "generation",
        startedAt: "2026-09-07T00:00:03.000Z", endedAt: "2026-09-07T00:00:04.000Z", status: "ok",
        toolInput: JSON.stringify([{ role: "user", content: [{ type: "text", text: '<system-reminder>ctx</system-reminder>\n<user_query>真实问题</user_query>' }] }]),
        toolOutput: JSON.stringify([{ model: "hy4-preview", choices: [{ message: { role: "assistant", content: "回答" } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }]),
      },
    ],
  }
  const { record } = roundTrip([doc], "sess-mixed")
  assert.ok(record)
  assert.equal(record.query, "真实问题")
  const users = record.interactions?.filter((i: any) => i.role === "user") ?? []
  assert.equal(users[0]?.content, "真实问题")
})

test("WorkBuddy round-trip: generation 缺失 usage 时不编造 token", () => {
  const doc = workbuddyTrace({ traceId: "trace-nousage", start: "2026-09-06T00:00:01.000Z", prompt: "hi", usage: {} as any })
  // 把 toolOutput 的 usage 清空
  const gen = doc.spans.find((s: any) => s.type === "generation")
  gen.toolOutput = JSON.stringify([{ model: "hy4-preview", choices: [{ message: { role: "assistant", content: "ok" } }] }])
  const { record } = roundTrip([doc], "sess-nousage")
  assert.ok(record)
  assert.equal(record.tokens, undefined)
  assert.equal(record.input_tokens, undefined)
  assert.equal(record.output_tokens, undefined)
})

// 真实 WorkBuddy 结构：function 与 generation 都平级挂在 agent span 之下，
// 工具与其对应的那次 LLM 之间没有父子链——必须按时间就近归属，否则所有工具会挤到最后一个 assistant。
function interleavedTrace() {
  const traceId = "trace-seq"
  const agentId = `${traceId}-agent`
  const gen = (n: number, ms: string) => ({
    traceId, spanId: `${traceId}-gen${n}`, parentId: agentId, name: "generation", type: "generation",
    startedAt: ms, endedAt: ms, status: "ok",
    toolInput: JSON.stringify([{ role: "user", content: [{ type: "text", text: "问题" }] }]),
    toolOutput: JSON.stringify([{ model: "hy4-preview", choices: [{ message: { role: "assistant", content: `回答${n}` } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }]),
  })
  const fn = (name: string, ms: string) => ({
    traceId, spanId: `${traceId}-fn-${name}`, parentId: agentId, name, type: "function",
    startedAt: ms, endedAt: ms, status: "ok", toolName: name,
    toolInput: JSON.stringify({ x: 1 }), toolOutput: JSON.stringify({ content: "ok" }),
  })
  return {
    trace: { traceId, name: "Agent workflow", startedAt: "2026-09-06T00:00:00.000Z", endedAt: "2026-09-06T00:00:10.000Z", status: "ok" },
    spans: [
      { traceId, spanId: agentId, parentId: null, name: "cli", type: "agent", startedAt: "2026-09-06T00:00:00.500Z", endedAt: "2026-09-06T00:00:10.000Z", status: "ok", agentName: "cli" },
      gen(1, "2026-09-06T00:00:01.000Z"),
      fn("ToolA", "2026-09-06T00:00:02.000Z"),
      gen(2, "2026-09-06T00:00:03.000Z"),
      fn("ToolB", "2026-09-06T00:00:04.000Z"),
    ],
  }
}

test("WorkBuddy round-trip: 工具按时间就近归属到对应的 LLM（不全挤到最后一个）", () => {
  const { record } = roundTrip([interleavedTrace()], "sess-seq", { sessionTotals: { used: 240, size: 200000 } })
  assert.ok(record)
  const assistants = record.interactions?.filter((i: any) => i.role === "assistant") ?? []
  assert.equal(assistants.length, 2)
  // ToolA 挂到第一次 LLM，ToolB 挂到第二次 LLM —— 而不是两个都挂在最后一个
  assert.equal(assistants[0].tool_calls?.length, 1)
  assert.equal(assistants[0].tool_calls?.[0]?.function?.name, "ToolA")
  assert.equal(assistants[1].tool_calls?.length, 1)
  assert.equal(assistants[1].tool_calls?.[0]?.function?.name, "ToolB")
  assert.equal(record.tool_call_count, 2)
  // latency 单位为毫秒（与详情页 formatDurationMs / 链路树根节点同源），trace 跨度 10s = 10000ms
  assert.equal(record.latency, 10000)
})

test("WorkBuddy round-trip: 'Agent' 工具（子 Agent 派发）按普通 TOOL 显示，不特殊处理成子 Agent", () => {
  const traceId = "trace-spawn"
  const agentId = `${traceId}-agent`
  const doc = {
    trace: { traceId, name: "Agent workflow", startedAt: "2026-09-06T00:00:00.000Z", endedAt: "2026-09-06T00:00:10.000Z", status: "ok" },
    spans: [
      { traceId, spanId: agentId, parentId: null, name: "cli", type: "agent", startedAt: "2026-09-06T00:00:00.500Z", endedAt: "2026-09-06T00:00:10.000Z", status: "ok", agentName: "cli" },
      {
        traceId, spanId: `${traceId}-gen`, parentId: agentId, name: "generation", type: "generation",
        startedAt: "2026-09-06T00:00:01.000Z", endedAt: "2026-09-06T00:00:01.500Z", status: "ok",
        toolInput: JSON.stringify([{ role: "user", content: [{ type: "text", text: "<user_query>协同分析</user_query>" }] }]),
        toolOutput: JSON.stringify([{ model: "hy4-preview", choices: [{ message: { role: "assistant", content: "派发子 Agent" } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }]),
      },
      {
        traceId, spanId: "span_b891b13aacfd48f3a7b02963", parentId: agentId, name: "Agent", type: "function",
        startedAt: "2026-09-06T00:00:02.000Z", endedAt: "2026-09-06T00:00:08.000Z", status: "ok", toolName: "Agent",
        toolInput: JSON.stringify({ description: "数据代理", prompt: "严格按契约生成数据", subagent_type: "general-purpose" }),
        toolOutput: JSON.stringify({ content: "已生成并通过校验" }),
      },
    ],
  }
  const { record } = roundTrip([doc], "sess-spawn")
  assert.ok(record)
  const assistant = record.interactions?.find((i: any) => i.role === "assistant" && i.tool_calls?.length)
  assert.ok(assistant)
  const call = assistant.tool_calls[0]
  // 子 Agent 调用本质是普通工具调用：保留原始工具名 "Agent"，不转成 task，也不合成子 Agent 节点
  assert.equal(call.function?.name, "Agent")
  assert.equal(call.original_tool_name, "Agent")
  assert.equal(call.tool_type, "function")
  // 参数与报告输出照常保留，可在 TOOL 节点里查看
  assert.equal(call.function?.arguments?.subagent_type, "general-purpose")
  assert.ok(String(call.result).includes("已生成并通过校验"))
  // 不再产生任何 role='subagent' 的交互
  assert.equal(record.interactions?.some((i: any) => i.role === "subagent"), false)
  assert.equal(record.tool_call_count, 1)
})

test("WorkBuddy round-trip: Agent 名称归一化为 WorkBuddy，状态标记为已完成", () => {
  const { record } = roundTrip([interleavedTrace()], "sess-name")
  assert.ok(record)
  // 内部 root agent 名 'cli' → 展示为 WorkBuddy
  assert.equal(record.agentName, "WorkBuddy")
  assert.equal(record.agent, "WorkBuddy")
  // trace_completed_at / trace_status 已设，界面「执行状态」才会显示已完成
  assert.ok(record.trace_completed_at)
  assert.equal(record.trace_status, "success")
})
