// 跨机·子 agent 逐轮归属端到端。事件形状照抄真实采样(fd103d73,CC 2.1.220,async Explore):
//   - 子 agent 的 LLM 轮次以 assistant_response 混在同一 session 流里,message.uuid 落在
//     subagents/agent-*.jsonl;prompt.id 与主 agent 共用,分不开
//   - 子 agent 的工具调用以 tool_result 混入,tool_use_id 只在子 agent transcript 里
//   - 子 agent 完成后 Task tool_result 才到,再来一条 task-notification 的 user_prompt
//     和主 agent 的最终答复(第二个 prompt.id)
// 客户端补传 subagent_map(meta.toolUseId + uuid 集 + 内部 tool_use_id 集)后,
// 服务端应把这些轮次逐轮归还给子 agent 节点,而不是平铺在 root。
// 时间戳刻意各不相同 —— 落库 monotonic 合并按 incoming 顺序保序是本链路成立的前提,
// 一并在这里回归(合并放最后一步)。
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const SPOOL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ai-claude-submap-"))
process.env.AGENT_INSIGHT_CLAUDE_OTEL_SPOOL_DIR = SPOOL_DIR

import { aggregateClaudeOtelSession } from "@/lib/ingest/claude-otel/aggregator"
import { appendClaudeOtelEvents } from "@/lib/ingest/claude-otel/spool"
import { buildContextSupplementEvents } from "@/lib/ingest/claude-otel/context-supplement"
import { normalizeClaudeOtlpLogs } from "@/lib/ingest/claude-otel/otlp-json"
import { buildAgentCallTree } from "@/lib/engine/observability/agent-trace"
import { mergeSessionInteractionsMonotonic } from "@/lib/engine/observability/session-interactions-merge"

const SESSION = "e2e-submap-1"
const REMOTE_ONLY = "/nonexistent-remote-host/bodies"
const t = (s: number) => new Date(Date.parse("2026-07-29T12:00:00.000Z") + s * 1000).toISOString()

const attr = (key: string, value: any) => ({
  key,
  value: typeof value === "number" ? { intValue: value } : { stringValue: String(value) },
})

function logRecord(eventName: string, ts: string, promptId: string, attrs: Record<string, any>, sequence: number) {
  return {
    body: { stringValue: `claude_code.${eventName}` },
    attributes: [
      attr("event.name", eventName),
      attr("event.timestamp", ts),
      attr("event.sequence", sequence),
      attr("session.id", SESSION),
      attr("prompt.id", promptId),
      ...Object.entries(attrs).map(([key, value]) => attr(key, value)),
    ],
  }
}

const OTLP_BODY = {
  resourceLogs: [{
    resource: { attributes: [attr("service.name", "claude-code")] },
    scopeLogs: [{
      logRecords: [
        logRecord("user_prompt", t(0), "p1", { prompt: "查清端口和超时配在哪" }, 0),
        // 主 agent 第一轮:文字 + 发起 Task(跨机拿不到 tool_use 块,正文只有文字)
        logRecord("api_request", t(1), "p1", { model: "deepseek-v4-flash", input_tokens: 900, output_tokens: 40, duration_ms: 800 }, 1),
        logRecord("api_request_body", t(1), "p1", { body_ref: `${REMOTE_ONLY}/r1.json`, body_length: 9000 }, 2),
        logRecord("api_response_body", t(1), "p1", { body_ref: `${REMOTE_ONLY}/s1.json`, body_length: 900 }, 3),
        logRecord("assistant_response", t(1.5), "p1", { response: "Explore 子 agent 已启动。", model: "deepseek-v4-flash", "message.uuid": "uuid-main-1" }, 4),
        // 子 agent 内部两轮 + 两次工具(uuid / tool_use_id 都只在 subagents/agent-*.jsonl 里)
        logRecord("api_request", t(2), "p1", { model: "deepseek-v4-pro", input_tokens: 500, output_tokens: 30, duration_ms: 700 }, 5),
        logRecord("assistant_response", t(2.5), "p1", { response: "我先列目录再读文件。", model: "deepseek-v4-pro", "message.uuid": "uuid-sub-1" }, 6),
        logRecord("tool_result", t(3), "p1", { tool_name: "Bash", tool_use_id: "call_inner_ls", success: "true", duration_ms: 40, tool_input: JSON.stringify({ command: "ls" }), tool_result_size_bytes: "64" }, 7),
        logRecord("tool_result", t(3.5), "p1", { tool_name: "Read", tool_use_id: "call_inner_read", success: "true", duration_ms: 30, tool_input: JSON.stringify({ file_path: "server/port.txt" }) }, 8),
        logRecord("api_request", t(4), "p1", { model: "deepseek-v4-pro", input_tokens: 700, output_tokens: 120, duration_ms: 1500 }, 9),
        logRecord("assistant_response", t(5), "p1", { response: "最终结论:端口 8931,超时 45s。", model: "deepseek-v4-pro", "message.uuid": "uuid-sub-2" }, 10),
        // 子 agent 完成 → Task 调用的 tool_result 才落
        logRecord("tool_result", t(6), "p1", { tool_name: "Agent", tool_use_id: "call_task_1", success: "true", duration_ms: 4200, tool_input: JSON.stringify({ subagent_type: "Explore", prompt: "找配置" }) }, 11),
        // async 形状:task-notification 作为第二个 prompt 进来,主 agent 给最终答复
        logRecord("user_prompt", t(7), "p2", { prompt: "<task-notification>…</task-notification>" }, 12),
        logRecord("api_request", t(7.5), "p2", { model: "deepseek-v4-flash", input_tokens: 800, output_tokens: 60, duration_ms: 900 }, 13),
        logRecord("assistant_response", t(8), "p2", { response: "端口配在 server/port.txt=8931,超时 server/timeout.txt=45s。", model: "deepseek-v4-flash", "message.uuid": "uuid-main-2" }, 14),
      ],
    }],
  }],
}

