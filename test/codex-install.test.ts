import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import http from "node:http"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createRequire } from "node:module"
import AdmZip from "adm-zip"

import { GET as getInstaller } from "@/app/api/ingest/setup/codex/route"
import { GET as getAsset } from "@/app/api/ingest/setup/codex/assets/[asset]/route"

const require = createRequire(import.meta.url)
const {
  HOOK_EVENTS,
  MATCHER_EVENTS,
} = require("../scripts/agent-trace-collectors/codex/codex-trace-core.cjs")
const {
  OTEL_BEGIN,
  OTEL_END,
  installHooksDocument,
  installOtelBlock,
  removeCollectorHooks,
  uninstallOtelBlock,
} = require("../scripts/agent-trace-collectors/codex/config-core.cjs")
const {
  assertSupportedRuntime,
  install,
  isSupportedCodexVersion,
  parseCodexVersion,
} = require("../scripts/agent-trace-collectors/codex/install.cjs")
const {
  buildVsix,
} = require("../scripts/agent-trace-collectors/codex/build-vsix.cjs")

const LEGACY_ASSETS = [
  "trace-transport.cjs",
  "codex-trace-core.cjs",
  "config-core.cjs",
  "hook-handler.cjs",
  "relay.cjs",
  "install.cjs",
  "uninstall.cjs",
  "self-check.cjs",
  "build-vsix.cjs",
  "extension-package.json",
  "extension.cjs",
  "ide-trace-core.cjs",
  "extension.vsixmanifest",
  "Content_Types.xml",
]

const BUNDLE_ENTRIES = [
  "codex/build-vsix.cjs",
  "codex/codex-trace-core.cjs",
  "codex/config-core.cjs",
  "codex/hook-handler.cjs",
  "codex/install.cjs",
  "codex/relay.cjs",
  "codex/self-check.cjs",
  "codex/uninstall.cjs",
  "codex/vscode-extension/[Content_Types].xml",
  "codex/vscode-extension/extension.cjs",
  "codex/vscode-extension/extension.vsixmanifest",
  "codex/vscode-extension/ide-trace-core.cjs",
  "codex/vscode-extension/package.json",
  "shared/trace-transport.cjs",
]

function resolveBashCommand(): string | undefined {
  const candidates = process.platform === "win32"
    ? [
        path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"),
        path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin", "bash.exe"),
      ]
    : ["bash"]
  return candidates.find((candidate) => {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true })
    return probe.status === 0 && /GNU bash/.test(probe.stdout)
  })
}

const BASH_COMMAND = resolveBashCommand()

async function tempDir(t: test.TestContext) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-install-"))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  return dir
}

function runProcess(
  command: string,
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: options.env,
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
    if (options.input !== undefined) child.stdin.end(options.input)
  })
}

