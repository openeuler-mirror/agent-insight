/**
 * Agent Insight RAS — pi platform adapter (L3).
 *
 * Observes assistant text/thinking deltas and tool executions, feeds the
 * core via the inproc bridge, and delivers abort/notice/steering actions
 * back through pi APIs. Fail-open everywhere: any error degrades to
 * "no observation", never into the host.
 *
 * D-003: observations continue inside the abort window (throttle only);
 * the hub's no_effect probe depends on window-internal observes.
 */

import { existsSync, readFileSync } from "node:fs"
import { applyActions } from "../common/host_actions.js"
import { createRasClient } from "./ras_client.ts"
import { createPiSessionHost } from "./host_control.ts"
import {
  resolveConfigPath,
  resolvePlatformCapabilityFromRas,
  syncCapabilityConfigFromInsight,
} from "./config_sync.ts"

export const OBSERVE_MIN_CHARS = 32
export const OBSERVE_HOT_CHARS = 100
export const OBSERVE_HOT_GROWTH = 40
export const OBSERVE_EARLY_GROWTH = 80

export function sessionKey(platform: string, nativeId: string | undefined | null): string {
  return `${platform}:${nativeId || "session"}`
}

// D-003: no aborting branch here (unlike the OpenCode adapter).
export function shouldObserveGrowth(len: number, prevLen: number): boolean {
  if (len < OBSERVE_MIN_CHARS) return false
  const growth = len - (prevLen || 0)
  if (growth <= 0) return false
  if (len >= OBSERVE_HOT_CHARS) return growth >= OBSERVE_HOT_GROWTH
  if (growth < OBSERVE_EARLY_GROWTH && len < 500) return false
  return true
}

export function shouldObserveText(text: string, prevLen: number): boolean {
  return shouldObserveGrowth(text ? text.length : 0, prevLen)
}

export function pickStreamingDelta(
  message: any,
  assistantMessageEvent: any,
): { channel: "llm_output" | "llm_reasoning"; delta: string } | null {
  if (!message || String(message.role) !== "assistant") return null
  const type = String(assistantMessageEvent?.type || "")
  const delta = assistantMessageEvent?.delta
  if (typeof delta !== "string" || !delta) return null
  if (type === "text_delta") return { channel: "llm_output", delta }
  if (type === "thinking_delta") return { channel: "llm_reasoning", delta }
  return null
}

function toolResultText(result: any): string {
  if (result == null) return ""
  if (typeof result === "string") return result
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}

function loadCapabilityConfig(platform: string) {
  try {
    const configPath = resolveConfigPath()
    if (!existsSync(configPath)) return {}
    const cfg = JSON.parse(readFileSync(configPath, "utf8"))
    const slice =
      resolvePlatformCapabilityFromRas(cfg?.agent_ras, platform) ||
      ({} as Record<string, any>)
    const recovery =
      slice.recovery && typeof slice.recovery === "object" ? slice.recovery : {}
    return {
      detectors: slice.detectors || {},
      notify_user_on_warning: recovery.notify_user_on_warning,
      recovery: { ...recovery },
      debug: Boolean(cfg?.agent_ras?.debug),
    }
  } catch {
    return {}
  }
}

