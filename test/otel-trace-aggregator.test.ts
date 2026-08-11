import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { getAdapter } from "@/lib/ingest/adapters/registry"
import { appendOtelTraceEvents } from "@/lib/ingest/otel/spool"
import { aggregateOtelTraceEvents, aggregateOtelTraceSession } from "@/lib/ingest/otel/aggregate"
import { getOtelTraceAdapter, listOtelTraceAdapters } from "@/lib/ingest/otel/adapter-registry"
import type { OtelTraceEvent } from "@/lib/ingest/otel/types"
import { buildAgentCallTree } from "@/lib/engine/observability/agent-trace"

function traceEvent(overrides: Partial<OtelTraceEvent>): OtelTraceEvent {
  return {
    receivedAt: "2026-06-09T00:00:00.000Z",
    sessionId: "session-a",
    traceId: "trace-a",
    spanId: "span-a",
    name: "span",
    kind: "llm",
    serviceName: "opencode",
    user: "alice",
    model: "gpt-test",
    usage: {
      input_tokens: 1,
      output_tokens: 2,
      total_tokens: 3,
    },
    latencyMs: 100,
    startTimeMs: 1000,
    attributes: {},
    ...overrides,
  }
}

test("OTel traces: aggregates trace spool events into one execution record", () => {
  const events = [
    traceEvent({
      spanId: "span-tool",
      kind: "tool",
      name: "tool.call",
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 20,
      startTimeMs: 1200,
      attributes: { "tool.name": "Read", "tool.arguments": "{\"file\":\"README.md\"}" },
    }),
    traceEvent({
      spanId: "span-llm",
      name: "chat",
      usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      latencyMs: 1500,
      startTimeMs: 1500,
      attributes: { "gen_ai.prompt": "hello", "gen_ai.completion": "done" },
    }),
    traceEvent({
      spanId: "span-llm",
      name: "chat",
      usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      latencyMs: 1500,
      startTimeMs: 1500,
      attributes: { "gen_ai.prompt": "hello", "gen_ai.completion": "done" },
    }),
  ]

  const record = aggregateOtelTraceEvents("session-a", events)

  assert.ok(record)
  assert.equal(record.task_id, "session-a")
  assert.equal(record.framework, "opencode")
  assert.equal(record.query, "hello")
  assert.equal(record.final_result, "done")
  assert.equal(record.model, "gpt-test")
  assert.equal(record.tokens, 18)
  assert.equal(record.input_tokens, 11)
  assert.equal(record.output_tokens, 7)
  assert.equal(record.latency, 1520)
  assert.equal(record.interactions?.length, 1)
  assert.equal(record.interactions?.[0]?.role, "assistant")
  assert.equal(record.interactions?.[0]?.content, "done")
  assert.equal(record.interactions?.[0]?.usage.total, 18)
  assert.equal(record.interactions?.[0]?.tool_calls?.length, 1)
  assert.equal(record.interactions?.[0]?.tool_calls?.[0]?.function?.name, "Read")
  assert.equal(record.llm_call_count, 1)
  assert.equal(record.tool_call_count, 1)
})

test("OTel traces: aggregates Langfuse LangGraph spans into skill, tool, and subagent interactions", () => {
  const sessionId = "server-troubleshooter-langfuse-capture"
  const events: OtelTraceEvent[] = [
    traceEvent({
      sessionId,
      traceId: "trace-langfuse",
      spanId: "root",
      name: "agent-run",
      kind: "span",
      serviceName: "langfuse-langgraph",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 10000,
      startTimeMs: 1000,
      attributes: {
        "langfuse.internal.is_app_root": true,
        "langfuse.observation.type": "span",
        "langfuse.trace.metadata.skill": "server-troubleshooter",
        "langfuse.observation.input": JSON.stringify({
          input: "diagnose disk",
          model: "GLM-5.2",
          skill: "server-troubleshooter",
        }),
        "langfuse.observation.output": JSON.stringify({ final_output: "disk is ok" }),
      },
    }),
    traceEvent({
      sessionId,
      traceId: "trace-langfuse",
      spanId: "main-llm-1",
      parentSpanId: "main-agent",
      name: "ChatOpenAI",
      kind: "llm",
      serviceName: "langfuse-langgraph",
      model: "GLM-5.2",
      usage: { input_tokens: 10, output_tokens: 3, reasoning_tokens: 1, total_tokens: 14 },
      latencyMs: 1000,
      startTimeMs: 2000,
      attributes: {
        "langfuse.observation.type": "generation",
        "langfuse.observation.output": JSON.stringify({
          role: "assistant",
          content: "I will load the skill.",
          tool_calls: [{ name: "follow_skill", args: { fault_type: "disk" }, id: "call-skill", type: "tool_call" }],
        }),
      },
    }),
    traceEvent({
      sessionId,
      traceId: "trace-langfuse",
      spanId: "main-agent",
      parentSpanId: "root",
      name: "server-troubleshooter",
      kind: "chain",
      serviceName: "langfuse-langgraph",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 9000,
      startTimeMs: 1900,
      attributes: {
        "langfuse.observation.type": "chain",
      },
    }),
    traceEvent({
      sessionId,
      traceId: "trace-langfuse",
      spanId: "tool-skill",
      parentSpanId: "root",
      name: "follow_skill",
      kind: "tool",
      serviceName: "langfuse-langgraph",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 20,
      startTimeMs: 3100,
      attributes: {
        "langfuse.observation.type": "tool",
        "langfuse.observation.input": JSON.stringify({ fault_type: "disk" }),
        "langfuse.observation.output": "server-troubleshooter steps",
      },
    }),
    traceEvent({
      sessionId,
      traceId: "trace-langfuse",
      spanId: "main-llm-2",
      parentSpanId: "root",
      name: "ChatOpenAI",
      kind: "llm",
      serviceName: "langfuse-langgraph",
      model: "GLM-5.2",
      usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
      latencyMs: 1000,
      startTimeMs: 4000,
      attributes: {
        "langfuse.observation.type": "generation",
        "langfuse.observation.output": JSON.stringify({
          role: "assistant",
          content: "I will call the report subagent.",
          tool_calls: [{
            name: "call_report_subagent",
            args: { diagnosis_summary: "disk ok" },
            id: "call-subagent",
            type: "tool_call",
          }],
        }),
      },
    }),
    traceEvent({
      sessionId,
      traceId: "trace-langfuse",
      spanId: "tool-subagent",
      parentSpanId: "root",
      name: "call_report_subagent",
      kind: "tool",
      serviceName: "langfuse-langgraph",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 3000,
      startTimeMs: 5100,
      attributes: {
        "langfuse.observation.type": "tool",
        "langfuse.observation.input": JSON.stringify({ diagnosis_summary: "disk ok" }),
        "langfuse.observation.output": "[subagent] report written",
      },
    }),
    traceEvent({
      sessionId,
      traceId: "trace-langfuse",
      spanId: "sub-llm",
      parentSpanId: "tool-subagent",
      name: "ChatOpenAI",
      kind: "llm",
      serviceName: "langfuse-langgraph",
      model: "GLM-5.2",
      usage: { input_tokens: 5, output_tokens: 6, total_tokens: 11 },
      latencyMs: 1000,
      startTimeMs: 5500,
      attributes: {
        "langfuse.observation.type": "generation",
        "langfuse.observation.output": JSON.stringify({
          role: "assistant",
          content: "Report is ready.",
          tool_calls: [{ name: "write_report", args: { content: "report" }, id: "call-write", type: "tool_call" }],
        }),
      },
    }),
    traceEvent({
      sessionId,
      traceId: "trace-langfuse",
      spanId: "write-report",
      parentSpanId: "tool-subagent",
      name: "write_report",
      kind: "tool",
      serviceName: "langfuse-langgraph",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 100,
      startTimeMs: 6600,
      attributes: {
        "langfuse.observation.type": "tool",
        "langfuse.observation.output": "report path",
      },
    }),
  ]

  const record = aggregateOtelTraceEvents(sessionId, events)

  assert.ok(record)
  assert.equal(record.framework, "langfuse-langgraph")
  assert.equal(record.agentName, "server-troubleshooter")
  assert.equal(record.agent, "server-troubleshooter")
  assert.equal(record.query, "diagnose disk")
  assert.equal(record.final_result, "disk is ok")
  assert.equal(record.skill, "server-troubleshooter")
  assert.deepEqual(record.invokedSkills, [{ name: "server-troubleshooter", version: null }])
  assert.equal(record.force_query_update, true)
  assert.equal(record.session_merge_strategy, "snapshot-replace")
  assert.equal(record.llm_call_count, 3)
  assert.equal(record.tool_call_count, 3)
  assert.equal(record.subagentCount, 1)
  assert.equal(record.interactions?.[0]?.role, "user")
  assert.equal(record.interactions?.[0]?.agent, "server-troubleshooter")
  assert.equal(record.interactions?.some((interaction: any) => interaction.role === "subagent"), true)
  const calls = record.interactions?.flatMap((interaction: any) => interaction.tool_calls || []) || []
  assert.equal(calls[0].function.name, "skill")
  assert.equal(JSON.parse(calls[0].function.arguments).name, "server-troubleshooter")
  assert.equal(calls.some((call: any) => call.function.name === "task"), true)
  assert.equal(calls.some((call: any) => call.function.name === "write_report" && call.output === "report path"), true)
})

