import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { GET as getCentralSetup } from "@/app/api/ingest/setup/route"
import { GET as getAutoSetup } from "@/app/api/ingest/setup/auto/route"

const ROOT = process.cwd()
const EXPECTED_PAGE = ["opencode", "claude", "codeagent", "openclaw", "hermes", "jiuwen", "pi-agent"]
const EXPECTED_CENTRAL = ["opencode", "openclaw", "claude", "codeagent", "hermes", "jiuwen", "pi-agent"]
const EXPECTED_AUTO = ["opencode", "claude", "codeagent", "hermes", "openclaw", "jiuwen", "pi-agent"]

function frameworkValues(source: string, constantName: string): string[] {
  const block = new RegExp(`const ${constantName}[^=]*= \\[([\\s\\S]*?)\\n\\];`).exec(source)?.[1]
  assert.ok(block, `${constantName} list not found`)
  return [...block.matchAll(/value:\s*['"]([^'"]+)['"]/g)].map(match => match[1])
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8")
}

function parsePowerShell(source: string): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-insight-pi-ps-"))
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

test("Pi is appended without reordering any existing central framework list", () => {
  const page = read("src/app/(main)/accessconfig/install/page.tsx")
  const central = read("src/app/api/ingest/setup/route.ts")
  const auto = read("src/app/api/ingest/setup/auto/route.ts")

  assert.deepEqual(frameworkValues(page, "FRAMEWORK_OPTIONS"), EXPECTED_PAGE)
  assert.deepEqual(frameworkValues(central, "FRAMEWORKS"), EXPECTED_CENTRAL)
  assert.deepEqual(frameworkValues(auto, "FRAMEWORKS"), EXPECTED_AUTO)
  assert.match(page, /frameworks=\$\{frameworks\.join\(','\)\}/)
})

test("central setup preselects only Pi and keeps no-parameter installs interactive", async () => {
  for (const script of [
    await centralScript("unix", "pi-agent"),
    await autoScript("unix", "pi-agent"),
  ]) {
    assert.match(script, /SELECTED_FRAMEWORKS="pi-agent"/)
    assert.match(script, /FRAMEWORKS_PRESELECTED="true"/)
    assert.match(script, /api\/ingest\/setup\/pi-agent/)
    assert.match(script, /INSTALL_PI_AGENT=true/)
  }

  assert.match(await centralScript("unix"), /FRAMEWORKS_PRESELECTED="false"/)
  assert.match(await autoScript("unix"), /FRAMEWORKS_PRESELECTED="false"/)
})

test("central setup filters invalid framework values before generating either shell", async () => {
  const injected = 'pi-agent,$(touch PWN),";Write-Host PWN'
  for (const platform of ["unix", "windows"] as const) {
    for (const getScript of [centralScript, autoScript]) {
      const script = await getScript(platform, injected)
      assert.doesNotMatch(script, /\$\(touch PWN\)|Write-Host PWN/)
      assert.match(script, platform === "windows"
        ? /\$SELECTED_FRAMEWORKS = "pi-agent"/
        : /SELECTED_FRAMEWORKS="pi-agent"/)
    }
  }
})

test("generated Pi Bash and PowerShell setup scripts pass native syntax parsers", async () => {
  for (const script of [
    await centralScript("unix", "pi-agent"),
    await autoScript("unix", "pi-agent"),
  ]) {
    const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr || result.stdout)
  }

  parsePowerShell(await centralScript("windows", "pi-agent"))
  parsePowerShell(await autoScript("windows", "pi-agent"))
  parsePowerShell(read("scripts/agent-trace-collectors/pi-agent/install.ps1"))

  for (const script of [
    await centralScript("windows", "pi-agent"),
    await autoScript("windows", "pi-agent"),
  ]) {
    assert.match(script, /\$piSetup\.Content -is \[byte\[\]\]/)
    assert.match(script, /\[Text\.Encoding\]::UTF8\.GetString\(\$piSetup\.Content\)/)
  }
})

test("CLI exposes framework preselection and local installations are detectable", async () => {
  const help = spawnSync(process.execPath, ["bin/cli.js", "install", "--help"], {
    cwd: ROOT,
    encoding: "utf8",
  })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /--frameworks <list>/)

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

test("Pi Node installer self-checks, reinstalls, and purges only the current-key spool", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-insight-pi-install-"))
  const homeDir = path.join(tempDir, "home")
  const binDir = path.join(tempDir, "bin")
  const logPath = path.join(tempDir, "pi.log")
  const sourceDir = path.join(ROOT, "scripts", "agent-trace-collectors", "pi-agent")
  const installer = path.join(sourceDir, "install.cjs")
  const env = {
    ...process.env,
    AGENT_INSIGHT_API_KEY: "test-pi-key",
    AGENT_INSIGHT_BASE_URL: "https://insight.example",
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    USERPROFILE: homeDir,
    HOME: homeDir,
  }
  try {
    fs.mkdirSync(binDir, { recursive: true })
    fs.writeFileSync(path.join(binDir, "pi.cmd"), `@echo off\r\necho %*>>"${logPath}"\r\nexit /b 0\r\n`)
    fs.writeFileSync(path.join(binDir, "pi"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logPath.replace(/\\/g, "/")}"\n`)
    fs.chmodSync(path.join(binDir, "pi"), 0o755)

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = spawnSync(process.execPath, [
        installer,
        "--source-dir", sourceDir,
        "--home", homeDir,
        "--skip-version-check",
      ], { encoding: "utf8", env })
      assert.equal(result.status, 0, result.stderr || result.stdout)
      assert.match(result.stdout, /collector installed/)
    }

    const agentInsightHome = path.join(homeDir, ".agent-insight")
    const packageDir = path.join(agentInsightHome, "collectors", "pi-agent")
    const spoolRoot = path.join(agentInsightHome, "otel_data", "pi-agent")
    const currentSpools = fs.readdirSync(spoolRoot)
    assert.equal(currentSpools.length, 1)
    fs.writeFileSync(path.join(spoolRoot, currentSpools[0], "current.ndjson"), "{}\n")
    fs.mkdirSync(path.join(spoolRoot, "other-key"), { recursive: true })
    fs.writeFileSync(path.join(spoolRoot, "other-key", "keep.ndjson"), "{}\n")

    const uninstall = spawnSync(process.execPath, [
      path.join(packageDir, "scripts", "uninstall.cjs"),
      "--purge",
    ], { encoding: "utf8", env })
    assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout)
    assert.equal(fs.existsSync(packageDir), false)
    assert.equal(fs.existsSync(path.join(agentInsightHome, "collectors", "shared", "trace-transport.cjs")), true)
    assert.equal(fs.existsSync(path.join(spoolRoot, currentSpools[0])), false)
    assert.equal(fs.existsSync(path.join(spoolRoot, "other-key", "keep.ndjson")), true)

    const piCalls = fs.readFileSync(logPath, "utf8")
    assert.match(piCalls, /install/)
    assert.match(piCalls, /remove/)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
