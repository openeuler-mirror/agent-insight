import assert from "node:assert/strict"
import test from "node:test"

import { mergeSessionInteractionsMonotonic } from "@/lib/engine/observability/session-interactions-merge"

test("mergeSessionInteractionsMonotonic preserves existing child-session messages even if incoming is longer but missing them", () => {
  const existing = [
    { role: "user", content: "root q", timestamp: "2026-01-01T00:00:00.000Z" },
    {
      role: "subagent",
      subagent_session_id: "ses_baize",
      subagent_name: "baize",
      content: "baize final report",
      timestamp: "2026-01-01T00:01:00.000Z",
    },
    { role: "assistant", content: "root a", timestamp: "2026-01-01T00:02:00.000Z" },
  ]

  const incoming = [
    { role: "user", content: "root q", timestamp: "2026-01-01T00:00:00.000Z" },
    { role: "assistant", content: "root a", timestamp: "2026-01-01T00:02:00.000Z" },
    { role: "assistant", content: "more steps 1", timestamp: "2026-01-01T00:03:00.000Z" },
    { role: "assistant", content: "more steps 2", timestamp: "2026-01-01T00:04:00.000Z" },
    { role: "assistant", content: "more steps 3", timestamp: "2026-01-01T00:05:00.000Z" },
  ]

  const merged = mergeSessionInteractionsMonotonic(existing as any[], incoming as any[])
  assert.ok(merged.some((m: any) => m.subagent_session_id === "ses_baize"))
  assert.ok(merged.length >= incoming.length)
})

test("mergeSessionInteractionsMonotonic never overwrites non-empty content with empty content", () => {
  const existing = [
    { role: "assistant", timestamp: 1, content: "hello" },
  ]
  const incoming = [
    { role: "assistant", timestamp: 1, content: "" },
  ]

  const merged = mergeSessionInteractionsMonotonic(existing as any[], incoming as any[])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].content, "hello")
})