test("OTel traces: Langfuse LangGraph extracts generations from non-ChatOpenAI wrappers (ChatDeepSeek)", () => {
  // 回归保护：generation 的识别不能再硬编码 name === "ChatOpenAI"，否则 ChatDeepSeek /
  // ChatTongyi 等 wrapper 的 LLM 调用会被全部漏掉，trace 里只剩一个占位 user、无内容。
  const sessionId = "langfuse-langgraph-chatdeepseek"
  const events: OtelTraceEvent[] = [
    traceEvent({
      sessionId,
      traceId: "trace-deepseek",
      spanId: "root",
      name: "agent-run",
      kind: "span",
      serviceName: "langfuse-langgraph",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 1000,
      startTimeMs: 1000,
      attributes: {
        "langfuse.internal.is_app_root": true,
        "langfuse.observation.type": "span",
        "langfuse.observation.input": JSON.stringify({ input: "深圳有活动吗" }),
      },
    }),
    traceEvent({
      sessionId,
      traceId: "trace-deepseek",
      spanId: "llm-1",
      parentSpanId: "root",
      name: "ChatDeepSeek",
      kind: "llm",
      serviceName: "langfuse-langgraph",
      model: "deepseek-chat",
      usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 },
      latencyMs: 800,
      startTimeMs: 1100,
      attributes: {
        "langfuse.observation.type": "generation",
        "langfuse.observation.output": JSON.stringify({
          role: "assistant",
          content: "路由到 query_agent",
        }),
      },
    }),
  ]

  const record = aggregateOtelTraceEvents(sessionId, events)

  assert.ok(record)
  assert.equal(record.framework, "langfuse-langgraph")
  // 关键：ChatDeepSeek 的 generation 必须被识别（旧代码硬编码 ChatOpenAI 时这里会是 0）
  assert.equal(record.llm_call_count, 1)
  assert.ok((record.tokens ?? 0) > 0)
  assert.equal(record.query, "深圳有活动吗")
  const assistant = record.interactions?.find((interaction: any) => interaction.role === "assistant")
  assert.ok(assistant, "应提取出 assistant 回复")
  assert.equal(assistant.content, "路由到 query_agent")
  assert.equal(record.final_result, "路由到 query_agent")
})

