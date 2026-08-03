import assert from "node:assert/strict"
import test from "node:test"

import { sortRasTracesByTime } from "@/lib/ingest/ras/sort-traces"

test("sortRasTracesByTime: default desc by latestTs", () => {
  const rows = [
    { id: "a", latestTs: "2026-07-30T10:00:00.000Z" },
    { id: "b", latestTs: "2026-07-31T10:00:00.000Z" },
    { id: "c", latestTs: "2026-07-29T10:00:00.000Z" },
  ]
  assert.deepEqual(
    sortRasTracesByTime(rows).map((r) => r.id),
    ["b", "a", "c"],
  )
})

test("sortRasTracesByTime: asc", () => {
  const rows = [
    { id: "a", latestTs: "2026-07-30T10:00:00.000Z" },
    { id: "b", latestTs: "2026-07-31T10:00:00.000Z" },
    { id: "c", latestTs: "2026-07-29T10:00:00.000Z" },
  ]
  assert.deepEqual(
    sortRasTracesByTime(rows, "asc").map((r) => r.id),
    ["c", "a", "b"],
  )
})

test("sortRasTracesByTime: invalid timestamps sink to end", () => {
  const rows = [
    { id: "bad", latestTs: "not-a-date" },
    { id: "ok", latestTs: "2026-07-30T10:00:00.000Z" },
    { id: "empty", latestTs: "" },
  ]
  assert.deepEqual(
    sortRasTracesByTime(rows, "desc").map((r) => r.id),
    ["ok", "bad", "empty"],
  )
  assert.deepEqual(
    sortRasTracesByTime(rows, "asc").map((r) => r.id),
    ["ok", "bad", "empty"],
  )
})

test("sortRasTracesByTime: does not mutate input", () => {
  const rows = [
    { id: "a", latestTs: "2026-07-30T10:00:00.000Z" },
    { id: "b", latestTs: "2026-07-31T10:00:00.000Z" },
  ]
  const copy = [...rows]
  sortRasTracesByTime(rows, "asc")
  assert.deepEqual(rows, copy)
})
