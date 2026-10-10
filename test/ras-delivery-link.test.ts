import assert from "node:assert/strict"
import test from "node:test"

import {
  buildRasDeliveryLinks,
  interleaveRasActions,
  normalizeRasDeliveryText,
} from "@/lib/ingest/ras/delivery-link"
import { buildRasTraceMarkers, findRasMarkersForEvent } from "@/lib/ingest/ras/trace-markers"
import type { AgentEvent, RawInteraction } from "@/lib/engine/observability/agent-trace"

test("normalizeRasDeliveryText strips system-reminder envelope", () => {
  assert.equal(
    normalizeRasDeliveryText("<system-reminder>\n  steer me  \n</system-reminder>"),
    "steer me",
  )
})

test("buildRasDeliveryLinks uses delivery_anchor message ids only", () => {
  const markers = buildRasTraceMarkers([
    {
      id: "anomaly-1",
      deliveryId: "d1",
      type: "anomaly",
      taskId: "ses_1",
      anomalyKind: "llm_thinking_loop",
      severity: "low",
      summary: "loop",
      actionTypes: "emit_notice",
      payloadJson: JSON.stringify({
        trace_anchor: { message_id: "msg_llm", part_id: "prt_1", channel: "llm_reasoning" },
        actions: [{ type: "emit_notice", message: "notice body" }],
      }),
      ts: "2026-07-30T10:00:00.000Z",
    },
    {
      id: "result-1",
      deliveryId: "d2",
      type: "action_result",
      taskId: "ses_1",
      anomalyKind: null,
      severity: null,
      summary: null,
      actionTypes: "emit_notice",
      payloadJson: JSON.stringify({
        action: "emit_notice",
        ok: true,
        message: "notice body",
        trace_anchor: { message_id: "msg_llm", part_id: "prt_1", channel: "llm_reasoning" },
        delivery_anchor: {
          message_id: "msg_notice",
          part_id: "prt_n",
          channel: "ras_notice",
        },
      }),
      ts: "2026-07-30T10:00:01.000Z",
    },
  ], "zh")

  assert.deepEqual(markers[0].deliveryMessageIds, ["msg_notice"])
  const links = buildRasDeliveryLinks({
    markers,
    interactions: [{ messageID: "msg_notice", role: "user", content: "notice body" }],
  })
  assert.equal(links.get("msg_notice")?.actionType, "emit_notice")
  assert.equal(links.get("msg_notice")?.markerId, "anomaly-1")
})

test("buildRasDeliveryLinks does not fall back to message text", () => {
  const markers = buildRasTraceMarkers([
    {
      id: "anomaly-2",
      deliveryId: "d1",
      type: "anomaly",
      taskId: "ses_2",
      anomalyKind: "llm_thinking_loop",
      severity: "low",
      summary: "loop",
      actionTypes: "emit_notice",
      payloadJson: JSON.stringify({
        trace_anchor: { message_id: "msg_llm", part_id: "prt_1", channel: "llm_reasoning" },
        actions: [{ type: "emit_notice", message: "检测到思考循环异常，已执行恢复操作" }],
      }),
      ts: "2026-07-30T10:00:00.000Z",
    },
    {
      id: "result-notice",
      deliveryId: "d2",
      type: "action_result",
      taskId: "ses_2",
      anomalyKind: null,
      severity: null,
      summary: null,
      actionTypes: "emit_notice",
      payloadJson: JSON.stringify({
        action: "emit_notice",
        ok: true,
        message: "检测到思考循环异常，已执行恢复操作",
        trace_anchor: { message_id: "msg_llm", part_id: "prt_1", channel: "llm_reasoning" },
      }),
      ts: "2026-07-30T10:00:01.000Z",
    },
  ], "zh")

  const links = buildRasDeliveryLinks({
    markers,
    interactions: [
      {
        messageID: "msg_user_notice",
        role: "user",
        content: "检测到思考循环异常，已执行恢复操作",
      },
    ],
  })
  assert.equal(links.size, 0)
})

test("interleaveRasActions pairs each action with matching result", () => {
  const steps = interleaveRasActions(
    [
      { type: "abort_stream" },
      { type: "emit_notice", message: "n" },
      { type: "push_steering", message: "s" },
    ],
    [
      { action: "abort_stream", ok: true, ts: 1 },
      { action: "emit_notice", ok: true, ts: 2 },
      { action: "push_steering", ok: false, ts: 3, error: "x" },
    ],
  )
  assert.deepEqual(
    steps.map((step) => step.kind === "action" ? step.action.type : `${step.result.action}:${step.result.ok}`),
    [
      "abort_stream",
      "abort_stream:true",
      "emit_notice",
      "emit_notice:true",
      "push_steering",
      "push_steering:false",
    ],
  )
})

test("findRasMarkersForEvent matches delivery message as ras node", () => {
  const markers = buildRasTraceMarkers([
    {
      id: "anomaly-1",
      deliveryId: "d1",
      type: "anomaly",
      taskId: "ses_1",
      anomalyKind: "llm_thinking_loop",
      severity: "low",
      summary: "loop",
      actionTypes: "emit_notice",
      payloadJson: JSON.stringify({
        trace_anchor: { message_id: "msg_llm", part_id: "prt_1", channel: "llm_reasoning" },
        actions: [{ type: "emit_notice", message: "notice" }],
      }),
      ts: "2026-07-30T10:00:00.000Z",
    },
    {
      id: "result-1",
      deliveryId: "d2",
      type: "action_result",
      taskId: "ses_1",
      anomalyKind: null,
      severity: null,
      summary: null,
      actionTypes: "emit_notice",
      payloadJson: JSON.stringify({
        action: "emit_notice",
        ok: true,
        message: "notice",
        trace_anchor: { message_id: "msg_llm", part_id: "prt_1", channel: "llm_reasoning" },
        delivery_anchor: { message_id: "msg_notice", channel: "ras_notice" },
      }),
      ts: "2026-07-30T10:00:01.000Z",
    },
  ], "zh")

  const interaction: RawInteraction = {
    messageID: "msg_notice",
    role: "user",
    content: "notice",
  }
  const event: AgentEvent = {
    kind: "ras",
    interaction,
    interactionIndex: 1,
    name: "emit_notice",
  }
  const hits = findRasMarkersForEvent(event, markers)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].id, "anomaly-1")
})
