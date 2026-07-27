import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { readOtelTraceEventsForSession } from "@/lib/ingest/claude-otel/spool"

/**
 * 上报正文契约：**打过去的东西，落到存储时还得在**。
 *
 * 端点契约（ingest-endpoint-contract）管的是「打给谁」，这份管「打过去之后长什么样」。
 * 两者缺一不可——真实事故里请求 200 OK、端点存在、handler 没报错，数据却在转换环节被
 * 整包丢掉：两轮对话（6 条 interactions）落库后只剩 2 条合成的 assistant span。
 */

process.env.AGENT_INSIGHT_UPLOADER_NO_MAIN = "1"

// ── opencode：插件事件 → uploader 拼出的上报 payload ────────────────────────────

const SID = "ses_contract_root"

/** 一轮对话的最小事件序列：用户提问 → 助手正文（含流式终稿） */
function roundRecords(round: {
  userMsgId: string
  userPartId: string
  userText: string
  assistantMsgId: string
  assistantPartId: string
  assistantText: string
  createdAt: number
}) {
  const part = (messageID: string, id: string, type: string, text: string) => ({
    kind: "event",
    sessionID: SID,
    payload: {
      type: "message.part.updated",
      event: { properties: { part: { id, type, text, messageID, sessionID: SID } } },
    },
  })
  const message = (id: string, role: string, created: number, completed?: number) => ({
    kind: "event",
    sessionID: SID,
    payload: {
      type: "message.updated",
      event: { properties: { info: { id, sessionID: SID, role, time: { created, completed } } } },
    },
  })

  return [
    { kind: "chat.message", sessionID: SID, payload: { messageID: round.userMsgId, text: round.userText } },
    message(round.userMsgId, "user", round.createdAt),
    part(round.userMsgId, round.userPartId, "text", round.userText),
    message(round.assistantMsgId, "assistant", round.createdAt + 20, round.createdAt + 9000),
    part(round.assistantMsgId, round.assistantPartId, "text", round.assistantText.slice(0, 4)),
    // 流式终稿：uploader 必须优先用它，而不是 message.part.updated 里的半截文本
    {
      kind: "text.complete",
      sessionID: SID,
      payload: { messageID: round.assistantMsgId, partID: round.assistantPartId, text: round.assistantText },
    },
  ]
}

const TWO_ROUND_RECORDS = [
  {
    kind: "event",
    sessionID: SID,
    payload: { type: "session.created", event: { properties: { sessionID: SID, info: { id: SID } } } },
  },
  ...roundRecords({
    userMsgId: "msg_u1",
    userPartId: "prt_u1",
    userText: "你能做什么？",
    assistantMsgId: "msg_a1",
    assistantPartId: "prt_a1",
    assistantText: "软件工程：代码编写、调试、重构、测试",
    createdAt: 1_785_135_600_000,
  }),
  ...roundRecords({
    userMsgId: "msg_u2",
    userPartId: "prt_u2",
    userText: "今天星期几？",
    assistantMsgId: "msg_a2",
    assistantPartId: "prt_a2",
    assistantText: "星期一",
    createdAt: 1_785_135_637_000,
  }),
]

test("opencode 上报 payload：多轮交互一轮都不能少", async () => {
  const { buildState, mergeGraph, deriveFields } = await import("../scripts/opencode_uploader_client.js")

  const interactions = mergeGraph(buildState(TWO_ROUND_RECORDS), SID)
  const conversation = interactions.filter((m: any) => m.role === "user" || m.role === "assistant")

  assert.deepEqual(
    conversation.map((m: any) => m.role),
    ["user", "assistant", "user", "assistant"],
    "两轮对话应产出 user/assistant/user/assistant 四条 interaction",
  )
  assert.deepEqual(
    conversation.map((m: any) => m.content),
    ["你能做什么？", "软件工程：代码编写、调试、重构、测试", "今天星期几？", "星期一"],
    "每一轮的提问与终稿正文都必须原样带上（终稿取 text.complete，不是流式半截）",
  )

  const derived = deriveFields(interactions)
  assert.equal(derived.final_result, "星期一", "final_result 应是最后一轮的助手终稿")
  assert.equal(derived.llm_call_count, 2, "两轮助手回复应计 2 次 LLM 调用")
})

// ── openclaw 桥接：这条路会丢正文，把它固化成用例 ──────────────────────────────

test("openclaw 桥接：整包 record 只留 query/final_result，interactions 会被丢掉", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bridge-"))
  const previous = process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR
  process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR = dir
  try {
    const { POST } = await import("@/app/api/ingest/openclaw/upload/route")
    const taskId = "ses_bridge_contract"
    const response = await POST(new Request("http://localhost/api/ingest/openclaw/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task_id: taskId,
        framework: "openclaw",
        query: "你能做什么？",
        final_result: "星期一",
        model: "GLM-5",
        tokens: 100,
        skills: ["demo-skill"],
        interactions: [
          { role: "user", content: "你能做什么？" },
          { role: "assistant", content: "软件工程：代码编写、调试、重构、测试" },
          { role: "user", content: "今天星期几？" },
          { role: "assistant", content: "星期一" },
        ],
      }),
    }))

    assert.equal(response.status, 200)
    const events = readOtelTraceEventsForSession(taskId, dir)

    // 1 条 llm span + 每个 skill 一条 tool span——**不是**每轮对话一条
    assert.deepEqual(events.map(e => e.kind), ["llm", "tool"])
    assert.ok(events.every(e => e.serviceName === "openclaw"), "桥接产物一律标记为 openclaw")
    assert.equal(events[0].attributes?.["gen_ai.prompt"], "你能做什么？")
    assert.equal(events[0].attributes?.["gen_ai.completion"], "星期一")

    // 这是本条用例的重点：中间两轮正文在产物里找不到。
    // 桥接是给 openclaw watcher 的有损转换，任何带完整 interactions 的上报都不该走这里，
    // 该走 /api/ingest/upload（见 ingest-endpoint-contract）。
    const serialized = JSON.stringify(events)
    assert.ok(
      !serialized.includes("软件工程：代码编写、调试、重构、测试"),
      "如果这条断言开始失败，说明桥接已经保留正文了——好事，但要连同注释和端点契约一起复核",
    )
    assert.equal(events[0].usage?.input_tokens, 50, "tokens 被对半劈成 input/output，不是真实分布")
    assert.equal(events[0].usage?.output_tokens, 50)
  } finally {
    if (previous === undefined) delete process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR
    else process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
