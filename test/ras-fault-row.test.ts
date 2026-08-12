import assert from "node:assert/strict"
import test from "node:test"

import {
  buildRasFaultOpTags,
  rasFaultRowOutcome,
  rasOpRole,
} from "@/lib/ingest/ras/fault-row"
import type { RasTraceMarker } from "@/lib/ingest/ras/trace-markers"

function marker(
  partial: Partial<Pick<RasTraceMarker, "actions" | "actionResults">>,
): Pick<RasTraceMarker, "actions" | "actionResults"> {
  return {
    actions: partial.actions || [],
    actionResults: partial.actionResults || [],
  }
}

test("rasOpRole marks abort_stream as abort", () => {
  assert.equal(rasOpRole("abort_stream"), "abort")
  assert.equal(rasOpRole("break_loop"), "recover")
})

test("buildRasFaultOpTags dedupes and keeps order without messages", () => {
  const tags = buildRasFaultOpTags(
    marker({
      actions: [
        { type: "break_loop", message: "end thinking" },
        { type: "abort_stream", message: "cut stream" },
        { type: "break_loop" },
        { type: "  " },
      ],
    }),
  )
  assert.deepEqual(tags, [
    { type: "break_loop", role: "recover" },
    { type: "abort_stream", role: "abort" },
  ])
})

test("rasFaultRowOutcome covers none / unknown / failed / success", () => {
  assert.equal(rasFaultRowOutcome(marker({})), "none")
  assert.equal(
    rasFaultRowOutcome(marker({ actions: [{ type: "break_loop" }] })),
    "unknown",
  )
  assert.equal(
    rasFaultRowOutcome(
      marker({
        actions: [{ type: "break_loop" }, { type: "abort_stream" }],
        actionResults: [
          { action: "break_loop", ok: true, ts: 1 },
          { action: "abort_stream", ok: false, ts: 2 },
        ],
      }),
    ),
    "failed",
  )
  assert.equal(
    rasFaultRowOutcome(
      marker({
        actions: [{ type: "break_loop" }],
        actionResults: [{ action: "break_loop", ok: true, ts: 1 }],
      }),
    ),
    "success",
  )
})
