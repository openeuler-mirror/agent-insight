import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const MB = 1024 * 1024

function parseArgs(args) {
  const options = {
    durationMs: 8 * 60 * 60 * 1000,
    intervalMs: 60 * 1000,
    maxRssMb: 50,
    maxGrowthMb: 5,
    maxSlopeMbPerHour: 1,
    products: [],
  }
  for (const arg of args) {
    const [key, rawValue = ""] = arg.replace(/^--/, "").split("=", 2)
    if (key === "duration-hours") options.durationMs = Number(rawValue) * 60 * 60 * 1000
    else if (key === "duration-seconds") options.durationMs = Number(rawValue) * 1000
    else if (key === "interval-seconds") options.intervalMs = Number(rawValue) * 1000
    else if (key === "max-rss-mb") options.maxRssMb = Number(rawValue)
    else if (key === "max-growth-mb") options.maxGrowthMb = Number(rawValue)
    else if (key === "max-slope-mb-per-hour") options.maxSlopeMbPerHour = Number(rawValue)
    else if (key === "products") options.products = rawValue.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean)
  }
  for (const [name, value] of Object.entries(options)) {
    if (name === "products") continue
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid --${name}: ${value}`)
  }
  return options
}

function walkLocks(root) {
  const locks = []
  const visit = (directory) => {
    let entries = []
    try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (entry.isFile() && entry.name === "uploader.lock") locks.push(target)
    }
  }
  visit(root)
  return locks
}

function discoverTargets(insightDir, requestedProducts) {
  const familyRoot = path.join(insightDir, "otel_data", "qoder")
  const requested = new Set(requestedProducts)
  const byProduct = new Map()
  for (const lockPath of walkLocks(familyRoot)) {
    const relative = path.relative(familyRoot, lockPath).split(path.sep)
    const product = String(relative[0] || "").toLowerCase()
    if (!product || (requested.size && !requested.has(product))) continue
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"))
      const pid = Number(lock.pid)
      if (Number.isInteger(pid) && pid > 0) byProduct.set(product, { product, pid, lockPath, startedAt: lock.startedAt })
    } catch {}
  }
  if (requested.size) {
    const missing = [...requested].filter((product) => !byProduct.has(product))
    if (missing.length) throw new Error(`No active unified-spool uploader lock for: ${missing.join(", ")}`)
  }
  const targets = [...byProduct.values()].sort((left, right) => left.product.localeCompare(right.product))
  if (!targets.length) throw new Error(`No Qoder uploader locks found below ${familyRoot}`)
  return targets
}

function windowsRss(pids) {
  const ids = pids.filter((pid) => Number.isInteger(pid) && pid > 0).join(",")
  const script = `Get-Process -Id @(${ids}) -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.Id),$($_.WorkingSet64)\" }`
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  })
  const values = new Map()
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    const [pid, bytes] = line.trim().split(",").map(Number)
    if (Number.isInteger(pid) && Number.isFinite(bytes)) values.set(pid, bytes)
  }
  return values
}

function unixRss(pids) {
  const values = new Map()
  if (process.platform === "linux") {
    for (const pid of pids) {
      try {
        const match = fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/^VmRSS:\s+(\d+)\s+kB$/m)
        if (match) values.set(pid, Number(match[1]) * 1024)
      } catch {}
    }
    return values
  }
  const result = spawnSync("ps", ["-o", "pid=,rss=", "-p", pids.join(",")], { encoding: "utf8", timeout: 10_000 })
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    const [pid, rssKb] = line.trim().split(/\s+/).map(Number)
    if (Number.isInteger(pid) && Number.isFinite(rssKb)) values.set(pid, rssKb * 1024)
  }
  return values
}

