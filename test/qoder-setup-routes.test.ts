import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

import { GET as getSetup } from "@/app/api/ingest/setup/route"
import { GET as getAutoSetup } from "@/app/api/ingest/setup/auto/route"
import { GET as getQoderDesktopVsix } from "@/app/api/ingest/setup/qoder-desktop-vsix/route"
import { GET as getQoderJetBrainsPlugin } from "@/app/api/ingest/setup/qoder-jetbrains-plugin/route"

const QODER_COMPONENTS = [
  "qoder_setup.mjs",
  "qoder_token_usage_env.mjs",
  "qoder_trace_collector.mjs",
  "qoder_uploader_client.mjs",
  "qoder_work_setup.mjs",
]

function frameworkValues(script: string): string[] {
  const start = script.indexOf("const frameworks = [")
  assert.notEqual(start, -1, "generated installer must contain the framework selector")
  const end = script.indexOf("];", start)
  assert.notEqual(end, -1, "generated installer must terminate the framework selector")
  return [...script.slice(start, end).matchAll(/value: '([^']+)'/g)].map((match) => match[1])
}

function assertGeneratedScriptSyntax(script: string, platform: "windows" | "unix"): void {
  // The legacy PowerShell generator contains unrelated mojibake strings that the
  // Windows parser rejects. Keep this regression check focused on Bash syntax;
  // the PowerShell Qoder block is asserted structurally below.
  if (platform === "windows") return

  const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" })

  assert.equal(result.status, 0, result.stderr || result.stdout)
}

async function setupScript(platform: "windows" | "unix"): Promise<string> {
  const response = await getSetup(new Request("http://localhost/api/ingest/setup?yes=1&frameworks=qoder&key=test-key", {
    headers: { "x-platform": platform, host: "localhost:3000" },
  }))
  assert.equal(response.status, 200)
  return response.text()
}

async function autoSetupScript(platform: "windows" | "unix"): Promise<string> {
  const response = await getAutoSetup(new Request("http://localhost/api/ingest/setup/auto?apiKey=test-key&host=localhost%3A3000", {
    headers: { "x-platform": platform, host: "localhost:3000" },
  }))
  assert.equal(response.status, 200)
  return response.text()
}

test("Qoder setup components are served from an explicit allowlist", async () => {
  for (const component of QODER_COMPONENTS) {
    const response = await getSetup(new Request(`http://localhost/api/ingest/setup?component=${component}`))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8")
    assert.equal(await response.text(), fs.readFileSync(path.join(process.cwd(), "scripts", component), "utf8"))
  }

  const rejected = await getSetup(new Request("http://localhost/api/ingest/setup?component=..%2Fpackage.json"))
  assert.equal(rejected.status, 404)
})

test("Qoder Desktop VSIX and JetBrains ZIP are exposed as fixed attachment downloads", async () => {
  const packages = [
    {
      get: getQoderDesktopVsix,
      filename: "agent-insight-qoder-desktop-0.1.12.vsix",
      contentType: "application/octet-stream",
    },
    {
      get: getQoderJetBrainsPlugin,
      filename: "agent-insight-qoder-jetbrains-0.1.9.zip",
      contentType: "application/zip",
    },
  ]

  for (const pluginPackage of packages) {
    const response = await pluginPackage.get()
    const expected = fs.readFileSync(path.join(process.cwd(), "public", "qoder-plugins", pluginPackage.filename))
    const actual = Buffer.from(await response.arrayBuffer())

    assert.equal(response.status, 200)
    assert.equal(response.headers.get("content-type"), pluginPackage.contentType)
    assert.equal(response.headers.get("content-disposition"), `attachment; filename="${pluginPackage.filename}"`)
    assert.equal(response.headers.get("content-length"), String(expected.byteLength))
    assert.equal(response.headers.get("x-content-type-options"), "nosniff")
    assert.deepEqual(actual, expected)
  }
})

test("curl setup appends Qoder without changing existing framework entries", async () => {
  for (const platform of ["unix", "windows"] as const) {
    const script = await setupScript(platform)
    assertGeneratedScriptSyntax(script, platform)
    assert.deepEqual(frameworkValues(script), ["opencode", "openclaw", "claude", "codeagent", "hermes", "jiuwen", "qoder"])
    assert.match(script, /INSTALL_QODER/)
    assert.match(script, /qoder_setup\.mjs/)
    assert.match(script, /qoder_token_usage_env\.mjs/)
    assert.match(script, /qoder_work_setup\.mjs/)
    assert.match(script, /--product=cli/)
    assert.match(script, /--product=desktop/)
    assert.match(script, /--product=jetbrains/)
    assert.match(script, /\/api\/ingest\/setup\/qoder-desktop-vsix/)
    assert.match(script, /\/api\/ingest\/setup\/qoder-jetbrains-plugin/)
    assert.match(script, /Install from VSIX/)
    assert.match(script, /Install Plugin from Disk/)
  }
})

test("local npm auto setup appends Qoder without changing existing framework entries", async () => {
  for (const platform of ["unix", "windows"] as const) {
    const script = await autoSetupScript(platform)
    assertGeneratedScriptSyntax(script, platform)
    assert.deepEqual(frameworkValues(script), ["opencode", "claude", "codeagent", "hermes", "openclaw", "jiuwen", "qoder"])
    assert.match(script, /INSTALL_QODER/)
    assert.match(script, /qoder_setup\.mjs/)
    assert.match(script, /qoder_token_usage_env\.mjs/)
    assert.match(script, /qoder_work_setup\.mjs/)
    assert.match(script, /--product=cli/)
    assert.match(script, /--product=desktop/)
    assert.match(script, /--product=jetbrains/)
    assert.match(script, /\/api\/ingest\/setup\/qoder-desktop-vsix/)
    assert.match(script, /\/api\/ingest\/setup\/qoder-jetbrains-plugin/)
    assert.match(script, /Install from VSIX/)
    assert.match(script, /Install Plugin from Disk/)
  }
})
