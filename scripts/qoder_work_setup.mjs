import crypto from "node:crypto"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { ensureQoderTokenUsageEnvironment } from "./qoder_token_usage_env.mjs"

export const QODER_WORK_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "SessionEnd",
  "Notification",
  "PermissionRequest",
]

const WORK_RUNTIME_DIR = "qoder-work"

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? {}))
}

function stableHex(value, length = 16) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, length)
}

function atomicWrite(file, content, mode = 0o600) {
  if (fs.existsSync(file)) file = fs.realpathSync(file)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`
  fs.writeFileSync(temporary, content, { encoding: "utf8", mode })
  fs.renameSync(temporary, file)
}

function readJson(file) {
  if (!fs.existsSync(file)) return {}
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""))
  } catch (error) {
    throw new Error(`Cannot update invalid QoderWork settings JSON at ${file}: ${error?.message || String(error)}`)
  }
}

function readEnvFile(file) {
  let text = ""
  try { text = fs.readFileSync(file, "utf8") } catch {}
  const values = {}
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (match) values[match[1]] = match[2]
  }
  return values
}

function quoteHookCommandArgument(value) {
  const normalized = process.platform === "win32" ? String(value).replace(/\\/g, "/") : String(value)
  return `"${normalized.replace(/(["\\$`])/g, "\\$1")}"`
}

function isAgentInsightWorkHook(handler, collectorPath) {
  const command = String(handler?.command || "").toLowerCase().replace(/\\/g, "/")
  return command.includes("agent-insight-probe.ps1")
    || (collectorPath && command.includes(String(collectorPath).toLowerCase().replace(/\\/g, "/")))
    || (command.includes("agent-insight") && command.includes("qoder-work") && command.includes("qoder_trace_collector.mjs"))
}

/** @param {any} settings @param {string | undefined} collectorPath */
export function removeQoderWorkHooks(settings, collectorPath = undefined) {
  const result = clone(settings)
  if (!result.hooks || typeof result.hooks !== "object" || Array.isArray(result.hooks)) return result
  for (const [eventName, rawGroups] of Object.entries(result.hooks)) {
    if (!Array.isArray(rawGroups)) continue
    const groups = rawGroups.flatMap((group) => {
      const hooks = Array.isArray(group?.hooks) ? group.hooks.filter((handler) => !isAgentInsightWorkHook(handler, collectorPath)) : []
      return hooks.length ? [{ ...group, hooks }] : []
    })
    if (groups.length) result.hooks[eventName] = groups
    else delete result.hooks[eventName]
  }
  if (Object.keys(result.hooks).length === 0) delete result.hooks
  return result
}

/** @param {any} settings @param {{ nodePath?: string, collectorPath: string }} options */
export function mergeQoderWorkHooks(settings, { nodePath, collectorPath }) {
  const result = removeQoderWorkHooks(settings, collectorPath)
  result.hooks = result.hooks && typeof result.hooks === "object" && !Array.isArray(result.hooks) ? result.hooks : {}
  const resolvedNodePath = nodePath || process.execPath
  const hookNodePath = process.platform === "win32"
    ? path.basename(resolvedNodePath, path.extname(resolvedNodePath))
    : resolvedNodePath
  const handler = {
    type: "command",
    command: [hookNodePath, collectorPath].map(quoteHookCommandArgument).join(" "),
    // Qoder Work must never wait for trace persistence on the interactive
    // request path. In particular SessionStart and UserPromptSubmit run before
    // startup/first-token work, so keeping the command hook asynchronous is a
    // hard performance invariant shared with the CLI/Desktop collector.
    async: true,
    timeout: 15,
  }
  for (const eventName of QODER_WORK_HOOK_EVENTS) {
    const groups = Array.isArray(result.hooks[eventName]) ? result.hooks[eventName] : []
    groups.push({ hooks: [handler] })
    result.hooks[eventName] = groups
  }
  return result
}

export function resolveQoderWorkHome(homeDir = os.homedir(), requested) {
  if (requested) return path.resolve(requested)
  for (const name of [".qoderworkcn", ".qoderwork"]) {
    const candidate = path.join(homeDir, name)
    if (fs.existsSync(candidate)) return candidate
  }
  return path.join(homeDir, ".qoderwork")
}