function closeServer(server: http.Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

async function bundleBytes(): Promise<Buffer> {
  const response = await getAsset(
    new Request("https://insight.example/assets/codex-collector-bundle.zip"),
    { params: Promise.resolve({ asset: "codex-collector-bundle.zip" }) },
  )
  assert.equal(response.status, 200)
  return Buffer.from(await response.arrayBuffer())
}

async function serveBundle(t: test.TestContext, bundle: Buffer): Promise<string> {
  const server = http.createServer((request, response) => {
    if (request.url === "/api/ingest/setup/codex/assets/codex-collector-bundle.zip") {
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
  t.after(() => closeServer(server))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  return `http://127.0.0.1:${address.port}`
}

async function runBashInstaller(source: string, homeDir: string) {
  assert.ok(BASH_COMMAND, "Bash is unavailable")
  return runProcess(BASH_COMMAND, [
    "-s",
    "--",
    "--home",
    homeDir,
    "--no-start",
    "--skip-editor-install",
    "--skip-version-check",
  ], {
    input: source,
    env: {
      ...process.env,
      AGENT_INSIGHT_API_KEY: "test-codex-key",
    },
  })
}

async function runPowerShellInstaller(source: string, homeDir: string) {
  const command = [
    "$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AGENT_INSIGHT_CODEX_INSTALLER_SOURCE))",
    "& ([ScriptBlock]::Create($source)) '--home' $env:AGENT_INSIGHT_CODEX_INSTALLER_HOME '--no-start' '--skip-editor-install' '--skip-version-check'",
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
  ].join("; ")
  return runProcess("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], {
    env: {
      ...process.env,
      AGENT_INSIGHT_API_KEY: "test-codex-key",
      AGENT_INSIGHT_CODEX_INSTALLER_HOME: homeDir,
      AGENT_INSIGHT_CODEX_INSTALLER_SOURCE: Buffer.from(source).toString("base64"),
    },
  })
}

async function assertInstallerLifecycle(
  t: test.TestContext,
  platform: "unix" | "windows",
  runInstaller: (source: string, homeDir: string) => Promise<{
    code: number | null
    stdout: string
    stderr: string
  }>,
) {
  const origin = await serveBundle(t, await bundleBytes())
  const response = await getInstaller(new Request(
    `${origin}/api/ingest/setup/codex`,
    { headers: { "x-platform": platform } },
  ))
  const source = await response.text()
  const homeDir = await tempDir(t)
  const collectorDir = path.join(homeDir, ".agent-insight", "collectors", "codex")

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const installed = await runInstaller(source, homeDir)
    assert.equal(installed.code, 0, installed.stderr || installed.stdout)
    assert.match(installed.stdout, /Agent Insight Codex collector installed/)
    assert.equal(
      await fsp.readFile(path.join(collectorDir, "vscode-extension", "[Content_Types].xml"), "utf8")
        .then(() => true, () => false),
      true,
    )

    if (attempt === 0) {
      const removed = spawnSync(process.execPath, [
        path.join(collectorDir, "uninstall.cjs"),
        "--home",
        homeDir,
        "--keep-extension",
      ], { encoding: "utf8", windowsHide: true })
      assert.equal(removed.status, 0, removed.stderr || removed.stdout)
      assert.equal(await fsp.stat(collectorDir).then(() => true, () => false), false)
    }
  }
}

async function assertTamperedBundleRejected(
  t: test.TestContext,
  platform: "unix" | "windows",
  runInstaller: (source: string, homeDir: string) => Promise<{
    code: number | null
    stdout: string
    stderr: string
  }>,
) {
  const tamperedBundle = await bundleBytes()
  tamperedBundle[tamperedBundle.length - 1] ^= 0xff
  const origin = await serveBundle(t, tamperedBundle)
  const response = await getInstaller(new Request(
    `${origin}/api/ingest/setup/codex`,
    { headers: { "x-platform": platform } },
  ))
  const homeDir = await tempDir(t)
  const result = await runInstaller(await response.text(), homeDir)
  assert.notEqual(result.code, 0, result.stderr || result.stdout)
  assert.match(`${result.stdout}\n${result.stderr}`, /bundle SHA-256 mismatch/i)
  assert.equal(
    await fsp.stat(path.join(homeDir, ".agent-insight", "collectors", "codex"))
      .then(() => true, () => false),
    false,
  )
}

test("hooks installer appends all 11 handlers, honors matcher support, and is idempotent", () => {
  const original = {
    description: "keep",
    unknown: { nested: true },
    hooks: {
      PreToolUse: [{
        matcher: "^Bash$",
        hooks: [{ type: "command", command: "existing", extra: 1 }],
      }],
    },
  }
  const handlerPath = path.resolve("/home/test/.agent-insight/collectors/codex/hook-handler.cjs")
  const first = installHooksDocument(original, {
    handlerPath,
    nodePath: "/usr/bin/node",
  })
  const second = installHooksDocument(first.document, {
    handlerPath,
    nodePath: "/usr/bin/node",
  })
  assert.equal(first.added, 11)
  assert.equal(second.added, 0)
  assert.deepEqual(first.document.unknown, original.unknown)
  assert.deepEqual(first.document.hooks.PreToolUse[0], original.hooks.PreToolUse[0])
  for (const eventName of HOOK_EVENTS) {
    const collectorGroup = first.document.hooks[eventName].find((group: {
      hooks?: Array<{ command?: string }>
    }) => group.hooks?.some((handler) => handler.command?.includes("hook-handler.cjs")))
    assert.ok(collectorGroup, eventName)
    assert.equal(
      Object.hasOwn(collectorGroup, "matcher"),
      MATCHER_EVENTS.has(eventName),
      eventName,
    )
    const handler = collectorGroup.hooks[0]
    assert.equal(handler.timeout, eventName === "SessionEnd" ? 3 : 5)
    assert.equal(handler.async, undefined)
  }
})

test("hooks uninstaller removes only the normalized Agent Insight handler path", () => {
  const handlerPath = path.resolve("C:\\Users\\test\\.agent-insight\\collectors\\codex\\hook-handler.cjs")
  const installed = installHooksDocument({
    hooks: {
      Stop: [{
        hooks: [{ type: "command", command: "node existing.cjs" }],
      }],
    },
  }, {
    handlerPath,
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
  })
  const removed = removeCollectorHooks(installed.document, { handlerPath })
  assert.equal(removed.removed, 11)
  assert.deepEqual(removed.document.hooks.Stop, [{
    hooks: [{ type: "command", command: "node existing.cjs" }],
  }])
  assert.equal(removed.document.hooks.SessionStart, undefined)
})

test("OTel managed block installs into an empty config and uninstalls cleanly", () => {
  const source = "[features]\nhooks = true\n"
  const installed = installOtelBlock(source, {
    relayPort: 43191,
    installSecret: "secret",
  })
  assert.equal(installed.conflict, false)
  assert.match(installed.source, new RegExp(OTEL_BEGIN))
  assert.match(installed.source, /protocol = "json"/)
  assert.match(installed.source, /log_user_prompt = true/)
  assert.match(installed.source, /127\.0\.0\.1:43191\/v1\/logs/)
  const removed = uninstallOtelBlock(installed.source, installed.previousBlock)
  assert.equal(removed.source, source)
})

test("OTel exporter none is restored byte-for-byte after uninstall", () => {
  const original = [
    "[features]",
    "hooks = true",
    "",
    "[otel]",
    'environment = "local"',
    'exporter = "none"',
    "log_user_prompt = true",
    "",
    "[mcp_servers.demo]",
    'command = "demo"',
    "",
  ].join("\n")
  const installed = installOtelBlock(original, {
    relayPort: 43191,
    installSecret: "secret",
  })
  assert.equal(installed.conflict, false)
  assert.ok(installed.previousBlock?.includes('exporter = "none"'))
  const removed = uninstallOtelBlock(installed.source, installed.previousBlock)
  assert.equal(removed.source, original)
})

test("OTel uninstall preserves a Codex-added MCP table inside the marker tail", () => {
  const source = "[features]\nhooks = true\n"
  const installed = installOtelBlock(source, {
    relayPort: 43191,
    installSecret: "secret",
  })
  const mcpTable = [
    "[mcp_servers.fixture]",
    'command = "node"',
    'args = ["fixture.cjs"]',
    "",
  ].join("\n")
  const mutated = installed.source.replace(
    OTEL_END,
    `${mcpTable}${OTEL_END}`,
  )
  const removed = uninstallOtelBlock(mutated, installed.previousBlock)
  assert.doesNotMatch(removed.source, /Agent Insight Codex OTel/i)
  assert.doesNotMatch(removed.source, /^\s*\[otel\]\s*$/m)
  assert.match(removed.source, /^\[mcp_servers\.fixture\]$/m)
  assert.match(removed.source, /^command = "node"$/m)
  assert.match(removed.source, /^args = \["fixture\.cjs"\]$/m)
})

test("OTel installer reports an existing exporter conflict without changing config", () => {
  for (const original of [
    '[otel]\nexporter = { otlp-http = { endpoint = "https://other" } }\n',
    '[otel]\nexporter = "none"\n\n[otel.logs]\nendpoint = "other"\n',
  ]) {
    const result = installOtelBlock(original, {
      relayPort: 43191,
      installSecret: "secret",
    })
    assert.equal(result.conflict, true)
    assert.equal(result.changed, false)
    assert.equal(result.source, original)
  }
})

test("source installer roundtrip preserves unrelated hooks and restores config", async (t) => {
  const homeDir = await tempDir(t)
  const codexDir = path.join(homeDir, ".codex")
  await fsp.mkdir(codexDir, { recursive: true })
  const hooksPath = path.join(codexDir, "hooks.json")
  const configPath = path.join(codexDir, "config.toml")
  const originalHooks = {
    description: "existing",
    hooks: {
      Stop: [{
        hooks: [{ type: "command", command: "node existing.cjs" }],
      }],
    },
  }
  const originalConfig = "[features]\nhooks = true\n"
  await fsp.writeFile(hooksPath, `${JSON.stringify(originalHooks, null, 2)}\n`)
  await fsp.writeFile(configPath, originalConfig)
  const previousKey = process.env.AGENT_INSIGHT_API_KEY
  const previousUrl = process.env.AGENT_INSIGHT_BASE_URL
  process.env.AGENT_INSIGHT_API_KEY = "test-api-key"
  process.env.AGENT_INSIGHT_BASE_URL = "https://insight.example"
  t.after(() => {
    if (previousKey === undefined) delete process.env.AGENT_INSIGHT_API_KEY
    else process.env.AGENT_INSIGHT_API_KEY = previousKey
    if (previousUrl === undefined) delete process.env.AGENT_INSIGHT_BASE_URL
    else process.env.AGENT_INSIGHT_BASE_URL = previousUrl
  })
  const result = await install({
    homeDir,
    sourceDir: path.join(process.cwd(), "scripts", "agent-trace-collectors", "codex"),
    relayPort: 43191,
    startRelay: false,
    installEditors: false,
    skipVersionCheck: true,
  })
  assert.equal(result.hooksAdded, 11)
  const installedHooks = await fsp.readFile(hooksPath, "utf8")
  assert.doesNotMatch(installedHooks, /test-api-key/)
  assert.match(await fsp.readFile(configPath, "utf8"), /AGENT INSIGHT CODEX OTEL/)
  const collectorConfig = JSON.parse(await fsp.readFile(
    path.join(homeDir, ".agent-insight", "collectors", "codex", "config.json"),
    "utf8",
  ))
  assert.equal(collectorConfig.apiKey, "test-api-key")
  if (process.platform !== "win32") {
    const configStat = await fsp.stat(
      path.join(homeDir, ".agent-insight", "collectors", "codex", "config.json"),
    )
    assert.equal(configStat.mode & 0o777, 0o600)
  }

  const managedUninstaller = path.join(
    homeDir,
    ".agent-insight",
    "collectors",
    "codex",
    "uninstall.cjs",
  )
  const uninstallResult = spawnSync(process.execPath, [
    managedUninstaller,
    "--home",
    homeDir,
    "--keep-files",
    "--keep-extension",
  ], { encoding: "utf8" })
  assert.equal(uninstallResult.status, 0, uninstallResult.stderr)
  assert.deepEqual(
    JSON.parse(await fsp.readFile(hooksPath, "utf8")),
    originalHooks,
  )
  assert.equal(await fsp.readFile(configPath, "utf8"), originalConfig)
})

test("reinstall preserves the original OTel block for later uninstall", async (t) => {
  const homeDir = await tempDir(t)
  const codexDir = path.join(homeDir, ".codex")
  const hooksPath = path.join(codexDir, "hooks.json")
  const configPath = path.join(codexDir, "config.toml")
  await fsp.mkdir(codexDir, { recursive: true })
  const originalHooks = {
    custom: { keep: true },
    hooks: {
      SessionStart: [{
        matcher: "custom",
        hooks: [{ type: "command", command: "/usr/bin/true" }],
      }],
    },
  }
  const originalConfig = [
    "[features]",
    "hooks = true",
    "",
    "[otel]",
    'exporter = "none"',
    "log_user_prompt = true",
    "",
  ].join("\n")
  await fsp.writeFile(hooksPath, `${JSON.stringify(originalHooks, null, 2)}\n`)
  await fsp.writeFile(configPath, originalConfig)
  const previousKey = process.env.AGENT_INSIGHT_API_KEY
  const previousUrl = process.env.AGENT_INSIGHT_BASE_URL
  process.env.AGENT_INSIGHT_API_KEY = "test-api-key"
  process.env.AGENT_INSIGHT_BASE_URL = "https://insight.example"
  t.after(() => {
    if (previousKey === undefined) delete process.env.AGENT_INSIGHT_API_KEY
    else process.env.AGENT_INSIGHT_API_KEY = previousKey
    if (previousUrl === undefined) delete process.env.AGENT_INSIGHT_BASE_URL
    else process.env.AGENT_INSIGHT_BASE_URL = previousUrl
  })
  const options = {
    homeDir,
    sourceDir: path.join(process.cwd(), "scripts", "agent-trace-collectors", "codex"),
    relayPort: 43191,
    startRelay: false,
    installEditors: false,
    skipVersionCheck: true,
  }

  await install(options)
  await install(options)

  const managedUninstaller = path.join(
    homeDir,
    ".agent-insight",
    "collectors",
    "codex",
    "uninstall.cjs",
  )
  const uninstallResult = spawnSync(process.execPath, [
    managedUninstaller,
    "--home",
    homeDir,
    "--keep-files",
    "--keep-extension",
  ], { encoding: "utf8" })
  assert.equal(uninstallResult.status, 0, uninstallResult.stderr)
  assert.deepEqual(
    JSON.parse(await fsp.readFile(hooksPath, "utf8")),
    originalHooks,
  )
  assert.equal(await fsp.readFile(configPath, "utf8"), originalConfig)
})

test("source uninstaller removes a config.toml created by installation", async (t) => {
  const homeDir = await tempDir(t)
  const codexDir = path.join(homeDir, ".codex")
  const hooksPath = path.join(codexDir, "hooks.json")
  const configPath = path.join(codexDir, "config.toml")
  const previousKey = process.env.AGENT_INSIGHT_API_KEY
  const previousUrl = process.env.AGENT_INSIGHT_BASE_URL
  process.env.AGENT_INSIGHT_API_KEY = "test-api-key"
  process.env.AGENT_INSIGHT_BASE_URL = "https://insight.example"
  t.after(() => {
    if (previousKey === undefined) delete process.env.AGENT_INSIGHT_API_KEY
    else process.env.AGENT_INSIGHT_API_KEY = previousKey
    if (previousUrl === undefined) delete process.env.AGENT_INSIGHT_BASE_URL
    else process.env.AGENT_INSIGHT_BASE_URL = previousUrl
  })

  await install({
    homeDir,
    sourceDir: path.join(process.cwd(), "scripts", "agent-trace-collectors", "codex"),
    relayPort: 43191,
    startRelay: false,
    installEditors: false,
    skipVersionCheck: true,
  })
  assert.match(await fsp.readFile(configPath, "utf8"), /AGENT INSIGHT CODEX OTEL/)

  const managedUninstaller = path.join(
    homeDir,
    ".agent-insight",
    "collectors",
    "codex",
    "uninstall.cjs",
  )
  const uninstallResult = spawnSync(process.execPath, [
    managedUninstaller,
    "--home",
    homeDir,
    "--keep-files",
    "--keep-extension",
  ], { encoding: "utf8" })
  assert.equal(uninstallResult.status, 0, uninstallResult.stderr)
  await assert.rejects(fsp.access(configPath), { code: "ENOENT" })
  await assert.rejects(fsp.access(hooksPath), { code: "ENOENT" })
})

test("VSIX builder creates the standard manifest and extension payload", async (t) => {
  const dir = await tempDir(t)
  const outputPath = path.join(dir, "collector.vsix")
  const repeatedOutputPath = path.join(dir, "collector-repeat.vsix")
  const result = await buildVsix({ outputPath })
  await buildVsix({ outputPath: repeatedOutputPath })
  assert.deepEqual(result.entries, [
    "extension.vsixmanifest",
    "[Content_Types].xml",
    "extension/package.json",
    "extension/extension.cjs",
    "extension/ide-trace-core.cjs",
  ])
  const archive = await fsp.readFile(outputPath)
  assert.equal(archive.readUInt32LE(0), 0x04034b50)
  for (const entry of result.entries) {
    assert.ok(archive.includes(Buffer.from(entry)), entry)
  }
  assert.deepEqual(archive, await fsp.readFile(repeatedOutputPath))
})

test("setup route escapes forwarded origins for Bash and PowerShell", async () => {
  const forwardedHost = 'proxy.example/$HOME-$(touch codex-pwn)-`id`-"quoted"-$env:USERPROFILE'
  const bash = await getInstaller(new Request(
    "https://insight.example/api/ingest/setup/codex",
    { headers: { "x-forwarded-host": forwardedHost, "x-forwarded-proto": "https" } },
  )).then((response) => response.text())
  const powerShell = await getInstaller(new Request(
    "https://insight.example/api/ingest/setup/codex",
    {
      headers: {
        "x-forwarded-host": forwardedHost,
        "x-forwarded-proto": "https",
        "x-platform": "windows",
      },
    },
  )).then((response) => response.text())

  assert.ok(bash.includes('https://proxy.example/\\$HOME-\\$(touch codex-pwn)-\\`id\\`-\\"quoted\\"-\\$env:USERPROFILE'))
  assert.ok(powerShell.includes('https://proxy.example/`$HOME-`$(touch codex-pwn)-``id``-`"quoted`"-`$env:USERPROFILE'))
})

test("setup serves one deterministic Codex bundle whose digest covers all 14 assets", async () => {
  const bashResponse = await getInstaller(new Request("https://insight.example/api/ingest/setup/codex"))
  const powerShellResponse = await getInstaller(new Request(
    "https://insight.example/api/ingest/setup/codex",
    { headers: { "x-platform": "windows" } },
  ))
  const bash = await bashResponse.text()
  const powerShell = await powerShellResponse.text()
  const bashDigest = /EXPECTED_BUNDLE_SHA256="([0-9a-f]{64})"/.exec(bash)?.[1]
  const powerShellDigest = /\$expectedBundleSha256 = "([0-9a-f]{64})"/.exec(powerShell)?.[1]
  assert.ok(bashDigest, "Bash bootstrap must embed a concrete bundle digest")
  assert.equal(powerShellDigest, bashDigest)
  assert.match(bash, /codex-collector-bundle\.zip/)
  assert.match(powerShell, /codex-collector-bundle\.zip/)
  assert.ok(bash.indexOf("ACTUAL_BUNDLE_SHA256") < bash.indexOf("unzip -q"))
  assert.ok(bash.indexOf("unzip -q") < bash.indexOf('node "$STAGING_DIR/codex/install.cjs"'))
  assert.ok(powerShell.indexOf("Get-FileHash") < powerShell.indexOf("Expand-Archive"))
  assert.ok(powerShell.indexOf("Expand-Archive") < powerShell.indexOf("& node"))
  assert.doesNotMatch(bash, /apiKey=/)
  assert.doesNotMatch(powerShell, /apiKey=/)

  const first = await bundleBytes()
  const second = await bundleBytes()
  assert.equal(createHash("sha256").update(first).digest("hex"), bashDigest)
  assert.deepEqual(first, second)
  assert.deepEqual(
    new AdmZip(first).getEntries().map((entry) => entry.entryName).sort(),
    BUNDLE_ENTRIES,
  )

  const probe = [
    'import { codexCollectorBundle } from "./src/app/api/ingest/setup/codex/bundle.ts"',
    "process.stdout.write(codexCollectorBundle(process.cwd()).sha256)",
  ].join("; ")
  const digests = ["UTC", "Asia/Shanghai", "America/Los_Angeles"].map((timezone) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, TZ: timezone },
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout
  })
  assert.deepEqual(new Set(digests), new Set([bashDigest]))
})

