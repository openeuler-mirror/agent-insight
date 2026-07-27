import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"

const root = process.cwd()
const outDir = path.join(root, "test", "pi-agent-trace", "out")
const mode = process.argv[2]
const piCommand = process.platform === "win32" ? "pi.cmd" : "pi"
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

function timedSync(args) {
  const started = performance.now()
  const result = spawnSync(piCommand, args, { encoding: "utf8", ...spawnOptions })
  const elapsed = performance.now() - started
  if (result.status !== 0) {
    throw new Error(result.error?.message || result.stderr || result.stdout || `pi exited with ${result.status}`)
  }
  return elapsed
}

async function startup() {
  const baseline = []
  const installed = []
  for (let index = 0; index < 20; index += 1) {
    baseline.push(timedSync(["--no-extensions", "--list-models"]))
    installed.push(timedSync(["--list-models"]))
  }
  await writeReport("startup", {
    environment: { platform: os.platform(), node: process.version },
    baseline: summary(baseline),
    installed: summary(installed),
    overheadMedianMs: summary(installed).medianMs - summary(baseline).medianMs,
    raw: { baseline, installed },
  })
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

function ttftOnce(baseArgs, withoutExtensions) {
  return new Promise((resolve, reject) => {
    const args = withoutExtensions ? ["--no-extensions", ...baseArgs] : baseArgs
    const started = performance.now()
    const child = spawn(piCommand, args, { stdio: ["ignore", "pipe", "pipe"], ...spawnOptions })
    let buffer = ""
    let measured = false
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
        const delta = event?.assistantMessageEvent?.delta
        if (!measured && event?.type === "message_update" && typeof delta === "string" && delta) {
          measured = true
          resolve(performance.now() - started)
        }
      }
    })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (!measured) reject(new Error(stderr || `Pi exited with ${code} before a text delta`))
    })
  })
}

async function ttft() {
  const args = parseArgs("PI_BENCH_ARGS_JSON")
  const baseline = []
  const installed = []
  for (let index = 0; index < 30; index += 1) {
    baseline.push(await ttftOnce(args, true))
    installed.push(await ttftOnce(args, false))
  }
  await writeReport("ttft", {
    environment: { platform: os.platform(), node: process.version },
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
  if (process.platform !== "linux") return null
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

async function soak() {
  if (process.platform !== "linux") throw new Error("RSS soak requires Linux /proc")
  const command = parseArgs("PI_SOAK_COMMAND_JSON")
  const hours = argValue("--hours", 8)
  const intervalMs = argValue("--interval-ms", 15 * 60 * 1000)
  const durationMs = hours * 60 * 60 * 1000
  const spool = path.join(os.homedir(), ".agent-insight", "otel_data", "pi-agent")
  const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "ignore", "pipe"] })
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
      samples.push({
        timestamp: new Date().toISOString(),
        rssKb: linuxRssKb(child.pid),
        spoolBytes: await directoryBytes(spool),
      })
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM")
    await writeReport("soak", {
      environment: { platform: os.platform(), node: process.version },
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
