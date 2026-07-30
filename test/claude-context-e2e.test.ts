// 跨机端到端(服务端全链路):OTLP wire JSON → 归一化 → 落 spool 文件 → 补传落同一份 spool
// → 按 sessionId 重聚合 → interactions → agent 树。
// 走的是真实文件读写与真实聚合入口(aggregateClaudeOtelSession),不是把事件数组直接喂给纯函数;
// 唯一没覆盖的是 HTTP 鉴权层与消费者定时器 —— 那两段要起服务,沙箱不给起。
//
// 跨机的判据:所有 body_ref 指向服务端根本不存在的路径,且路径里不含 `claude_raw_bodies/`
// (含该片段的路径 aggregator 会重写到本机 ~/.agent-insight 再试一次,那样就模拟不出跨机)。
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const SPOOL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ai-claude-spool-"))
process.env.AGENT_INSIGHT_CLAUDE_OTEL_SPOOL_DIR = SPOOL_DIR

import { aggregateClaudeOtelSession } from "@/lib/ingest/claude-otel/aggregator"
import { appendClaudeOtelEvents } from "@/lib/ingest/claude-otel/spool"
import { buildContextSupplementEvents } from "@/lib/ingest/claude-otel/context-supplement"
import { normalizeClaudeOtlpLogs } from "@/lib/ingest/claude-otel/otlp-json"
import { buildAgentCallTree } from "@/lib/engine/observability/agent-trace"

const SESSION = "e2e-xmachine-1"
const TS = "2026-07-29T12:00:00.000Z"
const REMOTE_ONLY = "/nonexistent-remote-host/bodies"

const attr = (key: string, value: any) => ({
  key,
  value: typeof value === "number" ? { intValue: value } : { stringValue: String(value) },
})

function logRecord(eventName: string, attrs: Record<string, any>, sequence: number) {
  return {
    body: { stringValue: `claude_code.${eventName}` },
    attributes: [
      attr("event.name", eventName),
      attr("event.timestamp", TS),
      attr("event.sequence", sequence),
      attr("session.id", SESSION),
      attr("prompt.id", "p1"),
      ...Object.entries(attrs).map(([key, value]) => attr(key, value)),
    ],
  }
}

/** 客户端跑一次带工具 + 子 agent 的会话后,平台真实收到的那批 OTel 日志(跨机形状)。 */
const OTLP_BODY = {
  resourceLogs: [{
    resource: { attributes: [attr("service.name", "claude-code")] },
    scopeLogs: [{
      logRecords: [
        logRecord("user_prompt", { prompt: "帮我看一下项目里的配置在哪" }, 0),
        logRecord("api_request", {
          model: "claude-sonnet-4-6", input_tokens: 1200, output_tokens: 300, cost_usd: "0.004", duration_ms: 2100,
        }, 1),
        // 请求体 / 响应体都只有 body_ref,指向客户端本机 —— 服务端读不到
        logRecord("api_request_body", { body_ref: `${REMOTE_ONLY}/req.json`, body_length: 120000 }, 2),
        logRecord("api_response_body", { body_ref: `${REMOTE_ONLY}/res.json`, body_length: 900 }, 3),
        logRecord("tool_result", {
          tool_name: "Read", tool_use_id: "toolu_read_1", success: "true", duration_ms: 40,
          tool_input: JSON.stringify({ file_path: "src/config.ts" }),
          tool_result_size_bytes: "128",  // 只有大小没有正文
        }, 4),
        logRecord("tool_result", {
          tool_name: "Agent", tool_use_id: "toolu_task_1", success: "true", duration_ms: 5200,
          tool_input: JSON.stringify({ subagent_type: "Explore", prompt: "找出配置文件位置" }),
        }, 5),
        logRecord("assistant_response", { response: "配置在 src/config.ts。", model: "claude-sonnet-4-6" }, 6),
      ],
    }],
  }],
}

/** 客户端补传器在 SessionEnd 时会发的四条。 */
const SUPPLEMENT_ITEMS = [
  { kind: "system_prompt", text: "You are Claude Code.\n项目规范：master 只能走 MR。", hash: "h-sys", capturedAt: TS },
  { kind: "hook_context", text: "【hook 注入】当前分支保护策略", hookEvent: "UserPromptSubmit", hookName: "repo-policy", hash: "h-hook", capturedAt: TS },
  { kind: "tool_output", toolUseId: "toolu_read_1", text: "export const config = { port: 3000 }", hash: "h-tool", capturedAt: TS },
  { kind: "tool_output", toolUseId: "toolu_task_1", text: "子 agent 结论：配置在 src/config.ts，另有 .env 覆盖。", hash: "h-task", capturedAt: TS },
]