test("legacy Codex assets are deprecated read-only responses and unknown keys stay 404", async () => {
  for (const asset of ["constructor", "toString", "../../package.json"]) {
    const response = await getAsset(
      new Request(`https://insight.example/assets/${encodeURIComponent(asset)}`),
      { params: Promise.resolve({ asset }) },
    )
    assert.equal(response.status, 404, asset)
  }
  for (const asset of LEGACY_ASSETS) {
    const response = await getAsset(
      new Request(`https://insight.example/assets/${asset}`),
      { params: Promise.resolve({ asset }) },
    )
    assert.equal(response.status, 200, asset)
    assert.ok((await response.text()).length > 20, asset)
    assert.equal(response.headers.get("deprecation"), "true", asset)
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", asset)
  }
})

test("Bash bootstrap rejects a tampered bundle before installation", async (t) => {
  if (!BASH_COMMAND) {
    t.skip("Bash is unavailable")
    return
  }
  await assertTamperedBundleRejected(t, "unix", runBashInstaller)
})

test("PowerShell bootstrap rejects a tampered bundle before installation", async (t) => {
  if (spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { windowsHide: true }).error) {
    t.skip("PowerShell is unavailable")
    return
  }
  await assertTamperedBundleRejected(t, "windows", runPowerShellInstaller)
})

