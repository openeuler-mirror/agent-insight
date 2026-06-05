import assert from "node:assert/strict"
import test from "node:test"

import {
  classifyEndReason,
  resolveMaxTimeoutRetries,
  retryOnTimeout,
  type TriggerEndReason,
} from "@/lib/engine/skill-generation/evaluator/runners/triggerEvalRetry"

// =========================================================================
// classifyEndReason —— 结束原因优先级：命中 > 报错 > 超时 > 自然跑完
// =========================================================================

test("classifyEndReason: 命中目标 skill → triggered", () => {
  assert.equal(classifyEndReason({ triggered: true, timedOut: false }), "triggered")
})

test("classifyEndReason: 命中优先于一切（即便同时超时/报错）", () => {
  // 命中后我们主动 abort，timer 可能也恰好触发——命中必须压过 timeout/error
  assert.equal(
    classifyEndReason({ triggered: true, timedOut: true, sessionError: "boom" }),
    "triggered",
  )
})

test("classifyEndReason: 有 session.error 且没命中 → error（即便也超时）", () => {
  assert.equal(classifyEndReason({ triggered: false, timedOut: true, sessionError: "boom" }), "error")
})

test("classifyEndReason: 超时被掐断、无报错、没命中 → timeout", () => {
  assert.equal(classifyEndReason({ triggered: false, timedOut: true }), "timeout")
})

test("classifyEndReason: 跑到自然 idle 没命中 → completed（真实'没触发'）", () => {
  assert.equal(classifyEndReason({ triggered: false, timedOut: false }), "completed")
})

// =========================================================================
// resolveMaxTimeoutRetries —— 默认 2，env 可覆盖，clamp 到 [0,5]
// =========================================================================

test("resolveMaxTimeoutRetries: 未设置 → 默认 2", () => {
  assert.equal(resolveMaxTimeoutRetries(undefined), 2)
})

test("resolveMaxTimeoutRetries: 显式 0 → 0（关闭重试）", () => {
  assert.equal(resolveMaxTimeoutRetries("0"), 0)
})

test("resolveMaxTimeoutRetries: 超上限 clamp 到 5", () => {
  assert.equal(resolveMaxTimeoutRetries("99"), 5)
})

test("resolveMaxTimeoutRetries: 负数 clamp 到 0", () => {
  assert.equal(resolveMaxTimeoutRetries("-3"), 0)
})

test("resolveMaxTimeoutRetries: 非数字 → 回退默认 2", () => {
  assert.equal(resolveMaxTimeoutRetries("abc"), 2)
})

// =========================================================================
// retryOnTimeout —— 只重试 timeout，外部终止即停，返回 attempts
// =========================================================================

/** 造一个按脚本依次返回不同 endReason 的 runOnce，并记录被调用次数。 */
function scriptedRunner(reasons: TriggerEndReason[]) {
  let calls = 0
  const runOnce = async () => {
    const reason = reasons[Math.min(calls, reasons.length - 1)]
    calls++
    return { endReason: reason, tag: `run-${calls}` }
  }
  return { runOnce, calls: () => calls }
}

test("retryOnTimeout: 首跑就非超时 → attempts=1，不重试", async () => {
  const { runOnce, calls } = scriptedRunner(["completed"])
  const r = await retryOnTimeout(runOnce, { maxRetries: 2 })
  assert.equal(r.attempts, 1)
  assert.equal(calls(), 1)
  assert.equal(r.endReason, "completed")
})

test("retryOnTimeout: 超时后命中 → attempts=2，跑两次，末次结果是命中", async () => {
  const { runOnce, calls } = scriptedRunner(["timeout", "triggered"])
  const r = await retryOnTimeout(runOnce, { maxRetries: 2 })
  assert.equal(r.attempts, 2)
  assert.equal(calls(), 2)
  assert.equal(r.endReason, "triggered")
})

test("retryOnTimeout: 一直超时、maxRetries=2 → 共 3 次尝试（1 初 + 2 重试）", async () => {
  const { runOnce, calls } = scriptedRunner(["timeout"])
  const r = await retryOnTimeout(runOnce, { maxRetries: 2 })
  assert.equal(r.attempts, 3)
  assert.equal(calls(), 3)
  assert.equal(r.endReason, "timeout")
})

test("retryOnTimeout: maxRetries=0 → 即便超时也只跑一次", async () => {
  const { runOnce, calls } = scriptedRunner(["timeout"])
  const r = await retryOnTimeout(runOnce, { maxRetries: 0 })
  assert.equal(r.attempts, 1)
  assert.equal(calls(), 1)
})

test("retryOnTimeout: 外部已终止 → 超时也不重试", async () => {
  const { runOnce, calls } = scriptedRunner(["timeout"])
  const r = await retryOnTimeout(runOnce, { maxRetries: 2, isAborted: () => true })
  assert.equal(r.attempts, 1)
  assert.equal(calls(), 1)
})

test("retryOnTimeout: 不重试 error（配置类硬错，重试是同样的错）", async () => {
  const { runOnce, calls } = scriptedRunner(["error"])
  const r = await retryOnTimeout(runOnce, { maxRetries: 2 })
  assert.equal(r.attempts, 1)
  assert.equal(calls(), 1)
  assert.equal(r.endReason, "error")
})

test("retryOnTimeout: onRetry 按即将开始的第 N 次重试回调", async () => {
  const { runOnce } = scriptedRunner(["timeout"])
  const seen: number[] = []
  await retryOnTimeout(runOnce, { maxRetries: 2, onRetry: a => seen.push(a) })
  assert.deepEqual(seen, [1, 2])
})
