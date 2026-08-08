import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"
import test from "node:test"

import { formatUploaderRuntimeForLog, resolveUploaderRuntime } from "../scripts/opencode_plugin_otel"

function fakeExists(...paths: string[]) {
  const existing = new Set(paths)
  return (candidate: string) => existing.has(candidate)
}

test("plugin runtime: prefers node from PATH", () => {
  const runtime = resolveUploaderRuntime({
    platform: "linux",
    pathEnv: "/custom/bin:/usr/bin",
    execPath: "/opt/codeagent",
    commonPaths: [],
    exists: fakeExists("/custom/bin/node", "/custom/bin/bun"),
  })

  assert.deepEqual(runtime, { cmd: "/custom/bin/node", argsPrefix: [] })
})

test("plugin runtime: uses bun run when only bun is available in PATH", () => {
  const runtime = resolveUploaderRuntime({
    platform: "linux",
    pathEnv: "/custom/bin",
    execPath: "/opt/codeagent",
    commonPaths: [],
    exists: fakeExists("/custom/bin/bun"),
  })

  assert.deepEqual(runtime, { cmd: "/custom/bin/bun", argsPrefix: ["run"] })
})

test("plugin runtime: probes common absolute paths after PATH", () => {
  const runtime = resolveUploaderRuntime({
    platform: "linux",
    pathEnv: "/missing",
    execPath: "/opt/codeagent",
    commonPaths: ["/usr/local/bin/node", "/usr/bin/bun"],
    exists: fakeExists("/usr/bin/bun"),
  })

  assert.deepEqual(runtime, { cmd: "/usr/bin/bun", argsPrefix: ["run"] })
})

test("plugin runtime: accepts a supported host executable fallback", () => {
  assert.deepEqual(
    resolveUploaderRuntime({
      platform: "linux",
      pathEnv: "",
      execPath: "/opt/node/bin/node",
      commonPaths: [],
      exists: fakeExists(),
    }),
    { cmd: "/opt/node/bin/node", argsPrefix: [] },
  )

  assert.deepEqual(
    resolveUploaderRuntime({
      platform: "win32",
      pathEnv: "",
      execPath: "C:\\Tools\\bun.exe",
      commonPaths: [],
      exists: fakeExists(),
    }),
    { cmd: "C:\\Tools\\bun.exe", argsPrefix: ["run"] },
  )
})

test("plugin runtime: rejects an agent binary as process.execPath", () => {
  for (const execPath of ["/root/0CHOME/bin/codeagent", "/opt/opencode/bin/opencode"]) {
    const runtime = resolveUploaderRuntime({
      platform: "linux",
      pathEnv: "",
      execPath,
      commonPaths: [],
      exists: fakeExists(),
    })

    assert.equal(runtime, null, execPath)
  }
})

test("plugin runtime: formats an unavailable runtime without dereferencing it", () => {
  assert.deepEqual(formatUploaderRuntimeForLog(null), {
    command: "(unavailable)",
    argsPrefix: "(none)",
  })
  assert.deepEqual(formatUploaderRuntimeForLog({ cmd: "/usr/bin/node", argsPrefix: [] }), {
    command: "/usr/bin/node",
    argsPrefix: "(none)",
  })
  assert.deepEqual(formatUploaderRuntimeForLog({ cmd: "/usr/bin/bun", argsPrefix: ["run"] }), {
    command: "/usr/bin/bun",
    argsPrefix: "run",
  })
})

test("plugin runtime: initializes when no JavaScript runtime is available", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-insight-opencode-runtime-"))
  const pluginUrl = pathToFileURL(path.resolve("scripts/opencode_plugin_otel.ts")).href
  const script = `
    import fs from "node:fs"

    fs.existsSync = () => false
    process.execPath = "/opt/codeagent"

    const pluginModule = await import(${JSON.stringify(pluginUrl)})
    const initializePlugin = pluginModule.default?.default ?? pluginModule.default
    const hooks = await initializePlugin()
    if (!hooks || typeof hooks !== "object") throw new Error("plugin did not initialize")
    process.stdout.write("initialized")
    process.exit(0)
  `

  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: homeDir,
        PATH: "/runtime-not-found",
        AGENT_INSIGHT_OPENCODE_OTEL_ENABLE: "true",
        AGENT_INSIGHT_OPENCODE_SPOOL_DIR: path.join(homeDir, "spool"),
      },
      timeout: 10_000,
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, "initialized")
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})
