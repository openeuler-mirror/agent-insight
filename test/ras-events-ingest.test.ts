import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

import {
  buildRasIngestRecord,
  normalizeRasIngestBody,
  rasKindLabel,
} from "@/lib/ingest/ras/normalize"
import { dedupeRasEvents } from "@/lib/ingest/ras/store"
import {
  buildRasTraceMarkers,
  findRasMarkersForEvent,
} from "@/lib/ingest/ras/trace-markers"
import type { AgentEvent, RawInteraction } from "@/lib/engine/observability/agent-trace"

test("normalizeRasIngestBody: requires taskId", () => {
  const r = normalizeRasIngestBody({
    type: "anomaly",
    deliveryId: "d1",
  })
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /taskId/i)
})

test("normalizeRasIngestBody: requires deliveryId", () => {
  const r = normalizeRasIngestBody({
    taskId: "ses_abc",
    type: "anomaly",
  })
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /deliveryId/i)
})

test("normalizeRasIngestBody: rejects witty.* attribute-only payloads", () => {
  const r = normalizeRasIngestBody({
    attributes: {
      "witty.session.id": "ses_abc",
      "witty.ras.event_type": "anomaly",
      "witty.ras.delivery_id": "delivery-42",
    },
    payload: { kind: "repeat_tool_call" },
  })
  assert.equal(r.ok, false)
})