function readRss(pids) {
  return process.platform === "win32" ? windowsRss(pids) : unixRss(pids)
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function slopeMbPerHour(samples) {
  if (samples.length < 2) return 0
  const origin = samples[0].timestampMs
  const points = samples.map((sample) => ({ x: (sample.timestampMs - origin) / 3_600_000, y: sample.rssMb }))
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length
  const numerator = points.reduce((sum, point) => sum + ((point.x - meanX) * (point.y - meanY)), 0)
  const denominator = points.reduce((sum, point) => sum + ((point.x - meanX) ** 2), 0)
  return denominator ? numerator / denominator : 0
}

function summarize(targets, samplesByPid, options, startedAt, completedAt) {
  const products = targets.map((target) => {
    const samples = samplesByPid.get(target.pid) || []
    const edgeCount = Math.max(1, Math.ceil(samples.length * 0.1))
    const firstMedianMb = median(samples.slice(0, edgeCount).map((sample) => sample.rssMb))
    const lastMedianMb = median(samples.slice(-edgeCount).map((sample) => sample.rssMb))
    const peakRssMb = Math.max(...samples.map((sample) => sample.rssMb))
    const growthMb = lastMedianMb - firstMedianMb
    const slope = slopeMbPerHour(samples)
    const passed = peakRssMb < options.maxRssMb && growthMb <= options.maxGrowthMb && slope <= options.maxSlopeMbPerHour
    return {
      product: target.product,
      pid: target.pid,
      sampleCount: samples.length,
      firstMedianMb,
      lastMedianMb,
      peakRssMb,
      growthMb,
      slopeMbPerHour: slope,
      passed,
    }
  })
  return {
    acceptanceCriterion: "AC29",
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    monitoredHours: (completedAt - startedAt) / 3_600_000,
    thresholds: {
      maxRssMb: options.maxRssMb,
      maxGrowthMb: options.maxGrowthMb,
      maxSlopeMbPerHour: options.maxSlopeMbPerHour,
    },
    products,
    passed: products.every((product) => product.passed),
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const insightDir = process.env.AGENT_INSIGHT_HOME || path.join(os.homedir(), ".agent-insight")
  const outputDir = path.join(insightDir, "performance")
  fs.mkdirSync(outputDir, { recursive: true })
  const targets = discoverTargets(insightDir, options.products)
  const runId = new Date().toISOString().replace(/[:.]/g, "-")
  const samplesPath = path.join(outputDir, `qoder-ac29-${runId}.jsonl`)
  const summaryPath = path.join(outputDir, `qoder-ac29-${runId}.summary.json`)
  const samplesByPid = new Map(targets.map((target) => [target.pid, []]))
  const startedAt = Date.now()

  while (true) {
    const timestampMs = Date.now()
    const rssByPid = readRss(targets.map((target) => target.pid))
    for (const target of targets) {
      const rssBytes = rssByPid.get(target.pid)
      if (!Number.isFinite(rssBytes)) throw new Error(`${target.product} uploader PID ${target.pid} exited during the soak`)
      const sample = { timestamp: new Date(timestampMs).toISOString(), timestampMs, product: target.product, pid: target.pid, rssMb: rssBytes / MB }
      samplesByPid.get(target.pid).push(sample)
      fs.appendFileSync(samplesPath, `${JSON.stringify(sample)}\n`, "utf8")
    }
    const remainingMs = options.durationMs - (Date.now() - startedAt)
    if (remainingMs <= 0) break
    await new Promise((resolve) => setTimeout(resolve, Math.min(options.intervalMs, remainingMs)))
  }

  const summary = summarize(targets, samplesByPid, options, startedAt, Date.now())
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8")
  process.stdout.write(`${JSON.stringify({ ...summary, samplesPath, summaryPath }, null, 2)}\n`)
  if (!summary.passed) process.exitCode = 1
}

const invokedPath = process.argv[1]
  ? pathToFileURL(fs.realpathSync(path.resolve(process.argv[1]))).href
  : ""
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`agent-insight-qoder-ac29: ${error?.message || String(error)}\n`)
    process.exitCode = 1
  })
}

export { discoverTargets, median, parseArgs, slopeMbPerHour, summarize }
