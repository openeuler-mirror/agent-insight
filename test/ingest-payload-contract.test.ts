import test from "node:test"
import assert from "node:assert/strict"

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

// ── openclaw watcher：新旧地址都复用通用无损上传语义 ─────────────────────────

test("openclaw 兼容入口原样委托通用 upload，并复用 400/401 身份错误", async () => {
  const [{ POST: legacyPost }, { POST: canonicalPost }] = await Promise.all([
    import("@/app/api/ingest/openclaw/upload/route"),
    import("@/app/api/ingest/upload/route"),
  ])
  assert.equal(legacyPost, canonicalPost, "兼容入口必须直接复用 canonical handler，不能再转换 record")

  const previousDefaultUser = process.env.AGENT_INSIGHT_DEFAULT_INGEST_USER
  process.env.AGENT_INSIGHT_DEFAULT_INGEST_USER = ""
  try {
    const record = {
      task_id: "ses_bridge_contract",
      framework: "openclaw",
      query: "你能做什么？",
      final_result: "星期一",
      interactions: [
        { role: "user", content: "你能做什么？" },
        { role: "assistant", content: "软件工程：代码编写、调试、重构、测试" },
        { role: "user", content: "今天星期几？" },
        { role: "assistant", content: "星期一" },
      ],
    }
    const missingIdentity = await legacyPost(new Request("http://localhost/api/ingest/openclaw/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(record),
    }))
    assert.equal(missingIdentity.status, 400)

    const invalidKey = await legacyPost(new Request("http://localhost/api/ingest/openclaw/upload", {
      method: "POST",
      headers: { "content-type": "application/json", "x-witty-api-key": "invalid-openclaw-contract-key" },
      body: JSON.stringify({ ...record, user: "untrusted-user" }),
    }))
    assert.equal(invalidKey.status, 401)
  } finally {
    if (previousDefaultUser === undefined) delete process.env.AGENT_INSIGHT_DEFAULT_INGEST_USER
    else process.env.AGENT_INSIGHT_DEFAULT_INGEST_USER = previousDefaultUser
  }
})
