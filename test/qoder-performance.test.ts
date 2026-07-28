import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"
import test from "node:test"

import { collectQoderHook } from "../scripts/qoder_trace_collector.mjs"
import { mergeQoderHooks, QODER_HOOK_EVENTS } from "../scripts/qoder_setup.mjs"
import { mergeQoderWorkHooks, QODER_WORK_HOOK_EVENTS } from "../scripts/qoder_work_setup.mjs"

const FIRST_TOKEN_DELAY_MS = 250
const FIRST_TOKEN_TRIALS = 7

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function collectorHandlers(settings: Record<string, unknown>, eventName: string): Array<Record<string, unknown>> {
  const hooks = settings.hooks as Record<string, Array<{ hooks?: Array<Record<string, unknown>> }>>
  return (hooks[eventName] || []).flatMap((group) => group.hooks || [])
    .filter((handler) => String(handler.command || "").includes("qoder_trace_collector.mjs"))
}

function startFirstTokenServer(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    })
    setTimeout(() => {
      response.end("data: first-token\n\n")
    }, FIRST_TOKEN_DELAY_MS)
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject)
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Unable to resolve the local first-token benchmark port"))
        return
      }
      resolve({ server, port: address.port })
    })
  })
}

function waitForFirstToken(port: number, agent: http.Agent, beforeRequest?: () => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now()
    beforeRequest?.()
    const request = http.get({ host: "127.0.0.1", port, path: "/v1/chat", agent }, (response) => {
      response.once("data", () => resolve(performance.now() - startedAt))
      response.once("error", reject)
      response.resume()
    })
    request.once("error", reject)
  })
}

test("AC27 Qoder startup work is asynchronous and synchronous collector dispatch stays below 200ms", async (context) => {
  const collectorPath = path.join(process.cwd(), "scripts", "qoder_trace_collector.mjs")
  const cliSettings = mergeQoderHooks({}, { nodePath: process.execPath, collectorPath }) as Record<string, unknown>
  for (const eventName of QODER_HOOK_EVENTS) {
    const handlers = collectorHandlers(cliSettings, eventName)
    assert.equal(handlers.length, 1)
    assert.equal(handlers[0].async, true, `${eventName} must be asynchronous for CLI/Desktop/JetBrains`)
  }

  const workSettings = mergeQoderWorkHooks({}, { nodePath: process.execPath, collectorPath }) as Record<string, unknown>
  for (const eventName of QODER_WORK_HOOK_EVENTS) {
    const handlers = collectorHandlers(workSettings, eventName)
    assert.equal(handlers.length, 1)
    assert.equal(handlers[0].async, true, `${eventName} must be asynchronous for Qoder Work`)
  }

  const desktopSource = fs.readFileSync(path.join(process.cwd(), "integrations", "qoder-desktop", "extension.js"), "utf8")
  const jetBrainsSource = fs.readFileSync(path.join(
    process.cwd(), "integrations", "qoder-jetbrains", "src", "main", "java", "org", "openeuler", "agentinsight", "qoder", "CollectorInstaller.java",
  ), "utf8")
  assert.match(desktopSource, /setTimeout\(\(\) => void installCollector\(context\), 0\)/)
  assert.match(jetBrainsSource, /executeOnPooledThread\(\(\) ->/)

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-startup-performance-"))
  try {
    const dispatchTimes: Record<string, number> = {}
    for (const product of ["cli", "desktop", "jetbrains", "work"]) {
      const startedAt = performance.now()
      const completion = collectQoderHook({
        session_id: `ac27-${product}`,
        hook_event_name: "SessionStart",
        qoder_product: product,
      }, {
        homeDir: root,
        insightDir: path.join(root, ".agent-insight"),
        qoderHome: path.join(root, ".qoder"),
        spoolDir: path.join(root, "spool", product),
        env: { AGENT_INSIGHT_API_KEY: "ac27-account" },
        disableUploadKick: true,
      })
      const synchronousDispatchMs = performance.now() - startedAt
      await completion
      dispatchTimes[product] = synchronousDispatchMs
      assert.ok(synchronousDispatchMs < 200, `${product} synchronous startup dispatch took ${synchronousDispatchMs.toFixed(2)}ms`)
    }
    context.diagnostic(`AC27 synchronous startup dispatch: ${JSON.stringify(dispatchTimes)}`)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("AC28 asynchronous prompt collection adds less than 5% to first-token latency", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-first-token-performance-"))
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
  const { server, port } = await startFirstTokenServer()
  const baseline: number[] = []
  const instrumented: number[] = []
  let sequence = 0
  try {
    // Warm the loopback connection and collector directory before recording the
    // medians. Startup cost is covered independently by AC27.
    await waitForFirstToken(port, agent)
    await collectQoderHook({
      session_id: "ac28-warmup",
      hook_event_name: "UserPromptSubmit",
      qoder_product: "desktop",
      prompt: "warmup",
    }, {
      homeDir: root,
      insightDir: path.join(root, ".agent-insight"),
      qoderHome: path.join(root, ".qoder"),
      spoolDir: path.join(root, "spool"),
      env: { AGENT_INSIGHT_API_KEY: "ac28-account" },
      disableUploadKick: true,
    })

    const measureInstrumented = async () => {
      let collectorCompletion: Promise<unknown> | undefined
      const elapsed = await waitForFirstToken(port, agent, () => {
        collectorCompletion = collectQoderHook({
          session_id: `ac28-${sequence++}`,
          hook_event_name: "UserPromptSubmit",
          qoder_product: "desktop",
          prompt: "Return one token.",
        }, {
          homeDir: root,
          insightDir: path.join(root, ".agent-insight"),
          qoderHome: path.join(root, ".qoder"),
          spoolDir: path.join(root, "spool"),
          env: { AGENT_INSIGHT_API_KEY: "ac28-account" },
          disableUploadKick: true,
        })
      })
      await collectorCompletion
      instrumented.push(elapsed)
    }

    // Alternate order so scheduler or machine-temperature drift affects both
    // groups evenly. The local SSE endpoint produces the first response chunk
    // after a fixed delay; the instrumented clock also includes collector
    // dispatch before the model request starts.
    for (let index = 0; index < FIRST_TOKEN_TRIALS; index++) {
      if (index % 2 === 0) {
        baseline.push(await waitForFirstToken(port, agent))
        await measureInstrumented()
      } else {
        await measureInstrumented()
        baseline.push(await waitForFirstToken(port, agent))
      }
    }

    const baselineMedian = median(baseline)
    const instrumentedMedian = median(instrumented)
    const increase = (instrumentedMedian - baselineMedian) / baselineMedian
    context.diagnostic(`AC28 first-token medians: baseline=${baselineMedian.toFixed(2)}ms, instrumented=${instrumentedMedian.toFixed(2)}ms, increase=${(increase * 100).toFixed(2)}%`)
    assert.ok(increase < 0.05, `first-token median increased by ${(increase * 100).toFixed(2)}% (limit: <5%)`)
  } finally {
    agent.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
