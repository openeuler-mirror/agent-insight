import assert from "node:assert/strict"
import test from "node:test"

import { isInProgressOpencodeSnapshot } from "../src/app/api/ingest/upload/route"

// 回归护栏：这个门曾经用 opencode_cli_completed 判定，导致正常交互式使用（CLI 一直开着）
// 的每一条 trace 都被当成"进行中"，评分/诊断/流程图要等用户退出 opencode 才出。
test("upload: 本轮已结束的快照必须跑完整分析（CLI 未退出也一样）", () => {
  assert.equal(
    isInProgressOpencodeSnapshot({
      framework: "opencode",
      trace_completed_at: "2026-07-22T07:30:05.000Z",
      opencode_cli_completed: false,
    }),
    false,
    "有 trace_completed_at 就说明本轮跑完了，不能因为 CLI 还开着就跳过分析",
  )
})

test("upload: CLI 已退出的快照跑完整分析", () => {
  assert.equal(
    isInProgressOpencodeSnapshot({
      framework: "opencode",
      opencode_cli_completed: true,
    }),
    false,
  )
})

test("upload: 无终稿且未 idle 的心跳快照走轻通道", () => {
  assert.equal(
    isInProgressOpencodeSnapshot({
      framework: "opencode",
      trace_completed_at: undefined,
      opencode_cli_completed: false,
    }),
    true,
  )
  // 空串 / 纯空白不算完成信号
  assert.equal(isInProgressOpencodeSnapshot({ framework: "opencode", trace_completed_at: "   " }), true)
})

test("upload: 非 opencode 框架永远不走轻通道", () => {
  for (const framework of ["claudecode", "jiuwenswarm", "langfuse", "hermes", undefined]) {
    assert.equal(
      isInProgressOpencodeSnapshot({ framework, opencode_cli_completed: false }),
      false,
      `${framework} 不应受 opencode 轻通道影响`,
    )
  }
})
