import crypto from "node:crypto"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { ensureQoderTokenUsageEnvironment } from "./qoder_token_usage_env.mjs"

export const QODER_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "SessionEnd",
]

const HOOK_NAME = "agent-insight-qoder"
const QODER_PRODUCTS = new Set(["cli", "desktop", "jetbrains"])

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

function readSettings(file) {
  if (!fs.existsSync(file)) return {}
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`Cannot update invalid Qoder settings JSON at ${file}: ${error?.message || String(error)}`)
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

/** @param {any} settings @param {{ nodePath?: string, collectorPath?: string }} options */
export function mergeQoderHooks(settings, { nodePath, collectorPath } = {}) {
  // Remove handlers from older installs first, including event names that a
  // newer Qoder product may no longer accept (for example StopFailure).
  const result = removeQoderHooks(settings)
  result.hooks = result.hooks && typeof result.hooks === "object" && !Array.isArray(result.hooks) ? result.hooks : {}
  const resolvedNodePath = nodePath || process.execPath
  const hookNodePath = process.platform === "win32"
    ? path.basename(resolvedNodePath, path.extname(resolvedNodePath))
    : resolvedNodePath
  let command
  if (process.platform === "win32") {
    // Qoder CN Desktop invokes the whole command as one `cmd.exe /c` argument.
    // In that mode cmd preserves argument quotes as literal characters, so
    // Node resolves `"C:\path\collector.mjs"` relative to cwd. The managed
    // runtime path is deliberately shell-safe and must remain unquoted.
    const windowsCollectorPath = String(collectorPath).replace(/\\/g, "/")
    if (/[\s&()^%!]/.test(windowsCollectorPath)) {
      throw new Error(`Qoder CN Hook runtime path must not contain cmd metacharacters: ${collectorPath}`)
    }
    command = `${hookNodePath} --no-warnings ${windowsCollectorPath}`
  } else {
    command = [hookNodePath, "--no-warnings", collectorPath].map(quoteHookCommandArgument).join(" ")
  }
  const handler = {
    type: "command",
    // Qoder CN CLI accepts an args array, while Qoder CN Desktop currently ignores it
    // and passes only command to `bash -c`. Keep the complete invocation in the
    // documented command field so the same user-level hook works in both products.
    // On Windows Qoder invokes commands through Git Bash. Using the PATH name
    // avoids `C:\Program Files\...` being split after native argument parsing.
    command,
    name: HOOK_NAME,
    async: true,
    timeout: 15,
  }
  for (const eventName of QODER_HOOK_EVENTS) {
    const groups = Array.isArray(result.hooks[eventName]) ? result.hooks[eventName] : []
    const retained = groups.flatMap((group) => {
      const hooks = Array.isArray(group?.hooks) ? group.hooks.filter((item) => item?.name !== HOOK_NAME) : []
      return hooks.length ? [{ ...group, hooks }] : []
    })
    retained.push({ hooks: [handler] })
    result.hooks[eventName] = retained
  }
  return result
}

/** @param {any} settings */
export function removeQoderHooks(settings) {
  const result = clone(settings)
  if (!result.hooks || typeof result.hooks !== "object" || Array.isArray(result.hooks)) return result
  for (const [eventName, rawGroups] of Object.entries(result.hooks)) {
    if (!Array.isArray(rawGroups)) continue
    const groups = rawGroups.flatMap((group) => {
      const hooks = Array.isArray(group?.hooks) ? group.hooks.filter((item) => item?.name !== HOOK_NAME) : []
      return hooks.length ? [{ ...group, hooks }] : []
    })
    if (groups.length) result.hooks[eventName] = groups
    else delete result.hooks[eventName]
  }
  if (Object.keys(result.hooks).length === 0) delete result.hooks
  return result
}

/** @param {string} text @param {Record<string, string>} updates */
export function updateEnvText(text, updates) {
  const updateMap = new Map(Object.entries(updates))
  const written = new Set()
  const lines = String(text || "").split(/\r?\n/)
  const output = []
  for (const line of lines) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)
    if (!match) {
      if (line || output.length) output.push(line)
      continue
    }
    const key = match[1]
    if (updateMap.has(key)) {
      if (!written.has(key)) output.push(`${key}=${updateMap.get(key)}`)
      written.add(key)
      continue
    }
    output.push(line)
  }
  for (const [key, value] of updateMap) {
    if (!written.has(key)) output.push(`${key}=${value}`)
  }
  return `${output.join("\n").replace(/^\n+|\n+$/g, "")}\n`
}

function settingsPath(scope, homeDir, projectDir, product = "cli") {
  if (!["user", "project", "local"].includes(scope)) throw new Error(`Unsupported Qoder settings scope: ${scope}`)
  if (scope === "project") return path.join(projectDir, ".qoder", "settings.json")
  if (scope === "local") return path.join(projectDir, ".qoder", "settings.local.json")
  if (product === "jetbrains") return path.join(homeDir, ".qoder", "settings.json")
  return path.join(homeDir, ".qoder-cn", "settings.json")
}