test("Bash bundle installer supports install, uninstall, and reinstall", async (t) => {
  if (!BASH_COMMAND) {
    t.skip("Bash is unavailable")
    return
  }
  await assertInstallerLifecycle(t, "unix", runBashInstaller)
})

test("PowerShell bundle installer supports install, uninstall, and reinstall", async (t) => {
  if (spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { windowsHide: true }).error) {
    t.skip("PowerShell is unavailable")
    return
  }
  await assertInstallerLifecycle(t, "windows", runPowerShellInstaller)
})

test("Codex version parser accepts the baseline and newer semantic releases", () => {
  const supported = parseCodexVersion("codex-cli 0.146.0")
  assert.deepEqual(supported, {
    major: 0,
    minor: 146,
    patch: 0,
    raw: "codex-cli 0.146.0",
  })
  assert.equal(isSupportedCodexVersion(parseCodexVersion("codex-cli 0.145.9")), true)
  assert.equal(isSupportedCodexVersion(parseCodexVersion("codex-cli 0.145.1-beta.1")), true)
  assert.equal(isSupportedCodexVersion(supported), true)
  assert.equal(isSupportedCodexVersion(parseCodexVersion("codex-cli 0.147.0")), true)
  assert.equal(isSupportedCodexVersion(parseCodexVersion("codex-cli 0.147.0-beta.1")), true)
  assert.equal(isSupportedCodexVersion(parseCodexVersion("codex-cli 1.0.0")), true)
  assert.equal(isSupportedCodexVersion(parseCodexVersion("codex-cli 0.145.0-beta.1")), false)
  assert.equal(isSupportedCodexVersion(parseCodexVersion("codex-cli 0.144.9")), false)
  assert.equal(parseCodexVersion("not a version"), undefined)
})

