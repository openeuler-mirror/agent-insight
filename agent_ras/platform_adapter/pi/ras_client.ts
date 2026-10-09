/**
 * In-process RAS client for the pi extension runtime.
 * Port of ../common/ras_client.js with the koffi bridge bound in.
 */

import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import * as bridge from "./bridge/koffi_bridge.ts"

// 默认开启；RAS_DEBUG_WIRE=0 / false 显式关闭
function wireDebugEnabled(): boolean {
  const v = process.env.RAS_DEBUG_WIRE
  return !(v === "0" || v === "false")
}

// 把每次 inproc 调用的请求载荷与返回结果原样落 JSONL（观测/排障用），可用 RAS_DEBUG_WIRE=0 关闭
function traceWire(op: string, sessionId: string, payload: any, result: unknown) {
  if (!wireDebugEnabled()) return
  try {
    const dir = join(bridge.insightRasDir(), "log")
    mkdirSync(dir, { recursive: true })
    appendFileSync(
      join(dir, "pi-wire.jsonl"),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        pid: process.pid,
        op,
        sessionId,
        request: payload,
        result,
      })}\n`,
      "utf8",
    )
  } catch { /* ignore */ }
}

export function createRasClient(options: Record<string, any> = {}) {
  const enabled = options.enabled !== false
  let ready = false
  let onActions: any = options.onActions || null

  async function call(op: string, sessionId: string, payload: any = {}) {
    if (!enabled) return null
    try {
      if (!ready && !bridge.embedReady()) {
        traceWire(op, sessionId, payload, { skipped: "embed_not_ready" })
        return null
      }
      ready = true
      const result = bridge.embedCall(op, sessionId, payload)
      traceWire(op, sessionId, payload, result)
      return result
    } catch (error: any) {
      ready = false
      console.error(
        `[insight-ras] inproc ${op} failed:`,
        error?.message || String(error),
      )
      return null
    }
  }

  async function dispatchActions(result: any, sessionId: string) {
    if (onActions && result?.actions?.length) {
      await onActions(sessionId, result.actions, result.anomaly)
    }
    return result
  }

  return {
    baseUrl: null,
    enabled,
    transport: "inproc",
    async ensure() {
      if (!enabled) return false
      ready = bridge.embedReady()
      return ready
    },
    async hello(sessionId: string, platform: string, config: unknown) {
      return call("hello", sessionId, { platform, config: config || {} })
    },
    async observe(sessionId: string, payload: any) {
      return dispatchActions(
        await call("observe", sessionId, payload || {}),
        sessionId,
      )
    },
    async reset(sessionId: string) {
      if (!ready) return
      await call("reset", sessionId, {})
    },
    async reportActionResult(sessionId: string, result: any) {
      const out = await call("action_result", sessionId, {
        action: result?.action,
        ok: Boolean(result?.ok),
        channel: result?.channel,
        error: result?.error,
        message: result?.message,
        trace_anchor: result?.trace_anchor,
        delivery_anchor: result?.delivery_anchor,
      })
      return Boolean((out as any)?.ok)
    },
    async flush(sessionId: string, timeoutMs = 2500) {
      if (!ready) return null
      return call("flush", sessionId, { timeout_ms: timeoutMs })
    },
    async skillResult(sessionId: string, payload: any) {
      return dispatchActions(
        await call("skill_result", sessionId, payload || {}),
        sessionId,
      )
    },
    async bye(sessionId: string) {
      if (!ready) return
      await call("flush", sessionId, { timeout_ms: 2500 })
      await call("bye", sessionId, {})
    },
    setOnActions(handler: any) {
      onActions = handler
    },
  }
}
