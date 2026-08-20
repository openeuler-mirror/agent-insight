/**
 * Wire action dispatcher aligned with core HostControl.
 *
 * Wire ↔ Host:
 *   abort_stream  → requestAbortStream()
 *   emit_notice   → emitUserNotice(message)
 *   push_steering → pushSteering(message)
 *
 * Platform-specific APIs belong in each platform's host_control — not here.
 */

export const WIRE_TO_HOST = {
  abort_stream: "requestAbortStream",
  emit_notice: "emitUserNotice",
  push_steering: "pushSteering",
}

/**
 * @typedef {{
 *   requestAbortStream?: () => (void|Promise<void>|Promise<{ok?: boolean, channel?: string, error?: string}>|{ok?: boolean, channel?: string, error?: string}),
 *   emitUserNotice?: (message: string) => (void|Promise<void>|Promise<{ok?: boolean, channel?: string, error?: string}>|{ok?: boolean, channel?: string, error?: string}),
 *   pushSteering?: (message: string) => (void|Promise<void>|Promise<{ok?: boolean, channel?: string, error?: string}>|{ok?: boolean, channel?: string, error?: string}),
 * }} RasHost
 */

/**
 * Apply wire actions in order via a HostControl-shaped host.
 *
 * @param {RasHost} host
 * @param {Array<{type?: string, message?: string}>} actions
 * @param {{ onResult?: (result: {action: string, ok: boolean, channel?: string, error?: string, message?: string, delivery_anchor?: object}) => (void|Promise<void>) }} [options]
 * @returns {Promise<Array<{action: string, ok: boolean, channel?: string, error?: string, message?: string, delivery_anchor?: object}>>}
 */
export async function applyActions(host, actions, options = {}) {
  const onResult = options.onResult
  const results = []
  for (const action of actions || []) {
    const type = String(action?.type || "")
    const message = type === "abort_stream" ? undefined : String(action?.message || "")
    const method = WIRE_TO_HOST[type]
    let result = {
      action: type || "unknown",
      ok: false,
      error: "unknown action",
      ...(message ? { message } : {}),
    }

    if (!method) {
      console.error("[insight-ras] unknown wire action", type)
    } else if (typeof host?.[method] !== "function") {
      result = {
        action: type,
        ok: false,
        error: `host missing ${method}`,
        ...(message ? { message } : {}),
      }
      console.error("[insight-ras] host missing method", method)
    } else {
      try {
        const arg = type === "abort_stream" ? undefined : message
        const raw =
          type === "abort_stream"
            ? await host.requestAbortStream()
            : await host[method](arg)
        if (raw && typeof raw === "object" && "ok" in raw) {
          result = {
            action: type,
            ok: Boolean(raw.ok),
            channel: raw.channel,
            error: raw.error,
            ...(message ? { message } : {}),
            ...(raw.delivery_anchor ? { delivery_anchor: raw.delivery_anchor } : {}),
          }
        } else {
          result = { action: type, ok: true, ...(message ? { message } : {}) }
        }
      } catch (err) {
        result = {
          action: type,
          ok: false,
          error: err?.message || String(err),
          ...(message ? { message } : {}),
        }
        console.error("[insight-ras] action failed", type, err)
      }
    }

    results.push(result)
    if (onResult) {
      try {
        await onResult(result)
      } catch (err) {
        console.error("[insight-ras] onResult failed", err)
      }
    }
  }
  return results
}

export default applyActions