test("installer accepts a future Codex CLI from an isolated PATH", async (t) => {
  const binDir = await tempDir(t)
  const homeDir = await tempDir(t)
  const commandName = process.platform === "win32" ? "codex.cmd" : "codex"
  const commandPath = path.join(binDir, commandName)
  const command = process.platform === "win32"
    ? "@echo off\r\necho codex-cli 0.147.0\r\n"
    : "#!/bin/sh\necho 'codex-cli 0.147.0'\n"
  await fsp.writeFile(commandPath, command, "utf8")
  if (process.platform !== "win32") await fsp.chmod(commandPath, 0o755)

  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") || "PATH"
  const originalPath = process.env[pathKey]
  const previousKey = process.env.AGENT_INSIGHT_API_KEY
  process.env[pathKey] = `${binDir}${path.delimiter}${originalPath || ""}`
  process.env.AGENT_INSIGHT_API_KEY = "test-api-key"
  t.after(() => {
    process.env[pathKey] = originalPath
    if (previousKey === undefined) delete process.env.AGENT_INSIGHT_API_KEY
    else process.env.AGENT_INSIGHT_API_KEY = previousKey
  })

  assert.equal(assertSupportedRuntime().minor, 147)
  const result = await install({
    homeDir,
    sourceDir: path.join(process.cwd(), "scripts", "agent-trace-collectors", "codex"),
    startRelay: false,
    installEditors: false,
  })
  assert.equal(result.collectorDir, path.join(homeDir, ".agent-insight", "collectors", "codex"))
})

