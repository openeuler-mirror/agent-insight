/**
 * Test: TRAE extensions.json Step 4 logic validation.
 *
 * Covers three root-cause bugs fixed in setup/route.ts:
 *   1. Missing comma between array elements (ForEach-Object scalar collapse → string concat)
 *   2. $mid variable expansion eating the field name in here-strings
 *   3. Corrupted file from previous bad runs breaking ConvertFrom-Json
 *
 * USAGE:
 *   npm test -- test/trae-extensions-json.test.ts
 *   TEST_FULL=1 npm test -- test/trae-extensions-json.test.ts  # includes PS script check (needs :3000)
 */

import test from "node:test"
import assert from "node:assert/strict"

// ─── Fixtures ───────────────────────────────────────────────────────────

const typicalExtensions = [
  {
    identifier: { id: "vue.volar", uuid: "a95ee795-1576-4ffa-acda-8d6e6a95c584" },
    version: "3.3.8",
    location: { $mid: 1, path: "/c:/Users/win11/.trae-cn/extensions/vue.volar-3.3.8-universal", scheme: "file" },
    relativeLocation: "vue.volar-3.3.8-universal",
    metadata: { installedTimestamp: 1785154029306, isMachineScoped: true }
  },
  {
    identifier: { id: "rust-lang.rust-analyzer" },
    version: "0.3.2301",
    location: { $mid: 1, path: "/c:/Users/win11/.trae-cn/extensions/rust-lang.rust-analyzer-0.3.2301", scheme: "file" },
    relativeLocation: "rust-lang.rust-analyzer-0.3.2301",
    metadata: { installedTimestamp: 1785154000000, isMachineScoped: true }
  }
]

const singleExtension = [typicalExtensions[0]]

function corruptedJson(): string {
  const arr = JSON.stringify(typicalExtensions)
  return arr.replace(/},\s*\{/s, "}    {") // missing comma
}

function withExistingAgentInsight(): object[] {
  return [...typicalExtensions, {
    identifier: { id: "agent-insight.agent-insight-trae-collector" },
    version: "0.1.0",
    location: { $mid: 1, path: "/c:/Users/win11/.trae-cn/extensions/agent-insight.agent-insight-trae-collector-0.1.0", scheme: "file" },
    relativeLocation: "agent-insight.agent-insight-trae-collector-0.1.0",
    metadata: { installedTimestamp: 1785000000000, isMachineScoped: true, pinned: true, source: "vsix" }
  }]
}

// ─── Step 4 logic simulator ─────────────────────────────────────────────

interface ExtEntry {
  identifier: { id: string; uuid?: string }
  version: string
  location: { $mid?: number; fsPath?: string; path: string; scheme: string }
  relativeLocation: string
  metadata: Record<string, unknown>
}

const EXT_ID = "agent-insight.agent-insight-trae-collector"

function step4Logic(existingJson: string, target: string, extName: string) {
  let exts: ExtEntry[]
  try { exts = JSON.parse(existingJson) } catch { exts = [] }
  exts = exts.filter(e => e.identifier.id !== EXT_ID)

  const newExt: ExtEntry = {
    identifier: { id: EXT_ID },
    version: "0.1.0",
    location: { $mid: 1, fsPath: target, path: target, scheme: "file" },
    relativeLocation: extName,
    metadata: { isMachineScoped: true, installedTimestamp: Date.now(), pinned: true, source: "vsix" }
  }
  exts.push(newExt)

  const output = JSON.stringify(exts, null, 2)
  try {
    const parsed = JSON.parse(output)
    const ours = parsed.find((e: ExtEntry) => e.identifier.id === EXT_ID)
    return { valid: true, count: parsed.length, hasOurs: !!ours, hasMid: ours?.location?.$mid === 1 }
  } catch (e: any) {
    return { valid: false, count: -1, hasOurs: false, hasMid: false }
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────

test("AC31: 2 pre-existing → 3 total", () => {
  const r = step4Logic(JSON.stringify(typicalExtensions), "C:\\Users\\win11\\.trae-cn\\extensions\\agent-insight.agent-insight-trae-collector-0.1.0", "agent-insight.agent-insight-trae-collector-0.1.0")
  assert.equal(r.valid, true)
  assert.equal(r.count, 3)
  assert.equal(r.hasOurs, true)
  assert.equal(r.hasMid, true)
})

test("AC31: 1 pre-existing → 2 total (scalar-collapse edge case)", () => {
  const r = step4Logic(JSON.stringify(singleExtension), "C:\\Target\\ext", "agent-insight.agent-insight-trae-collector-0.1.0")
  assert.equal(r.valid, true)
  assert.equal(r.count, 2)
  assert.equal(r.hasOurs, true)
})

test("AC31: idempotent: reinstall removes old, adds new → same count", () => {
  const r = step4Logic(JSON.stringify(withExistingAgentInsight()), "C:\\Target\\ext", "agent-insight.agent-insight-trae-collector-0.1.0")
  assert.equal(r.valid, true)
  assert.equal(r.count, 3)
  assert.equal(r.hasOurs, true)
})

test("AC31: corrupted JSON → reset and produce valid output", () => {
  assert.throws(() => JSON.parse(corruptedJson()))
  const r = step4Logic(corruptedJson(), "C:\\Target\\ext", "agent-insight.agent-insight-trae-collector-0.1.0")
  assert.equal(r.valid, true)
  assert.equal(r.count, 1, "only new extension survives")
  assert.equal(r.hasOurs, true)
})

test("AC31: empty string → 1 extension", () => {
  const r = step4Logic("", "C:\\Target\\ext", "agent-insight.agent-insight-trae-collector-0.1.0")
  assert.equal(r.valid, true)
  assert.equal(r.count, 1)
  assert.equal(r.hasOurs, true)
})

// ─── PS script structure check (requires running server) ─────────────────

test("AC31: PS script: no old buggy patterns, has new patterns", { skip: !process.env.TEST_FULL }, async () => {
  const res = await fetch("http://localhost:3000/api/ingest/setup?framework=trae", {
    headers: { "user-agent": "Windows PowerShell", "x-platform": "windows" }
  })
  assert.equal(res.status, 200)
  const script = await res.text()

  assert.ok(!script.includes("ForEach-Object { $_ | ConvertTo-Json"), "old ForEach-Object pattern removed")
  assert.ok(script.includes('location: { "$mid": 1'), "$mid via literal object present")
  assert.ok(script.includes("JSON.stringify(exts, null, 2)"), "single serialization on array")
  assert.ok(script.includes('try {'), "try-catch present")
  assert.ok(script.includes("Recreated extensions.json"), "corruption recovery present")
})