function normalizeProduct(value) {
  const product = String(value || "cli").trim().toLowerCase()
  if (!QODER_PRODUCTS.has(product)) throw new Error(`Unsupported Qoder product: ${product}`)
  return product
}

function productSpoolDir(insightDir, accountHash, product) {
  return path.join(insightDir, "otel_data", "qoder", product, accountHash)
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
export function installQoderCollector(options = {}) {
  const homeDir = options.homeDir || os.homedir()
  const projectDir = options.projectDir || process.cwd()
  const insightDir = options.insightDir || getAgentInsightHome(homeDir)
  const sourceDir = options.sourceDir || path.dirname(fileURLToPath(import.meta.url))
  const scope = options.scope || "user"
  const product = normalizeProduct(options.product)
  const installedConfig = options.fromConfig ? readEnvFile(path.join(insightDir, "config")) : {}
  const host = String(options.host || installedConfig.AGENT_INSIGHT_HOST || "").trim().replace(/\/+$/, "")
  const apiKey = String(options.apiKey || installedConfig.AGENT_INSIGHT_API_KEY || "").trim()
  if (!host) throw new Error("--host is required")
  if (!apiKey) throw new Error("--api-key is required")
  if (/[\r\n]/.test(host) || /[\r\n]/.test(apiKey)) throw new Error("Qoder setup values cannot contain newlines")

  const collectorPath = path.join(insightDir, "qoder_trace_collector.mjs")
  const uploaderPath = path.join(insightDir, "qoder_uploader_client.mjs")
  const accountHash = stableHex(apiKey)
  const baseSpoolDir = productSpoolDir(insightDir, accountHash, "cli")
  const spoolDir = productSpoolDir(insightDir, accountHash, product)
  fs.mkdirSync(spoolDir, { recursive: true, mode: 0o700 })
  fs.copyFileSync(path.join(sourceDir, "qoder_trace_collector.mjs"), collectorPath)
  fs.copyFileSync(path.join(sourceDir, "qoder_uploader_client.mjs"), uploaderPath)

  const targetSettings = settingsPath(scope, homeDir, projectDir, product)
  const settings = mergeQoderHooks(readSettings(targetSettings), { nodePath: process.execPath, collectorPath })
  process.stderr.write(`安装将改写 Qoder Hook 配置 ${targetSettings} 和 ${path.join(insightDir, "config")}；请在安装前自行备份。此安装不提供自动备份或配置回退。\n`)
  atomicWrite(targetSettings, `${JSON.stringify(settings, null, 2)}\n`)
  const tokenUsageEnvironment = product === "cli" && (options.configureTokenUsageEnvironment ?? options.homeDir === undefined)
    ? ensureQoderTokenUsageEnvironment({
        homeDir,
        insightDir,
        adapter: options.tokenUsageEnvironmentAdapter,
      })
    : undefined

  const configFile = path.join(insightDir, "config")
  let configText = ""
  try { configText = fs.readFileSync(configFile, "utf8") } catch {}
  atomicWrite(configFile, updateEnvText(configText, {
    AGENT_INSIGHT_HOST: host,
    AGENT_INSIGHT_API_KEY: apiKey,
    AGENT_INSIGHT_QODER_SPOOL_DIR: baseSpoolDir,
    AGENT_INSIGHT_QODER_UPLOADER: uploaderPath,
  }))

  const uploaderPid = options.startUploader === false ? undefined : startUploader(uploaderPath, spoolDir, host, apiKey)
  return { settingsPath: targetSettings, collectorPath, uploaderPath, spoolDir, accountHash, product, tokenUsageEnvironment, uploaderPid }
}

function getAgentInsightHome(homeDir = os.homedir()) {
  if (process.env.AGENT_INSIGHT_DATA_DIR) throw new Error('AGENT_INSIGHT_DATA_DIR is no longer supported; use AGENT_INSIGHT_HOME.')
  const root = process.env.AGENT_INSIGHT_HOME || path.join(homeDir, '.agent-insight')
  return path.resolve(root.replace(/^(?:~|\$HOME|\$\{HOME\})(?=[/\\]|$)/, () => homeDir))
}

function parseArgs(args) {
  const command = args[0] || "status"
  const options = {}
  for (const arg of args.slice(1)) {
    if (arg === "--no-start") options.startUploader = false
    else if (arg === "--from-config") options.fromConfig = true
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
    process.stdout.write(`${JSON.stringify(installQoderCollector(options), null, 2)}\n`)
    return
  }
  process.exitCode = 1
  process.stdout.write("Usage: node qoder_setup.mjs install --host=<url> --api-key=<key> [--scope=user|project|local] [--product=cli|desktop|jetbrains] [--no-start]\n")
  process.stdout.write("       node qoder_setup.mjs install --from-config [--scope=user|project|local] [--product=cli|desktop|jetbrains] [--no-start]\n")
}

const invokedPath = process.argv[1]
  ? pathToFileURL(fs.realpathSync(path.resolve(process.argv[1]))).href
  : ""
if (import.meta.url === invokedPath) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`agent-insight-qoder-setup: ${error?.message || String(error)}\n`)
    process.exitCode = 1
  }
}
