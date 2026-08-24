/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const {
  createDesktopRolloutReader,
  extractRolloutContentEvents,
} = require("../scripts/agent-trace-collectors/codex/rollout-reader.cjs")
const { CodexTraceCore } = require("../scripts/agent-trace-collectors/codex/codex-trace-core.cjs")
const {
  aggregateCodexTraceEvents,
} = require("../src/lib/ingest/otel/adapters/codex.ts")

class MemoryWriter {
  events: Array<Record<string, any>> = []

  async append(event: Record<string, any>) {
    this.events.push(structuredClone(event))
    return event
  }

  async flush() {}
}

function rolloutLine(type: string, payload: Record<string, unknown>, timestampMs = 1_700_000_000_000) {
  return { type, timestamp_ms: timestampMs, payload }
}

function eventMsg(type: string, payload: Record<string, unknown>, timestampMs = 1_700_000_000_000) {
  return rolloutLine("event_msg", { type, ...payload }, timestampMs)
}

// 形态取自真实桌面 rollout（01a019d6 会话脱敏）：
// session_meta → task_started → user_message → response_item(assistant/custom_tool_call/
// custom_tool_call_output) → agent_message → task_complete
function realShapedRecords() {
  return [
    rolloutLine("session_meta", { id: "thread-c1", originator: "Codex Desktop", source: "vscode" }),
    eventMsg("task_started", { turn_id: "turn-c1" }),
    eventMsg("user_message", { turn_id: "turn-c1", message: "分析一下这个任务" }),
    rolloutLine("response_item", {
      type: "message",
      role: "assistant",
      id: "msg_a1",
      content: [{ type: "output_text", text: "我先读取项目状态，再按流程执行。" }],
    }),
    rolloutLine("response_item", {
      type: "custom_tool_call",
      id: "ct_1",
      call_id: "call_c1_tool",
      name: "shell",
      input: "ls -la",
    }),
    rolloutLine("response_item", {
      type: "custom_tool_call_output",
      id: "cto_1",
      call_id: "call_c1_tool",
      output: [{ type: "output_text", text: "total 4\nfile.txt" }],
    }),
    eventMsg("agent_message", { message: "第一步完成，共发现 1 个文件。" }),
    eventMsg("task_complete", { turn_id: "turn-c1", status: "completed", last_assistant_message: "任务完成结论。" }),
  ]
}

function av(value: unknown) {
  if (typeof value === "number") return { intValue: value }
  return { stringValue: String(value) }
}

function otlpLogs(eventName: string, attributes: Record<string, unknown>, timestampMs = 1_700_000_000_500) {
  return {
    resourceLogs: [{
      resource: { attributes: [{ key: "service.name", value: av("codex-app-server") }] },
      scopeLogs: [{
        scope: { name: "codex-otel", version: "0.145.0" },
        logRecords: [{
          timeUnixNano: String(timestampMs * 1e6),
          attributes: Object.entries({ "event.name": eventName, ...attributes })
            .map(([key, value]) => ({ key, value: av(value) })),
        }],
      }],
    }],
  }
}

