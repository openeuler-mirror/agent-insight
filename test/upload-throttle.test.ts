import assert from "node:assert/strict"
import test from "node:test"

import { createPerKeyThrottle } from "@/lib/ingest/upload-throttle"

test("createPerKeyThrottle: runs immediately then throttles to at most once per interval, last wins", async () => {
  const throttle = createPerKeyThrottle(30)
  const seen: number[] = []

  throttle.run("k", () => seen.push(1))
  throttle.run("k", () => seen.push(2))
  throttle.run("k", () => seen.push(3))

  await new Promise((r) => setTimeout(r, 80))
  assert.deepEqual(seen, [1, 3])
})

