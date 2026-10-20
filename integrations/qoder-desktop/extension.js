/* eslint-disable @typescript-eslint/no-require-imports -- VS Code loads this extension through its CommonJS entry point. */
const childProcess = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const vscode = require("vscode")

const PRODUCT = "desktop"
let statusItem
let installPromise
let activeContext
let flushPromise

function insightDirectory() {
  return path.resolve((process.env.AGENT_INSIGHT_HOME || path.join(os.homedir(), ".agent-insight")).replace(/^(?:~|\$HOME|\$\{HOME\})(?=[/\\]|$)/, () => os.homedir()))
}

function runtimeDirectory() {
  return path.join(insightDirectory(), "qoder-desktop", "runtime")
}

function configPath() {
  return path.join(insightDirectory(), "config")
}

function readEnvFile(file) {
  const values = {}
  let text = ""
  try { text = fs.readFileSync(file, "utf8") } catch {}
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (match) values[match[1]] = match[2]
  }
  return values
}

function updateEnvText(text, updates) {
  const values = new Map(Object.entries(updates))
  const written = new Set()
  const output = []
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)
    if (!match || !values.has(match[1])) {
      if (line || output.length) output.push(line)
      continue
    }
    if (!written.has(match[1])) output.push(`${match[1]}=${values.get(match[1])}`)
    written.add(match[1])
  }
  for (const [key, value] of values) {
    if (!written.has(key)) output.push(`${key}=${value}`)
  }
  return `${output.join("\n").replace(/^\n+|\n+$/g, "")}\n`
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 })
  fs.renameSync(temporary, file)
}

function prepareRuntime(context) {
  const runtime = runtimeDirectory()
  fs.mkdirSync(runtime, { recursive: true })
  for (const file of ["qoder_trace_collector.mjs", "qoder_uploader_client.mjs", "qoder_setup.mjs", "qoder_token_usage_env.mjs"]) {
    fs.copyFileSync(path.join(context.extensionPath, "collector", file), path.join(runtime, file))
  }
  return path.join(runtime, "qoder_setup.mjs")
}

function execFile(file, args) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, { windowsHide: true, timeout: 20_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || stdout || error.message).trim()))
      else resolve(String(stdout || "").trim())
    })
  })
}

function setStatus(text, tooltip) {
  if (!statusItem) return
  statusItem.text = text
  statusItem.tooltip = tooltip
  statusItem.show()
}

function flushCollector(context) {
  if (!context) return Promise.resolve()
  if (flushPromise) return flushPromise
  flushPromise = (async () => {
    const collectorPath = path.join(runtimeDirectory(), "qoder_trace_collector.mjs")
    if (!fs.existsSync(collectorPath)) prepareRuntime(context)
    await execFile("node", [
      collectorPath,
      "--flush",
      `--product=${PRODUCT}`,
      "--wait-for-lock-ms=5000",
    ])
  })().finally(() => {
    flushPromise = undefined
  })
  return flushPromise
}

async function writeConfiguration(context) {
  const settings = vscode.workspace.getConfiguration("agentInsightQoder")
  const existing = readEnvFile(configPath())
  const host = String(settings.get("host") || existing.AGENT_INSIGHT_HOST || "").trim().replace(/\/+$/, "")
  const apiKey = String(await context.secrets.get("agentInsightQoder.apiKey") || existing.AGENT_INSIGHT_API_KEY || "").trim()
  if (!host || !apiKey) return false
  if (/[\r\n]/.test(host) || /[\r\n]/.test(apiKey)) throw new Error("Configuration values cannot contain newlines")
  let text = ""
  try { text = fs.readFileSync(configPath(), "utf8") } catch {}
  atomicWrite(configPath(), updateEnvText(text, {
    AGENT_INSIGHT_HOST: host,
    AGENT_INSIGHT_API_KEY: apiKey,
    AGENT_INSIGHT_QODER_MAX_CONTENT_CHARS: String(settings.get("maxContentChars") || 2000),
  }))
  return true
}

async function installCollector(context) {
  if (installPromise) return installPromise
  installPromise = (async () => {
    const enabled = vscode.workspace.getConfiguration("agentInsightQoder").get("enabled", true)
    if (!enabled) {
      setStatus("$(circle-slash) Agent Insight", "Automatic collector setup is disabled; existing Hook configuration remains active")
      return
    }
    setStatus("$(sync~spin) Agent Insight", "Installing the Qoder CN Desktop collector")
    void vscode.window.showWarningMessage(`安装将改写 ${path.join(os.homedir(), ".qoder-cn", "settings.json")} 和 ${configPath()}；请在安装前自行备份。此安装不提供自动备份或配置回退。`)
    if (!await writeConfiguration(context)) {
      setStatus("$(warning) Agent Insight", "Configuration required. Click to configure.")
      return
    }
    const setupPath = prepareRuntime(context)
    await execFile("node", [
      setupPath,
      "install",
      "--from-config",
      "--scope=user",
      `--product=${PRODUCT}`,
    ])
    setStatus("$(pulse) Agent Insight", "Active · Qoder CN Desktop Trace collector")
  })().catch((error) => {
    setStatus("$(error) Agent Insight", `Setup failed: ${String(error.message || error).slice(0, 120)}`)
    throw error
  }).finally(() => {
    installPromise = undefined
  })
  return installPromise
}

async function configure(context) {
  const existing = readEnvFile(configPath())
  const settings = vscode.workspace.getConfiguration("agentInsightQoder")
  const host = await vscode.window.showInputBox({
    title: "Agent Insight server URL",
    value: String(settings.get("host") || existing.AGENT_INSIGHT_HOST || "http://localhost:3000"),
    validateInput: (value) => /^https?:\/\/.+/.test(value.trim()) ? undefined : "URL must start with http:// or https://",
    ignoreFocusOut: true,
  })
  if (host === undefined) return
  const apiKey = await vscode.window.showInputBox({
    title: "Agent Insight API Key",
    prompt: "Stored in Qoder SecretStorage and shared with the local Agent Insight collector.",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? undefined : "API Key is required",
  })
  if (apiKey === undefined) return
  await settings.update("host", host.trim().replace(/\/+$/, ""), vscode.ConfigurationTarget.Global)
  await context.secrets.store("agentInsightQoder.apiKey", apiKey.trim())
  await installCollector(context)
  vscode.window.showInformationMessage("Agent Insight Qoder CN Desktop collector is active.")
}

function activate(context) {
  activeContext = context
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90)
  statusItem.command = "agentInsightQoder.configure"
  setStatus("$(sync~spin) Agent Insight", "Starting Qoder CN Desktop Trace collector")
  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand("agentInsightQoder.configure", () => configure(context)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("agentInsightQoder")) void installCollector(context)
    }),
  )
  setTimeout(() => void installCollector(context), 0)
}

function deactivate() {
  const pending = flushCollector(activeContext).catch((error) => {
    console.warn(`Agent Insight Qoder CN Desktop flush failed; pending spool is preserved: ${String(error?.message || error)}`)
  })
  activeContext = undefined
  return pending
}

module.exports = { activate, deactivate }
