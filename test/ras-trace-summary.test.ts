import assert from "node:assert/strict"
import test from "node:test"

import {
  isAgentModePreamble,
  pickFiUserQuery,
  pickReliabilityTraceSummary,
} from "@/lib/ingest/ras/trace-summary"

test("isAgentModePreamble detects OpenCode mode headers", () => {
  assert.equal(isAgentModePreamble("[search-mode]\nMAXIMIZE SEARCH"), true)
  assert.equal(isAgentModePreamble("[analyze-mode]\nANALYSIS MODE"), true)
  assert.equal(isAgentModePreamble("使用 thinking-dead-loop 技能"), false)
})

test("pickReliabilityTraceSummary prefers session label over mode query", () => {
  const summary = pickReliabilityTraceSummary({
    anomalySummary: null,
    executionQuery:
      "[search-mode]\nMAXIMIZE SEARCH EFFORT. Launch multiple background agents",
    sessionLabel: "thinking-dead-loop-v0",
  })
  assert.equal(summary, "thinking-dead-loop-v0")
})

test("pickReliabilityTraceSummary keeps real FI query", () => {
  const summary = pickReliabilityTraceSummary({
    executionQuery: "使用 thinking-dead-loop 技能，执行逻辑死循环。",
    sessionLabel: "thinking-dead-loop-v0",
  })
  assert.equal(summary, "使用 thinking-dead-loop 技能，执行逻辑死循环。")
})

test("pickFiUserQuery skips mode preamble user turns", () => {
  const q = pickFiUserQuery(
    [
      { role: "user", content: "[search-mode]\nMAXIMIZE SEARCH EFFORT" },
      { role: "user", content: "使用 thinking-dead-loop 技能，执行场景2" },
    ],
    "thinking-dead-loop",
  )
  assert.match(q, /thinking-dead-loop/)
})

test("pickFiUserQuery falls back to FI fault name", () => {
  const q = pickFiUserQuery(
    [{ role: "user", content: "[analyze-mode]\nANALYSIS MODE only" }],
    "thinking-dead-loop",
  )
  assert.equal(q, "FI thinking-dead-loop")
})
