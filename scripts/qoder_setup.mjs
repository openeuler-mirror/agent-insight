import crypto from "node:crypto"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  ensureQoderTokenUsageEnvironment,
  releaseQoderTokenUsageEnvironment,
} from "./qoder_token_usage_env.mjs"

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
const CONFIG_KEYS = [
  "AGENT_INSIGHT_QODER_SPOOL_DIR",
  "AGENT_INSIGHT_QODER_UPLOADER",
]
const QODER_PRODUCTS = new Set(["cli", "desktop", "jetbrains"])

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? {}))
}

function stableHex(value, length = 16) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, length)
}

function atomicWrite(file, content, mode = 0o600) {
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

/** @param {string} text @param {Record<string, string>} updates @param {string[]} removals */
export function updateEnvText(text, updates, removals = []) {
  const removeSet = new Set(removals)
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
    if (removeSet.has(key)) continue
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

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function pauseSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function stopUploader(spoolDir) {
  const pids = new Set()
  for (const name of ["uploader.lock", "upload-run.lock"]) {
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(spoolDir, name), "utf8"))
      const pid = Number(lock.pid)
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid)
    } catch {}
  }
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM") } catch {}
  }
  return [...pids]
}

function waitForUploaderExit(pids, graceMs = 2_000) {
  const unique = [...new Set(pids)].filter((pid) => pid !== process.pid)
  const deadline = Date.now() + graceMs
  while (unique.some(processIsAlive) && Date.now() < deadline) pauseSync(25)
  for (const pid of unique.filter(processIsAlive)) {
    try { process.kill(pid, "SIGKILL") } catch {}
  }
  const forcedDeadline = Date.now() + 500
  while (unique.some(processIsAlive) && Date.now() < forcedDeadline) pauseSync(25)
  return unique.filter((pid) => !processIsAlive(pid))
}

function normalizeProduct(value) {
  const product = String(value || "cli").trim().toLowerCase()
  if (!QODER_PRODUCTS.has(product)) throw new Error(`Unsupported Qoder product: ${product}`)
  return product
}

function normalizeOwner(value, product) {
  const owner = String(value || product).trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]*$/.test(owner)) throw new Error(`Unsupported Qoder owner: ${owner}`)
  return owner
}

function ownerDirectory(insightDir) {
  return path.join(insightDir, "qoder-owners")
}

function ownerMarkerPath(insightDir, owner) {
  return path.join(ownerDirectory(insightDir), `${owner}.json`)
}

function readOwnerMarkers(insightDir) {
  const markers = []
  try {
    for (const entry of fs.readdirSync(ownerDirectory(insightDir), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue
      try {
        const value = JSON.parse(fs.readFileSync(path.join(ownerDirectory(insightDir), entry.name), "utf8"))
        if (value?.owner && value?.settingsPath) markers.push(value)
      } catch {}
    }
  } catch {}
  return markers
}

function productSpoolDir(insightDir, accountHash, product) {
  return path.join(insightDir, "otel_data", "qoder", product, accountHash)
}

function stopQoderUploaders(insightDir, product) {
  const pids = []
  const roots = [
    path.join(insightDir, "otel_data", "qoder", product),
    path.join(insightDir, "otel_data", `qoder-${product}`),
  ]
  for (const root of roots) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) pids.push(...stopUploader(path.join(root, entry.name)))
      }
    } catch {}
  }
  waitForUploaderExit(pids)
  return [...new Set(pids)]
}

