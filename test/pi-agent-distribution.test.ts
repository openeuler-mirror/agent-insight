import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import test from "node:test"

import { GET as getInstaller } from "@/app/api/ingest/setup/pi-agent/route"
import { GET as getAsset } from "@/app/api/ingest/setup/pi-agent/assets/[asset]/route"

const require = createRequire(import.meta.url)
const { isSupportedPiVersion } = require("../scripts/agent-trace-collectors/pi-agent/install.cjs")

const ASSETS = [
  "package.json",
  "pi-agent-insight.ts",
  "pi-trace-core.cjs",
  "self-check.cjs",
  "uninstall.cjs",
  "install.cjs",
  "trace-transport.cjs",
]

test("Pi installer is self-contained, version-gated, and does not put secrets in asset URLs", async () => {
  const response = await getInstaller(new Request("https://insight.example/api/ingest/setup/pi-agent"))
  const source = await response.text()
  assert.equal(response.status, 200)
  assert.match(source, /Node\.js.*>=22\.19\.0/)
  assert.match(source, /AGENT_INSIGHT_API_KEY/)
  assert.match(source, /install\.cjs/)
  assert.match(source, /--source-dir/)
  assert.match(source, /AGENT_INSIGHT_BASE_URL:-https:\/\/insight\.example/)
  assert.match(source, /ASSET_URL="\$BASE_URL\/api\/ingest\/setup\/pi-agent\/assets"/)
  assert.doesNotMatch(source, /apiKey=/)
  assert.doesNotMatch(source, /github\.com/)
})

test("Pi setup route returns the PowerShell staging installer for Windows", async () => {
  const response = await getInstaller(new Request(
    "https://insight.example/api/ingest/setup/pi-agent",
    { headers: { "x-platform": "windows" } },
  ))
  const source = await response.text()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("content-type"), "application/x-powershell; charset=utf-8")
  assert.match(source, /install\.cjs/)
  assert.match(source, /Invoke-WebRequest/)
  assert.match(source, /--source-dir/)
  assert.doesNotMatch(source, /apiKey=/)
})

test("Pi setup route escapes forwarded origins before embedding them in shell scripts", async () => {
  for (const platform of ["unix", "windows"] as const) {
    const response = await getInstaller(new Request(
      "https://insight.example/api/ingest/setup/pi-agent",
      {
        headers: {
          "x-platform": platform,
          "x-forwarded-proto": "https",
          "x-forwarded-host": "insight.example$(touch PWN)\"`$HOME",
        },
      },
    ))
    const source = await response.text()
    assert.equal(response.status, 200)
    assert.match(
      source,
      platform === "windows"
        ? /insight\.example`\$\(touch PWN\)`"/
        : /insight\.example\\\$\(touch PWN\)\\"\\`\\\$HOME/,
    )
  }
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
  const prototypeAsset = await getAsset(
    new Request("https://insight.example/assets/constructor"),
    { params: Promise.resolve({ asset: "constructor" }) },
  )
  assert.equal(prototypeAsset.status, 404)
})

test("Pi package manifest declares the real Extension entry and an open-ended compatible Pi range", () => {
  const manifestPath = path.join(
    process.cwd(),
    "scripts",
    "agent-trace-collectors",
    "pi-agent",
    "package.json",
  )
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  assert.deepEqual(manifest.pi.extensions, ["./extensions/pi-agent-insight.ts"])
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], ">=0.82.1")
})

test("Pi installer accepts newer semver releases while rejecting unsupported versions", () => {
  assert.equal(isSupportedPiVersion("pi 0.82.1"), true)
  assert.equal(isSupportedPiVersion("0.82.2-beta.1"), true)
  assert.equal(isSupportedPiVersion("0.83.0"), true)
  assert.equal(isSupportedPiVersion("v1.0.0"), true)
  assert.equal(isSupportedPiVersion("0.82.0"), false)
  assert.equal(isSupportedPiVersion("unknown"), false)
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