test("OTel traces: Langfuse LangGraph supervisor multi-agent — query from request.history, kind=agent subagents", () => {
  // 按真实业务 trace 建模（supervisor 意图路由 → query_agent / qa_agent 两个具名 kind=agent 子 agent）：
  // 1) 用户问题埋在 root input 的 request.history[].content（业务网关结构），不能退化成兜底串；
  // 2) 子 agent 不再依赖 call_report_subagent 工具名，凡具名 kind=agent span 都构成子 agent 作用域；
  // 3) 最终回复出自 qa_agent（子 agent）内的最后一个 generation。
  const sessionId = "langfuse-supervisor-multiagent"
  const mk = (over: Partial<OtelTraceEvent>) => traceEvent({
    sessionId,
    traceId: "trace-supervisor",
    serviceName: "langfuse-langgraph",
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    ...over,
  })
  const events: OtelTraceEvent[] = [
    mk({
      spanId: "root",
      name: "AssistantService.chat",
      kind: "chain",
      startTimeMs: 1000,
      latencyMs: 20000,
      attributes: {
        "langfuse.observation.type": "chain",
        "langfuse.observation.input": JSON.stringify({
          request: {
            uid: "1032082625425629184",
            session_id: "1295544694416965632",
            selected_entities: [],
            history: [{ role: "user", content: "盖宇行发布了哪些文章？" }],
          },
        }),
      },
    }),
    // supervisor 意图路由（主流程 LLM）
    mk({
      spanId: "sup-llm",
      parentSpanId: "root",
      name: "ChatDeepSeek",
      kind: "llm",
      model: "Qwen3.5-122B-A10B",
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      startTimeMs: 2000,
      latencyMs: 500,
      attributes: {
        "langfuse.observation.type": "generation",
        "langfuse.observation.input": JSON.stringify([
          { role: "system", content: "你是一个智能知识助手的意图识别器。" },
          { role: "user", content: "盖宇行发布了哪些文章？" },
        ]),
        "langfuse.observation.output": JSON.stringify({ role: "assistant", content: "{\"next\": \"query_agent\"}" }),
      },
    }),
    // 子 agent 1：query_agent（具名 kind=agent）
    mk({
      spanId: "agent-query",
      parentSpanId: "root",
      name: "query_agent",
      kind: "agent",
      startTimeMs: 3000,
      latencyMs: 5000,
      attributes: { "langfuse.observation.type": "agent" },
    }),
    mk({
      spanId: "q-llm",
      parentSpanId: "agent-query",
      name: "ChatDeepSeek",
      kind: "llm",
      model: "Qwen3.5-122B-A10B",
      usage: { input_tokens: 20, output_tokens: 6, total_tokens: 26 },
      startTimeMs: 3500,
      latencyMs: 800,
      attributes: {
        "langfuse.observation.type": "generation",
        "langfuse.observation.input": JSON.stringify([
          { role: "system", content: "你是「结构化查询助手」。根据用户中文诉求调度工具。" },
          { role: "user", content: "盖宇行发布了哪些文章？" },
        ]),
        "langfuse.observation.output": JSON.stringify({
          role: "assistant",
          content: "",
          tool_calls: [{ name: "synthesize_sql", args: { question: "盖宇行发布了哪些文章？" }, id: "t1", type: "tool_call" }],
          additional_kwargs: { reasoning_content: "用户询问盖宇行发布的文章，需要调用SQL工具查询。" },
        }),
      },
    }),
    mk({
      spanId: "tool-sql",
      parentSpanId: "agent-query",
      name: "synthesize_sql",
      kind: "tool",
      startTimeMs: 4500,
      latencyMs: 300,
      attributes: {
        "langfuse.observation.type": "tool",
        // 纯文本工具输出，带 Python ensure_ascii 的 \uXXXX 转义（parse 不动 → 走解码兜底）
        "langfuse.observation.output": "\\u5171 0 \\u6761\\uff0c\\u5168\\u90e8\\u5c55\\u793a",
      },
    }),
    // 子 agent 2：qa_agent（具名 kind=agent），产出最终回答
    mk({
      spanId: "agent-qa",
      parentSpanId: "root",
      name: "qa_agent",
      kind: "agent",
      startTimeMs: 9000,
      latencyMs: 6000,
      attributes: { "langfuse.observation.type": "agent" },
    }),
    mk({
      spanId: "qa-llm",
      parentSpanId: "agent-qa",
      name: "ChatDeepSeek",
      kind: "llm",
      model: "Qwen3.5-122B-A10B",
      usage: { input_tokens: 30, output_tokens: 9, total_tokens: 39 },
      startTimeMs: 9500,
      latencyMs: 700,
      attributes: {
        "langfuse.observation.type": "generation",
        // type=human/system 变体（LangChain 序列化消息形态）
        "langfuse.observation.input": JSON.stringify([
          { type: "system", content: "你是一个知识问答助手。根据用户问题检索文档内容并给出准确回答。" },
          { type: "human", content: "盖宇行 发布 文章" },
        ]),
        "langfuse.observation.output": JSON.stringify({ role: "assistant", content: "在知识库和数据库中均未查询到相关文章。" }),
      },
    }),
  ]

  const record = aggregateOtelTraceEvents(sessionId, events)

  assert.ok(record)
  assert.equal(record.framework, "langfuse-langgraph")
  // query 从 request.history 深挖出来，不再是兜底串
  assert.equal(record.query, "盖宇行发布了哪些文章？")
  assert.equal(record.interactions?.[0]?.content, "盖宇行发布了哪些文章？")
  // 最终回复 = 最后一个 generation（在 qa_agent 子 agent 内）
  assert.equal(record.final_result, "在知识库和数据库中均未查询到相关文章。")
  // 两个具名 kind=agent 子 agent 都识别出来
  assert.equal(record.subagentCount, 2)
  const subs = record.interactions?.filter((interaction: any) => interaction.role === "subagent") || []
  assert.deepEqual([...new Set(subs.map((i: any) => i.subagent_name))].sort(), ["qa_agent", "query_agent"])
  assert.ok(subs.every((i: any) => i.subagent_session_id), "子 agent 交互都应带 subagent_session_id")
  const subSessions = new Set(subs.map((i: any) => i.subagent_session_id))
  assert.equal(subSessions.size, 2, "两个子 agent 应各有独立的 subagent_session_id")
  // supervisor 的路由 LLM 属于主流程 assistant
  const supervisor = record.interactions?.find((i: any) => i.role === "assistant")
  assert.ok(supervisor)
  assert.equal(supervisor.spanId, "sup-llm")
  // 子 agent 内的 tool_call 正常挂上输出
  const calls = subs.flatMap((i: any) => i.tool_calls || [])
  assert.equal(calls.some((c: any) => c.function.name === "synthesize_sql" && c.state === "success"), true)
  // 系统提示词进对话流：主流程 + 两个子 agent 各一条 role=system
  const systems = record.interactions?.filter((i: any) => i.role === "system") || []
  assert.equal(systems.length, 3)
  assert.ok(systems.some((i: any) => i.content.includes("意图识别器") && !i.subagent_session_id), "主流程系统提示词")
  assert.ok(systems.some((i: any) => i.subagent_name === "query_agent" && i.content.includes("结构化查询助手")), "query_agent 系统提示词")
  assert.ok(systems.some((i: any) => i.subagent_name === "qa_agent" && i.content.includes("知识问答助手")), "qa_agent 系统提示词（type=system 变体）")
  // 每条 generation interaction 挂完整入参消息（含 system + 上下文）
  assert.equal(supervisor.requestMessages?.[0]?.role, "system")
  assert.equal(supervisor.requestMessages?.[1]?.role, "user")
  const qaInteraction = subs.find((i: any) => i.subagent_name === "qa_agent")
  assert.equal(qaInteraction?.requestMessages?.[1]?.role, "user", "type=human 应归一成 user")
  // 纯工具调用的 assistant：content 留空，不再把原始 output JSON（\uXXXX 乱码来源）塞进去
  const qLlm = subs.find((i: any) => i.spanId === "q-llm")
  assert.equal(qLlm?.content, "")
  // DeepSeek 思考过程提取到 parts[type=reasoning]（trace UI 思考块约定）
  assert.equal(qLlm?.parts?.[0]?.type, "reasoning")
  assert.ok(qLlm?.parts?.[0]?.text.includes("盖宇行"))
  // 纯文本工具输出里的 \uXXXX 转义被解码还原成中文
  const sqlCall = calls.find((c: any) => c.function.name === "synthesize_sql")
  assert.equal(sqlCall?.output, "共 0 条，全部展示")
  // 路由型子 agent 合成 task 锚点：主流程 assistant 上应有两个 task 调用
  const taskCalls = (record.interactions || [])
    .flatMap((i: any) => (i.tool_calls || []).filter((c: any) => c.function?.name === "task"))
  assert.equal(taskCalls.length, 2)
  const taskArgs = taskCalls.map((c: any) => JSON.parse(c.function.arguments))
  assert.deepEqual(taskArgs.map((a: any) => a.subagent_type).sort(), ["qa_agent", "query_agent"])
  assert.ok(taskArgs.every((a: any) => a.subagent_session_id), "task 锚点应带 subagent_session_id")
  // 终极验证：详情页的 agent 树真能开出两个子节点（此前只有 multi-agent 标签、树上无子节点）
  const tree = buildAgentCallTree(record.interactions as any[])
  assert.ok(tree)
  assert.equal(tree.children.length, 2)
  assert.deepEqual(tree.children.map((c: any) => c.subagentType).sort(), ["qa_agent", "query_agent"])
  assert.deepEqual(tree.children.map((c: any) => c.agentName).sort(), ["qa_agent", "query_agent"])
})

