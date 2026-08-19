import assert from "node:assert/strict"
import test from "node:test"

import { rasRecoveryPipelineLabel } from "@/lib/ingest/ras/normalize"
import {
  buildRasTaskSummaries,
  deriveTraceLifecycle,
} from "@/lib/ingest/ras/store"

const ts = new Date("2026-07-30T10:00:00.000Z")

test("buildRasTaskSummaries: abort + action_result ok → recovery success", () => {
  const byTask = buildRasTaskSummaries([
    {
      taskId: "t1",
      type: "anomaly",
      anomalyKind: "llm_thinking_dead_loop",
      severity: "high",
      summary: "loop",
      actionTypes: null,
      payloadJson: JSON.stringify({ evidence: { detection_level: "L1" } }),
      ts,
    },
    {
      taskId: "t1",
      type: "actions",
      anomalyKind: null,
      severity: null,
      summary: null,
      actionTypes: "abort_stream,push_steering",
      payloadJson: JSON.stringify({ actions: [{ type: "abort_stream" }] }),
      ts,
    },
    {
      taskId: "t1",
      type: "action_result",
      anomalyKind: null,
      severity: null,
      summary: "abort_stream succeeded",
      actionTypes: "abort_stream",
      payloadJson: JSON.stringify({ action: "abort_stream", ok: true }),
      ts,
    },
  ])
  const s = byTask.t1
  assert.equal(s.hasFault, true)
  assert.equal(s.recoveryStarted, true)
  assert.equal(s.recoveryOutcome, "success")
  assert.equal(s.abortedStream, true)
  assert.equal(s.detectionLevel, "L1")
})

test("buildRasTaskSummaries: abort without action_result → recovery unknown", () => {
  const byTask = buildRasTaskSummaries([
    {
      taskId: "t2",
      type: "anomaly",
      anomalyKind: "llm_thinking_dead_loop",
      severity: "medium",
      summary: "loop",
      actionTypes: null,
      payloadJson: "{}",
      ts,
    },
    {
      taskId: "t2",
      type: "actions",
      anomalyKind: null,
      severity: null,
      summary: null,
      actionTypes: "abort_stream",
      payloadJson: "{}",
      ts,
    },
  ])
  assert.equal(byTask.t2.recoveryOutcome, "unknown")
  assert.equal(byTask.t2.abortedStream, true)
})

test("buildRasTaskSummaries: no fault → recovery none", () => {
  const byTask = buildRasTaskSummaries([])
  assert.deepEqual(byTask, {})
})

test("buildRasTaskSummaries: action_result ok=false → recovery failed", () => {
  const byTask = buildRasTaskSummaries([
    {
      taskId: "t3",
      type: "anomaly",
      anomalyKind: "repeat_tool_call",
      severity: "medium",
      summary: "repeat",
      actionTypes: null,
      payloadJson: "{}",
      ts,
    },
    {
      taskId: "t3",
      type: "actions",
      anomalyKind: null,
      severity: null,
      summary: null,
      actionTypes: "emit_notice",
      payloadJson: "{}",
      ts,
    },
    {
      taskId: "t3",
      type: "action_result",
      anomalyKind: null,
      severity: null,
      summary: null,
      actionTypes: "emit_notice",
      payloadJson: JSON.stringify({ action: "emit_notice", ok: false }),
      ts,
    },
  ])
  assert.equal(byTask.t3.recoveryOutcome, "failed")
  assert.equal(byTask.t3.abortedStream, false)
})

test("deriveTraceLifecycle: completedAt → success (ignore failures/finalResult)", () => {
  const life = deriveTraceLifecycle({
    completedAt: "2026-07-30T10:01:00.000Z",
  })
  assert.equal(life.traceStatus, "success")
  assert.equal(life.traceStatusReason, "session-ended")
})

test("deriveTraceLifecycle: no completedAt → running", () => {
  const life = deriveTraceLifecycle({
    completedAt: null,
  })
  assert.equal(life.traceStatus, "running")
  assert.equal(life.traceStatusReason, "missing-completion-signal")
})

test("rasRecoveryPipelineLabel: recovered with abort hint", () => {
  const label = rasRecoveryPipelineLabel({
    hasFault: true,
    recoveryStarted: true,
    recoveryOutcome: "success",
    abortedStream: true,
    locale: "zh",
  })
  assert.equal(label.label, "有故障 · 已启动 · 恢复成功")
  assert.equal(label.hint, "含流中断动作")
  assert.equal(label.badgeStatus, "success")
})

test("combined: abort recovered + session ended → success lifecycle + success recovery", () => {
  const summary = buildRasTaskSummaries([
    {
      taskId: "t4",
      type: "anomaly",
      anomalyKind: "llm_thinking_dead_loop",
      severity: "high",
      summary: "loop",
      actionTypes: null,
      payloadJson: "{}",
      ts,
    },
    {
      taskId: "t4",
      type: "actions",
      anomalyKind: null,
      severity: null,
      summary: null,
      actionTypes: "abort_stream",
      payloadJson: "{}",
      ts,
    },
    {
      taskId: "t4",
      type: "action_result",
      anomalyKind: null,
      severity: null,
      summary: null,
      actionTypes: "abort_stream",
      payloadJson: JSON.stringify({ ok: true }),
      ts,
    },
  ]).t4
  const life = deriveTraceLifecycle({
    completedAt: "2026-07-30T11:00:00.000Z",
  })
  assert.equal(summary.abortedStream, true)
  assert.equal(summary.recoveryOutcome, "success")
  assert.equal(life.traceStatus, "success")
})