function startUploader(uploaderPath, spoolDir, host, apiKey) {
  const child = spawn(process.execPath, [uploaderPath, "--watch"], {
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

/** @param {any} options */
export function installQoderCollector(options = {}) {
  const homeDir = options.homeDir || os.homedir()
  const projectDir = options.projectDir || process.cwd()
  const insightDir = options.insightDir || path.join(homeDir, ".agent-insight")
  const sourceDir = options.sourceDir || path.dirname(fileURLToPath(import.meta.url))
  const scope = options.scope || "user"
  const product = normalizeProduct(options.product)
  const owner = normalizeOwner(options.owner, product)
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
  atomicWrite(targetSettings, `${JSON.stringify(settings, null, 2)}\n`)
  const markerPath = ownerMarkerPath(insightDir, owner)
  atomicWrite(markerPath, `${JSON.stringify({ owner, product, scope, settingsPath: targetSettings }, null, 2)}\n`)
  const tokenUsageEnvironment = product === "cli" && (options.configureTokenUsageEnvironment ?? options.homeDir === undefined)
    ? ensureQoderTokenUsageEnvironment({
        homeDir,
        insightDir,
        owner: "cli",
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
  return { settingsPath: targetSettings, collectorPath, uploaderPath, spoolDir, accountHash, product, owner, markerPath, tokenUsageEnvironment, uploaderPid }
}

/** @param {any} options */
export function uninstallQoderCollector(options = {}) {
  const homeDir = options.homeDir || os.homedir()
  const projectDir = options.projectDir || process.cwd()
  const insightDir = options.insightDir || path.join(homeDir, ".agent-insight")
  const scope = options.scope || "user"
  const product = normalizeProduct(options.product)
  const owner = normalizeOwner(options.owner, product)
  const targetSettings = settingsPath(scope, homeDir, projectDir, product)
  const markerPath = ownerMarkerPath(insightDir, owner)
  const markers = readOwnerMarkers(insightDir)
  const currentMarker = markers.find((marker) => marker.owner === owner)
  try { fs.unlinkSync(markerPath) } catch {}
  const remainingOwners = readOwnerMarkers(insightDir)
  const ownedSettingsPath = currentMarker?.settingsPath || targetSettings
  const settingsStillShared = remainingOwners.some((marker) => path.resolve(marker.settingsPath) === path.resolve(ownedSettingsPath))
  if (!settingsStillShared && fs.existsSync(ownedSettingsPath)) {
    const settings = removeQoderHooks(readSettings(ownedSettingsPath))
    atomicWrite(ownedSettingsPath, `${JSON.stringify(settings, null, 2)}\n`)
  }

  const configFile = path.join(insightDir, "config")
  let configText = ""
  try { configText = fs.readFileSync(configFile, "utf8") } catch {}
  const spoolMatch = configText.match(/^AGENT_INSIGHT_QODER_SPOOL_DIR=(.+)$/m)
  const spoolDir = spoolMatch?.[1]?.trim()
  const stoppedUploaderPids = stopQoderUploaders(insightDir, product)
  const tokenUsageEnvironment = product === "cli"
    ? releaseQoderTokenUsageEnvironment({
        homeDir,
        insightDir,
        owner: "cli",
        adapter: options.tokenUsageEnvironmentAdapter,
      })
    : undefined
  if (!remainingOwners.length && configText) atomicWrite(configFile, updateEnvText(configText, {}, CONFIG_KEYS))

  if (!remainingOwners.length) {
    for (const file of [path.join(insightDir, "qoder_trace_collector.mjs"), path.join(insightDir, "qoder_uploader_client.mjs")]) {
      try { fs.unlinkSync(file) } catch {}
    }
    try { fs.rmdirSync(ownerDirectory(insightDir)) } catch {}
  }
  const qoderSpoolRoot = path.resolve(insightDir, "otel_data", "qoder", product)
  const legacySpoolRoot = path.resolve(insightDir, "otel_data", `qoder-${product}`)
  if (options.purge) {
    const insightRoot = path.resolve(insightDir) + path.sep
    for (const root of [qoderSpoolRoot, legacySpoolRoot]) {
      if (root.startsWith(insightRoot)) fs.rmSync(root, { recursive: true, force: true })
    }
  }
  return {
    settingsPath: ownedSettingsPath,
    spoolDir,
    product,
    owner,
    remainingOwners: remainingOwners.map((marker) => marker.owner),
    stoppedUploaderPids,
    tokenUsageEnvironment,
    purged: Boolean(options.purge),
  }
}

function parseArgs(args) {
  const command = args[0] || "status"
  const options = {}
  for (const arg of args.slice(1)) {
    if (arg === "--purge") options.purge = true
    else if (arg === "--no-start") options.startUploader = false
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
  if (command === "uninstall") {
    process.stdout.write(`${JSON.stringify(uninstallQoderCollector(options), null, 2)}\n`)
    return
  }
  process.stdout.write("Usage: node qoder_setup.mjs install --host=<url> --api-key=<key> [--scope=user|project|local] [--product=cli|desktop|jetbrains] [--owner=<id>] [--no-start]\n")
  process.stdout.write("       node qoder_setup.mjs install --from-config [--scope=user|project|local] [--product=cli|desktop|jetbrains] [--owner=<id>] [--no-start]\n")
  process.stdout.write("       node qoder_setup.mjs uninstall [--scope=user|project|local] [--product=cli|desktop|jetbrains] [--owner=<id>] [--purge]\n")
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ""
if (import.meta.url === invokedPath) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`agent-insight-qoder-setup: ${error?.message || String(error)}\n`)
    process.exitCode = 1
  }
}