test("Agent tree: tool-only LLM turns without reasoning fall back to tool-name summary", () => {
  // 纯工具调用轮次：content 为空（adapter 防乱码故意留空）且无 reasoning——
  // 时间线上的 LLM 行摘要不能空白，应兜底显示工具名。
  const tree = buildAgentCallTree([
    { role: "user", content: "查一下", agent: "a", timestamp: "2026-07-14T00:00:00.000Z" },
    {
      role: "assistant", content: "", agent: "a", timestamp: "2026-07-14T00:00:01.000Z",
      tool_calls: [{ id: "t1", type: "function", state: "success", function: { name: "synthesize_sql", arguments: "{}" } }],
    },
  ] as any[])
  assert.ok(tree)
  const llmEvents = (tree.events || []).filter((e: any) => e.kind === "llm")
  assert.equal(llmEvents.length, 1)
  assert.ok(llmEvents[0]?.summary?.includes("synthesize_sql"), "空 content 无 reasoning 时摘要应含工具名")
})

test("OTel traces: pure Langfuse SDK traces (non-LangGraph) take the langfuse adapter and get a completion time", () => {
  // 按真实"一直执行中"trace 建模：非 LangGraph 的纯 Langfuse SDK 埋点服务调用
  // （serviceName='langfuse'，chain root + 1 个 generation）。此前落 generic 兜底：
  // 不产 trace_completed_at（Session.endTime 恒空 → 界面永远"执行中"）、query 兜底
  // 'OTel Session'、chain 被当 tool。
  const sessionId = "pure-langfuse-observe"
  const events: OtelTraceEvent[] = [
    traceEvent({
      sessionId,
      traceId: "trace-pure-lf",
      spanId: "svc-root",
      name: "AssistantService.trending",
      kind: "chain",
      serviceName: "langfuse",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      startTimeMs: 1000,
      latencyMs: 8000,
      attributes: {
        "langfuse.observation.type": "chain",
        "langfuse.observation.input": JSON.stringify({ request: { uid: "1011", limit: 10 } }),
      },
    }),
    traceEvent({
      sessionId,
      traceId: "trace-pure-lf",
      spanId: "svc-llm",
      parentSpanId: "svc-root",
      name: "ChatDeepSeek",
      kind: "llm",
      serviceName: "langfuse",
      model: "Qwen3.5-122B-A10B",
      usage: { input_tokens: 3159, output_tokens: 194, total_tokens: 3353 },
      startTimeMs: 2000,
      latencyMs: 4000,
      attributes: {
        "langfuse.observation.type": "generation",
        "langfuse.observation.input": JSON.stringify([
          { role: "system", content: "你是推荐问题生成器。" },
          { role: "user", content: "生成10个热门问题" },
        ]),
        "langfuse.observation.output": JSON.stringify({ role: "assistant", content: "1. 什么是KV缓存…" }),
      },
    }),
  ]

  const record = aggregateOtelTraceEvents(sessionId, events)

  assert.ok(record)
  // 走 langfuse 专用 adapter，但 framework 保留真实来源（不冒充 langfuse-langgraph）
  assert.equal(record.framework, "langfuse")
  // 关键：有完成时间 → Session.endTime 能写上 → 不再永远"执行中"
  assert.ok(record.trace_completed_at)
  // query 从 LLM 入参深挖，不再是 generic 的 'OTel Session'
  assert.equal(record.query, "生成10个热门问题")
  assert.equal(record.final_result, "1. 什么是KV缓存…")
  // chain 结构 span 不再被当成 tool
  assert.equal(record.tool_call_count, 0)
  assert.equal(record.llm_call_count, 1)
})

test("OTel traces: Langfuse LangGraph falls back to AI message names for unnamed internal agent spans", () => {
  const sessionId = "legacy-langgraph-agent-name"
  const events: OtelTraceEvent[] = [
    traceEvent({
      sessionId,
      traceId: "trace-legacy-langgraph",
      spanId: "root",
      name: "agent-run-20260701T074612Z",
      kind: "span",
      serviceName: "langfuse-langgraph",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 1000,
      startTimeMs: 1000,
      attributes: {
        "langfuse.internal.is_app_root": true,
        "langfuse.observation.type": "span",
        "langfuse.trace.metadata.skill": "server-troubleshooter",
        "langfuse.observation.input": JSON.stringify({ input: "diagnose disk", skill: "server-troubleshooter" }),
        "langfuse.observation.output": JSON.stringify({ final_output: "disk is ok" }),
      },
    }),
    traceEvent({
      sessionId,
      traceId: "trace-legacy-langgraph",
      spanId: "internal-agent",
      parentSpanId: "root",
      name: "agent",
      kind: "agent",
      serviceName: "langfuse-langgraph",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 900,
      startTimeMs: 1100,
      attributes: {
        "langfuse.observation.type": "agent",
        "langfuse.observation.metadata.langgraph_node": "agent",
        "langfuse.observation.output": JSON.stringify({
          messages: [{
            type: "ai",
            name: "server-troubleshooter",
            content: "I will diagnose disk.",
          }],
        }),
      },
    }),
    traceEvent({
      sessionId,
      traceId: "trace-legacy-langgraph",
      spanId: "llm",
      parentSpanId: "internal-agent",
      name: "ChatOpenAI",
      kind: "llm",
      serviceName: "langfuse-langgraph",
      model: "GLM-5.2",
      usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
      latencyMs: 400,
      startTimeMs: 1200,
      attributes: {
        "langfuse.observation.type": "generation",
        "langfuse.observation.output": JSON.stringify({
          content: "disk is ok",
          name: "server-troubleshooter",
        }),
      },
    }),
  ]

  const record = aggregateOtelTraceEvents(sessionId, events)

  assert.ok(record)
  assert.equal(record.agentName, "server-troubleshooter")
  assert.equal(record.agent, "server-troubleshooter")
  assert.equal(record.interactions?.[0]?.agent, "server-troubleshooter")
})

