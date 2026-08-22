import assert from "node:assert/strict"
import test from "node:test"

import {
  aggregateFleetReliability,
  type ReliabilityEventRow,
  type ReliabilityExecutionRow,
} from "@/lib/fleet/reliability"

const hour = 3_600_000
const start = new Date("2026-08-20T08:00:00.000Z").getTime()

function execution(overrides: Partial<ReliabilityExecutionRow> & { id: string }): ReliabilityExecutionRow {
  return {
    id: overrides.id,
    taskId: overrides.taskId ?? overrides.id,
    timestamp: overrides.timestamp ?? new Date(start),
    framework: overrides.framework ?? "opencode",
    agentName: overrides.agentName ?? "agent-a",
    query: overrides.query ?? "task",
    toolCallErrorCount: overrides.toolCallErrorCount ?? 0,
    failures: overrides.failures ?? null,
    callStats: overrides.callStats ?? null,
  }
}

function event(overrides: Partial<ReliabilityEventRow> & Pick<ReliabilityEventRow, "id" | "deliveryId" | "taskId" | "type">): ReliabilityEventRow {
  return {
    id: overrides.id,
    deliveryId: overrides.deliveryId,
    taskId: overrides.taskId,
    type: overrides.type,
    platform: overrides.platform ?? null,
    framework: overrides.framework ?? null,
    anomalyKind: overrides.anomalyKind ?? null,
    severity: overrides.severity ?? null,
    summary: overrides.summary ?? null,
    actionTypes: overrides.actionTypes ?? null,
    payloadJson: overrides.payloadJson ?? "{}",
    ts: overrides.ts ?? new Date(start),
  }
}

const callStats = JSON.stringify({
  v: 1,
  steps: 1,
  llm: {},
  tool: {},
  errTypes: { "超时": 2, "judge:answer_error": 1 },
})

test("aggregateFleetReliability separates RAS reliability from Execution failures", () => {
  const rows = [
    execution({ id: "normal", taskId: "normal", agentName: "agent-a" }),
    execution({ id: "recovered", taskId: "recovered", agentName: "agent-b", framework: "claude" }),
    execution({ id: "unrecovered", taskId: "unrecovered", timestamp: new Date(start + hour), toolCallErrorCount: 1, callStats }),
    execution({ id: "execution-only-failure", taskId: "execution-only-failure", toolCallErrorCount: 1 }),
  ]
  const events = [
    event({ id: "a1", deliveryId: "a1", taskId: "recovered", type: "anomaly", platform: "claude", anomalyKind: "loop", severity: "medium" }),
    event({ id: "a2", deliveryId: "a2", taskId: "recovered", type: "actions", actionTypes: "abort_stream" }),
    event({ id: "a3", deliveryId: "a3", taskId: "recovered", type: "action_result", payloadJson: JSON.stringify({ ok: true }), ts: new Date(start + 1000) }),
    event({ id: "a3-copy", deliveryId: "a3", taskId: "recovered", type: "action_result", payloadJson: JSON.stringify({ ok: false }), ts: new Date(start + 2000) }),
    event({ id: "b1", deliveryId: "b1", taskId: "unrecovered", type: "anomaly", anomalyKind: "tool_repeat", severity: "low", ts: new Date(start + hour) }),
    event({ id: "b2", deliveryId: "b2", taskId: "unrecovered", type: "anomaly", anomalyKind: "tool_repeat", severity: "critical", ts: new Date(start + hour + 1000) }),
  ]

  const data = aggregateFleetReliability({
    rows,
    events,
    starts: [start, start + hour],
    plan: { gran: "hour", count: 2, step: hour },
  })

  assert.deepEqual(data.kpi, {
    totalTraces: 4,
    faultTraces: 2,
    faultRate: 50,
    recoveredTraces: 1,
    recoveryRate: 50,
    unrecoveredTraces: 1,
  })
  assert.deepEqual(data.trend.map(({ faults, recovered }) => ({ faults, recovered })), [
    { faults: 1, recovered: 1 },
    { faults: 1, recovered: 0 },
  ])
  assert.equal(data.severity.find((item) => item.key === "normal")?.count, 2)
  assert.equal(data.severity.find((item) => item.key === "medium")?.count, 1)
  assert.equal(data.severity.find((item) => item.key === "critical")?.count, 1)
  assert.equal(data.failureSupplement.failAgents.find((item) => item.name === "agent-a")?.fail, 2)
  assert.deepEqual(data.failureSupplement.errTypes.tool, [{ label: "超时", count: 2 }])
  assert.deepEqual(data.failureSupplement.errTypes.judge, [{ label: "answer_error", count: 1 }])
  assert.deepEqual(data.recentFaultTraces.map((item) => item.recoveryStatus), ["unrecovered", "recovered"])
})

test("aggregateFleetReliability applies platform and agent filters before all panels", () => {
  const rows = [
    execution({ id: "t1", taskId: "t1", agentName: "alpha", framework: "opencode" }),
    execution({ id: "t2", taskId: "t2", agentName: "beta", framework: "claude" }),
  ]
  const events = [
    event({ id: "e1", deliveryId: "e1", taskId: "t1", type: "anomaly", anomalyKind: "loop", severity: null }),
    event({ id: "e2", deliveryId: "e2", taskId: "t2", type: "anomaly", platform: "claude", anomalyKind: "timeout", severity: "high" }),
  ]

  const unfiltered = aggregateFleetReliability({
    rows, events, starts: [start],
    plan: { gran: "hour", count: 1, step: hour },
  })
  assert.equal(unfiltered.severity.find((item) => item.key === "unlabeled")?.count, 1)

  const data = aggregateFleetReliability({
    rows,
    events,
    starts: [start],
    plan: { gran: "hour", count: 1, step: hour },
    platform: "claude",
    agent: "beta",
  })

  assert.deepEqual(data.filters.platforms, ["claude", "opencode"])
  assert.deepEqual(data.filters.agents, ["beta"])
  assert.equal(data.kpi.totalTraces, 1)
  assert.equal(data.kpi.faultTraces, 1)
  assert.equal(data.severity.find((item) => item.key === "high")?.count, 1)
  assert.deepEqual(data.recentFaultTraces.map((item) => item.taskId), ["t2"])
})

test("trace without RAS events is no-fault even when anomaly status would be unknown", () => {
  const data = aggregateFleetReliability({
    rows: [execution({ id: "unknown-status" })],
    events: [],
    starts: [start],
    plan: { gran: "hour", count: 1, step: hour },
  })

  assert.equal(data.kpi.faultTraces, 0)
  assert.equal(data.kpi.faultRate, 0)
  assert.equal(data.severity.find((item) => item.key === "normal")?.count, 1)
  assert.deepEqual(data.recentFaultTraces, [])
})
