import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

function argsMap(args) {
  return Object.fromEntries(args.flatMap((arg) => {
    const match = arg.match(/^--([^=]+)=(.*)$/)
    return match ? [[match[1], match[2]]] : []
  }))
}

function parentAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function markedObsolete(extensionPath, extensionId) {
  const obsoletePath = path.join(path.dirname(extensionPath), ".obsolete")
  try {
    const value = JSON.parse(fs.readFileSync(obsoletePath, "utf8"))
    const folder = path.basename(extensionPath).toLowerCase()
    const id = String(extensionId || "").toLowerCase()
    return Object.keys(value || {}).some((key) => {
      const normalized = key.toLowerCase()
      return normalized === folder || normalized.startsWith(`${id}-`)
    })
  } catch {
    return false
  }
}

function runSetup(setupPath, purge) {
  return new Promise((resolve) => {
    const args = [
      setupPath,
      "uninstall",
      "--scope=user",
      "--product=desktop",
      "--owner=desktop",
    ]
    if (purge) args.push("--purge")
    execFile("node", args, { windowsHide: true, timeout: 20_000 }, () => resolve())
  })
}

const options = argsMap(process.argv.slice(2))
const extensionPath = path.resolve(options["extension-path"] || "")
const extensionId = options["extension-id"] || ""
const parentPid = Number(options["parent-pid"])
const setupPath = path.resolve(options["setup-path"] || "")
const runtimeDir = path.resolve(options["runtime-dir"] || "")
const purge = options.purge === "1"

const timer = setInterval(async () => {
  const removed = !fs.existsSync(path.join(extensionPath, "package.json")) || markedObsolete(extensionPath, extensionId)
  if (removed) {
    clearInterval(timer)
    if (fs.existsSync(setupPath)) await runSetup(setupPath, purge)
    if (runtimeDir.includes(`${path.sep}.agent-insight${path.sep}qoder-desktop${path.sep}runtime`)) {
      try { fs.rmSync(runtimeDir, { recursive: true, force: true }) } catch {}
    }
    process.exit(0)
  }
  if (!Number.isInteger(parentPid) || parentPid <= 0 || !parentAlive(parentPid)) {
    clearInterval(timer)
    process.exit(0)
  }
}, 2_000)

await new Promise((resolve) => process.once("exit", resolve))
