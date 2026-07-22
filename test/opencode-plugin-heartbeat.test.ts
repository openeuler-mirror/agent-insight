import assert from "node:assert/strict"
import test from "node:test"

import { computeHeartbeatDecision } from "../scripts/opencode_plugin_otel"

const HB = 60_000

test("plugin heartbeat: 会话第一个事件只起表，不算一次上报", () => {
  assert.equal(
    computeHeartbeatDecision({ now: 1_000_000, heartbeatMs: HB, lastKickAt: 0, heartbeatClockAt: 0 }),
    "start-clock",
  )
})

// 回归护栏（真实事故）：曾经把心跳的计时起点写进 kickUploader 的节流表，
// 等于伪造一次"刚上报过"。结果 15 秒内做完的短任务，其 session.idle 上报被
// 冷却期吞掉，整条 trace 一次都不上报。
// 起表这一步必须是 "start-clock" —— 一个明确区别于 "kick" 的动作，
// 调用方据此只写心跳自己的时钟。
test("plugin heartbeat: 起表动作与真实上报动作必须可区分", () => {
  const decision = computeHeartbeatDecision({ now: 1_000_000, heartbeatMs: HB })
  assert.notEqual(decision, "kick", "起表绝不能被当成一次真实上报，否则会污染节流时间线")
  assert.equal(decision, "start-clock")
})

test("plugin heartbeat: 未到间隔不触发", () => {
  assert.equal(
    computeHeartbeatDecision({
      now: 1_000_000 + HB - 1,
      heartbeatMs: HB,
      heartbeatClockAt: 1_000_000,
    }),
    "none",
  )
})

test("plugin heartbeat: 到达间隔触发", () => {
  assert.equal(
    computeHeartbeatDecision({
      now: 1_000_000 + HB,
      heartbeatMs: HB,
      heartbeatClockAt: 1_000_000,
    }),
    "kick",
  )
})

test("plugin heartbeat: 真实 kick 时间优先于心跳时钟，避免与 idle 触发叠加", () => {
  // idle 刚上报过（lastKickAt 更新），即使心跳时钟很旧也不该马上再推一次
  assert.equal(
    computeHeartbeatDecision({
      now: 1_000_000 + HB,
      heartbeatMs: HB,
      lastKickAt: 1_000_000 + HB - 1,
      heartbeatClockAt: 1,
    }),
    "none",
  )
})

test("plugin heartbeat: heartbeatMs<=0 完全关闭", () => {
  for (const heartbeatMs of [0, -1, Number.NaN]) {
    assert.equal(
      computeHeartbeatDecision({ now: 9_999_999, heartbeatMs, heartbeatClockAt: 1 }),
      "none",
      `heartbeatMs=${heartbeatMs} 应关闭心跳`,
    )
  }
})