test("OTel traces: Langfuse LangGraph snapshots latest root trace for reused session ids", () => {
  const sessionId = "reused-langfuse-session"
  const events: OtelTraceEvent[] = [
    traceEvent({
      sessionId,
      traceId: "trace-old",
      spanId: "old-root",
      name: "old-run",
      kind: "span",
      serviceName: "langfuse-langgraph",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 100,
      startTimeMs: 1000,
      attributes: {
        "langfuse.internal.is_app_root": true,
        "langfuse.observation.type": "span",
        "langfuse.observation.input": JSON.stringify({ input: "old query" }),
        "langfuse.observation.output": JSON.stringify({ final_output: "" }),
      },
    }),
    traceEvent({
      sessionId,
      traceId: "trace-old",
      spanId: "old-tool",
      parentSpanId: "old-root",
      name: "old_tool",
      kind: "tool",
      serviceName: "langfuse-langgraph",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      startTimeMs: 1050,
      attributes: { "langfuse.observation.type": "tool" },
    }),
    traceEvent({
      sessionId,
      traceId: "trace-new",
      spanId: "new-root",
      name: "new-run",
      kind: "span",
      serviceName: "langfuse-langgraph",
      user: "dev-user",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 1000,
      startTimeMs: 3000,
      attributes: {
        "langfuse.internal.is_app_root": true,
        "langfuse.observation.type": "span",
        "langfuse.trace.metadata.skill": "server-troubleshooter",
        "langfuse.observation.input": JSON.stringify({ input: "new query", skill: "server-troubleshooter" }),
        "langfuse.observation.output": JSON.stringify({ final_output: "new final" }),
      },
    }),
    traceEvent({
      sessionId,
      traceId: "trace-new",
      spanId: "new-llm",
      parentSpanId: "new-root",
      name: "ChatOpenAI",
      kind: "llm",
      serviceName: "langfuse-langgraph",
      model: "GLM-5.2",
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      startTimeMs: 3100,
      attributes: {
        "langfuse.observation.type": "generation",
        "langfuse.observation.output": JSON.stringify({
          content: "new assistant",
          tool_calls: [{ name: "check_disk", args: {}, id: "call-disk", type: "tool_call" }],
        }),
      },
    }),
    traceEvent({
      sessionId,
      traceId: "trace-new",
      spanId: "new-tool",
      parentSpanId: "new-root",
      name: "check_disk",
      kind: "tool",
      serviceName: "langfuse-langgraph",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      startTimeMs: 3200,
      attributes: {
        "langfuse.observation.type": "tool",
        "langfuse.observation.output": "disk ok",
      },
    }),
  ]

  const record = aggregateOtelTraceEvents(sessionId, events)

  assert.ok(record)
  assert.equal(record.query, "new query")
  assert.equal(record.final_result, "new final")
  assert.equal(record.skill, "server-troubleshooter")
  assert.equal(record.tool_call_count, 1)
  assert.equal(record.llm_call_count, 1)
  assert.equal(record.user, "dev-user")
  assert.equal(record.agentName, "new-run")
  assert.equal(record.interactions?.some((interaction: any) => String(interaction.content || "").includes("old query")), false)
})

test("OTel traces: aggregates Hermes agent spans without double-counting usage", () => {
  const events = [
    traceEvent({
      sessionId: "20260611_103002_288942",
      traceId: "trace-hermes",
      spanId: "span-agent",
      name: "agent",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 15694, output_tokens: 421, total_tokens: 16115 },
      latencyMs: 11697,
      startTimeMs: 1000,
      attributes: {
        "openinference.span.kind": "AGENT",
        "hermes.session.kind": "session",
        "hermes.agent.role": "root",
        "hermes.agent.name": "default",
        "hermes.profile.name": "default",
        "input.value": "Which subagents are available?",
        "output.value": "Here are the available subagents.",
      },
    }),
    traceEvent({
      sessionId: "20260611_103002_288942",
      traceId: "trace-hermes",
      spanId: "span-api",
      parentSpanId: "span-llm",
      name: "api.GLM-5.1",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 15694, output_tokens: 421, total_tokens: 16115 },
      latencyMs: 11682,
      startTimeMs: 1006,
      attributes: {
        "openinference.span.kind": "LLM",
        "llm.model_name": "GLM-5.1",
        "llm.token_count.prompt": 15694,
        "llm.token_count.completion": 421,
        "llm.token_count.total": 16115,
      },
    }),
    traceEvent({
      sessionId: "20260611_103002_288942",
      traceId: "trace-hermes",
      spanId: "span-llm",
      parentSpanId: "span-agent",
      name: "llm.GLM-5.1",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 11680,
      startTimeMs: 1005,
      attributes: {
        "openinference.span.kind": "LLM",
        "input.value": "Which subagents are available?",
        "output.value": "Here are the available subagents.",
      },
    }),
  ]

  const record = aggregateOtelTraceEvents("20260611_103002_288942", events)

  assert.ok(record)
  assert.equal(record.framework, "hermes")
  assert.equal(record.agentName, "hermes")
  assert.equal(record.agent, "hermes")
  assert.equal(record.model, "GLM-5.1")
  assert.equal(record.query, "Which subagents are available?")
  assert.equal(record.final_result, "Here are the available subagents.")
  assert.equal(record.trace_completed_at, "1970-01-01T00:00:12.697Z")
  assert.equal(record.tokens, 16115)
  assert.equal(record.input_tokens, 15694)
  assert.equal(record.output_tokens, 421)
  assert.equal(record.latency, 11697)
  assert.equal(record.llm_call_count, 1)
  assert.equal(record.interactions?.length, 2)
  assert.equal(record.interactions?.[0]?.role, "user")
  assert.equal(record.interactions?.[0]?.content, "Which subagents are available?")
  assert.equal(record.interactions?.[1]?.role, "assistant")
  assert.equal(record.interactions?.[1]?.content, "Here are the available subagents.")
  assert.equal(record.interactions?.[1]?.usage.total, 16115)
})

