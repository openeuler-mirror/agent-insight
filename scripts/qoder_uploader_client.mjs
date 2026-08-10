import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_RETRY_BASE_MS = 5_000
const DEFAULT_RETRY_CAP_MS = 5 * 60_000

function parseEnvFile(file) {
  const out = {}
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const index = trimmed.indexOf("=")
      if (index <= 0) continue
      const key = trimmed.slice(0, index).trim()
      const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "")
      out[key] = value
    }
  } catch {}
  return out
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 })
  fs.renameSync(temporary, file)
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return fallback
  }
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

function acquireProcessLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const descriptor = fs.openSync(file, "wx", 0o600)
      fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`)
      fs.closeSync(descriptor)
      return () => {
        const owner = readJson(file, {})
        if (Number(owner.pid) === process.pid) {
          try { fs.unlinkSync(file) } catch {}
        }
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      const owner = readJson(file, {})
      if (processIsAlive(Number(owner.pid))) return null
      try { fs.unlinkSync(file) } catch {}
    }
  }
  return null
}

async function acquireProcessLockWithWait(file, waitMs) {
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0)
  while (true) {
    const release = acquireProcessLock(file)
    if (release || Date.now() >= deadline) return release
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))))
  }
}

function cleanupUploadedSession(spoolDir, pendingDir, pendingName) {
  const match = pendingName.match(/^([a-f0-9]{32})-/i)
  if (!match) return
  const sessionKey = match[1]
  try {
    const hasPending = fs.readdirSync(pendingDir)
      .some((name) => name.startsWith(`${sessionKey}-`) && name.endsWith(".json") && !name.endsWith(".retry.json"))
    if (hasPending) return
    fs.rmSync(path.join(spoolDir, "events", sessionKey), { recursive: true, force: true })
  } catch {}
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

export function retryDelayMs(attempt, baseMs = DEFAULT_RETRY_BASE_MS, capMs = DEFAULT_RETRY_CAP_MS) {
  const failures = Math.max(1, Math.trunc(Number(attempt) || 1))
  const exponent = Math.max(0, failures - 3)
  return Math.min(capMs, baseMs * (2 ** exponent))
}

export function resolveTraceEndpoint(host) {
  const base = String(host || "").trim().replace(/\/+$/, "")
  if (!base) return ""
  if (/\/api\/ingest\/otel\/v1\/traces$/i.test(base)) return base
  return `${base}/api/ingest/otel/v1/traces`
}

export async function uploadPending(options = {}) {
  const homeDir = options.homeDir || os.homedir()
  const insightDir = options.insightDir || path.join(homeDir, ".agent-insight")
  const config = { ...parseEnvFile(path.join(insightDir, "config")), ...process.env, ...options.env }
  const spoolDir = options.spoolDir || config.AGENT_INSIGHT_QODER_SPOOL_DIR
  const endpoint = options.endpoint || resolveTraceEndpoint(config.AGENT_INSIGHT_HOST)
  const apiKey = options.apiKey ?? config.AGENT_INSIGHT_API_KEY ?? ""
  const timeoutMs = positiveNumber(options.timeoutMs ?? config.AGENT_INSIGHT_QODER_UPLOAD_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  const retryBaseMs = positiveNumber(options.retryBaseMs ?? config.AGENT_INSIGHT_QODER_RETRY_BASE_MS, DEFAULT_RETRY_BASE_MS)
  const retryCapMs = positiveNumber(options.retryCapMs ?? config.AGENT_INSIGHT_QODER_RETRY_CAP_MS, DEFAULT_RETRY_CAP_MS)
  const now = typeof options.now === "function" ? options.now : Date.now
  const request = options.fetch || globalThis.fetch
  if (!spoolDir) throw new Error("AGENT_INSIGHT_QODER_SPOOL_DIR is not configured")
  if (!endpoint) throw new Error("AGENT_INSIGHT_HOST is not configured")
  if (typeof request !== "function") throw new Error("fetch is unavailable")

  const releaseRunLock = options.disableRunLock
    ? () => {}
    : await acquireProcessLockWithWait(path.join(spoolDir, "upload-run.lock"), options.waitForLockMs)
  if (!releaseRunLock) return { uploaded: 0, failed: 0, deferred: 0, pending: 0, locked: true }

  try {
    const pendingDir = path.join(spoolDir, "pending")
    let files = []
    try {
      files = fs.readdirSync(pendingDir).filter((name) => name.endsWith(".json") && !name.endsWith(".retry.json")).sort()
    } catch {
      return { uploaded: 0, failed: 0, deferred: 0, pending: 0 }
    }

    let uploaded = 0
    let failed = 0
    let deferred = 0
    for (const name of files) {
      const file = path.join(pendingDir, name)
      const retryFile = `${file}.retry.json`
      const retry = readJson(retryFile, { attempts: 0, nextAttemptAt: 0 })
      if (!options.force && Number(retry.nextAttemptAt) > now()) {
        deferred++
        continue
      }
      const payload = readJson(file, null)
      if (!payload) {
        failed++
        atomicWriteJson(retryFile, {
          attempts: Number(retry.attempts || 0) + 1,
          nextAttemptAt: now() + retryDelayMs(Number(retry.attempts || 0) + 1, retryBaseMs, retryCapMs),
          error: "invalid pending JSON",
        })
        continue
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await request(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(apiKey ? { "x-witty-api-key": apiKey } : {}),
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
        if (!response?.ok) throw new Error(`HTTP ${response?.status || "unknown"}`)
        fs.unlinkSync(file)
        try { fs.unlinkSync(retryFile) } catch {}
        cleanupUploadedSession(spoolDir, pendingDir, name)
        uploaded++
      } catch (error) {
        failed++
        const attempts = Number(retry.attempts || 0) + 1
        atomicWriteJson(retryFile, {
          attempts,
          nextAttemptAt: now() + retryDelayMs(attempts, retryBaseMs, retryCapMs),
          error: String(error?.message || error).slice(0, 500),
        })
      } finally {
        clearTimeout(timer)
      }
    }
    return { uploaded, failed, deferred, pending: files.length - uploaded }
  } finally {
    releaseRunLock()
  }
}

async function main() {
  const watch = process.argv.includes("--watch")
  const intervalArg = process.argv.find((arg) => arg.startsWith("--interval-ms="))
  const intervalMs = positiveNumber(intervalArg?.split("=")[1], 60_000)
  if (!watch) {
    const result = await uploadPending()
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  const homeDir = os.homedir()
  const insightDir = path.join(homeDir, ".agent-insight")
  const config = { ...parseEnvFile(path.join(insightDir, "config")), ...process.env }
  const spoolDir = config.AGENT_INSIGHT_QODER_SPOOL_DIR
  if (!spoolDir) throw new Error("AGENT_INSIGHT_QODER_SPOOL_DIR is not configured")
  fs.mkdirSync(spoolDir, { recursive: true })
  const lockFile = path.join(spoolDir, "uploader.lock")
  try {
    const existing = readJson(lockFile, {})
    const pid = Number(existing.pid)
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0)
        return
      } catch {}
    }
    try { fs.unlinkSync(lockFile) } catch {}
    const descriptor = fs.openSync(lockFile, "wx", 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`)
    fs.closeSync(descriptor)
  } catch (error) {
    if (error?.code === "EEXIST") return
    throw error
  }
  let stopping = false
  let wakeInterval
  let intervalTimer
  const stop = () => {
    stopping = true
    if (intervalTimer) clearTimeout(intervalTimer)
    wakeInterval?.()
    wakeInterval = undefined
  }
  const waitForInterval = () => new Promise((resolve) => {
    wakeInterval = resolve
    intervalTimer = setTimeout(() => {
      intervalTimer = undefined
      wakeInterval = undefined
      resolve()
    }, intervalMs)
  })
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  try {
    while (!stopping) {
      try {
        await uploadPending()
      } catch (error) {
        process.stderr.write(`agent-insight-qoder-uploader: ${error?.message || String(error)}\n`)
      }
      if (!stopping) await waitForInterval()
    }
    await uploadPending().catch(() => {})
  } finally {
    try { fs.unlinkSync(lockFile) } catch {}
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(fs.realpathSync(path.resolve(process.argv[1]))).href
  : ""
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`agent-insight-qoder-uploader: ${error?.message || String(error)}\n`)
    process.exitCode = 1
  })
}