async function setupRasPiExtension(pi: any) {
  const rasDebugEarly = process.env.RAS_DEBUG === "1" || process.env.RAS_DEBUG === "true"
  const rasLogEarly = (...args: any[]) => {
    if (rasDebugEarly) console.error("[insight-ras]", ...args)
  }
  await syncCapabilityConfigFromInsight({ platform: "pi", log: rasLogEarly })
  const helloPayload = loadCapabilityConfig("pi")
  const rasDebug = rasDebugEarly || (helloPayload as any).debug === true
  const rasLog = (...args: any[]) => {
    if (rasDebug) console.error("[insight-ras]", ...args)
  }

  const greeted = new Set<string>()
  const lastObservedLen = new Map<string, number>()
  const textBuffers = new Map<string, string>()
  const thinkBuffers = new Map<string, string>()
  const pendingText = new Map<string, any>()
  const toolQueues = new Map<string, any[]>()
  const observing = new Set<string>()
  const ctxRef: { current: any } = { current: null }

  const ras = createRasClient({
    onActions: async (sessionId: string, actions: any[], anomaly: any) => {
      const sessionHost = createPiSessionHost({ pi, ctxRef, sessionId })
      await applyActions(sessionHost, actions, {
        onResult: (result: any) =>
          ras.reportActionResult(sessionId, {
            ...result,
            trace_anchor: anomaly?.trace_anchor,
            delivery_anchor: result?.delivery_anchor,
          }),
      })
    },
  })

  function sidOf(ctx: any): string {
    return sessionKey("pi", ctx?.sessionManager?.getSessionId?.())
  }

  function resetTurnState(sid: string) {
    textBuffers.delete(sid)
    thinkBuffers.delete(sid)
    lastObservedLen.delete(sid)
    ras.flush(sid).catch(() => {})
  }

  function clearSessionState(sid: string) {
    greeted.delete(sid)
    lastObservedLen.delete(sid)
    textBuffers.delete(sid)
    thinkBuffers.delete(sid)
    pendingText.delete(sid)
    toolQueues.delete(sid)
    observing.delete(sid)
  }

  async function drainObserve(sid: string) {
    if (observing.has(sid)) return
    observing.add(sid)
    try {
      while (true) {
        if (!greeted.has(sid)) {
          greeted.add(sid)
          try {
            await ras.hello(sid, "pi", helloPayload)
          } catch (error: any) {
            rasLog("hello failed:", error?.message || error)
          }
        }
        const queue = toolQueues.get(sid)
        const toolPayload = queue && queue.length ? queue.shift() : null
        const textPayload = pendingText.get(sid) || null
        if (textPayload) pendingText.delete(sid)
        const payload = toolPayload || textPayload
        if (!payload) break
        try {
          await ras.observe(sid, payload)
        } catch (error: any) {
          rasLog("observe failed:", error?.message || error)
        }
      }
    } finally {
      observing.delete(sid)
    }
  }

  function scheduleToolObserve(sid: string, payload: any) {
    let queue = toolQueues.get(sid)
    if (!queue) {
      queue = []
      toolQueues.set(sid, queue)
    }
    queue.push(payload)
    void drainObserve(sid)
  }

  pi.on("session_start", (event: any, ctx: any) => {
    try {
      ctxRef.current = ctx
      // /new /resume /fork replay shutdown+start: core session state is fresh,
      // drop stale accumulators so thresholds stay comparable.
      clearSessionState(sidOf(ctx))
      rasLog("session_start", event?.reason, sidOf(ctx))
    } catch (error: any) {
      rasLog("session_start failed:", error?.message || error)
    }
  })

  pi.on("session_shutdown", (event: any, ctx: any) => {
    try {
      const sid = sidOf(ctx)
      clearSessionState(sid)
      rasLog("session_shutdown", event?.reason, sid)
      void ras.bye(sid).catch(() => {})
    } catch (error: any) {
      rasLog("session_shutdown failed:", error?.message || error)
    }
  })

  pi.on("message_update", (event: any, ctx: any) => {
    try {
      ctxRef.current = ctx
      const sid = sidOf(ctx)
      const picked = pickStreamingDelta(event?.message, event?.assistantMessageEvent)
      if (!picked) return
      if (picked.channel === "llm_output") {
        textBuffers.set(sid, (textBuffers.get(sid) || "") + picked.delta)
      } else {
        thinkBuffers.set(sid, (thinkBuffers.get(sid) || "") + picked.delta)
      }
      const total =
        (textBuffers.get(sid) || "").length + (thinkBuffers.get(sid) || "").length
      const prev = lastObservedLen.get(sid) || 0
      if (!shouldObserveGrowth(total, prev)) return
      lastObservedLen.set(sid, total)
      const messageId = String(event?.message?.id || "")
      const snapshot = picked.channel === "llm_output"
        ? textBuffers.get(sid) || ""
        : thinkBuffers.get(sid) || ""
      pendingText.set(sid, {
        kind: "assistant_text",
        channel: picked.channel,
        text: snapshot,
        mode: "snapshot",
        trace_anchor: { message_id: messageId, channel: picked.channel },
      })
      void drainObserve(sid)
    } catch (error: any) {
      rasLog("message_update failed:", error?.message || error)
    }
  })

  pi.on("tool_execution_end", (event: any, ctx: any) => {
    try {
      ctxRef.current = ctx
      const sid = sidOf(ctx)
      const toolCallId = String(event?.toolCallId || "")
      const resultText = toolResultText(event?.result)
      const tool: Record<string, any> = {
        name: String(event?.toolName || ""),
        phase: "after",
        args: event?.args && typeof event.args === "object" ? event.args : {},
      }
      if (event?.isError) tool.error = resultText
      else tool.result = resultText
      scheduleToolObserve(sid, {
        kind: "tool",
        tool,
        trace_anchor: {
          message_id: toolCallId,
          call_id: toolCallId,
          channel: "tool_call",
        },
      })
    } catch (error: any) {
      rasLog("tool_execution_end failed:", error?.message || error)
    }
  })

  // Turn boundaries: reset accumulators so thresholds stay per-turn comparable.
  pi.on("agent_settled", (_event: any, ctx: any) => {
    try {
      ctxRef.current = ctx
      resetTurnState(sidOf(ctx))
    } catch (error: any) {
      rasLog("agent_settled failed:", error?.message || error)
    }
  })

  pi.on("turn_end", (_event: any, ctx: any) => {
    try {
      ctxRef.current = ctx
      resetTurnState(sidOf(ctx))
    } catch (error: any) {
      rasLog("turn_end failed:", error?.message || error)
    }
  })

  rasLog("pi extension ready")
}

export default async function createRasPiExtension(pi: any) {
  try {
    await setupRasPiExtension(pi)
  } catch (error: any) {
    console.error(
      "[insight-ras] pi extension init failed (fail-open):",
      error?.message || error,
    )
  }
}
