import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("pi ras_client wire log", () => {
  it("appends request payload and result to pi-wire.jsonl when RAS_DEBUG_WIRE=1", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-wire-"))
    process.env.AGENT_INSIGHT_RAS_HOME = home
    process.env.RAS_DEBUG_WIRE = "1"
    const { createRasClient } = await import(
      `../../../platform_adapter/pi/ras_client.ts?t=${Date.now()}`
    )
    const client = createRasClient({})
    await client.observe("pi:s1", { kind: "assistant_text", text: "hello world" })
    await client.bye("pi:s1")

    const file = join(home, "log", "pi-wire.jsonl")
    assert.ok(existsSync(file), "wire log file should exist")
    const records = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    const observe = records.find((r) => r.op === "observe")
    assert.ok(observe, "observe record present")
    assert.equal(observe.sessionId, "pi:s1")
    assert.equal(observe.request.kind, "assistant_text")
    assert.equal(observe.request.text, "hello world")
    assert.equal(observe.result.skipped, "embed_not_ready")
    // fail-open：koffi 不可用时 ready 恒 false，bye 短路，只有 observe 留痕
    assert.equal(records.length, 1)
  })

  it("writes wire log by default when RAS_DEBUG_WIRE is unset", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-wire-default-"))
    process.env.AGENT_INSIGHT_RAS_HOME = home
    delete process.env.RAS_DEBUG_WIRE
    const { createRasClient } = await import(
      `../../../platform_adapter/pi/ras_client.ts?t=${Date.now()}`
    )
    const client = createRasClient({})
    await client.observe("pi:s2", { kind: "assistant_text", text: "secret" })
    assert.ok(existsSync(join(home, "log", "pi-wire.jsonl")), "wire log on by default")
  })

  it("writes nothing when RAS_DEBUG_WIRE=0", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-wire-off-"))
    process.env.AGENT_INSIGHT_RAS_HOME = home
    process.env.RAS_DEBUG_WIRE = "0"
    const { createRasClient } = await import(
      `../../../platform_adapter/pi/ras_client.ts?t=${Date.now()}`
    )
    const client = createRasClient({})
    await client.observe("pi:s2", { kind: "assistant_text", text: "secret" })
    assert.equal(existsSync(join(home, "log")), false, "no log dir when explicitly disabled")
  })
})