test("端到端(跨机):OTLP → spool 文件 → 补传 → 重聚合,四样缺失全部补回", () => {
  // ① 平台收 OTel 日志并落盘(等价 POST /api/ingest/otel/v1/logs 的处理)
  const otelEvents = normalizeClaudeOtlpLogs(OTLP_BODY, { receivedAt: TS, authenticatedUser: "e2e@example.com" })
  assert.ok(otelEvents.length >= 7, "OTLP 归一化应产出全部事件")
  appendClaudeOtelEvents(otelEvents)

  // 补传前先确认基线:这就是今天线上跨机的样子
  const before = aggregateClaudeOtelSession(SESSION).record
  assert.ok(before)
  const beforeRoles = (before!.interactions as any[]).map((item) => item.role)
  assert.deepEqual(beforeRoles, ["user", "assistant"], "补传前:只有对话,没有 system / hook / 子 agent")
  const beforeReadOutput = (before!.interactions as any[])
    .flatMap((item) => item.tool_calls || [])
    .find((call: any) => call.id === "toolu_read_1")?.output
  assert.equal(beforeReadOutput, undefined, "补传前:工具输出为空")

  // ② 客户端补传落到同一份 spool(等价 POST /api/ingest/claude/context 的处理)
  const { events: supplementEvents, truncated } = buildContextSupplementEvents(SESSION, SUPPLEMENT_ITEMS, {
    receivedAt: TS,
    maxTextChars: 64000,
  })
  assert.equal(supplementEvents.length, 4)
  assert.equal(truncated, 0)
  appendClaudeOtelEvents(supplementEvents)

  // 落盘真的发生了(消费者就是靠这份文件的新增字节发现要重算)
  const spoolFiles: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === "logs.jsonl") spoolFiles.push(full)
    }
  }
  walk(SPOOL_DIR)
  assert.equal(spoolFiles.length, 1, "补传要写进同一份 logs.jsonl,不新增 spool 源")
  const spoolText = fs.readFileSync(spoolFiles[0], "utf8")
  assert.equal(spoolText.trim().split("\n").length, otelEvents.length + supplementEvents.length)

  // ③ 重聚合(消费者被新增字节唤醒后做的事)
  const after = aggregateClaudeOtelSession(SESSION).record
  assert.ok(after)
  const interactions = after!.interactions as any[]

  // —— system prompt 补回来了
  const system = interactions.filter((item) => item.role === "system")
  assert.equal(system.length, 1)
  assert.match(system[0].content, /master 只能走 MR/)
  assert.equal(system[0].system_prompt_source, "client-supplement")

  // —— hook 注入上下文补回来了,且不污染用户输入口径
  const hooks = interactions.filter((item) => item.role === "hook_context")
  assert.equal(hooks.length, 1)
  assert.equal(hooks[0].hook_event, "UserPromptSubmit")
  assert.equal(after!.query, "帮我看一下项目里的配置在哪")

  // —— 工具输出挂回那次调用
  const readCall = interactions.flatMap((item) => item.tool_calls || []).find((call: any) => call.id === "toolu_read_1")
  assert.equal(readCall?.output, "export const config = { port: 3000 }")

  // —— 子 agent 那一轮补出来了
  const subagent = interactions.find((item) => item.role === "subagent")
  assert.ok(subagent)
  assert.match(subagent.content, /另有 \.env 覆盖/)

  // —— 指标口径没被补传带偏
  assert.equal(after!.tool_call_count, 2)
  assert.equal(after!.llm_call_count, 1)
  assert.equal(after!.user, "e2e@example.com")

  // ④ 前端拿到的树:root + 一个子 agent 节点
  const tree = buildAgentCallTree(interactions)
  assert.ok(tree)
  assert.equal(tree!.systemPrompts?.length, 1)
  assert.equal(tree!.hookContexts?.length, 1)
  assert.equal(tree!.children.length, 1)
  assert.equal(tree!.children[0].agentName, "explore")
  assert.equal(tree!.stats.taskCalls, 1)
})

test("端到端:同一批补传重复上传(客户端重试)不产生重复内容", () => {
  const { events } = buildContextSupplementEvents(SESSION, SUPPLEMENT_ITEMS, { receivedAt: TS, maxTextChars: 64000 })
  appendClaudeOtelEvents(events)

  const record = aggregateClaudeOtelSession(SESSION).record
  const interactions = record!.interactions as any[]
  assert.equal(interactions.filter((item) => item.role === "system").length, 1)
  assert.equal(interactions.filter((item) => item.role === "hook_context").length, 1)
  assert.equal(interactions.filter((item) => item.role === "subagent").length, 1)

  fs.rmSync(SPOOL_DIR, { recursive: true, force: true })
})
