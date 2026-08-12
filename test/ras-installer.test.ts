import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createRequire } from "node:module"
import {
  getAgentInsightBashDownloadHelper,
  getAgentInsightClientPackageSpec,
  getAgentInsightRasBashInstaller,
} from "../src/lib/ingest/setup-package"

const require = createRequire(import.meta.url)
const installer = require("../scripts/install-ras.js")

test("RAS installer accepts Python 3.10+ only", () => {
  assert.equal(installer.isSupportedPythonVersion("3.10.0"), true)
  assert.equal(installer.isSupportedPythonVersion("3.13.2"), true)
  assert.equal(installer.isSupportedPythonVersion("3.9.18"), false)
  assert.equal(installer.isSupportedPythonVersion("invalid"), false)
})

test("RAS config merge preserves user thresholds and updates runtime fields", () => {
  const merged = installer.mergeRasConfig(
    {
      agent_ras: {
        enabled: false,
        service: { transport: "http", custom: "keep" },
        insight: { enabled: false, custom: "keep" },
        llm_thinking_loop: { detection_start_chars: 1234 },
      },
      customRoot: true,
    },
    {
      python: "/usr/bin/python3",
      pythonHome: "/usr",
      libpython: "/usr/lib/libpython3.so",
      runtimeRoot: "/tmp/runtime",
      pythonPackages: "/tmp/runtime/.python-packages",
      eventsUrl: "http://localhost:3000/api/ingest/ras-events",
      apiKey: "secret",
    },
  )

  assert.equal(merged.customRoot, true)
  assert.equal(merged.agent_ras.enabled, true)
  assert.equal(merged.agent_ras.service.transport, "inproc")
  assert.equal(merged.agent_ras.service.custom, "keep")
  assert.equal(merged.agent_ras.service.python_packages, "/tmp/runtime/.python-packages")
  assert.equal(merged.agent_ras.insight.enabled, false)
  assert.equal(merged.agent_ras.insight.custom, "keep")
  assert.equal(merged.agent_ras.insight.api_key, "secret")
  assert.equal(merged.agent_ras.llm_thinking_loop.detection_start_chars, 1234)
  assert.equal(merged.agent_ras.llm_thinking_loop.semantic_content_enabled, true)
})

test("OpenCode config merge is idempotent and preserves existing agents", () => {
  const once = installer.mergeOpenCodeConfig({
    plugin: ["existing.js"],
    agent: { existing: { hidden: true } },
  })
  const twice = installer.mergeOpenCodeConfig(once)
  assert.deepEqual(twice.plugin, ["existing.js", "./plugins/agent-insight-ras.js"])
  assert.deepEqual(twice.agent.existing, { hidden: true })
})

test("generated OpenCode wrapper exports the RAS plugin exactly once", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "scripts/install-ras.js"),
    "utf8",
  )
  assert.match(source, /export \{ default \} from/)
  assert.doesNotMatch(source, /export \{ AgentRasPlugin, default \}/)
  assert.match(source, /'--ignore-installed'/)
})

test("invalid JSON is backed up before replacement", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ras-json-"))
  const file = path.join(root, "config.json")
  fs.writeFileSync(file, "{broken", "utf8")
  assert.deepEqual(installer.readJsonWithBackup(file, "test config"), {})
  const backups = fs.readdirSync(root).filter((name) => name.startsWith("config.json.bak."))
  assert.equal(backups.length, 1)
  assert.equal(fs.readFileSync(path.join(root, backups[0]), "utf8"), "{broken")
})

test("installer reports disabled, unsupported and missing-runtime states", () => {
  assert.equal(
    installer.installRas({ env: { AGENT_INSIGHT_RAS: "0" } }).status,
    "disabled",
  )
  assert.equal(
    installer.installRas({ env: {}, platform: "win32" }).status,
    "unsupported",
  )
  assert.equal(
    installer.installRas({ env: {}, platform: "linux", packageRoot: "/missing" }).status,
    "failed",
  )
})

test("Python probe accepts a venv whose shared library lives in base prefix", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ras-python-probe-"))
  const libpython = path.join(root, "libpython3.11.so")
  fs.writeFileSync(libpython, "")
  const runner = (command: string, args: string[]) => {
    if (args.includes("--version")) return { status: 0, stdout: "pip 24.0" }
    return {
      status: 0,
      stdout: JSON.stringify({
        version: "3.11.9",
        executable: command,
        home: path.join(root, "venv"),
        libpython,
      }),
    }
  }
  const result = installer.probePython({ candidates: ["/tmp/venv/bin/python"], runner })
  assert.equal(result.status, "ready")
  assert.equal(result.libpython, libpython)
})

