import assert from "node:assert/strict"
import test from "node:test"

import { debounceByKey } from "@/lib/ingest/upload-analysis-debouncer"

test("debounceByKey runs only once per key and keeps latest payload", async () => {
  const seen: number[] = []
  debounceByKey("k1", 20, () => seen.push(1))
  debounceByKey("k1", 20, () => seen.push(2))

  await new Promise((r) => setTimeout(r, 60))
  assert.deepEqual(seen, [2])
})

