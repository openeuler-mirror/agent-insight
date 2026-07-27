import assert from "node:assert/strict"
import test from "node:test"

import { buildAgentCallTree, firstMeaningfulLine } from "../src/lib/engine/observability/agent-trace"

/**
 * 时间线上「LLM 图标后面一片空白，右侧详情却有完整 think + response」的回归看护。
 *
 * 根因是标签取 `summary.split('\n')[0]`：推理模型在 thinking 结束后普遍先吐 `\n\n`
 * 再出正文，首行就是空串；而 summary 整体非空、走不到调用方的 'LLM' 兜底，于是渲染
 * 出一个空标签。右侧拿的是全文，所以看起来「有些显示有些不显示」。
 */

test("firstMeaningfulLine: 跳过前导空行，取第一条有内容的行", () => {
  assert.equal(firstMeaningfulLine("\n\n你好！请问有什么问题我可以帮助你的？"), "你好！请问有什么问题我可以帮助你的？")
  assert.equal(firstMeaningfulLine("第一行\n第二行"), "第一行")
  assert.equal(firstMeaningfulLine("   \n\t\n  正文  \n后面"), "正文")
})

test("firstMeaningfulLine: 全空白与缺省返回空串（让调用方用兜底文案）", () => {
  assert.equal(firstMeaningfulLine("\n\n   \n\t"), "")
  assert.equal(firstMeaningfulLine(""), "")
  assert.equal(firstMeaningfulLine(undefined), "")
})

test("firstMeaningfulLine: 按字符数截断", () => {
  assert.equal(firstMeaningfulLine("a".repeat(80)), "a".repeat(60))
  assert.equal(firstMeaningfulLine("abcdef", 3), "abc")
})

// 真实上报形态：Qwen3.5 经 opencode 上报，reasoning 结束后 text part 以 "\n\n" 开头
test("以换行开头的 LLM 回复必须给出非空标签", () => {
  const tree = buildAgentCallTree([
    {
      role: "user",
      content: "你好，我有个问题想问你",
      timestamp: "2026-07-27T09:47:04.174Z",
      parts: [{ id: "prt_u", type: "text", text: "你好，我有个问题想问你" }],
    },
    {
      role: "assistant",
      content: "\n\n你好！请问有什么问题我可以帮助你的？",
      timestamp: "2026-07-27T09:47:04.185Z",
      agent: "build",
      parts: [
        { id: "prt_s", type: "step-start" },
        { id: "prt_r", type: "reasoning", text: "用户打招呼并说有问题想问，我应该友好地回应。\n" },
        { id: "prt_t", type: "text", text: "\n\n你好！请问有什么问题我可以帮助你的？" },
      ],
    },
  ] as any)

  assert.ok(tree)
  const llm = tree.events.find((e) => e.kind === "llm")
  assert.ok(llm, "assistant 轮必须产出 llm 事件")
  assert.ok(llm.summary?.startsWith("\n"), "前提：这类正文确实以换行开头")

  // 时间线标签：不能是空串，否则图标后面一片空白
  const label = firstMeaningfulLine(llm.summary) || "LLM"
  assert.equal(label, "你好！请问有什么问题我可以帮助你的？")
  assert.notEqual(label.trim(), "")
})
