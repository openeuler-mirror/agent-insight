import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

import { GET as getInstaller } from "@/app/api/ingest/setup/pi-agent/route"
import { GET as getAsset } from "@/app/api/ingest/setup/pi-agent/assets/[asset]/route"

const ASSETS = [
  "package.json",
  "pi-agent-insight.ts",
  "pi-trace-core.cjs",
  "self-check.cjs",
  "uninstall.cjs",
  "trace-transport.cjs",
]

test("Pi installer is self-contained, version-gated, and does not put secrets in asset URLs", async () => {
  const response = await getInstaller(new Request("https://insight.example/api/ingest/setup/pi-agent"))
  const source = await response.text()
  assert.equal(response.status, 200)
  assert.match(source, /Node\.js.*>=22\.19\.0/)
  assert.match(source, /0\.82\.\*/)
  assert.match(source, /AGENT_INSIGHT_API_KEY/)
  assert.match(source, /pi install "\$PACKAGE_DIR"/)
  assert.match(source, /scripts\/self-check\.cjs/)
  assert.match(source, /AGENT_INSIGHT_BASE_URL:-https:\/\/insight\.example/)
  assert.match(source, /ASSET_URL="\$BASE_URL\/api\/ingest\/setup\/pi-agent\/assets"/)
  assert.doesNotMatch(source, /apiKey=/)
  assert.doesNotMatch(source, /github\.com/)
})

test("Pi setup asset route serves only the fixed first-party allowlist", async () => {
  for (const asset of ASSETS) {
    const response = await getAsset(
      new Request(`https://insight.example/assets/${asset}`),
      { params: Promise.resolve({ asset }) },
    )
    assert.equal(response.status, 200, asset)
    assert.ok((await response.text()).length > 20, asset)
    assert.equal(response.headers.get("x-content-type-options"), "nosniff")
  }

  const denied = await getAsset(
    new Request("https://insight.example/assets/../../package.json"),
    { params: Promise.resolve({ asset: "../../package.json" }) },
  )
  assert.equal(denied.status, 404)
})

test("Pi package manifest declares the real Extension entry and compatible Pi range", () => {
  const manifestPath = path.join(
    process.cwd(),
    "scripts",
    "agent-trace-collectors",
    "pi-agent",
    "package.json",
  )
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  assert.deepEqual(manifest.pi.extensions, ["./extensions/pi-agent-insight.ts"])
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], ">=0.82.1 <0.83.0")
})

test("uninstall script refuses to mutate a source checkout outside the managed package path", () => {
  const script = path.join(
    process.cwd(),
    "scripts",
    "agent-trace-collectors",
    "pi-agent",
    "scripts",
    "uninstall.cjs",
  )
  const result = spawnSync(process.execPath, [script, "--purge"], { encoding: "utf8" })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Refusing to remove unexpected collector package path/)
  assert.equal(fs.existsSync(script), true)
})

test("uninstall source scopes deletion to Pi paths and requires purge-all confirmation", () => {
  const source = fs.readFileSync(
    path.join(
      process.cwd(),
      "scripts",
      "agent-trace-collectors",
      "pi-agent",
      "scripts",
      "uninstall.cjs",
    ),
    "utf8",
  )
  assert.match(source, /otel_data", "pi-agent"/)
  assert.match(source, /--purge-all/)
  assert.match(source, /--yes/)
  assert.doesNotMatch(source, /opencode|claude|hermes|codex/)
})
