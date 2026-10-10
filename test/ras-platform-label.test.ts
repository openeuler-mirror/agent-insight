import assert from "node:assert/strict"
import test from "node:test"

import {
  getPlatformLabel,
  resolveTracePlatform,
} from "@/lib/ingest/ras/platform-label"

test("getPlatformLabel: known platforms", () => {
  assert.equal(getPlatformLabel("xiaoo"), "xiaoO")
  assert.equal(getPlatformLabel("opencode"), "OpenCode")
  assert.equal(getPlatformLabel("openjiuwen"), "openJiuwen")
  assert.equal(getPlatformLabel(""), "—")
})

test("resolveTracePlatform: prefer event platform over execution framework", () => {
  assert.equal(
    resolveTracePlatform({
      eventPlatform: "xiaoo",
      executionFramework: "opencode",
    }),
    "xiaoo",
  )
  assert.equal(
    resolveTracePlatform({
      eventPlatform: null,
      executionFramework: "opencode",
    }),
    "opencode",
  )
  assert.equal(
    resolveTracePlatform({
      eventPlatform: null,
      eventFramework: "hermes",
      executionFramework: null,
    }),
    "hermes",
  )
})