test("OTel traces: Hermes completion uses the latest root turn without hermes.session.kind", () => {
  const sessionId = "20260616_195101_0590e0";
  const rootAttrs = {
    "hermes.session_id": sessionId,
    "hermes.root_session_id": sessionId,
    "hermes.agent.role": "root",
    "hermes.agent.name": "root",
  };
  const events = [
    traceEvent({
      sessionId,
      traceId: "trace-hermes-real-shape",
      spanId: "agent-1",
      name: "agent",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 2223,
      startTimeMs: 1000,
      attributes: {
        ...rootAttrs,
        "openinference.span.kind": "AGENT",
        "input.value": "hello didi",
        "output.value": "Hi.",
      },
    }),
    traceEvent({
      sessionId,
      traceId: "trace-hermes-real-shape",
      spanId: "llm-1",
      parentSpanId: "agent-1",
      name: "llm.deepseek-v4-flash",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 2222,
      startTimeMs: 1000,
      attributes: {
        ...rootAttrs,
        "openinference.span.kind": "LLM",
        "input.value": "hello didi",
        "output.value": "Hi.",
      },
    }),
    traceEvent({
      sessionId,
      traceId: "trace-hermes-real-shape",
      spanId: "api-1",
      parentSpanId: "llm-1",
      name: "api.deepseek-v4-flash",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      latencyMs: 2210,
      startTimeMs: 1009,
      attributes: {
        ...rootAttrs,
        "openinference.span.kind": "LLM",
        "llm.response.finish_reason": "stop",
        "output.value": "Hi.",
      },
    }),
    traceEvent({
      sessionId,
      traceId: "trace-hermes-real-shape",
      spanId: "agent-2",
      name: "agent",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 15515,
      startTimeMs: 15000,
      attributes: {
        ...rootAttrs,
        "openinference.span.kind": "AGENT",
        "input.value": "帮我看看啊内存",
        "output.value": "Memory summary.",
      },
    }),
    traceEvent({
      sessionId,
      traceId: "trace-hermes-real-shape",
      spanId: "llm-2",
      parentSpanId: "agent-2",
      name: "llm.deepseek-v4-flash",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 15512,
      startTimeMs: 15000,
      attributes: {
        ...rootAttrs,
        "openinference.span.kind": "LLM",
        "input.value": "帮我看看啊内存",
        "output.value": "Memory summary.",
      },
    }),
    traceEvent({
      sessionId,
      traceId: "trace-hermes-real-shape",
      spanId: "api-2",
      parentSpanId: "llm-2",
      name: "api.deepseek-v4-flash",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
      latencyMs: 2380,
      startTimeMs: 28120,
      attributes: {
        ...rootAttrs,
        "openinference.span.kind": "LLM",
        "llm.response.finish_reason": "stop",
        "output.value": "Memory summary.",
      },
    }),
  ];

  const record = aggregateOtelTraceEvents(sessionId, events);

  assert.ok(record);
  assert.equal(record.query, "hello didi");
  assert.equal(record.final_result, "Memory summary.");
  assert.equal(record.trace_completed_at, "1970-01-01T00:00:30.515Z");
})

test("OTel traces: Hermes adapter builds user, tool, and final output from span tree", () => {
  const events = [
    traceEvent({
      sessionId: "20260611_141826_808e5a",
      traceId: "trace-hermes-tree",
      spanId: "span-agent",
      name: "agent",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 44033, output_tokens: 323, total_tokens: 44356 },
      latencyMs: 12731,
      startTimeMs: 1000,
      attributes: {
        "openinference.span.kind": "AGENT",
        "hermes.session.kind": "session",
        "input.value": "Show me the skill.",
        "output.value": "Final answer.",
      },
    }),
    traceEvent({
      sessionId: "20260611_141826_808e5a",
      traceId: "trace-hermes-tree",
      spanId: "span-llm",
      parentSpanId: "span-agent",
      name: "llm.GLM-5.1",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 12727,
      startTimeMs: 1004,
      attributes: {
        "openinference.span.kind": "LLM",
        "input.value": "Show me the skill.",
        "output.value": "Final answer.",
        "llm.model_name": "GLM-5.1",
      },
    }),
    traceEvent({
      sessionId: "20260611_141826_808e5a",
      traceId: "trace-hermes-tree",
      spanId: "span-api-1",
      parentSpanId: "span-llm",
      name: "api.GLM-5.1",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 15699, output_tokens: 44, total_tokens: 15743 },
      latencyMs: 3941,
      startTimeMs: 1008,
      attributes: {
        "openinference.span.kind": "LLM",
        "llm.model_name": "GLM-5.1",
      },
    }),
    traceEvent({
      sessionId: "20260611_141826_808e5a",
      traceId: "trace-hermes-tree",
      spanId: "span-tool",
      parentSpanId: "span-llm",
      kind: "tool",
      name: "tool.skill_view",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 23,
      startTimeMs: 4950,
      attributes: {
        "openinference.span.kind": "TOOL",
        "tool.name": "skill_view",
        "input.value": "{\"skill\":\"demo\"}",
        "output.value": "Tool output.",
        "hermes.tool.outcome": "completed",
      },
    }),
    traceEvent({
      sessionId: "20260611_141826_808e5a",
      traceId: "trace-hermes-tree",
      spanId: "span-api-2",
      parentSpanId: "span-llm",
      name: "api.GLM-5.1",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 28334, output_tokens: 279, total_tokens: 28613 },
      latencyMs: 8735,
      startTimeMs: 5000,
      attributes: {
        "openinference.span.kind": "LLM",
        "llm.model_name": "GLM-5.1",
      },
    }),
  ]

  const record = aggregateOtelTraceEvents("20260611_141826_808e5a", events)

  assert.ok(record)
  assert.equal(record.framework, "hermes")
  assert.equal(record.model, "GLM-5.1")
  assert.equal(record.query, "Show me the skill.")
  assert.equal(record.final_result, "Final answer.")
  assert.equal(record.trace_completed_at, "1970-01-01T00:00:13.731Z")
  assert.equal(record.tokens, 44356)
  assert.equal(record.input_tokens, 44033)
  assert.equal(record.output_tokens, 323)
  assert.equal(record.latency, 12731)
  assert.equal(record.llm_call_count, 2)
  assert.equal(record.tool_call_count, 1)
  assert.equal(record.interactions?.length, 3)
  assert.equal(record.interactions?.[0]?.role, "user")
  assert.equal(record.interactions?.[0]?.content, "Show me the skill.")
  assert.equal(record.interactions?.[1]?.role, "assistant")
  assert.equal(record.interactions?.[1]?.name, "tool.skill_view")
  assert.equal(record.interactions?.[1]?.tool_calls?.[0]?.function?.name, "skill_view")
  assert.equal(record.interactions?.[1]?.tool_calls?.[0]?.result, "Tool output.")
  assert.equal(record.interactions?.[2]?.role, "assistant")
  assert.equal(record.interactions?.[2]?.content, "Final answer.")
  assert.equal(record.interactions?.[2]?.usage.total, 44356)
})

