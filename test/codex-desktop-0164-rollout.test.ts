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

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Bug 446-9：Codex Desktop 0.164 起 rollout 不再发 `user_message` 生命周期事件，
 * 用户输入改由 `event_msg.payload.type = item_completed` 的 `item.type = UserMessage`
 * 条目承载，token 改由顶层 `token_usage_record` 记录承载。
 *
 * 旧 reader 只识别 `user_message`，导致每个 turn 都缺少 execution_started /
 * user_input_accepted，随后 task_complete 因 `activeTaskHadUserInput=false` 被丢弃，
 * 桌面 trace 完全不落库（真实证据：共享库 codex Execution 最新一条停在 2026-09-02，
 * 而 10-25 两个真实会话 988 行 rollout 产生 967 条 unknownRecords）。
 *
 * 本文件是本 Bug 的稳定红灯：夹具字段逐字取自 0.164 真实 rollout。
 */
import assert from "node:assert/strict"
import test from "node:test"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const {
  recordsToLifecycleEvents,
  extractRolloutContentEvents,
} = require("../scripts/agent-trace-collectors/codex/rollout-reader.cjs")
const { createCodexLifecycleReducer } = require("../scripts/agent-trace-collectors/codex/lifecycle-reducer.cjs")
const { CodexTraceCore } = require("../scripts/agent-trace-collectors/codex/codex-trace-core.cjs")
const {
  aggregateCodexTraceEvents,
  keepLatestCodexSpanSnapshots,
} = require("../src/lib/ingest/otel/adapters/codex.ts")

function otelLlm(spanId: string, total: number, turn = "01a1713e-66a4-7081-8023-facd0ab70ff7") {
  return {
    sessionId: `${THREAD}:turn:${turn}`,
    traceId: "trace-1",
    spanId,
    parentSpanId: undefined,
    kind: "llm",
    name: "llm.gpt-6.1-sol",
    startTimeMs: BASE_TS,
    endTimeMs: BASE_TS + 10,
    attributes: { "codex.turn.id": turn, "codex.execution.id": `${THREAD}:turn:${turn}` },
    usage: { input: total - 10, output: 10, reasoning: 0, total },
  }
}

function rolloutLlm(spanId: string, total: number, turn = "01a1713e-66a4-7081-8023-facd0ab70ff7") {
  return {
    ...otelLlm(spanId, total, turn),
    attributes: {
      "codex.turn.id": turn,
      "codex.execution.id": `${THREAD}:turn:${turn}`,
      "codex.usage.source": "rollout",
    },
  }
}

test("Bug 446-10 红灯：同一 turn 的 OTel 与 rollout 双通道 usage 不重复计量", () => {
  // 真实样本（0.164 单 turn）：OTel 45 条中 20 条带 usage 共 2821159，
  // rollout 33 条共 3856883（等于原始真值）；两路相加会虚增到 6678042。
  const events: any[] = [
    rolloutLlm("roll-1", 2000000),
    rolloutLlm("roll-2", 1856883),
    otelLlm("otel-1", 1000),
    otelLlm("otel-2", 1821159),
  ]
  const deduped = keepLatestCodexSpanSnapshots(events)
  const usageTotal = deduped.reduce((sum: number, event: any) => sum + (event.usage?.total || 0), 0)
  assert.equal(usageTotal, 3856883, "rollout usage 为权威计量，OTel usage 不得叠加")
  // 无正文的 OTel 计量快照在去掉 usage 后只剩空壳，必须整体丢弃：保留会让
  // LLM 节点数虚增（真实样本 33 usage + 5 正文 = 38，虚增后曾达 119），
  // 并在 UI 里渲染成一串「未采集到模型输出」。
  const shellLeft = deduped.filter((event: any) => event.spanId === "otel-1")
  assert.equal(shellLeft.length, 0, "无正文的空壳 OTel LLM 节点必须丢弃")
  assert.equal(deduped.filter((event: any) => event.kind === "llm").length, 2, "只保留两条 rollout LLM 节点")
})

