import crypto from "node:crypto"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const QODERCN_TOKEN_USAGE_ENV = "QODERCN_EXPOSE_TOKEN_USAGE"
const MANAGED_VALUE = "1"
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
    }
  }

  const environmentFile = path.join(getAgentInsightHome(homeDir), "qodercn-token-usage.env")
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
  }
}

export function ensureQoderTokenUsageEnvironment(options = {}) {
  const adapter = options.adapter || createSystemEnvironmentAdapter(options)
  const currentValue = adapter.read(QODERCN_TOKEN_USAGE_ENV)
  if (currentValue !== MANAGED_VALUE) {
    const homeDir = options.homeDir || os.homedir()
    const target = (options.platform || process.platform) === "win32"
      ? `Windows 用户环境变量 ${QODERCN_TOKEN_USAGE_ENV}`
      : profilePaths(homeDir).join(", ")
    process.stderr.write(`安装将设置 ${QODERCN_TOKEN_USAGE_ENV}=1，并可能改写 ${target}；请在安装前自行备份。此安装不提供自动备份或配置回退。\n`)
    adapter.set(QODERCN_TOKEN_USAGE_ENV, MANAGED_VALUE)
  }
  return {
    name: QODERCN_TOKEN_USAGE_ENV,
    value: MANAGED_VALUE,
    changed: currentValue !== MANAGED_VALUE,
    restartRequired: true,
  }
}

function getAgentInsightHome(homeDir = os.homedir()) {
  if (process.env.AGENT_INSIGHT_DATA_DIR) throw new Error('AGENT_INSIGHT_DATA_DIR is no longer supported; use AGENT_INSIGHT_HOME.')
  const root = process.env.AGENT_INSIGHT_HOME || path.join(homeDir, '.agent-insight')
  return path.resolve(root.replace(/^(?:~|\$HOME|\$\{HOME\})(?=[/\\]|$)/, () => homeDir))
}
