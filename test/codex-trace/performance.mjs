import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"

const root = process.cwd()
const outDir = path.join(root, "test", "codex-trace", "out")
const mode = process.argv[2]
const codexCommand = process.env.CODEX_COMMAND || (process.platform === "win32" ? "codex.cmd" : "codex")
const baselineHome = process.env.CODEX_BASELINE_HOME
const installedHome = process.env.CODEX_INSTALLED_HOME || path.join(os.homedir(), ".codex")
const spawnOptions = process.platform === "win32" ? { shell: true } : {}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

function summary(values) {
  return {
    samples: values.length,
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    minMs: Math.min(...values),
    maxMs: Math.max(...values),
  }
}

async function writeReport(name, report) {
  await fsp.mkdir(outDir, { recursive: true })
  const target = path.join(outDir, `${name}-${Date.now()}.json`)
  await fsp.writeFile(target, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${target}\n`)
}

function parseArgs(name) {
  const raw = process.env[name]
  if (!raw) throw new Error(`${name} is required`)
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`${name} must be a JSON string array`)
  }
  return parsed
}

function codexEnv(codexHome) {
  return { ...process.env, CODEX_HOME: codexHome }
}

function timedSync(args, codexHome) {
  const started = performance.now()
  const result = spawnSync(codexCommand, args, {
    encoding: "utf8",
    env: codexEnv(codexHome),
    ...spawnOptions,
  })
  const elapsed = performance.now() - started
  if (result.status !== 0) {
    throw new Error(result.error?.message || result.stderr || result.stdout || `codex exited with ${result.status}`)
  }
  return elapsed
}

async function startup() {
  if (!baselineHome) throw new Error("CODEX_BASELINE_HOME is required")
  const args = parseArgs("CODEX_STARTUP_ARGS_JSON")
  const baseline = []
  const installed = []
  for (let index = 0; index < 20; index += 1) {
    baseline.push(timedSync(args, baselineHome))
    installed.push(timedSync(args, installedHome))
  }
  await writeReport("startup", {
    environment: { platform: os.platform(), node: process.version, codexCommand },
    baseline: summary(baseline),
    installed: summary(installed),
    overheadMedianMs: summary(installed).medianMs - summary(baseline).medianMs,
    raw: { baseline, installed },
  })
}

function ttftOnce(args, codexHome) {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const child = spawn(codexCommand, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: codexEnv(codexHome),
      ...spawnOptions,
    })
    let buffer = ""
    let ttftMs = null
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.stdout.on("data", (chunk) => {
      buffer += chunk
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ""
      for (const line of lines) {
        if (!line.trim()) continue
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        const type = event?.type || event?.event?.type
        const text = event?.item?.text || event?.delta || event?.message?.content
        if (ttftMs === null && (
          type === "response.output_text.delta" ||
          (type === "item.completed" && typeof text === "string" && text)
        )) {
          ttftMs = performance.now() - started
        }
      }
    })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `Codex exited with ${code}`))
      } else if (ttftMs === null) {
        reject(new Error(stderr || "Codex exited before assistant output"))
      } else {
        resolve(ttftMs)
      }
    })
  })
}

async function ttft() {
  if (!baselineHome) throw new Error("CODEX_BASELINE_HOME is required")
  const args = parseArgs("CODEX_TTFT_ARGS_JSON")
  const baseline = []
  const installed = []
  for (let index = 0; index < 30; index += 1) {
    baseline.push(await ttftOnce(args, baselineHome))
    installed.push(await ttftOnce(args, installedHome))
  }
  await writeReport("ttft", {
    environment: { platform: os.platform(), node: process.version, codexCommand },
    baseline: summary(baseline),
    installed: summary(installed),
    overheadMedianMs: summary(installed).medianMs - summary(baseline).medianMs,
    raw: { baseline, installed },
  })
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? Number(process.argv[index + 1]) : fallback
}

function linuxRssKb(pid) {
  if (process.platform !== "linux" || !pid) return null
  const status = fs.readFileSync(`/proc/${pid}/status`, "utf8")
  return Number(/^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1]) || null
}

async function directoryBytes(dir) {
  let total = 0
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) total += await directoryBytes(target)
    else if (entry.isFile()) total += (await fsp.stat(target)).size
  }
  return total
}

async function relayPid() {
  const codexRoot = path.join(os.homedir(), ".agent-insight", "otel_data", "codex")
  const namespaces = await fsp.readdir(codexRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of namespaces) {
    if (!entry.isDirectory()) continue
    try {
      const state = JSON.parse(await fsp.readFile(
        path.join(codexRoot, entry.name, "relay-state.json"),
        "utf8",
      ))
      if (Number.isInteger(state.pid)) return state.pid
    } catch {}
  }
  return undefined
}

async function soak() {
  if (process.platform !== "linux") throw new Error("RSS soak requires Linux /proc")
  const command = parseArgs("CODEX_SOAK_COMMAND_JSON")
  const hours = argValue("--hours", 8)
  const intervalMs = argValue("--interval-ms", 15 * 60 * 1000)
  const durationMs = hours * 60 * 60 * 1000
  const spool = path.join(os.homedir(), ".agent-insight", "otel_data", "codex")
  const child = spawn(command[0], command.slice(1), {
    stdio: ["ignore", "ignore", "pipe"],
    env: codexEnv(installedHome),
  })
  const samples = []
  const startedAt = Date.now()
  let interrupted = false
  const stop = () => {
    interrupted = true
    child.kill("SIGTERM")
  }
  process.once("SIGINT", stop)
  try {
    while (!interrupted && Date.now() - startedAt <= durationMs && child.exitCode === null) {
      const currentRelayPid = await relayPid()
      samples.push({
        timestamp: new Date().toISOString(),
        codexRssKb: linuxRssKb(child.pid),
        relayPid: currentRelayPid,
        relayRssKb: linuxRssKb(currentRelayPid),
        spoolBytes: await directoryBytes(spool),
      })
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM")
    await writeReport("soak", {
      environment: { platform: os.platform(), node: process.version, codexCommand },
      requestedHours: hours,
      completedHours: (Date.now() - startedAt) / 3_600_000,
      interrupted,
      samples,
    })
  }
}

if (mode === "startup") await startup()
else if (mode === "ttft") await ttft()
else if (mode === "soak") await soak()
else throw new Error("Usage: performance.mjs <startup|ttft|soak>")