test("Bug 446-10 红灯：择一不得连带删除同 turn 的 tool/agent 事件", () => {
  // 早期实现按「无 body」判定丢弃，把同 turn 的 tool 与 agent 一起删掉，
  // 该 turn 没有 agent 根事件 → 服务端不落库（真实样本 1239 tool + 63 agent 全丢）。
  const turn = "01a1713e-66a4-7081-8023-facd0ab70ff7"
  const toolEvent = {
    sessionId: `${THREAD}:turn:${turn}`,
    spanId: "tool-1",
    kind: "tool",
    name: "tool.exec",
    startTimeMs: BASE_TS,
    endTimeMs: BASE_TS + 5,
    attributes: {
      "codex.turn.id": turn,
      "codex.execution.id": `${THREAD}:turn:${turn}`,
      "tool.name": "exec",
    },
  }
  const agentEvent = {
    sessionId: `${THREAD}:turn:${turn}`,
    spanId: "agent-root",
    kind: "agent",
    name: "agent.codex",
    status: "completed",
    startTimeMs: BASE_TS,
    endTimeMs: BASE_TS + 100,
    attributes: {
      "codex.turn.id": turn,
      "codex.execution.id": `${THREAD}:turn:${turn}`,
      "agent.insight.lifecycle": "execution",
    },
  }
  const kept = keepLatestCodexSpanSnapshots([
    rolloutLlm("roll-1", 1000, turn),
    otelLlm("otel-shell", 500, turn),
    toolEvent,
    agentEvent,
  ])
  assert.ok(kept.some((event: any) => event.spanId === "tool-1"), "tool 事件必须保留")
  assert.ok(kept.some((event: any) => event.spanId === "agent-root"), "agent 根事件必须保留，否则该 turn 不落库")
  // 聚合器还要求 sourceKind 等归属字段；这里只锁"择一不误删非 LLM 事件"。
  assert.equal(kept.filter((event: any) => event.kind === "llm").length, 1, "只保留一条 rollout LLM 节点")
})

test("Bug 446-10 对照：带正文的 OTel LLM 节点保留正文、仅去掉 usage", () => {
  const withBody = { ...otelLlm("otel-body", 900), output: "assistant 正文" }
  const deduped = keepLatestCodexSpanSnapshots([rolloutLlm("roll-1", 1000), withBody])
  const kept = deduped.find((event: any) => event.spanId === "otel-body")
  assert.ok(kept, "带正文的 OTel 节点必须保留（正文是唯一来源）")
  assert.equal(kept.output, "assistant 正文", "正文不得丢失")
  assert.equal(kept.usage, undefined, "但不得重复计量")
})

test("Bug 446-10 对照：无 rollout usage 的 turn 保留 OTel 计量不变", () => {
  const events: any[] = [otelLlm("otel-a", 1234), otelLlm("otel-b", 4321)]
  const kept = keepLatestCodexSpanSnapshots(events)
  const total = kept.reduce((sum: number, event: any) => sum + (event.usage?.total || 0), 0)
  assert.equal(total, 5555, "纯 OTel 的 turn（CLI/IDE 或 0.164 前版本）行为不变")
})

const THREAD = "01a17135-f417-7ce0-b5f9-56ad5e6805d0"
const TURN = "01a17135-f8a7-7891-845d-9ba43bad78c3"
const BASE_TS = 1_792_900_724_408

function rec(type: string, payload: Record<string, unknown>, offsetMs = 0) {
  return {
    timestamp: new Date(BASE_TS + offsetMs).toISOString(),
    type,
    payload,
  }
}

function sessionMeta() {
  return rec("session_meta", {
    id: THREAD,
    session_id: THREAD,
    originator: "Codex Desktop",
    cli_version: "0.164.0-alpha.11.1",
    source: "vscode",
    thread_source: "user",
    model_provider: "custom",
  })
}