const SUPPLEMENT_ITEMS = [
  {
    kind: "subagent_map",
    toolUseId: "call_task_1",
    text: JSON.stringify({
      toolUseId: "call_task_1",
      agentType: "Explore",
      spawnDepth: 1,
      messageUuids: ["uuid-sub-1", "uuid-sub-2"],
      toolUseIds: ["call_inner_ls", "call_inner_read"],
    }),
    hash: "h-map",
    capturedAt: t(9),
  },
  { kind: "tool_output", toolUseId: "call_task_1", text: "最终结论:端口 8931,超时 45s。", hash: "h-task-out", capturedAt: t(6) },
  { kind: "tool_output", toolUseId: "call_inner_ls", text: "port.txt timeout.txt", hash: "h-ls-out", capturedAt: t(3) },
]

test("端到端(跨机):subagent_map 把子 agent 内部轮次与工具逐轮归位", async () => {
  const otelEvents = normalizeClaudeOtlpLogs(OTLP_BODY, { receivedAt: t(10), authenticatedUser: "e2e@example.com" })
  appendClaudeOtelEvents(otelEvents)

  // 基线:没有映射时,子 agent 轮次平铺在 root(今天线上的样子)
  const before = aggregateClaudeOtelSession(SESSION).record!
  const beforeSubTurns = (before.interactions as any[]).filter((item) => item.role === "subagent")
  assert.equal(beforeSubTurns.length, 0, "补传前:没有任何子 agent 轮次")
  assert.equal(
    (before.interactions as any[]).filter((item) => item.role === "assistant").length,
    4,
    "补传前:子 agent 的 2 轮混在 root 的 assistant 里(2 主 + 2 子)",
  )

  const { events: supplementEvents } = buildContextSupplementEvents(SESSION, SUPPLEMENT_ITEMS, {
    receivedAt: t(10),
    maxTextChars: 64000,
  })
  assert.equal(supplementEvents.length, 3)
  appendClaudeOtelEvents(supplementEvents)

  const after = aggregateClaudeOtelSession(SESSION).record!
  const interactions = after.interactions as any[]

  // —— 子 agent 的两轮逐轮归位,root 只剩主 agent 自己的两轮
  const subTurns = interactions.filter((item) => item.role === "subagent")
  assert.equal(subTurns.length, 2)
  assert.ok(subTurns.every((item) => item.subagent_session_id === `${SESSION}:call_task_1`))
  assert.ok(subTurns.every((item) => item.subagent_source === "client-supplement"))
  assert.match(subTurns[0].content, /列目录/)
  assert.match(subTurns[1].content, /端口 8931/)
  const rootTurns = interactions.filter((item) => item.role === "assistant")
  assert.equal(rootTurns.length, 2)
  assert.match(after.final_result || "", /server\/port\.txt/, "finalResult 是主 agent 的答复,不被子 agent 轮次覆盖")

  // —— 内部工具挂到发起它的那一轮子 agent 轮上,不再平铺 root
  const innerCalls = subTurns.flatMap((item) => item.tool_calls || [])
  assert.deepEqual(innerCalls.map((call: any) => call.id).sort(), ["call_inner_ls", "call_inner_read"])
  assert.equal(innerCalls.find((call: any) => call.id === "call_inner_ls")?.output, "port.txt timeout.txt")
  assert.ok(rootTurns.every((item) => !(item.tool_calls || []).some((call: any) => call.id.startsWith("call_inner"))))

  // —— Task 调用本身仍在 root 轮上(带补传输出),且没有重复合成的"结论轮"
  const taskCall = rootTurns.flatMap((item) => item.tool_calls || []).find((call: any) => call.id === "call_task_1")
  assert.ok(taskCall, "Task 调用挂在 root")
  assert.match(String(taskCall.output || ""), /端口 8931/)

  // —— 建树:一个 explore 子节点,内部 2 轮 LLM + 2 次工具
  const tree = buildAgentCallTree(interactions)!
  assert.equal(tree.children.length, 1)
  const child = tree.children[0]
  assert.equal(child.agentName, "explore")
  assert.equal(child.stats.llmCalls, 2)
  assert.equal(child.stats.toolCalls, 2)
  assert.equal(tree.stats.taskCalls, 1)

  // —— 落库:claudecode 走 snapshot-replace(整条覆盖)。补传是"重解释"——同一条消息
  //    从 assistant 变成 role=subagent,monotonic 按 key 合并认不出是同一条,会让新旧两种
  //    解释共存(task 调用双份、树上长出重复子节点),所以绝不能走 monotonic。
  //    这里钉死两件事:①适配器声明了 snapshot-replace;②补传后的快照不缩水
  //    (data-service 的缩水护栏以 interaction 数为准,更小会拒绝覆盖)。
  const { claudeAdapter } = await import("@/lib/ingest/adapters/claude")
  assert.equal(claudeAdapter.sessionMergeStrategy, "snapshot-replace")
  assert.ok(interactions.length >= (before.interactions as any[]).length, "补传后的快照只会更全,缩水护栏不会拦")

  // monotonic 合并对"重解释"无能为力的证据(claudecode 改走 snapshot-replace 的原因):
  const merged = mergeSessionInteractionsMonotonic(before.interactions as any[], interactions)
  assert.ok(
    merged.filter((item: any) => item.role === "assistant").length > 2,
    "monotonic 会让平铺旧解释与归位新解释共存 —— 这正是不能用它的原因",
  )
})

