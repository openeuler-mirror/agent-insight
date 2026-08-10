import crypto from "node:crypto"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const QODERCN_TOKEN_USAGE_ENV = "QODERCN_EXPOSE_TOKEN_USAGE"
const MANAGED_VALUE = "1"
const STATE_FILE = "qodercn-token-usage-env.json"
const PROFILE_START = "# >>> agent-insight qodercn token usage >>>"
const PROFILE_END = "# <<< agent-insight qodercn token usage <<<"

function atomicWrite(file, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`
  fs.writeFileSync(temporary, content, { encoding: "utf8", mode })
  fs.renameSync(temporary, file)
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `${command} exited with ${result.status}`).trim())
  }
  return String(result.stdout || "")
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function readWindowsUserEnvironment(name) {
  const result = spawnSync("reg.exe", ["query", "HKCU\\Environment", "/v", name], {
    encoding: "utf8",
    windowsHide: true,
  })
  if (result.status !== 0) return undefined
  const match = String(result.stdout || "").match(new RegExp(`^\\s*${escapeRegExp(name)}\\s+REG_\\w+\\s+(.*)$`, "mi"))
  return match?.[1]?.trim()
}

function removeManagedProfileBlock(text) {
  const pattern = new RegExp(`\\r?\\n?${escapeRegExp(PROFILE_START)}[\\s\\S]*?${escapeRegExp(PROFILE_END)}\\r?\\n?`, "g")
  return String(text || "").replace(pattern, "\n").replace(/^\n+|\n+$/g, "")
}

function profilePaths(homeDir) {
  return [".profile", ".bashrc", ".zshrc"].map((name) => path.join(homeDir, name))
}

function createSystemEnvironmentAdapter({ homeDir = os.homedir(), platform = process.platform } = {}) {
  if (platform === "win32") {
    return {
      read: (name) => readWindowsUserEnvironment(name),
      set: (name, value) => {
        run("setx.exe", [name, value])
        process.env[name] = value
      },
      restore: (name, previousValue) => {
        if (previousValue === undefined) {
          const result = spawnSync("reg.exe", ["delete", "HKCU\\Environment", "/v", name, "/f"], {
            encoding: "utf8",
            windowsHide: true,
          })
          if (result.status !== 0 && readWindowsUserEnvironment(name) !== undefined) {
            throw new Error(String(result.stderr || result.stdout || "Failed to remove managed Qoder environment variable").trim())
          }
          delete process.env[name]
          return
        }
        run("setx.exe", [name, previousValue])
        process.env[name] = previousValue
      },
    }
  }

  const environmentFile = path.join(homeDir, ".agent-insight", "qodercn-token-usage.env")
  const sourceLine = `[ -f "${environmentFile.replace(/\\/g, "/")}" ] && . "${environmentFile.replace(/\\/g, "/")}"`
  return {
    read: (name) => process.env[name],
    set: (name, value) => {
      atomicWrite(environmentFile, `export ${name}=${value}\n`)
      const block = `${PROFILE_START}\n${sourceLine}\n${PROFILE_END}`
      for (const profile of profilePaths(homeDir)) {
        let text = ""
        try { text = fs.readFileSync(profile, "utf8") } catch {}
        const cleaned = removeManagedProfileBlock(text)
        atomicWrite(profile, `${cleaned ? `${cleaned}\n\n` : ""}${block}\n`)
      }
      process.env[name] = value
    },
    restore: (name, previousValue) => {
      for (const profile of profilePaths(homeDir)) {
        if (!fs.existsSync(profile)) continue
        const cleaned = removeManagedProfileBlock(fs.readFileSync(profile, "utf8"))
        atomicWrite(profile, cleaned ? `${cleaned}\n` : "")
      }
      try { fs.unlinkSync(environmentFile) } catch {}
      if (previousValue === undefined) delete process.env[name]
      else process.env[name] = previousValue
    },
  }
}

function readState(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"))
    if (value?.version === 1 && Array.isArray(value.owners)) return value
  } catch {}
  return undefined
}

export function ensureQoderTokenUsageEnvironment(options = {}) {
  const insightDir = options.insightDir || path.join(options.homeDir || os.homedir(), ".agent-insight")
  const owner = String(options.owner || "").trim().toLowerCase()
  if (!owner) throw new Error("Qoder token usage environment owner is required")
  const statePath = path.join(insightDir, STATE_FILE)
  const adapter = options.adapter || createSystemEnvironmentAdapter(options)
  const currentValue = adapter.read(QODERCN_TOKEN_USAGE_ENV)
  const existing = readState(statePath)
  const owners = new Set(existing?.owners || [])
  owners.add(owner)
  const state = existing || {
    version: 1,
    previousValue: currentValue,
  }
  state.owners = [...owners].sort()
  state.managedValue = MANAGED_VALUE
  if (currentValue !== MANAGED_VALUE) adapter.set(QODERCN_TOKEN_USAGE_ENV, MANAGED_VALUE)
  atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`)
  return {
    name: QODERCN_TOKEN_USAGE_ENV,
    value: MANAGED_VALUE,
    owners: state.owners,
    statePath,
    changed: currentValue !== MANAGED_VALUE,
    restartRequired: true,
  }
}

export function releaseQoderTokenUsageEnvironment(options = {}) {
  const insightDir = options.insightDir || path.join(options.homeDir || os.homedir(), ".agent-insight")
  const owner = String(options.owner || "").trim().toLowerCase()
  if (!owner) throw new Error("Qoder token usage environment owner is required")
  const statePath = path.join(insightDir, STATE_FILE)
  const state = readState(statePath)
  if (!state) return { name: QODERCN_TOKEN_USAGE_ENV, owners: [], restored: false, statePath }
  const owners = state.owners.filter((value) => value !== owner)
  if (owners.length) {
    atomicWrite(statePath, `${JSON.stringify({ ...state, owners }, null, 2)}\n`)
    return { name: QODERCN_TOKEN_USAGE_ENV, owners, restored: false, statePath }
  }
  const adapter = options.adapter || createSystemEnvironmentAdapter(options)
  const currentValue = adapter.read(QODERCN_TOKEN_USAGE_ENV)
  let restored = false
  if (currentValue === state.managedValue) {
    adapter.restore(QODERCN_TOKEN_USAGE_ENV, state.previousValue)
    restored = true
  }
  try { fs.unlinkSync(statePath) } catch {}
  return { name: QODERCN_TOKEN_USAGE_ENV, owners: [], restored, statePath }
}