test("normalizeRasIngestBody: maps flat fields to record", () => {
  const r = normalizeRasIngestBody({
    taskId: "ses_abc",
    type: "anomaly",
    deliveryId: "delivery-42",
    anomalyKind: "repeat_tool_call",
    severity: "medium",
    summary: "tool repeated",
    framework: "opencode",
    payload: { kind: "repeat_tool_call", evidence: { n: 4 } },
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.record.taskId, "ses_abc")
  assert.equal(r.record.type, "anomaly")
  assert.equal(r.record.anomalyKind, "repeat_tool_call")
  assert.equal(r.record.severity, "medium")
  assert.equal(r.record.summary, "tool repeated")
  assert.equal(r.record.deliveryId, "delivery-42")
  assert.equal(r.record.framework, "opencode")
  assert.ok(r.record.payloadJson.includes("evidence"))
})

test("normalizeRasIngestBody: extracts actionTypes from payload.actions", () => {
  const r = normalizeRasIngestBody({
    type: "actions",
    taskId: "t1",
    deliveryId: "d7",
    platform: "opencode",
    payload: { actions: [{ type: "abort_stream" }, { type: "emit_notice" }] },
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.record.type, "actions")
  assert.equal(r.record.actionTypes, "abort_stream,emit_notice")
})

test("buildRasIngestRecord: batches multiple events", () => {
  const r = normalizeRasIngestBody({
    events: [
      {
        taskId: "s1",
        type: "anomaly",
        deliveryId: "d1",
        anomalyKind: "llm_thinking_dead_loop",
      },
      {
        taskId: "s1",
        type: "actions",
        deliveryId: "d2",
        payload: { actions: [{ type: "abort_stream" }] },
      },
    ],
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.records?.length, 2)
})

test("rasKindLabel: known kinds", () => {
  assert.equal(rasKindLabel("llm_thinking_dead_loop", "zh"), "思考死循环")
  assert.equal(rasKindLabel("repeat_tool_call", "en"), "repeat tool call")
  assert.equal(rasKindLabel("unknown_kind", "zh"), "unknown_kind")
})

test("buildRasIngestRecord helper mirrors single-event normalize", () => {
  const rec = buildRasIngestRecord({
    taskId: "x",
    type: "skill_result",
    deliveryId: "d-skill",
    payload: { ok: true },
  })
  assert.equal(rec.taskId, "x")
  assert.equal(rec.type, "skill_result")
  assert.equal(rec.deliveryId, "d-skill")
})

test("dedupeRasEvents uses deliveryId without collapsing equal occurrences", () => {
  const base = {
    taskId: "ses_current",
    type: "anomaly",
    anomalyKind: "llm_thinking_loop",
    severity: "high",
    summary: "same payload",
    actionTypes: "abort_stream",
    payloadJson: JSON.stringify({ evidence: { mode: "suffix_cycle" } }),
  }
  const rows = dedupeRasEvents([
    { ...base, id: "first", deliveryId: "delivery-1", ts: new Date("2026-07-29T11:31:09.398Z") },
    { ...base, id: "retry", deliveryId: "delivery-1", ts: new Date("2026-07-29T11:31:09.498Z") },
    { ...base, id: "second-occurrence", deliveryId: "delivery-2", ts: new Date("2026-07-29T11:31:09.498Z") },
  ])

  assert.deepEqual(rows.map(row => row.id), ["first", "second-occurrence"])
})

test("RAS read API derives identity from the shared auth resolver", () => {
  const route = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/ingest/ras-events/route.ts"),
    "utf8",
  )
  assert.match(route, /import \{ resolveUser \} from "@\/lib\/auth\/auth"/)
  assert.doesNotMatch(route, /searchParams\.get\(["']user["']\)/)
  assert.match(route, /valid x-witty-api-key required/)
})

test("RAS events route supports authenticated bulk delete by taskIds", () => {
  const route = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/ingest/ras-events/route.ts"),
    "utf8",
  )
  assert.match(route, /export async function DELETE/)
  assert.match(route, /deleteReliabilityTraces/)
  assert.match(route, /body\.taskIds/)
  assert.match(route, /Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS"/)
})

test("deleteReliabilityTraces only targets owned task ids", () => {
  const store = fs.readFileSync(
    path.join(process.cwd(), "src/lib/ingest/ras/store.ts"),
    "utf8",
  )
  assert.match(store, /export async function deleteReliabilityTraces/)
  assert.match(store, /isSubagent: false/)
  assert.match(store, /rasAnomalyEvent\.deleteMany/)
  assert.match(store, /execution\.deleteMany/)
  assert.match(store, /session\.deleteMany/)
})

test("RAS event writes use atomic compound-key upserts", () => {
  const store = fs.readFileSync(
    path.join(process.cwd(), "src/lib/ingest/ras/store.ts"),
    "utf8",
  )
  assert.match(store, /taskId_deliveryId/)
  assert.doesNotMatch(store, /taskId_rasEventId_type/)
  assert.doesNotMatch(store, /rasAnomalyEvent\.findFirst/)
})

test("next.config drops RAS deep-path rewrites", () => {
  const cfg = fs.readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8")
  assert.doesNotMatch(cfg, /\/api\/ingest\/ras\/v1\/events/)
  assert.doesNotMatch(cfg, /\/api\/ras\/v1\/events/)
})

test("buildRasTraceMarkers preserves recovery prompt content and anchored results", () => {
  const anchor = {
    message_id: "msg_1",
    part_id: "prt_reasoning",
    channel: "llm_reasoning",
  }
  const markers = buildRasTraceMarkers([
    {
      id: "anomaly-1",
      deliveryId: "d1",
      type: "anomaly",
      taskId: "ses_1",
      anomalyKind: "llm_thinking_loop",
      severity: "low",
      summary: "loop",
      actionTypes: "abort_stream,emit_notice,push_steering",
      payloadJson: JSON.stringify({
        evidence: { mode: "suffix_cycle" },
        actions: [
          { type: "abort_stream" },
          { type: "emit_notice", message: "notice body" },
          { type: "push_steering", message: "steer body" },
        ],
        trace_anchor: anchor,
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
        trace_anchor: anchor,
        delivery_anchor: { message_id: "msg_notice", channel: "ras_notice" },
      }),
      ts: "2026-07-30T10:00:01.000Z",
    },
  ], "zh")

  assert.equal(markers.length, 1)
  assert.deepEqual(
    markers[0].actions.map((a) => a.type),
    ["abort_stream", "emit_notice", "push_steering"],
  )
  assert.equal(markers[0].actions[1].message, "notice body")
  assert.deepEqual(markers[0].deliveryMessageIds, ["msg_notice"])
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
