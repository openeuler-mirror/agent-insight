/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports -- The VM fixture mocks VS Code's CommonJS host boundary. */
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import vm from "node:vm"

const extensionRoot = path.join(process.cwd(), "integrations", "qoder-desktop")

test("Qoder CN Desktop VSIX manifest exposes startup, status commands, and Settings", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "package.json"), "utf8"))
  assert.equal(manifest.main, "./extension.js")
  assert.equal(manifest.version, "0.1.12")
  assert.equal(manifest.displayName, "Agent Insight Qoder CN Collector")
  assert.ok(manifest.activationEvents.includes("onStartupFinished"))
  assert.deepEqual(manifest.extensionKind, ["ui"])
  assert.ok(manifest.contributes.commands.some((item: any) => item.command === "agentInsightQoder.configure"))
  assert.equal(manifest.contributes.configuration.properties["agentInsightQoder.enabled"].default, true)
  assert.equal(manifest.contributes.configuration.properties["agentInsightQoder.maxContentChars"].default, 2000)
  assert.equal(manifest.contributes.configuration.properties["agentInsightQoder.purgeOnUninstall"].default, true)
})

test("Qoder Desktop activation keeps synchronous startup below 200ms and 50MB", () => {
  const source = fs.readFileSync(path.join(extensionRoot, "extension.js"), "utf8")
  const commands: string[] = []
  let statusShown = false
  let watcherStarted = false
  const status = {
    text: "",
    tooltip: "",
    command: "",
    show() { statusShown = true },
    dispose() {},
  }
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    ConfigurationTarget: { Global: 1 },
    window: {
      createStatusBarItem: () => status,
      showInputBox: async () => undefined,
      showWarningMessage: async () => undefined,
      showInformationMessage: () => undefined,
    },
    commands: {
      registerCommand(command: string) {
        commands.push(command)
        return { dispose() {} }
      },
    },
    workspace: {
      getConfiguration: () => ({
        get: (_key: string, fallback: unknown) => fallback,
        update: async () => undefined,
      }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
  }
  const childProcess = {
    spawn() {
      watcherStarted = true
      return { unref() {} }
    },
    execFile() {},
  }
  const extensionModule = { exports: {} as any }
  const sandbox = {
    Buffer,
    console,
    module: extensionModule,
    exports: extensionModule.exports,
    process,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    require(specifier: string) {
      if (specifier === "vscode") return vscode
      if (specifier === "node:child_process") return childProcess
      if (specifier === "node:fs") return fs
      if (specifier === "node:os") return require("node:os")
      if (specifier === "node:path") return path
      throw new Error(`Unexpected extension dependency: ${specifier}`)
    },
  }
  vm.runInNewContext(source, sandbox, { filename: path.join(extensionRoot, "extension.js") })
  const context = {
    extensionPath: extensionRoot,
    extension: { id: "openeuler.agent-insight-qoder-desktop" },
    secrets: { get: async () => undefined, store: async () => undefined },
    subscriptions: [] as unknown[],
  }
  const beforeHeap = process.memoryUsage().heapUsed
  const startedAt = performance.now()
  extensionModule.exports.activate(context)
  const activationMs = performance.now() - startedAt
  const heapDelta = Math.max(0, process.memoryUsage().heapUsed - beforeHeap)

  assert.equal(statusShown, true)
  assert.equal(watcherStarted, true)
  assert.ok(commands.includes("agentInsightQoder.configure"))
  assert.ok(commands.includes("agentInsightQoder.uninstallCollector"))
  assert.ok(activationMs < 200, `synchronous activation took ${activationMs.toFixed(2)}ms`)
  assert.ok(heapDelta < 50 * 1024 * 1024, `synchronous activation allocated ${heapDelta} bytes`)
})

test("Qoder Desktop deactivation awaits a forced collector flush", async () => {
  const root = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "qoder-desktop-deactivate-"))
  try {
    const fixtureExtension = path.join(root, "extension")
    const collectorDir = path.join(fixtureExtension, "collector")
    fs.mkdirSync(collectorDir, { recursive: true })
    for (const file of ["qoder_trace_collector.mjs", "qoder_uploader_client.mjs", "qoder_setup.mjs", "qoder_token_usage_env.mjs"]) {
      fs.writeFileSync(path.join(collectorDir, file), "")
    }
    const source = fs.readFileSync(path.join(extensionRoot, "extension.js"), "utf8")
    const calls: Array<{ file: string; args: string[] }> = []
    const vscode = {
      StatusBarAlignment: { Left: 1 },
      ConfigurationTarget: { Global: 1 },
      window: {
        createStatusBarItem: () => ({ show() {}, dispose() {} }),
        showInputBox: async () => undefined,
        showWarningMessage: async () => undefined,
        showInformationMessage: () => undefined,
      },
      commands: { registerCommand: () => ({ dispose() {} }) },
      workspace: {
        getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback, update: async () => undefined }),
        onDidChangeConfiguration: () => ({ dispose() {} }),
      },
    }
    const childProcess = {
      spawn: () => ({ unref() {} }),
      execFile(file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) {
        calls.push({ file, args })
        setImmediate(() => callback(null, "{}", ""))
      },
    }
    const extensionModule = { exports: {} as any }
    const sandbox = {
      Buffer,
      console,
      module: extensionModule,
      exports: extensionModule.exports,
      process,
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      require(specifier: string) {
        if (specifier === "vscode") return vscode
        if (specifier === "node:child_process") return childProcess
        if (specifier === "node:fs") return fs
        if (specifier === "node:os") return { homedir: () => root }
        if (specifier === "node:path") return path
        throw new Error(`Unexpected extension dependency: ${specifier}`)
      },
    }
    vm.runInNewContext(source, sandbox, { filename: path.join(extensionRoot, "extension.js") })
    extensionModule.exports.activate({
      extensionPath: fixtureExtension,
      extension: { id: "openeuler.agent-insight-qoder-desktop" },
      secrets: { get: async () => undefined, store: async () => undefined },
      subscriptions: [],
    })
    await extensionModule.exports.deactivate()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].file, "node")
    assert.ok(calls[0].args.includes("--flush"))
    assert.ok(calls[0].args.includes("--product=desktop"))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("Qoder for JetBrains flushes before application disposal and plugin unload", () => {
  const javaRoot = path.join(process.cwd(), "integrations", "qoder-jetbrains", "src", "main", "java", "org", "openeuler", "agentinsight", "qoder")
  const marker = fs.readFileSync(path.join(javaRoot, "JetBrainsMarkerService.java"), "utf8")
  const lifecycle = fs.readFileSync(path.join(javaRoot, "AgentInsightPluginLifecycle.java"), "utf8")
  const installer = fs.readFileSync(path.join(javaRoot, "CollectorInstaller.java"), "utf8")
  assert.match(marker, /void dispose\(\)[\s\S]*CollectorInstaller\.flushOwnedCollector\(\)/)
  assert.match(lifecycle, /beforePluginUnload[\s\S]*flushOwnedCollector\(\)[\s\S]*uninstallOwnedCollector\(\)/)
  assert.match(installer, /--flush/)
  assert.match(installer, /--product=jetbrains/)
})
