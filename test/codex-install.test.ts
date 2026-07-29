import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createRequire } from "node:module"

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
  install,
  isSupportedCodexVersion,
  parseCodexVersion,
} = require("../scripts/agent-trace-collectors/codex/install.cjs")
const {
  buildVsix,
} = require("../scripts/agent-trace-collectors/codex/build-vsix.cjs")

const ASSETS = [
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

async function tempDir(t: test.TestContext) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-install-"))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  return dir
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
  assert.match(installed.source, /log_user_prompt = false/)
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

test("setup route is self-contained and assets use a fixed allowlist", async () => {
  const installer = await getInstaller(
    new Request("https://insight.example/api/ingest/setup/codex"),
  )
  const source = await installer.text()
  assert.equal(installer.status, 200)
  assert.match(source, /AGENT_INSIGHT_API_KEY/)
  assert.match(source, /Node\.js >=20/)
  assert.match(source, /api\/ingest\/setup\/codex\/assets/)
  assert.match(source, /node "\$STAGING_DIR\/codex\/install\.cjs"/)
  assert.doesNotMatch(source, /apiKey=/)

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

test("setup route returns the PowerShell staging installer for Windows", async () => {
  const installer = await getInstaller(new Request(
    "https://insight.example/api/ingest/setup/codex",
    { headers: { "x-platform": "windows" } },
  ))
  const source = await installer.text()
  assert.equal(installer.status, 200)
  assert.equal(installer.headers.get("content-type"), "application/x-powershell; charset=utf-8")
  assert.match(source, /install\.cjs/)
  assert.match(source, /Invoke-WebRequest/)
  assert.match(source, /--source-dir/)
  assert.doesNotMatch(source, /apiKey=/)
})

test("Codex version parser accepts the minimum compatible version and later releases", () => {
  const minimum = parseCodexVersion("codex-cli 0.145.0")
  assert.deepEqual(minimum, {
    major: 0,
    minor: 145,
    patch: 0,
    raw: "codex-cli 0.145.0",
  })
  assert.equal(isSupportedCodexVersion(minimum), true)
  assert.equal(isSupportedCodexVersion(parseCodexVersion("codex-cli 0.146.0")), true)
  assert.equal(isSupportedCodexVersion(parseCodexVersion("codex-cli 0.144.9")), false)
  assert.equal(parseCodexVersion("not a version"), undefined)
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
