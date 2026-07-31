import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { GET as getCentralSetup } from "@/app/api/ingest/setup/route"
import { GET as getAutoSetup } from "@/app/api/ingest/setup/auto/route"
import { aggregateOtelTraceEvents } from "@/lib/ingest/otel/aggregate"
import type { OtelTraceEvent } from "@/lib/ingest/otel/types"

const ROOT = process.cwd()
const EXPECTED_PAGE = ["opencode", "claude", "codeagent", "openclaw", "hermes", "jiuwen", "codex"]
const EXPECTED_CENTRAL = ["opencode", "openclaw", "claude", "codeagent", "hermes", "jiuwen", "codex"]
const EXPECTED_AUTO = ["opencode", "claude", "codeagent", "hermes", "openclaw", "jiuwen", "codex"]

function frameworkValues(source: string, constantName: string): string[] {
  const block = new RegExp(`const ${constantName}[^=]*= \\[([\\s\\S]*?)\\n\\];`).exec(source)?.[1]
  assert.ok(block, `${constantName} list not found`)
  return [...block.matchAll(/value:\s*['"]([^'"]+)['"]/g)].map(match => match[1])
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8")
}

function parsePowerShell(source: string): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-insight-codex-ps-"))
  const scriptPath = path.join(tempDir, "setup.ps1")
  try {
    fs.writeFileSync(scriptPath, source)
    const command = [
      "$tokens = $null",
      "$errors = $null",
      "[System.Management.Automation.Language.Parser]::ParseFile($env:AGENT_INSIGHT_PARSE_TARGET, [ref]$tokens, [ref]$errors) | Out-Null",
      "if ($errors.Count) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }",
    ].join("; ")
    const result = spawnSync("pwsh", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
      env: {
        ...process.env,
        AGENT_INSIGHT_PARSE_TARGET: scriptPath,
      },
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

async function centralScript(platform: "unix" | "windows", frameworks?: string): Promise<string> {
  const params = new URLSearchParams({ key: "test-key" })
  if (frameworks !== undefined) params.set("frameworks", frameworks)
  const response = await getCentralSetup(new Request(
    `https://insight.example/api/ingest/setup?${params}`,
    {
      headers: {
        host: "insight.example",
        "x-forwarded-proto": "https",
        "x-platform": platform,
      },
    },
  ))
  assert.equal(response.status, 200)
  return response.text()
}

async function autoScript(platform: "unix" | "windows", frameworks?: string): Promise<string> {
  const params = new URLSearchParams({
    apiKey: "test-key",
    host: "insight.example",
  })
  if (frameworks !== undefined) params.set("frameworks", frameworks)
  const response = await getAutoSetup(new Request(
    `https://insight.example/api/setup/auto?${params}`,
    {
      headers: {
        host: "insight.example",
        "x-forwarded-proto": "https",
        "x-platform": platform,
      },
    },
  ))
  assert.equal(response.status, 200)
  return response.text()
}

function genericEvent(completion: string, latencyMs: number): OtelTraceEvent {
  return {
    receivedAt: "2026-07-28T00:00:00.000Z",
    sessionId: "generic-session",
    traceId: "generic-trace",
    spanId: "stable-span",
    name: "chat",
    kind: "llm",
    serviceName: "generic-fixture",
    user: "alice",
    model: "fixture-model",
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
    },
    latencyMs,
    startTimeMs: 1_700_000_000_000,
    attributes: {
      "gen_ai.prompt": "query",
      "gen_ai.completion": completion,
    },
  }
}

test("Codex is appended without reordering any existing central framework list", () => {
  const page = read("src/app/(main)/accessconfig/install/page.tsx")
  const central = read("src/app/api/ingest/setup/route.ts")
  const auto = read("src/app/api/ingest/setup/auto/route.ts")

  assert.deepEqual(frameworkValues(page, "FRAMEWORK_OPTIONS"), EXPECTED_PAGE)
  assert.deepEqual(frameworkValues(central, "FRAMEWORKS"), EXPECTED_CENTRAL)
  assert.deepEqual(frameworkValues(auto, "FRAMEWORKS"), EXPECTED_AUTO)
  assert.match(page, /frameworks=\$\{frameworks\.join\(','\)\}/)
})

test("central setup preselects only Codex and keeps no-parameter installs interactive", async () => {
  for (const script of [
    await centralScript("unix", "codex"),
    await autoScript("unix", "codex"),
  ]) {
    assert.match(script, /SELECTED_FRAMEWORKS="codex"/)
    assert.match(script, /FRAMEWORKS_PRESELECTED="true"/)
    assert.match(script, /api\/ingest\/setup\/codex/)
    assert.match(script, /INSTALL_CODEX=true/)
    assert.match(script, /CODEX_INSTALLER="\$\(mktemp\)"/)
    assert.doesNotMatch(script, /setup\/codex"\s*\|\s*sh/)
  }

  assert.match(await centralScript("unix"), /FRAMEWORKS_PRESELECTED="false"/)
  assert.match(await autoScript("unix"), /FRAMEWORKS_PRESELECTED="false"/)
})

test("central setup filters invalid framework values before generating either shell", async () => {
  const injected = 'codex,$(touch PWN),";Write-Host PWN'
  for (const platform of ["unix", "windows"] as const) {
    for (const getScript of [centralScript, autoScript]) {
      const script = await getScript(platform, injected)
      assert.doesNotMatch(script, /\$\(touch PWN\)|Write-Host PWN/)
      assert.match(script, platform === "windows"
        ? /\$SELECTED_FRAMEWORKS = "codex"/
        : /SELECTED_FRAMEWORKS="codex"/)
    }
  }
})

test("generated Codex Bash and PowerShell setup scripts pass native syntax parsers", async () => {
  for (const script of [
    await centralScript("unix", "codex"),
    await autoScript("unix", "codex"),
  ]) {
    const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr || result.stdout)
  }

  parsePowerShell(await centralScript("windows", "codex"))
  parsePowerShell(await autoScript("windows", "codex"))
  parsePowerShell(read("scripts/agent-trace-collectors/codex/install.ps1"))

  for (const script of [
    await centralScript("windows", "codex"),
    await autoScript("windows", "codex"),
  ]) {
    assert.match(script, /-OutFile \$codexInstaller/)
    assert.match(script, /& \$codexInstaller/)
    assert.doesNotMatch(script, /\[scriptblock\]::Create/)
  }
})

test("CLI exposes framework preselection and detects the installed local package", async () => {
  const help = spawnSync(process.execPath, ["bin/cli.js", "install", "--help"], {
    cwd: ROOT,
    encoding: "utf8",
  })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /--frameworks <list>/)

  const invalid = spawnSync(process.execPath, ["bin/cli.js", "install", "--frameworks", "codex,unknown"], {
    cwd: ROOT,
    encoding: "utf8",
  })
  assert.notEqual(invalid.status, 0)
  assert.match(invalid.stderr, /Invalid framework list/)

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-insight-local-package-"))
  const linkPath = path.join(tempDir, "node_modules", "agent-insight")
  const previousCwd = process.cwd()
  try {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true })
    fs.symlinkSync(ROOT, linkPath, "junction")
    process.chdir(tempDir)
    const installModule = await import("../scripts/install.js")
    const isCurrentPackageInstalledInCwd = installModule.isCurrentPackageInstalledInCwd
      || installModule.default.isCurrentPackageInstalledInCwd
    assert.equal(isCurrentPackageInstalledInCwd(), true)
  } finally {
    process.chdir(previousCwd)
    fs.rmSync(tempDir, { recursive: true, force: true })
  }

  const installSource = read("scripts/install.js")
  assert.match(installSource, /setupParams\.set\('frameworks', frameworks\)/)
  assert.match(installSource, /isCurrentPackageInstalledInCwd\(\)/)
})

test("generic OTel duplicate spans retain the first snapshot", () => {
  const record = aggregateOtelTraceEvents("generic-session", [
    genericEvent("first snapshot", 10),
    genericEvent("later snapshot", 500),
  ])
  assert.equal(record?.framework, "generic-fixture")
  assert.equal(record?.final_result, "first snapshot")
})
