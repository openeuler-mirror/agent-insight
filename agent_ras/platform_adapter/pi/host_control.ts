/**
 * pi host control: maps core action wires onto pi extension APIs.
 * The host only delivers (BC-002); all decisions stay in core.
 */

export interface PiSessionContextLike {
  sessionManager?: { getSessionId?: () => string }
  hasUI?: boolean
  isIdle?: () => boolean
  abort?: () => void
  ui?: { notify?: (message: string, level?: string) => void }
}

export interface PiExtensionApiLike {
  sendUserMessage?: (content: string, options?: Record<string, unknown>) => void
}

function asText(message: unknown): string {
  return String(message ?? "")
}

export function createPiSessionHost({
  pi,
  ctxRef,
  sessionId,
}: {
  pi: PiExtensionApiLike
  ctxRef: { current: PiSessionContextLike | null }
  sessionId: string
}) {
  function currentCtx(): PiSessionContextLike | null {
    const ctx = ctxRef?.current
    // sessionId is the join key "pi:<nativeId>"; ctx exposes the native id.
    const nativeId = String(sessionId || "").replace(/^[^:]*:/, "")
    const sid = ctx?.sessionManager?.getSessionId?.()
    return sid && sid === nativeId ? ctx : null
  }

  return {
    async requestAbortStream() {
      try {
        const ctx = currentCtx()
        if (!ctx?.abort) {
          return { ok: false, channel: "pi.abort", error: "no_ctx" }
        }
        ctx.abort()
        return { ok: true, channel: "pi.abort" }
      } catch (error: any) {
        return { ok: false, channel: "pi.abort", error: error?.message || String(error) }
      }
    },

    async emitUserNotice(message: unknown) {
      try {
        const ctx = currentCtx()
        const text = asText(message)
        if (!ctx?.ui?.notify || ctx.hasUI === false) {
          console.log(`[insight-ras] notice (no UI): ${text}`)
          return { ok: true, channel: "pi.notice.noop" }
        }
        ctx.ui.notify(text, "info")
        return { ok: true, channel: "pi.notify" }
      } catch (error: any) {
        return { ok: false, channel: "pi.notify", error: error?.message || String(error) }
      }
    },

    async pushSteering(message: unknown) {
      try {
        const ctx = currentCtx()
        const text = asText(message)
        if (!ctx || typeof pi?.sendUserMessage !== "function") {
          return { ok: false, channel: "pi.steer", error: "no_ctx" }
        }
        if (ctx.isIdle?.()) {
          pi.sendUserMessage(text)
          return { ok: true, channel: "pi.send" }
        }
        pi.sendUserMessage(text, { deliverAs: "steer" })
        return { ok: true, channel: "pi.steer" }
      } catch (error: any) {
        return { ok: false, channel: "pi.steer", error: error?.message || String(error) }
      }
    },
  }
}