test("Bug 56 红灯：rollout reader 提取 assistant 正文、工具输出与 agent_message 正文", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-rollout-content-"))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const sessions = path.join(root, "sessions")
  await fsp.mkdir(sessions, { recursive: true })
  const rollout = path.join(sessions, "rollout-content.jsonl")
  await fsp.writeFile(rollout, `${realShapedRecords().map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8")

  const collected: any[] = []
  const reader = createDesktopRolloutReader({
    enabled: true,
    sessionsDir: sessions,
    stateDir: path.join(root, "state"),
    onEvents: async (items: any[]) => collected.push(...items),
  })
  await reader.scan()

  const content = collected.filter((item) => item.eventType === "rollout_content")
  // 1) assistant 正文（response_item message）
  const assistant = content.find((item) => item.contentKind === "llm_text")
  assert.ok(assistant, "must emit rollout_content llm_text for assistant response_item message")
  assert.match(assistant.payload.text, /我先读取项目状态/)
  // 2) 工具输出（custom_tool_call_output，call_id 与 OTLP 同源）
  const toolOutput = content.find((item) => item.contentKind === "tool_output")
  assert.ok(toolOutput, "must emit rollout_content tool_output for tool call output")
  assert.equal(toolOutput.payload.callId, "call_c1_tool")
  assert.match(String(toolOutput.payload.output), /file\.txt/)
  // 3) agent_message 正文
  const agentMessage = content.find((item) => item.contentKind === "agent_message")
  assert.ok(agentMessage, "must emit rollout_content agent_message for event_msg agent_message")
  assert.match(agentMessage.payload.text, /第一步完成/)
  // 4) 每条 content 事件带 turn 归属
  assert.ok(content.every((item) => item.sourceExecutionId === "turn-c1"), "content events carry turn attribution")
})

test("Bug 56 红灯：core 把 rollout 正文写入 OTLP 同源 session（llm/tool 快照可合并）", async () => {
  const writer = new MemoryWriter()
  const core = new CodexTraceCore({ writer, now: () => 1_700_000_001_000 })

  // OTLP 路径先建立同 turn 的事件（模拟 sse_event usage llm span + tool_result）
  await core.processOtel(otlpLogs("codex.sse_event", {
    "conversation.id": "thread-c1",
    "turn.id": "turn-c1",
    "event.kind": "response.completed",
    "response.id": "resp_1",
    input_token_count: 100,
    output_token_count: 20,
  }, 1_700_000_000_500))

  // rollout 内容事件（reader 产出形态）
  const base = {
    sourceThreadId: "thread-c1",
    sourceKind: "desktop",
    sourceExecutionId: "turn-c1",
    provenance: { direct: true, confidence: "direct" },
  }
  await core.processRolloutContent({ ...base, eventId: "rc-1", eventType: "rollout_content", contentKind: "llm_text", timestampMs: 1_700_000_000_600, payload: { text: "我先读取项目状态，再按流程执行。" } })
  await core.processRolloutContent({ ...base, eventId: "rc-2", eventType: "rollout_content", contentKind: "tool_output", timestampMs: 1_700_000_000_700, payload: { callId: "call_c1_tool", toolName: "shell", output: "total 4\nfile.txt" } })

  // 1) llm 正文与 OTLP usage 进同一 session（sessionId 前缀一致，非 codex: 合成前缀）
  const llmContent = writer.events.find((e) => e.kind === "llm" && (e.output || "").includes("我先读取项目状态"))
  assert.ok(llmContent, "rollout llm_text must be appended as an llm event")
  assert.equal(llmContent.sessionId, "thread-c1:turn:turn-c1", "content must live in the OTLP-sourced session id")
  // 2) 工具输出复用 OTLP tool 的 spanId（stableSpanId(sessionId,'tool',callId)），使
  //    服务端 keepLatestCodexSpanSnapshots 能合并两路快照
  const otelToolSpanId = writer.events
    .filter((e) => e.kind === "tool")
    .map((e) => e.spanId)
  const contentTool = writer.events.find((e) => e.kind === "tool" && (e.tool?.result || "").includes("file.txt"))
  assert.ok(contentTool, "rollout tool_output must be appended as a tool event with result")
  assert.ok(otelToolSpanId.includes(contentTool.spanId), "tool content event must share spanId with the OTLP tool event when call ids match")
})

test("Bug 56 红灯：adapter 聚合后 LLM 节点带正文、工具带结果（端到端形态）", async () => {
  const writer = new MemoryWriter()
  const core = new CodexTraceCore({ writer, now: () => 1_700_000_001_000 })
  const base = {
    sourceThreadId: "thread-c2",
    sourceKind: "desktop",
    sourceExecutionId: "turn-c2",
    provenance: { direct: true, confidence: "direct" },
  }
  await core.processOtel(otlpLogs("codex.user_prompt", {
    "conversation.id": "thread-c2",
    "turn.id": "turn-c2",
    prompt: "端到端验证任务",
  }, 1_700_000_000_500))
  await core.processOtel(otlpLogs("codex.sse_event", {
    "conversation.id": "thread-c2",
    "turn.id": "turn-c2",
    "event.kind": "response.completed",
    "response.id": "resp_e2e",
    input_token_count: 50,
    output_token_count: 10,
  }, 1_700_000_000_600))
  await core.processOtel(otlpLogs("codex.tool_result", {
    "conversation.id": "thread-c2",
    "turn.id": "turn-c2",
    "tool.name": "shell",
    call_id: "call_e2e_1",
  }, 1_700_000_000_700))
  await core.processRolloutContent({ ...base, eventId: "rc-e2e-1", eventType: "rollout_content", contentKind: "llm_text", timestampMs: 1_700_000_000_650, payload: { text: "这是模型的第一句正文回答。" } })
  await core.processRolloutContent({ ...base, eventId: "rc-e2e-2", eventType: "rollout_content", contentKind: "tool_output", timestampMs: 1_700_000_000_800, payload: { callId: "call_e2e_1", toolName: "shell", output: "ls 结果：hello.txt" } })

  const record = aggregateCodexTraceEvents("thread-c2:turn:turn-c2", writer.events as any)
  assert.ok(record, "aggregation must produce a record")
  const llmWithText = (record?.interactions || []).find((i: any) => i.role === "assistant" && (i.content || "").includes("第一句正文回答"))
  assert.ok(llmWithText, "aggregated interactions must include LLM content from rollout")
  const toolWithOutput = (record?.interactions || []).find((i: any) => (i.tool_calls || []).some((c: any) => (c.output || "").includes("hello.txt")))
  assert.ok(toolWithOutput, "aggregated interactions must include tool output from rollout")
  assert.equal(record?.query, "端到端验证任务")
})