test("OTel traces: Hermes adapter emits intermediate LLM messages from api spans", () => {
  const events = [
    traceEvent({
      sessionId: "20260611_172750_1af360",
      traceId: "trace-hermes-steps",
      spanId: "span-agent",
      name: "agent",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 300, output_tokens: 80, total_tokens: 380 },
      latencyMs: 7000,
      startTimeMs: 1000,
      attributes: {
        "openinference.span.kind": "AGENT",
        "hermes.session.kind": "session",
      },
    }),
    traceEvent({
      sessionId: "20260611_172750_1af360",
      traceId: "trace-hermes-steps",
      spanId: "span-llm",
      parentSpanId: "span-agent",
      name: "llm.GLM-5.1",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 6990,
      startTimeMs: 1001,
      attributes: {
        "openinference.span.kind": "LLM",
        "input.value": "我的电脑很卡，检查 3000 端口服务。",
        "llm.model_name": "GLM-5.1",
      },
    }),
    traceEvent({
      sessionId: "20260611_172750_1af360",
      traceId: "trace-hermes-steps",
      spanId: "span-api-1",
      parentSpanId: "span-llm",
      name: "api.GLM-5.1",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      latencyMs: 900,
      startTimeMs: 1010,
      attributes: {
        "openinference.span.kind": "LLM",
        "llm.model_name": "GLM-5.1",
        "llm.response.finish_reason": "tool_calls",
        "output.value": JSON.stringify({
          choices: [{ message: { content: "好的，让我先加载 server-troubleshooter 技能。" } }],
        }),
      },
    }),
    traceEvent({
      sessionId: "20260611_172750_1af360",
      traceId: "trace-hermes-steps",
      spanId: "span-tool-1",
      parentSpanId: "span-llm",
      kind: "tool",
      name: "tool.skill_view",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 40,
      startTimeMs: 1915,
      attributes: {
        "openinference.span.kind": "TOOL",
        "tool.name": "skill_view",
        "input.value": "{\"skill\":\"server-troubleshooter\"}",
        "output.value": "技能已加载。",
      },
    }),
    traceEvent({
      sessionId: "20260611_172750_1af360",
      traceId: "trace-hermes-steps",
      spanId: "span-api-2",
      parentSpanId: "span-llm",
      name: "api.GLM-5.1",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      latencyMs: 800,
      startTimeMs: 2000,
      attributes: {
        "openinference.span.kind": "LLM",
        "llm.model_name": "GLM-5.1",
        "llm.response.finish_reason": "tool_calls",
        "output.value": JSON.stringify({
          choices: [{ message: { content: "技能已加载。按照步骤执行诊断流程。" } }],
        }),
      },
    }),
    traceEvent({
      sessionId: "20260611_172750_1af360",
      traceId: "trace-hermes-steps",
      spanId: "span-tool-2",
      parentSpanId: "span-llm",
      kind: "tool",
      name: "tool.terminal",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 60,
      startTimeMs: 2810,
      attributes: {
        "openinference.span.kind": "TOOL",
        "tool.name": "terminal",
        "input.value": "ps aux",
        "output.value": "next-server rss 2.38GB",
      },
    }),
    traceEvent({
      sessionId: "20260611_172750_1af360",
      traceId: "trace-hermes-steps",
      spanId: "span-api-3",
      parentSpanId: "span-llm",
      name: "api.GLM-5.1",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      latencyMs: 1200,
      startTimeMs: 2900,
      attributes: {
        "openinference.span.kind": "LLM",
        "llm.model_name": "GLM-5.1",
        "llm.response.finish_reason": "stop",
        "output.value": JSON.stringify({
          choices: [{ message: { content: "诊断完成：3000 端口服务存在内存增长风险。" } }],
        }),
      },
    }),
  ];

  const record = aggregateOtelTraceEvents("20260611_172750_1af360", events);

  assert.ok(record);
  assert.equal(record.framework, "hermes");
  assert.equal(record.final_result, "诊断完成：3000 端口服务存在内存增长风险。");
  assert.equal(record.llm_call_count, 3);
  assert.equal(record.tool_call_count, 2);
  assert.deepEqual(record.interactions?.map((interaction: any) => interaction.role), [
    "user",
    "assistant",
    "assistant",
    "assistant",
    "assistant",
    "assistant",
  ]);
  assert.equal(record.interactions?.[1]?.content, "好的，让我先加载 server-troubleshooter 技能。");
  assert.equal(record.interactions?.[2]?.tool_calls?.[0]?.function?.name, "skill_view");
  assert.equal(record.interactions?.[3]?.content, "技能已加载。按照步骤执行诊断流程。");
  assert.equal(record.interactions?.[4]?.tool_calls?.[0]?.function?.name, "terminal");
  assert.equal(record.interactions?.[5]?.content, "诊断完成：3000 端口服务存在内存增长风险。");
  assert.equal(record.interactions?.[5]?.usage.total, 150);
});

test("Framework adapter registry marks Hermes as plugin onboarding with snapshot replacement", () => {
  const adapter = getAdapter("hermes");

  assert.equal(adapter.descriptor.onboard, "plugin");
  assert.equal(adapter.sessionMergeStrategy, "snapshot-replace");
  assert.equal(adapter.capabilities?.skills, true);
  assert.equal(adapter.capabilities?.subagentTree, true);
});

test("OTel trace adapter registry selects Hermes before the generic fallback", () => {
  const hermesEvent = traceEvent({ serviceName: "hermes" });
  const genericEvent = traceEvent({ serviceName: "another-agent" });

  // 顺序即优先级：专用适配器都排在 generic 兜底之前。新增适配器要显式登记在这里。
  assert.deepEqual(listOtelTraceAdapters().map(adapter => adapter.id), ["langfuse-langgraph", "hermes", "qwencode", "openclaw", "qoder", "generic"]);
  assert.equal(getOtelTraceAdapter([hermesEvent]).id, "hermes");
  assert.equal(getOtelTraceAdapter([genericEvent]).id, "generic");
});