test("npm manifest includes RAS runtime without tests or caches", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
  )
  const files = new Set<string>(pkg.files as string[])
  assert.equal(files.has("agent_ras/"), true)
  for (const entry of installer.RUNTIME_ENTRIES) {
    assert.equal(fs.existsSync(path.join(process.cwd(), "agent_ras", entry)), true)
  }
  assert.equal([...files].some((entry) => entry.startsWith("agent_ras/tests")), false)
  assert.equal(
    [...files].some((entry) => !entry.startsWith("!") && entry.includes("__pycache__")),
    false,
  )
  assert.equal(files.has("scripts/"), true)
  assert.equal(files.has("!scripts/**/__pycache__/"), true)
  assert.equal(files.has("!.next/standalone/.env"), true)
  assert.equal(files.has("!.next/standalone/logs/"), true)
  assert.equal(files.has("!.next/standalone/**/*.log"), true)
  assert.equal(files.has("!.next/standalone/**/*.db"), true)
  assert.equal(files.has("!.next/standalone/scripts/otel_data/"), true)
  const npmignore = fs.readFileSync(path.join(process.cwd(), ".npmignore"), "utf8")
  assert.match(npmignore, /agent_ras\/tests\//)
  assert.match(npmignore, /agent_ras\/\*\*\/__pycache__\//)
  assert.match(npmignore, /scripts\/\*\*\/__pycache__\//)
  assert.match(npmignore, /scripts\/otel_data\//)
})

test("OpenCode setup scripts install RAS on the Agent host and fail open", () => {
  const downloadSource = getAgentInsightBashDownloadHelper()
  assert.match(downloadSource, /\.tmp\.\$\$/)
  assert.match(downloadSource, /curl -sSf/)
  assert.match(downloadSource, /mv -f/)

  const installerSource = getAgentInsightRasBashInstaller()
  assert.match(installerSource, /npm pack --ignore-scripts/)
  assert.match(installerSource, /NPM_CONFIG_CACHE=/)
  assert.match(installerSource, /for ras_attempt in 1 2 3/)
  assert.match(installerSource, /agent_ras\/pyproject\.toml/)
  assert.match(installerSource, /scripts\/install-ras\.js/)
  assert.match(installerSource, /__agent_insight_ras_preflight__/)
  assert.match(installerSource, /--max-time 60/)
  assert.doesNotMatch(installerSource, /\bnpx\b/)

  for (const relativePath of [
    "src/app/api/ingest/setup/route.ts",
    "src/app/api/ingest/setup/auto/route.ts",
  ]) {
    const source = fs.readFileSync(path.join(process.cwd(), relativePath), "utf8")
    assert.match(
      source,
      /install_agent_insight_ras/,
    )
    assert.match(source, /getAgentInsightClientPackageSpec/)
    assert.match(source, /Agent RAS installation (failed|skipped); telemetry setup will continue/)
    assert.match(source, /use WSL on Windows/)
    // 目标观测栈：OpenCode 组件经 /api/setup/*（rewrite 到 ingest），与 Qoder/Trae 一致。
    assert.match(source, /\$AGENT_INSIGHT_BASE_URL\/api\/setup\/opencode/)
    assert.doesNotMatch(
      source,
      /npx --yes --package="\$AGENT_INSIGHT_PACKAGE_SPEC" agent-insight install-ras/,
    )
  }
})

test("client setup pins RAS installation to the serving package version", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
  )
  assert.equal(
    getAgentInsightClientPackageSpec(),
    `${pkg.name}@${pkg.version}`,
  )

  const previous = process.env.AGENT_INSIGHT_CLIENT_PACKAGE_SPEC
  process.env.AGENT_INSIGHT_CLIENT_PACKAGE_SPEC = "https://packages.example/agent-insight.tgz"
  try {
    assert.equal(
      getAgentInsightClientPackageSpec(),
      "https://packages.example/agent-insight.tgz",
    )
  } finally {
    if (previous === undefined) {
      delete process.env.AGENT_INSIGHT_CLIENT_PACKAGE_SPEC
    } else {
      process.env.AGENT_INSIGHT_CLIENT_PACKAGE_SPEC = previous
    }
  }
})

test("platform startup does not install or require an Agent-host RAS runtime", () => {
  for (const relativePath of [
    "scripts/develop_start.sh",
    "scripts/start.sh",
    "scripts/start.js",
  ]) {
    const source = fs.readFileSync(path.join(process.cwd(), relativePath), "utf8")
    assert.doesNotMatch(source, /install-ras\.js --check|checkRasInstallation/)
  }

  const installSource = fs.readFileSync(
    path.join(process.cwd(), "scripts/install.js"),
    "utf8",
  )
  assert.doesNotMatch(installSource, /installRas|require\(['"]\.\/install-ras\.js/)
})

test("OpenCode RAS defers embedded Python initialization until an observed event", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "agent_ras/platform_adapter/opencode/plugin.js"),
    "utf8",
  )
  assert.doesNotMatch(source, /ras\.ensure\(\)/)
  assert.match(source, /await ras\.hello\(/)
})

test("prepack removes duplicate RAS source from standalone output", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "scripts/prepare-npm-package.js"),
    "utf8",
  )
  assert.match(source, /STANDALONE_JUNK_DIRS[\s\S]*'agent_ras'/)
  assert.match(source, /STANDALONE_JUNK_DIRS[\s\S]*'\.git'/)
  assert.match(source, /STANDALONE_JUNK_DIRS[\s\S]*'logs'/)
  assert.match(source, /STANDALONE_JUNK_FILES[\s\S]*'\.env'/)
  assert.match(source, /STANDALONE_JUNK_FILES[\s\S]*'server\.log'/)
})

test("all startup paths run the non-destructive RAS SQLite preflight", () => {
  const migrationSource = fs.readFileSync(
    path.join(process.cwd(), "scripts/prepare-ras-sqlite-schema.js"),
    "utf8",
  )
  assert.match(migrationSource, /ADD COLUMN "deliveryId" TEXT/)
  assert.match(migrationSource, /HAVING COUNT\(\*\) > 1/)
  assert.match(
    migrationSource,
    /CREATE UNIQUE INDEX IF NOT EXISTS "RasAnomalyEvent_taskId_deliveryId_key"/,
  )

  for (const relativePath of [
    "scripts/develop_start.sh",
    "scripts/start.sh",
    "scripts/start.js",
    "scripts/postinstall.js",
    "scripts/docker-entrypoint.sh",
  ]) {
    const source = fs.readFileSync(path.join(process.cwd(), relativePath), "utf8")
    assert.match(source, /prepare-ras-sqlite-schema\.js/)
  }
})