function taskStarted() {
  return rec("event_msg", {
    type: "task_started",
    turn_id: TURN,
    root_turn_id: TURN,
    started_at: 1792900724,
    collaboration_mode_kind: "default",
  }, 1)
}

/** 0.164 用户输入载体：item_completed + item.type=UserMessage。 */
function userMessageItem(text: string, offsetMs = 2) {
  return rec("event_msg", {
    type: "item_completed",
    thread_id: THREAD,
    turn_id: TURN,
    item: {
      type: "UserMessage",
      id: "01a17135-fe6f-7301-88bb-4571a257d8bf",
      client_id: "b2e8fa85-e292-4628-a1c2-71cf2d706da5",
      content: [{ type: "text", text, text_elements: [] }],
    },
    started_at_ms: BASE_TS + offsetMs,
    completed_at_ms: BASE_TS + offsetMs,
  }, offsetMs)
}

/** 0.164 token 载体：顶层 token_usage_record。 */
function tokenUsage(offsetMs = 3000) {
  return rec("token_usage_record", {
    thread_id: THREAD,
    turn_id: TURN,
    session_id: THREAD,
    root_turn_id: TURN,
    response_id: "resp_0aeba9528f066847016add7e766a90819182824e7af985266d",
    usage: {
      input_tokens: 34981,
      cached_input_tokens: 4096,
      cache_write_input_tokens: 128,
      output_tokens: 161,
      reasoning_output_tokens: 64,
      total_tokens: 35142,
    },
    turn_token_usage: { input_tokens: 34981, output_tokens: 161, total_tokens: 35142 },
    thread_token_usage: { input_tokens: 34981, output_tokens: 161, total_tokens: 35142 },
  }, offsetMs)
}

function taskComplete(offsetMs = 4000) {
  return rec("event_msg", {
    type: "task_complete",
    root_turn_id: TURN,
    turn_id: TURN,
    last_agent_message: "已完成",
    started_at: 1792900724,
    completed_at: 1792901108,
    duration_ms: 383239,
    time_to_first_token_ms: 3661,
  }, offsetMs)
}

/** 0.164 的 reasoning 条目字段从 summary 改为 summary_text/raw_content。 */
function reasoningItem(offsetMs = 500) {
  return rec("response_item", {
    type: "reasoning",
    id: "rs_0aeba9528f066847016add7e825c148191a3637ca654e3f655",
    summary_text: ["先核对补丁状态，再复现 ufn 报错"],
    raw_content: ["先核对补丁状态，再复现 ufn 报错"],
  }, offsetMs)
}

function context(): Record<string, any> {
  return { sourceThreadId: undefined, sourceKind: "unknown", unknownRecords: 0, toolNames: new Map() }
}

function run(records: any[]) {
  let ctx = context()
  const events: any[] = []
  for (const record of records) {
    const lifecycle = recordsToLifecycleEvents(record, ctx)
    ctx = lifecycle.context
    events.push(...lifecycle.events)
    const content = extractRolloutContentEvents(record, ctx)
    ctx = content.context
    events.push(...content.events)
  }
  return { events, context: ctx }
}

test("Bug 446-9 红灯：0.164 的 item_completed(UserMessage) 必须产出 execution_started 与 user_input_accepted", () => {
  const { events, context: finalContext } = run([sessionMeta(), taskStarted(), userMessageItem("可以看到我们 DIY ZCode 补丁这一块，好像最近发生了一个 bug。")])

  const started = events.find((item: any) => item.eventType === "execution_started")
  assert.ok(started, "0.164 用户输入必须产出 execution_started（旧 reader 在此为 0）")
  assert.equal(started.sourceExecutionId, TURN, "sourceExecutionId 必须是 task_started 的 turn_id")

  const accepted = events.find((item: any) => item.eventType === "user_input_accepted")
  assert.ok(accepted, "0.164 用户输入必须产出 user_input_accepted")
  assert.match(String(accepted.payload?.content), /DIY ZCode 补丁/, "用户输入正文必须完整保留")
  assert.equal(accepted.inputKind, "initial", "本轮首条输入是 initial")
  assert.equal(finalContext.activeTaskHadUserInput, true, "activeTaskHadUserInput 必须置位，否则 task_complete 被丢弃")
  assert.equal(finalContext.unknownRecords, 0, "已知 item 不应计入 unknownRecords")
})