test("source checkout uninstaller refuses recursive removal outside managed path", () => {
  const script = path.join(
    process.cwd(),
    "scripts",
    "agent-trace-collectors",
    "codex",
    "uninstall.cjs",
  )
  const result = spawnSync(process.execPath, [script, "--purge", "--keep-extension"], {
    encoding: "utf8",
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Refusing to remove unexpected collector path/)
})

test("Windows hook handlers wrap node invocation in cmd /c", () => {
  const handlerPath = "C:\\Users\\test\\.agent-insight\\collectors\\codex\\hook-handler.cjs"
  // 模拟 Windows 平台：nodePath 为 Windows 可执行文件路径
  const installed = installHooksDocument({ hooks: {} }, {
    handlerPath,
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
  })
  const handler = installed.document.hooks.SessionStart[0].hooks[0]
  // command 保持原始 node 调用；commandWindows 用 cmd /c 包装（MSYS execvp 无法
  // 直接执行 PE 二进制，见 docs/tasks/bugs/issue-159-codex-open.md Bug 7）
  assert.equal(
    handler.command,
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\test\\.agent-insight\\collectors\\codex\\hook-handler.cjs"',
  )
  assert.ok(handler.commandWindows.startsWith('cmd /c "'), "commandWindows wraps in cmd /c")
  assert.ok(
    handler.commandWindows.includes('"C:\\Program Files\\nodejs\\node.exe"'),
    "commandWindows keeps node path",
  )
})
