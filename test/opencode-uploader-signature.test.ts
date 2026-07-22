import assert from "node:assert/strict"
import test from "node:test"

process.env.AGENT_INSIGHT_UPLOADER_NO_MAIN = "1"

const uploaderPromise = import("../scripts/opencode_uploader_client.js")

// 工具死循环的最小复现：同一条 assistant message 内不断追加 tool part。
// 消息条数、终稿文本、message 时间戳全程不变——这正是旧 sig 的全部组成。
function loopRecords(toolCallCount: number) {
  const records: any[] = [
    {
      kind: "event",
      sessionID: "ses_root",
      payload: {
        type: "message.updated",
        event: {
          properties: {
            info: {
              id: "msg_1",
              sessionID: "ses_root",
              role: "assistant",
              time: { created: 1000, completed: 2000 },
            },
          },
        },
      },
    },
  ]
  for (let i = 0; i < toolCallCount; i++) {
    records.push({
      kind: "event",
      sessionID: "ses_root",
      payload: {
        type: "message.part.updated",
        event: {
          properties: {
            messageID: "msg_1",
            sessionID: "ses_root",
            part: {
              id: `prt_${i}`,
              type: "tool",
              tool: "bash",
              callID: `call_${i}`,
              state: { status: "completed", input: { cmd: "echo loop" } },
            },
          },
        },
      },
    })
  }
  return records
}

async function signatureFor(toolCallCount: number) {
  const uploader: any = await uploaderPromise
  const state = uploader.buildState(loopRecords(toolCallCount))
  const interactions = uploader.mergeGraph(state, "ses_root")
  const derived = uploader.deriveFields(interactions)
  return {
    sig: uploader.buildSignature({
      interactionCount: interactions.length,
      finalResultLength: String(derived.final_result || "").length,
      lastTs: 2000,
      traceCompletedAt: "",
      cliCompleted: false,
      toolCallCount: derived.tool_call_count,
      tokens: derived.tokens,
      recordCount: uploader.subtreeRecordCount(state, "ses_root"),
    }),
    interactions,
    derived,
  }
}

test("opencode uploader: 工具循环推进时 sig 必须变化（否则整个循环期间都被 checkpoint skip）", async () => {
  const round1 = await signatureFor(3)
  const round2 = await signatureFor(7)

  // 旧 sig 的五个组成部分全都没变 —— 这就是死循环上不去的根因
  assert.equal(round1.interactions.length, round2.interactions.length)
  assert.equal(
    String(round1.derived.final_result || "").length,
    String(round2.derived.final_result || "").length,
  )
  const legacySig1 = round1.sig.split("|").slice(0, 5).join("|")
  const legacySig2 = round2.sig.split("|").slice(0, 5).join("|")
  assert.equal(legacySig1, legacySig2, "前提假设：旧格式 sig 在工具循环下确实不变")

  // 新 sig 必须能分辨出来
  assert.notEqual(round1.sig, round2.sig)
  const uploader: any = await uploaderPromise
  assert.equal(uploader.isSignatureUnchanged(round1.sig, round2.sig), false)
})

test("opencode uploader: sig 未推进时仍然判为未变化（去重不能失效）", async () => {
  const uploader: any = await uploaderPromise
  const a = await signatureFor(3)
  const b = await signatureFor(3)
  assert.equal(a.sig, b.sig)
  assert.equal(uploader.isSignatureUnchanged(a.sig, b.sig), true)
})

test("opencode uploader: 旧 5 段式 checkpoint 不触发全量重传", async () => {
  const uploader: any = await uploaderPromise
  const { sig } = await signatureFor(3)
  const legacySig = sig.split("|").slice(0, 5).join("|")

  // 升级后第一次扫描：老 checkpoint 只要前 5 段对得上，就视为未变化，
  // 避免把 spool 保留期内的历史会话全部重传 + 触发一轮 LLM 分析风暴。
  assert.equal(uploader.isSignatureUnchanged(legacySig, sig), true)

  // 老格式的前 5 段在工具循环下恒定不变，所以升级后的第一轮扫描仍然判为"未变化"。
  // 这不会让循环中的会话永久卡住：main() 命中这条分支时会把 checkpoint 原地升级成
  // 新格式，下一轮 recordCount/toolCallCount 已推进就会放行，代价只有一个心跳周期。
  const advanced = (await signatureFor(9)).sig
  assert.equal(uploader.isSignatureUnchanged(legacySig, advanced), true)
  assert.equal(uploader.isSignatureUnchanged(sig, advanced), false, "升级成新格式后必须立刻能分辨")

  assert.equal(uploader.isSignatureUnchanged("", sig), false)
})

test("opencode uploader: 子会话的记录数计入 root 的 sig", async () => {
  const uploader: any = await uploaderPromise
  const records = [
    ...loopRecords(1),
    {
      kind: "event",
      sessionID: "ses_child",
      payload: {
        type: "session.created",
        event: { properties: { info: { id: "ses_child", parentID: "ses_root", agent: "worker" } } },
      },
    },
    { kind: "chat.message", sessionID: "ses_child", payload: { messageID: "msg_c", text: "hi" } },
  ]
  const state = uploader.buildState(records)

  assert.deepEqual(uploader.collectSessionSubtree(state, "ses_root").sort(), ["ses_child", "ses_root"])
  assert.equal(
    uploader.subtreeRecordCount(state, "ses_root"),
    uploader.subtreeRecordCount(state, "ses_child") + 2,
    "root 自身 2 条（message.updated + 1 个 tool part）+ 子会话全部",
  )
})