test("OTel traces: Hermes adapter preserves subagent ownership and builds a child tree", () => {
  const rootSessionId = "hermes-root";
  const childSessionId = "hermes-child";
  const rootAttrs = {
    "hermes.session_id": rootSessionId,
    "hermes.root_session_id": rootSessionId,
    "hermes.agent.role": "root",
    "hermes.agent.name": "planner",
    "hermes.profile.name": "planner",
  };
  const childAttrs = {
    "hermes.session_id": childSessionId,
    "hermes.root_session_id": rootSessionId,
    "hermes.parent_session_id": rootSessionId,
    "hermes.agent.role": "researcher",
    "hermes.agent.name": "researcher",
  };
  const events = [
    traceEvent({
      sessionId: rootSessionId,
      traceId: "trace-hermes-subagent",
      spanId: "root-agent",
      name: "agent",
      serviceName: "hermes",
      startTimeMs: 1000,
      latencyMs: 5000,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      attributes: { ...rootAttrs, "openinference.span.kind": "AGENT", "input.value": "Delegate this task." },
    }),
    traceEvent({
      sessionId: rootSessionId,
      traceId: "trace-hermes-subagent",
      spanId: "root-llm",
      parentSpanId: "root-agent",
      name: "llm.GLM-5.1",
      serviceName: "hermes",
      startTimeMs: 1001,
      latencyMs: 4990,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      attributes: { ...rootAttrs, "openinference.span.kind": "LLM", "input.value": "Delegate this task.", "output.value": "Root final." },
    }),
    traceEvent({
      sessionId: rootSessionId,
      traceId: "trace-hermes-subagent",
      spanId: "task-span",
      parentSpanId: "root-llm",
      kind: "tool",
      name: "tool.task",
      serviceName: "hermes",
      startTimeMs: 1100,
      latencyMs: 3000,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      attributes: {
        ...rootAttrs,
        "openinference.span.kind": "TOOL",
        "tool.name": "task",
        "input.value": JSON.stringify({ subagent_type: "researcher", description: "Inspect logs", session_id: childSessionId }),
        "output.value": JSON.stringify({ session_id: childSessionId, result: "Child final." }),
      },
    }),
    traceEvent({
      sessionId: rootSessionId,
      traceId: "trace-hermes-subagent",
      spanId: "child-agent",
      parentSpanId: "task-span",
      name: "agent.subagent.researcher",
      serviceName: "hermes",
      startTimeMs: 1200,
      latencyMs: 2500,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      attributes: { ...childAttrs, "openinference.span.kind": "AGENT", "input.value": "Inspect logs", "output.value": "Child final." },
    }),
    traceEvent({
      sessionId: rootSessionId,
      traceId: "trace-hermes-subagent",
      spanId: "child-llm",
      parentSpanId: "child-agent",
      name: "llm.GLM-5.1",
      serviceName: "hermes",
      startTimeMs: 1201,
      latencyMs: 2400,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      attributes: { ...childAttrs, "openinference.span.kind": "LLM", "input.value": "Inspect logs", "output.value": "Child final." },
    }),
    traceEvent({
      sessionId: rootSessionId,
      traceId: "trace-hermes-subagent",
      spanId: "child-api",
      parentSpanId: "child-llm",
      name: "api.GLM-5.1",
      serviceName: "hermes",
      startTimeMs: 1300,
      latencyMs: 2000,
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
      attributes: { ...childAttrs, "openinference.span.kind": "LLM", "llm.response.finish_reason": "stop", "output.value": "Child final." },
    }),
  ];

  const record = aggregateOtelTraceEvents(rootSessionId, events);
  assert.ok(record);
  assert.equal(record.agentName, "planner");
  assert.equal(record.agent, "planner");
  assert.equal(record.interactions?.find((interaction: any) => interaction.role === "user")?.agent, "planner");
  assert.equal(record.interactions?.filter((interaction: any) => interaction.role === "subagent").length, 2);
  assert.equal(record.interactions?.find((interaction: any) => interaction.role === "subagent")?.subagent_session_id, childSessionId);

  const tree = buildAgentCallTree(record.interactions as any[]);
  assert.ok(tree);
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0]?.sessionId, childSessionId);
  assert.equal(tree.children[0]?.subagentType, "researcher");
  assert.equal(tree.children[0]?.agentName, "researcher");
});

test("OTel traces: aggregateOtelTraceSession reads traces spool files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-trace-agg-"))
  try {
    appendOtelTraceEvents([
      traceEvent({
        spanId: "span-llm",
        attributes: { "gen_ai.prompt": "hello", "gen_ai.completion": "done" },
      }),
    ], dir)

    const result = aggregateOtelTraceSession("session-a", dir)
    assert.equal(result.eventCount, 1)
    assert.equal(result.record?.framework, "opencode")
    assert.equal(result.record?.task_id, "session-a")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("OTel traces: Hermes parses provider candidate content and preserves API errors", () => {
  const events = [
    traceEvent({
      sessionId: "hermes-provider-shapes",
      traceId: "trace-provider-shapes",
      spanId: "llm",
      name: "llm.GLM-5.1",
      serviceName: "hermes",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      attributes: {
        "openinference.span.kind": "LLM",
        "input.value": "hello",
      },
    }),
    traceEvent({
      sessionId: "hermes-provider-shapes",
      traceId: "trace-provider-shapes",
      spanId: "api-error",
      parentSpanId: "llm",
      name: "api.GLM-5.1",
      serviceName: "hermes",
      startTimeMs: 1100,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      attributes: {
        "openinference.span.kind": "LLM",
        "llm.response.finish_reason": "error",
        "error.message": "provider temporarily unavailable",
      },
    }),
    traceEvent({
      sessionId: "hermes-provider-shapes",
      traceId: "trace-provider-shapes",
      spanId: "api-success",
      parentSpanId: "llm",
      name: "api.GLM-5.1",
      serviceName: "hermes",
      startTimeMs: 1200,
      usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
      attributes: {
        "openinference.span.kind": "LLM",
        "llm.response.finish_reason": "stop",
        "output.value": JSON.stringify({ candidates: [{ content: { parts: [{ text: "candidate answer" }] } }] }),
      },
    }),
  ];

  const record = aggregateOtelTraceEvents("hermes-provider-shapes", events);
  assert.ok(record);
  assert.equal(record.llm_call_count, 2);
  assert.equal(record.final_result, "candidate answer");
  const errorInteraction = record.interactions?.find((interaction: any) => interaction.status === "error");
  assert.equal(errorInteraction?.content, "API request failed: provider temporarily unavailable");
  assert.equal(errorInteraction?.error?.message, "provider temporarily unavailable");
});

test("OTel traces: Hermes adapter surfaces the system prompt from request messages", () => {
  const requestMessages = JSON.stringify([
    { role: "system", content: "You are a Hermes agent. Be concise." },
    { role: "user", content: "hi" },
  ]);
  const events = [
    traceEvent({
      sessionId: "sess-sys",
      traceId: "trace-sys",
      spanId: "span-agent",
      name: "agent",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      startTimeMs: 1000,
      attributes: {
        "openinference.span.kind": "AGENT",
        "hermes.session.kind": "session",
        "hermes.agent.role": "root",
        "hermes.agent.name": "default",
        "hermes.profile.name": "default",
        "input.value": "hi",
        "output.value": "hello",
      },
    }),
    traceEvent({
      sessionId: "sess-sys",
      traceId: "trace-sys",
      spanId: "span-llm",
      parentSpanId: "span-agent",
      name: "llm.GLM",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      startTimeMs: 1005,
      attributes: {
        "openinference.span.kind": "LLM",
        "input.value": "hi",
        "output.value": "hello",
      },
    }),
    traceEvent({
      sessionId: "sess-sys",
      traceId: "trace-sys",
      spanId: "span-api",
      parentSpanId: "span-llm",
      name: "api.GLM",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      startTimeMs: 1006,
      attributes: {
        "openinference.span.kind": "LLM",
        "llm.model_name": "GLM",
        "input.value": requestMessages,
        "llm.input_messages": requestMessages,
        "output.value": "hello",
        "llm.response.finish_reason": "stop",
      },
    }),
  ];

  const record = aggregateOtelTraceEvents("sess-sys", events);
  assert.ok(record);
  const system = record.interactions?.find((it: any) => it.role === "system");
  assert.ok(system, "expected a system interaction");
  assert.equal(system.content, "You are a Hermes agent. Be concise.");
  assert.equal(system.system_prompt_length, "You are a Hermes agent. Be concise.".length);
  // a plain-string input.value (no messages array) must NOT fabricate a system turn
  const userOnly = record.interactions?.find((it: any) => it.role === "user");
  assert.equal(userOnly?.content, "hi");

  const tree = buildAgentCallTree(record.interactions as any[]);
  assert.equal(tree?.systemPrompts?.length, 1);
  assert.equal(tree?.systemPrompts?.[0]?.text, "You are a Hermes agent. Be concise.");
});