test("Bug 446-9 红灯：0.164 会话必须落成一次带 query 与终态的执行", () => {
  const { events } = run([sessionMeta(), taskStarted(), userMessageItem("修复 DIY 补丁的 bug"), taskComplete()])

  const completed = events.find((item: any) => item.eventType === "execution_completed")
  assert.ok(completed, "task_complete 必须产出 execution_completed（旧 reader 因缺 user input 丢弃）")
  assert.equal(completed.status, "completed")

  const reducer = createCodexLifecycleReducer()
  for (const item of events) reducer.apply(item)
  const snapshot = reducer.snapshot()
  assert.equal(snapshot.executions.length, 1, "一次桌面任务只应产生一条执行")
  assert.equal(snapshot.executions[0].status, "completed", "执行必须有终态")
  assert.match(String(snapshot.executions[0].query), /修复 DIY 补丁的 bug/, "执行必须带用户 query")
})

test("Bug 446-9 红灯：token_usage_record 必须被解析为 llm usage（输入/输出/推理/缓存/总计）", () => {
  const { events } = run([sessionMeta(), taskStarted(), userMessageItem("统计 token"), tokenUsage()])

  const usageEvents = events.filter((item: any) => item.eventType === "rollout_usage")
  assert.equal(usageEvents.length, 1, "一条 token_usage_record 必须产出一条 rollout_usage 事件")
  const payload = usageEvents[0].payload
  assert.equal(payload.inputTokens, 34981)
  assert.equal(payload.outputTokens, 161)
  assert.equal(payload.reasoningTokens, 64)
  assert.equal(payload.cacheReadTokens, 4096)
  assert.equal(payload.cacheWriteTokens, 128)
  assert.equal(payload.totalTokens, 35142)
  assert.equal(payload.responseId, "resp_0aeba9528f066847016add7e766a90819182824e7af985266d", "usage 必须与响应 id 关联，供 span 归并")
  assert.equal(usageEvents[0].sourceExecutionId, TURN, "usage 必须归属到本轮 turn")
})

test("Bug 446-9 对照：0.164 reasoning 仅含 encrypted_content，不得伪造正文节点", () => {
  const { events } = run([sessionMeta(), taskStarted(), userMessageItem("推理正文"), reasoningItem()])

  const reasoning = events.filter((item: any) => /先核对补丁状态/.test(String(item.payload?.text)))
  assert.equal(reasoning.length, 0, "0.164 reasoning 已加密（summary_text 为空），不得凭 encrypted_content 造正文")
  const llmTexts = events.filter((item: any) => item.eventType === "rollout_content" && item.contentKind === "llm_text")
  assert.equal(llmTexts.length, 0, "本夹具没有助手消息，不得凭空生成 llm_text")
})

test("Bug 446-9 对照：旧格式 user_message 行为保持不变", () => {
  const legacy = [
    rec("session_meta", { id: THREAD, originator: "Codex Desktop", source: "exec" }),
    rec("event_msg", { type: "task_started", turn_id: "task-legacy" }, 1),
    rec("event_msg", { type: "user_message", turn_id: "task-legacy", message: "旧格式输入" }, 2),
  ]
  const { events, context: finalContext } = run(legacy)
  assert.ok(events.find((item: any) => item.eventType === "execution_started"), "旧格式仍须产出 execution_started")
  const accepted = events.find((item: any) => item.eventType === "user_input_accepted")
  assert.equal(accepted?.payload?.content, "旧格式输入", "旧格式正文不得被新分支改写")
  assert.equal(finalContext.unknownRecords, 0)
})