test("端到端(同机):有可读响应体时 subagent_map 完全不插手", () => {
  const SAME = "e2e-submap-same"
  const parentBody = JSON.stringify({
    id: "msg_parent", type: "message", role: "assistant", model: "m",
    content: [
      { type: "text", text: "dispatch" },
      { type: "tool_use", id: "call_task_1", name: "Agent", input: { subagent_type: "Explore", prompt: "找配置" } },
    ],
    usage: { input_tokens: 100, output_tokens: 20 }, stop_reason: "tool_use",
  })
  const childBody = JSON.stringify({
    id: "msg_child", type: "message", role: "assistant", model: "m",
    content: [{ type: "text", text: "端口 8931" }], usage: { input_tokens: 30, output_tokens: 3 }, stop_reason: "end_turn",
  })
  const sameEvents = normalizeClaudeOtlpLogs({
    resourceLogs: [{
      scopeLogs: [{
        logRecords: [
          { body: { stringValue: "claude_code.user_prompt" }, attributes: [attr("event.name", "user_prompt"), attr("event.timestamp", t(0)), attr("event.sequence", 0), attr("session.id", SAME), attr("prompt.id", "p1"), attr("prompt", "查配置")] },
          { body: { stringValue: "claude_code.api_response_body" }, attributes: [attr("event.name", "api_response_body"), attr("event.timestamp", t(1)), attr("event.sequence", 1), attr("session.id", SAME), attr("prompt.id", "p1"), attr("body", parentBody)] },
          { body: { stringValue: "claude_code.api_response_body" }, attributes: [attr("event.name", "api_response_body"), attr("event.timestamp", t(2)), attr("event.sequence", 2), attr("session.id", SAME), attr("prompt.id", "p1"), attr("body", childBody)] },
          { body: { stringValue: "claude_code.tool_result" }, attributes: [attr("event.name", "tool_result"), attr("event.timestamp", t(3)), attr("event.sequence", 3), attr("session.id", SAME), attr("prompt.id", "p1"), attr("tool_name", "Agent"), attr("tool_use_id", "call_task_1"), attr("success", "true"), attr("tool_input", JSON.stringify({ subagent_type: "Explore" }))] },
        ],
      }],
    }],
  }, { receivedAt: t(10), authenticatedUser: "e2e@example.com" })
  appendClaudeOtelEvents(sameEvents)

  const plain = aggregateClaudeOtelSession(SAME).record!

  appendClaudeOtelEvents(buildContextSupplementEvents(SAME, [SUPPLEMENT_ITEMS[0]], { receivedAt: t(10), maxTextChars: 64000 }).events)
  const withMap = aggregateClaudeOtelSession(SAME).record!

  // 同机快照逐字不变:映射只服务跨机 fallback 路径
  assert.deepEqual(
    JSON.parse(JSON.stringify(withMap.interactions)),
    JSON.parse(JSON.stringify(plain.interactions)),
  )

  fs.rmSync(SPOOL_DIR, { recursive: true, force: true })
})