function startUploader(uploaderPath, spoolDir, host, apiKey) {
  const child = spawn(process.execPath, [uploaderPath, "--watch", `--spool-dir=${spoolDir}`], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      AGENT_INSIGHT_HOST: host,
      AGENT_INSIGHT_API_KEY: apiKey,
      AGENT_INSIGHT_QODER_SPOOL_DIR: spoolDir,
    },
  })
  child.unref()
  return child.pid
}

/** @param {any} options
 * @returns {any} */
export function installQoderWorkCollector(options = {}) {
  const homeDir = options.homeDir || os.homedir()
  const insightDir = options.insightDir || getAgentInsightHome(homeDir)
  const sourceDir = options.sourceDir || path.dirname(fileURLToPath(import.meta.url))
  const qoderWorkHome = resolveQoderWorkHome(homeDir, options.qoderWorkHome)
  const installedConfig = readEnvFile(path.join(insightDir, "config"))
  const host = String(options.host || installedConfig.AGENT_INSIGHT_HOST || "").trim().replace(/\/+$/, "")
  const apiKey = String(options.apiKey || installedConfig.AGENT_INSIGHT_API_KEY || "").trim()
  if (!host) throw new Error("Agent Insight host is required; configure it first or pass --host")
  if (!apiKey) throw new Error("Agent Insight API key is required; configure it first or pass --api-key")
  if (/[\r\n]/.test(host) || /[\r\n]/.test(apiKey)) throw new Error("QoderWork setup values cannot contain newlines")

  const runtimeDir = path.join(insightDir, WORK_RUNTIME_DIR)
  const collectorPath = path.join(runtimeDir, "qoder_trace_collector.mjs")
  const uploaderPath = path.join(runtimeDir, "qoder_uploader_client.mjs")
  const accountHash = stableHex(apiKey)
  const spoolDir = path.join(insightDir, "otel_data", "qoder", "work", accountHash)
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(spoolDir, { recursive: true, mode: 0o700 })
  fs.copyFileSync(path.join(sourceDir, "qoder_trace_collector.mjs"), collectorPath)
  fs.copyFileSync(path.join(sourceDir, "qoder_uploader_client.mjs"), uploaderPath)

  const settingsPath = path.join(qoderWorkHome, "settings.json")
  const settings = mergeQoderWorkHooks(readJson(settingsPath), { nodePath: process.execPath, collectorPath })
  process.stderr.write(`安装将改写 Qoder Work Hook 配置 ${settingsPath}；请在安装前自行备份。此安装不提供自动备份或配置回退。\n`)
  atomicWrite(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
  const tokenUsageEnvironment = (options.configureTokenUsageEnvironment ?? options.homeDir === undefined)
    ? ensureQoderTokenUsageEnvironment({
        homeDir,
        insightDir,
        adapter: options.tokenUsageEnvironmentAdapter,
      })
    : undefined
  const uploaderPid = options.startUploader === false ? undefined : startUploader(uploaderPath, spoolDir, host, apiKey)
  return { settingsPath, qoderWorkHome, collectorPath, uploaderPath, spoolDir, accountHash, tokenUsageEnvironment, uploaderPid }
}

function parseArgs(args) {
  const command = args[0] || "status"
  const options = {}
  for (const arg of args.slice(1)) {
    if (arg === "--no-start") options.startUploader = false
    else if (arg.startsWith("--") && arg.includes("=")) {
      const [key, ...rest] = arg.slice(2).split("=")
      options[key.replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = rest.join("=")
    }
  }
  return { command, options }
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2))
  if (command === "install") {
    process.stdout.write(`${JSON.stringify(installQoderWorkCollector(options), null, 2)}\n`)
    return
  }
  process.exitCode = 1
  process.stdout.write("Usage: node qoder_work_setup.mjs install [--host=<url> --api-key=<key>] [--no-start]\n")
}

const invokedPath = process.argv[1]
  ? pathToFileURL(fs.realpathSync(path.resolve(process.argv[1]))).href
  : ""
if (import.meta.url === invokedPath) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`agent-insight-qoder-work-setup: ${error?.message || String(error)}\n`)
    process.exitCode = 1
  }
}

function getAgentInsightHome(homeDir = os.homedir()) {
  if (process.env.AGENT_INSIGHT_DATA_DIR) throw new Error('AGENT_INSIGHT_DATA_DIR is no longer supported; use AGENT_INSIGHT_HOME.')
  const root = process.env.AGENT_INSIGHT_HOME || path.join(homeDir, '.agent-insight')
  return path.resolve(root.replace(/^(?:~|\$HOME|\$\{HOME\})(?=[/\\]|$)/, () => homeDir))
}