test("Bug 446-9 对照：非用户项（CommandExecution/Reasoning 等）不得被误判为用户输入", () => {
  const { events } = run([
    sessionMeta(),
    taskStarted(),
    rec("event_msg", {
      type: "item_completed",
      thread_id: THREAD,
      turn_id: TURN,
      item: { type: "CommandExecution", id: "exec-1", command: ["bash", "-lc", "pwd"], status: "completed" },
    }, 2),
  ])
  assert.equal(events.filter((item: any) => item.eventType === "user_input_accepted").length, 0, "工具执行不是用户输入")
})

class MemoryWriter {
  events: Array<Record<string, any>> = []
  async append(event: Record<string, any>) {
    this.events.push(structuredClone(event))
    return event
  }
  async flush() {}
}

function usageEvent(responseId: string, total: number, offsetMs = 0) {
  return {
    eventId: `usage-${responseId}`,
    eventType: "rollout_usage",
    source: "desktop_rollout",
    sourceKind: "desktop",
    sourceThreadId: THREAD,
    sourceExecutionId: TURN,
    timestampMs: BASE_TS + offsetMs,
    payload: {
      inputTokens: total - 10,
      outputTokens: 10,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: total,
      responseId,
    },
    provenance: { direct: true, confidence: "direct" },
  }
}

test("Bug 446-9 红灯：一条 usage 记录落一个独立 LLM span，多条 usage 不互相覆盖", async () => {
  const writer = new MemoryWriter()
  const core = new CodexTraceCore({ writer, now: () => BASE_TS })
  await core.processLifecycleEvent({ ...usageEvent("resp-a", 1000, 10) })
  await core.processLifecycleEvent({ ...usageEvent("resp-b", 2000, 20) })
  await core.processLifecycleEvent({ ...usageEvent("resp-c", 3000, 30) })

  const llms = writer.events.filter((event: any) => event.kind === "llm")
  assert.equal(llms.length, 3, "每条 usage 必须成为一次独立 LLM 调用")
  const spanIds = new Set(llms.map((event: any) => event.spanId))
  assert.equal(spanIds.size, 3, "span 不得共享，否则服务端按 spanId 保留最新快照会丢 token")
  assert.equal(
    llms.reduce((sum: number, event: any) => sum + (event.usage?.total || 0), 0),
    6000,
    "token 总额必须等于三条 usage 之和，不重不漏",
  )
})

test("Bug 446-9 红灯：正文与 usage 不互相吞并（正文保留输出，usage 保留计量）", async () => {
  const writer = new MemoryWriter()
  const core = new CodexTraceCore({ writer, now: () => BASE_TS })
  await core.processRolloutContent({
    eventId: "content-1",
    eventType: "rollout_content",
    source: "desktop_rollout",
    sourceKind: "desktop",
    sourceThreadId: THREAD,
    sourceExecutionId: TURN,
    contentKind: "llm_text",
    timestampMs: BASE_TS + 5,
    payload: { itemId: "msg-1", text: "已修复并写入安装版。" },
  })
  await core.processLifecycleEvent({ ...usageEvent("resp-x", 5000, 10) })

  const withText = writer.events.filter((event: any) => event.kind === "llm" && event.output)
  assert.equal(withText.length, 1, "正文必须落成带 output 的 LLM 节点（Bug 56 契约）")
  assert.match(withText[0].output, /已修复并写入安装版/)
  const total = writer.events
    .filter((event: any) => event.kind === "llm")
    .reduce((sum: number, event: any) => sum + (event.usage?.total || 0), 0)
  assert.equal(total, 5000, "usage 不得因正文存在而丢失")
})
