import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import AdmZip from "adm-zip"

import { GET as getInstaller } from "@/app/api/ingest/setup/pi-agent/route"
import { GET as getAsset } from "@/app/api/ingest/setup/pi-agent/assets/[asset]/route"

const require = createRequire(import.meta.url)
const { isSupportedPiVersion } = require("../scripts/agent-trace-collectors/pi-agent/install.cjs")

const BUNDLE_ENTRIES = [
  "pi-agent/extensions/pi-agent-insight.ts",
  "pi-agent/install.cjs",
  "pi-agent/lib/pi-trace-core.cjs",
  "pi-agent/package.json",
  "pi-agent/scripts/self-check.cjs",
  "pi-agent/scripts/uninstall.cjs",
  "shared/trace-transport.cjs",
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
  assert.match(source, /BUNDLE_URL="\$BASE_URL\/api\/ingest\/setup\/pi-agent\/assets\/pi-agent-bundle\.zip"/)
  assert.match(source, /EXPECTED_BUNDLE_SHA256="[0-9a-f]{64}"/)
  assert.ok(source.indexOf("ACTUAL_BUNDLE_SHA256") < source.indexOf("unzip -q"))
  assert.ok(source.indexOf("unzip -q") < source.indexOf('node "$STAGE_DIR/pi-agent/install.cjs"'))
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
  assert.match(source, /pi-agent-bundle\.zip/)
  assert.match(source, /Get-FileHash/)
  assert.match(source, /Expand-Archive/)
  assert.match(source, /--source-dir/)
  assert.ok(source.indexOf("Get-FileHash") < source.indexOf("Expand-Archive"))
  assert.ok(source.indexOf("Expand-Archive") < source.indexOf("& node"))
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

test("Pi setup serves one complete bundle whose SHA-256 matches the bootstrap", async () => {
  const installerResponse = await getInstaller(new Request("https://insight.example/api/ingest/setup/pi-agent"))
  const installer = await installerResponse.text()
  const expectedDigest = /EXPECTED_BUNDLE_SHA256="([0-9a-f]{64})"/.exec(installer)?.[1]
  assert.ok(expectedDigest, "bootstrap must embed a concrete bundle digest")

  const response = await getAsset(
    new Request("https://insight.example/assets/pi-agent-bundle.zip"),
    { params: Promise.resolve({ asset: "pi-agent-bundle.zip" }) },
  )
  const bundle = Buffer.from(await response.arrayBuffer())
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("content-type"), "application/zip")
  assert.equal(response.headers.get("x-content-type-options"), "nosniff")
  assert.equal(createHash("sha256").update(bundle).digest("hex"), expectedDigest)
  assert.deepEqual(
    new AdmZip(bundle).getEntries().map((entry) => entry.entryName).sort(),
    BUNDLE_ENTRIES,
  )

  for (const oldAsset of ["install.cjs", "pi-trace-core.cjs", "trace-transport.cjs"]) {
    const legacy = await getAsset(
      new Request(`https://insight.example/assets/${oldAsset}`),
      { params: Promise.resolve({ asset: oldAsset }) },
    )
    assert.equal(legacy.status, 200, oldAsset)
    assert.equal(legacy.headers.get("deprecation"), "true", oldAsset)
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

test("PowerShell bootstrap rejects a tampered Pi bundle before installation", async (t) => {
  const bundleResponse = await getAsset(
    new Request("https://insight.example/assets/pi-agent-bundle.zip"),
    { params: Promise.resolve({ asset: "pi-agent-bundle.zip" }) },
  )
  const tamperedBundle = Buffer.from(await bundleResponse.arrayBuffer())
  tamperedBundle[tamperedBundle.length - 1] ^= 0xff

  const server = http.createServer((request, response) => {
    if (request.url === "/api/ingest/setup/pi-agent/assets/pi-agent-bundle.zip") {
      response.writeHead(200, { "content-type": "application/zip" })
      response.end(tamperedBundle)
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  t.after(() => server.close())
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const origin = `http://127.0.0.1:${address.port}`
  const installerResponse = await getInstaller(new Request(
    `${origin}/api/ingest/setup/pi-agent`,
    { headers: { "x-platform": "windows" } },
  ))
  const installer = await installerResponse.text()

  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const encodedInstaller = Buffer.from(installer, "utf16le").toString("base64")
    const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedInstaller], {
      env: { ...process.env, AGENT_INSIGHT_API_KEY: "test-pi-key" },
      windowsHide: true,
    })
    let output = ""
    child.stdout.on("data", (chunk) => { output += chunk })
    child.stderr.on("data", (chunk) => { output += chunk })
    child.once("error", reject)
    child.once("close", (code) => resolve({ code, output }))
  })

  assert.notEqual(result.code, 0, result.output)
  assert.match(result.output, /bundle SHA-256 mismatch/)
  assert.doesNotMatch(result.output, /collector installed/)
})

test("PowerShell bootstrap installs a valid Pi bundle end to end", async (t) => {
  const bundleResponse = await getAsset(
    new Request("https://insight.example/assets/pi-agent-bundle.zip"),
    { params: Promise.resolve({ asset: "pi-agent-bundle.zip" }) },
  )
  const bundle = Buffer.from(await bundleResponse.arrayBuffer())
  const server = http.createServer((request, response) => {
    if (request.url === "/api/ingest/setup/pi-agent/assets/pi-agent-bundle.zip") {
      response.writeHead(200, { "content-type": "application/zip" })
      response.end(bundle)
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  t.after(() => server.close())
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const origin = `http://127.0.0.1:${address.port}`
  const installerResponse = await getInstaller(new Request(
    `${origin}/api/ingest/setup/pi-agent`,
    { headers: { "x-platform": "windows" } },
  ))
  const installer = await installerResponse.text()

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-insight-pi-e2e-"))
  const homeDir = path.join(tempDir, "user")
  const agentInsightHome = path.join(tempDir, "agent-insight")
  const binDir = path.join(tempDir, "bin")
  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(
    path.join(binDir, "pi.cmd"),
    "@echo off\r\nif \"%1\"==\"--version\" echo pi 0.82.1\r\nexit /b 0\r\n",
  )
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const encodedInstaller = Buffer.from(installer, "utf16le").toString("base64")
    const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedInstaller], {
      env: {
        ...process.env,
        AGENT_INSIGHT_API_KEY: "test-pi-key",
        AGENT_INSIGHT_BASE_URL: origin,
        AGENT_INSIGHT_HOME: agentInsightHome,
        HOME: homeDir,
        USERPROFILE: homeDir,
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      },
      windowsHide: true,
    })
    let output = ""
    child.stdout.on("data", (chunk) => { output += chunk })
    child.stderr.on("data", (chunk) => { output += chunk })
    child.once("error", reject)
    child.once("close", (code) => resolve({ code, output }))
  })
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }))

  assert.equal(result.code, 0, result.output)
  assert.match(result.output, /collector installed/)
  assert.equal(fs.existsSync(path.join(agentInsightHome, "collectors", "pi-agent", "extensions", "pi-agent-insight.ts")), true)
  assert.equal(fs.existsSync(path.join(agentInsightHome, "collectors", "pi-agent", "config.json")), true)
  assert.equal(fs.existsSync(path.join(agentInsightHome, "collectors", "shared", "trace-transport.cjs")), true)
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
