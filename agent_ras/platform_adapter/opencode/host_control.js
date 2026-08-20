/**
 * OpenCode HostControl equivalent (L3).
 *
 * Delivery only: toast / abort / prompt APIs. Message bodies come from
 * RAS core robustness_prompt — do not rewrite wire text.
 *
 * SDK shapes (@opencode-ai/sdk buildClientParams — version-dependent!):
 *   showToast({ message, variant, title?, duration? })  // flat body fields
 *   executeCommand({ command: "session.interrupt" })    // TUI keybind; needs focus
 *   session.abort({ sessionID })                        // SDK v2 / OC 1.18+
 *   session.abort({ path: { id } })                     // SDK v1 — required or abort 500s
 *   session.interrupt?.({ sessionID })                  // POST /api/session/:id/interrupt
 *   session.prompt({ path: { id }, body: { parts } })   // SDK v1 — required
 *   session.prompt({ sessionID, parts })                // SDK v2
 *   HTTP POST {serverUrl}/session/{id}/prompt_async     // fallback (PluginInput.serverUrl)
 *
 * Nested `{ path: { id } }` is WRONG for v2 (dropped/500) but REQUIRED for v1.
 * Flat `{ sessionID }` is WRONG for v1. Host tries both. Esc in TUI eventually
 * calls session.abort; the keybind alone needs focus + double-press.
 */

const ABORT_RETRY_MS = 300
const ABORT_MAX_ATTEMPTS = 5

const FALLBACK_ABORT_UNCONFIRMED =
  "无法确认已截断当前生成流，请手动停止（Esc / Abort）。停止后将尝试纠偏续作。"

/**
 * Normalize SDK / fetch-style responses to a boolean success.
 *
 * @opencode-ai/sdk (hey-api) returns `{ data, error, response }` with
 * `responseStyle: "fields"`. Void/toast endpoints often have `data: undefined`
 * on HTTP 200 — that must count as success (old Boolean(data) treated them as fail
 * and fell through to console.error USER_NOTICE).
 */
function sdkOk(raw) {
  if (raw === true || raw == null) return true
  if (raw === false) return false
  if (typeof raw !== "object") return Boolean(raw)
  if (raw.error != null && raw.error !== false) return false
  const status = raw.response?.status ?? raw.status
  if (typeof status === "number" && (status < 200 || status >= 300)) {
    // 204 No Content is success for prompt_async / toast.
    if (status !== 204) return false
  }
  // Prefer hey-api `data` over `response.ok` — Response objects may be present
  // even when callers only care about the boolean/void payload.
  if ("data" in raw) return raw.data !== false
  if (raw.response && typeof raw.response.ok === "boolean") {
    return raw.response.ok
  }
  if (raw.ok === false) return false
  if (raw.ok === true) return true
  return true
}

function summarizeRaw(raw) {
  if (raw == null) return String(raw)
  if (typeof raw !== "object") return String(raw)
  try {
    return JSON.stringify({
      data: raw.data,
      error: raw.error,
      ok: raw.ok,
      status: raw.response?.status ?? raw.status,
    })
  } catch {
    return String(raw)
  }
}

function summarizeSdkFailure(label, raw) {
  return `${label} returned falsy: ${summarizeRaw(raw)}`
}

/**
 * Best-effort extract OpenCode message/part ids from session.prompt responses.
 * Shapes vary by SDK version (hey-api fields, bare info, parts array).
 * Prefer sync prompt (not prompt_async 204) so delivery_anchor can be recovered.
 * Do NOT client-preallocate UUID messageIDs — OpenCode exits the agent loop via
 * string compare `lastUser.id < lastAssistant.id`; non-ascending ids cause spin.
 */
function extractDeliveryIds(raw) {
  const roots = []
  if (raw && typeof raw === "object") {
    roots.push(raw)
    if (raw.data != null && typeof raw.data === "object") roots.push(raw.data)
    if (raw.raw != null && typeof raw.raw === "object") roots.push(raw.raw)
    if (raw.raw?.data != null && typeof raw.raw.data === "object") {
      roots.push(raw.raw.data)
    }
  }
  let messageId = ""
  let partId = ""
  for (const root of roots) {
    const info = root.info && typeof root.info === "object" ? root.info : null
    const candidate = String(
      root.messageID ||
        root.messageId ||
        root.message_id ||
        info?.id ||
        info?.messageID ||
        "",
    ).trim()
    // Prefer explicit message ids over generic root.id (often a request id).
    if (candidate && (!messageId || candidate.startsWith("msg_"))) {
      messageId = candidate
    }
    const parts = Array.isArray(root.parts)
      ? root.parts
      : Array.isArray(info?.parts)
        ? info.parts
        : []
    for (const part of parts) {
      if (!part || typeof part !== "object") continue
      if (!messageId) {
        messageId = String(
          part.messageID || part.messageId || part.message_id || "",
        ).trim()
      }
      if (!partId) {
        partId = String(
          part.id || part.partID || part.partId || part.part_id || "",
        ).trim()
      }
      if (messageId && partId) break
    }
    if (messageId && partId) break
  }
  if (!messageId) return null
  return {
    message_id: messageId,
    ...(partId ? { part_id: partId } : {}),
  }
}

function withDeliveryAnchor(result, prompted, channel) {
  const extracted =
    extractDeliveryIds(prompted?.raw) ||
    extractDeliveryIds(prompted) ||
    {}
  // Prefer OpenCode-assigned ids from the prompt response. Legacy
  // client-preallocated deliveryMessageId is fallback only when extract fails.
  const extractedId = String(extracted.message_id || "").trim()
  const fallback = String(prompted?.deliveryMessageId || "").trim()
  const messageId = extractedId || fallback
  if (!messageId) return result
  return {
    ...result,
    delivery_anchor: {
      message_id: messageId,
      ...(extracted.part_id ? { part_id: extracted.part_id } : {}),
      channel,
    },
  }
}

/**
 * @param {{ client: any, directory?: string, serverUrl?: string, tuiAvailable?: boolean }} opts
 */
export function createOpenCodeHost({
  client,
  directory = "",
  serverUrl = "",
  tuiAvailable = true,
}) {
  /** @type {Map<string, object>} */
  const sessions = new Map()
  /** @type {Record<string, string>} */
  let hostMessages = {}
  const workspaceDir = String(directory || "").trim()
  const configuredServerUrl = String(serverUrl || "").replace(/\/$/, "")
  const sessionParamStyle = (() => {
    for (const fn of [
      client?.session?.abort,
      client?.session?.promptAsync,
      client?.session?.prompt,
    ]) {
      if (typeof fn !== "function") continue
      const source = Function.prototype.toString.call(fn)
      if (source.includes("/session/{sessionID}")) return "v2"
      if (source.includes("/session/{id}")) return "v1"
    }
    return "v2"
  })()

  function setHostMessages(messages) {
    if (messages && typeof messages === "object") {
      hostMessages = { ...hostMessages, ...messages }
    }
  }

  function abortUnconfirmedNotice() {
    return (
      hostMessages.platform_abort_unconfirmed_user_notice ||
      FALLBACK_ABORT_UNCONFIRMED
    )
  }

  function state(nativeId) {
    const id = String(nativeId || "session")
    let s = sessions.get(id)
    if (!s) {
      s = {
        nativeId: id,
        phase: "idle", // idle | aborting | awaiting_idle | steered | failed
        notice: "",
        pendingNotice: "",
        steer: "",
        idleArrivedEarly: false,
        abortAttempts: 0,
        lastAbortAt: 0,
        lastPartLen: 0,
        failedNotified: false,
      }
      sessions.set(id, s)
    }
    return s
  }

  function forSession(sessionId) {
    const nativeId = String(sessionId).includes(":")
      ? String(sessionId).split(":").slice(1).join(":")
      : String(sessionId)
    const s = state(nativeId)
    return {
      nativeId,
      requestAbortStream: () => requestAbortStream(s),
      emitUserNotice: (message) => emitUserNotice(s, message),
      pushSteering: (message) => pushSteering(s, message),
      get phase() {
        return s.phase
      },
    }
  }

  async function requestAbortStream(s) {
    s.phase = "aborting"
    s.abortAttempts = 0
    s.failedNotified = false
    return abortOnce(s)
  }

  /**
   * Try session.abort with several SDK param shapes.
   * OpenCode 1.18+ uses flat `{ sessionID }`; older clients used `{ id }` /
   * `{ path: { id } }` — wrong shape yields empty path and a falsy/error body
   * while the stream keeps running.
   */
  async function callSessionAbort(nativeId) {
    if (typeof client?.session?.abort !== "function") {
      return { ok: false, error: "session.abort missing" }
    }
    const v1Shapes = [
      { path: { id: nativeId } },
      { id: nativeId },
      { path: { sessionID: nativeId } },
    ]
    const v2Shape = { sessionID: nativeId }
    const shapes = sessionParamStyle === "v1"
      ? [...v1Shapes, v2Shape]
      : [v2Shape, ...v1Shapes]
    let lastError = null
    let lastRaw = null
    for (const args of shapes) {
      try {
        const raw = await client.session.abort(args)
        lastRaw = raw
        if (sdkOk(raw)) {
          return { ok: true, raw, args }
        }
        lastError = summarizeSdkFailure("session.abort", raw)
      } catch (err) {
        lastError = err?.message || String(err)
      }
    }
    return { ok: false, error: lastError || "session.abort returned falsy", raw: lastRaw }
  }

  /** Prefer HTTP interrupt API (not TUI keybind — that requires focus + double-Esc). */
  async function callSessionInterrupt(nativeId) {
    const interrupt =
      client?.session?.interrupt ||
      client?.control?.session?.interrupt ||
      client?.api?.session?.interrupt
    if (typeof interrupt !== "function") {
      return { ok: false, error: "session.interrupt missing" }
    }
    const shapes = [{ sessionID: nativeId }, { id: nativeId }, { path: { sessionID: nativeId } }]
    let lastError = null
    for (const args of shapes) {
      try {
        const raw = await interrupt.call(client.session || client, args)
        if (sdkOk(raw)) return { ok: true, raw, args }
        lastError = summarizeSdkFailure("session.interrupt", raw)
      } catch (err) {
        lastError = err?.message || String(err)
      }
    }
    return { ok: false, error: lastError || "session.interrupt failed" }
  }

  async function abortOnce(s) {
    s.abortAttempts += 1
    s.lastAbortAt = Date.now()
    const channels = []
    let anyOk = false
    let lastError = null

    // 1) Real stop: SessionRunState.cancel via session.abort (always returns true on hit).
    const aborted = await callSessionAbort(s.nativeId)
    if (aborted.ok) {
      anyOk = true
      channels.push("session.abort")
    } else {
      lastError = aborted.error
      console.error("[insight-ras] session.abort failed", lastError, summarizeRaw(aborted.raw))
    }

    // 2) Process-owned interrupt API (NoContent; idle = no-op). Better than TUI command.
    const interrupted = await callSessionInterrupt(s.nativeId)
    if (interrupted.ok) {
      anyOk = true
      channels.push("session.interrupt.api")
    } else if (interrupted.error && interrupted.error !== "session.interrupt missing") {
      console.error("[insight-ras] session.interrupt.api failed", interrupted.error)
      if (!anyOk) lastError = interrupted.error
    }

    // 3) TUI keybind fallback — needs focused TUI; first press only clears, second aborts.
    if (!anyOk && tuiAvailable && typeof client?.tui?.executeCommand === "function") {
      try {
        const raw1 = await client.tui.executeCommand({ command: "session.interrupt" })
        const raw2 = await client.tui.executeCommand({ command: "session.interrupt" })
        if (sdkOk(raw1) || sdkOk(raw2) || raw1 == null || raw2 == null) {
          anyOk = true
          channels.push("tui.session.interrupt×2")
        }
      } catch (err) {
        console.error(
          "[insight-ras] tui.executeCommand session.interrupt failed",
          err?.message || String(err),
        )
        if (!anyOk) lastError = err?.message || String(err)
      }
    }

    // If first abort looked failed but we have no confirmation, fire abort once more.
    if (!anyOk) {
      const retry = await callSessionAbort(s.nativeId)
      if (retry.ok) {
        anyOk = true
        channels.push("session.abort.retry")
      } else {
        lastError = retry.error || lastError
      }
    }

    if (anyOk) {
      return {
        ok: true,
        channel: channels.join("+") || "session.abort",
      }
    }
    return {
      ok: false,
      channel: "session.abort",
      error: lastError || "abort_failed",
    }
  }

  async function onPartGrowth(nativeId, textLen) {
    const s = state(nativeId)
    s.lastPartLen = textLen
    if (s.phase !== "aborting" && s.phase !== "failed") return null

    const now = Date.now()
    if (now - s.lastAbortAt < ABORT_RETRY_MS) return null

    if (s.abortAttempts >= ABORT_MAX_ATTEMPTS) {
      if (!s.failedNotified) {
        s.phase = "failed"
        s.failedNotified = true
        await emitUserNotice(s, abortUnconfirmedNotice())
        return {
          ok: false,
          channel: "abort_escalate",
          error: "abort_unconfirmed",
          escalated: true,
        }
      }
      return abortOnce(s)
    }

    return abortOnce(s)
  }

  async function emitUserNotice(s, message) {
    // Pass through core-rendered text; do not wrap or rewrite.
    const text = String(message || "")
    if (!text) {
      return { ok: false, channel: "empty", error: "empty_notice" }
    }
    s.notice = text
    const toastBody = {
      title: "Agent RAS",
      message: text,
      variant: "warning",
      duration: 10000,
    }

    // Prefer TUI toast (visible prompt), never red console as the happy path.
    if (tuiAvailable && typeof client?.tui?.showToast === "function") {
      try {
        // Flat toast fields — `{ body: {...} }` is dropped by showToast's param map.
        const raw = await client.tui.showToast(toastBody)
        if (sdkOk(raw)) {
          const injected = await injectNoReplyNotice(s, text)
          return withDeliveryAnchor(
            { ok: true, channel: "tui.toast" },
            injected,
            "ras_notice",
          )
        }
      } catch (err) {
        console.error(
          "[insight-ras] showToast failed",
          err?.message || String(err),
        )
      }
    }

    if (tuiAvailable && typeof client?.tui?.publish === "function") {
      try {
        // publish maps key `body` → request body (unlike showToast).
        const raw = await client.tui.publish({
          body: {
            type: "tui.toast.show",
            properties: toastBody,
          },
        })
        if (sdkOk(raw)) {
          const injected = await injectNoReplyNotice(s, text)
          return withDeliveryAnchor(
            { ok: true, channel: "tui.publish" },
            injected,
            "ras_notice",
          )
        }
      } catch (err) {
        console.error(
          "[insight-ras] tui.publish toast failed",
          err?.message || String(err),
        )
      }
    }

    const injected = await injectNoReplyNotice(s, text)
    if (injected.ok) {
      return withDeliveryAnchor(
        { ok: true, channel: "session.prompt.noReply" },
        injected,
        "ras_notice",
      )
    }

    // Last resort only — user should not normally see this.
    console.error(`[insight-ras] USER_NOTICE (tui unavailable) ${s.nativeId}: ${text}`)
    s.pendingNotice = text
    return { ok: true, channel: "console.error+pending_idle" }
  }

  async function injectNoReplyNotice(s, text) {
    const prompted = await callSessionPrompt(
      s.nativeId,
      [{ type: "text", text }],
      { noReply: true, preferSync: true },
    )
    if (!prompted.ok) {
      console.error("[insight-ras] noReply notice failed", prompted.error)
      return {
        ok: false,
        error: prompted.error,
        raw: prompted.raw,
        deliveryMessageId: prompted.deliveryMessageId,
      }
    }
    return {
      ok: true,
      raw: prompted.raw,
      channel: prompted.channel,
      deliveryMessageId: prompted.deliveryMessageId,
    }
  }

  async function callSessionPrompt(nativeId, parts, extra = {}) {
    const promptAsyncFn = client?.session?.promptAsync || client?.promptAsync
    const promptFn = client?.session?.prompt || client?.prompt
    const preferSync = Boolean(extra.preferSync)
    // Only pass messageID when the caller explicitly supplies one (legacy).
    // Recovery notice/steer must NOT invent UUID ids — let OpenCode allocate.
    const deliveryMessageId = String(
      extra.messageID || extra.messageId || extra._rasDeliveryMessageId || "",
    ).trim()
    const promptExtra = { ...extra }
    delete promptExtra._rasDeliveryMessageId
    delete promptExtra.preferSync
    if (!deliveryMessageId) {
      delete promptExtra.messageID
      delete promptExtra.messageId
    }
    const body = {
      parts,
      ...promptExtra,
      ...(deliveryMessageId ? { messageID: deliveryMessageId } : {}),
    }
    const query = workspaceDir ? { directory: workspaceDir } : undefined

    const v1Shapes = [
      { path: { id: nativeId }, body, ...(query ? { query } : {}) },
      { path: { sessionID: nativeId }, body, ...(query ? { query } : {}) },
      { id: nativeId, body, ...(query ? { query } : {}) },
    ]
    const v2Shape = {
      sessionID: nativeId,
      parts,
      ...promptExtra,
      ...(deliveryMessageId ? { messageID: deliveryMessageId } : {}),
      ...(workspaceDir ? { directory: workspaceDir } : {}),
    }
    const shapes = sessionParamStyle === "v1"
      ? [...v1Shapes, v2Shape]
      : [v2Shape, ...v1Shapes]
    let lastError = null
    let lastRaw = null
    let sawBadPath = false

    // preferSync (notice/steer): sync prompt returns body with OC-assigned ids;
    // prompt_async is often 204 void and cannot supply delivery_anchor.
    const fnOrder = preferSync || deliveryMessageId
      ? [promptFn, promptAsyncFn]
      : [promptAsyncFn, promptFn]

    for (const fn of fnOrder) {
      if (typeof fn !== "function") continue
      for (const args of shapes) {
        try {
          const raw = await fn.call(client.session || client, args)
          lastRaw = raw
          if (sdkOk(raw) || raw == null) {
            const extracted = extractDeliveryIds(raw)
            return {
              ok: true,
              raw,
              args,
              channel: "session.prompt",
              deliveryMessageId:
                deliveryMessageId || extracted?.message_id || undefined,
            }
          }
          lastError = summarizeSdkFailure("session.prompt", raw)
          const errText = String(lastError || "")
          if (errText.includes("%7Bid%7D") || errText.includes("%7BsessionID%7D")) {
            sawBadPath = true
          }
          // Always try next shape on failure (server may hide path-template in logs).
        } catch (err) {
          lastError = err?.message || String(err)
          if (
            String(lastError).includes("%7Bid%7D") ||
            String(lastError).includes("%7BsessionID%7D")
          ) {
            sawBadPath = true
          }
        }
      }
    }

    // Bypass broken SDK path templates via HTTP prompt_async (PluginInput.serverUrl).
    const viaHttp = await promptViaHttp(nativeId, parts, {
      ...promptExtra,
      ...(deliveryMessageId ? { messageID: deliveryMessageId } : {}),
    })
    if (viaHttp.ok) {
      return {
        ...viaHttp,
        deliveryMessageId: deliveryMessageId || viaHttp.deliveryMessageId,
      }
    }

    return {
      ok: false,
      error:
        lastError ||
        viaHttp.error ||
        (sawBadPath
          ? "session.prompt path-template broken (%7Bid%7D) and HTTP fallback failed"
          : "session.prompt failed"),
      raw: lastRaw,
      deliveryMessageId: deliveryMessageId || undefined,
    }
  }

  function digBaseUrl(obj, depth = 0) {
    if (!obj || depth > 4) return ""
    try {
      if (typeof obj.getConfig === "function") {
        const cfg = obj.getConfig()
        if (cfg?.baseUrl) return String(cfg.baseUrl)
      }
    } catch {
      /* ignore */
    }
    for (const key of ["baseUrl", "url", "origin", "serverUrl"]) {
      if (typeof obj[key] === "string" && /^https?:\/\//.test(obj[key])) {
        return obj[key]
      }
    }
    for (const key of ["config", "client", "_client", "session"]) {
      const nested = digBaseUrl(obj[key], depth + 1)
      if (nested) return nested
    }
    return ""
  }

  function resolveClientBaseUrl() {
    return (
      configuredServerUrl ||
      digBaseUrl(client) ||
      process.env.OPENCODE_SERVER_URL ||
      process.env.OPENCODE_URL ||
      ""
    )
  }

  /** Parse /proc/self/net/tcp(6) for local LISTEN ports (plugin runs in OC process). */
  function listLoopbackListenPorts() {
    const ports = new Set()
    for (const file of ["/proc/self/net/tcp", "/proc/self/net/tcp6"]) {
      let text = ""
      try {
        text = require("node:fs").readFileSync(file, "utf8")
      } catch {
        continue
      }
      for (const line of text.split("\n").slice(1)) {
        const parts = line.trim().split(/\s+/)
        if (parts.length < 4) continue
        // state 0A = LISTEN
        if (parts[3] !== "0A") continue
        const [ipHex, portHex] = String(parts[1] || "").split(":")
        if (!portHex) continue
        const port = Number.parseInt(portHex, 16)
        if (!Number.isFinite(port) || port <= 0) continue
        const ip = String(ipHex || "").toUpperCase()
        // 127.0.0.1, 0.0.0.0, ::1, ::
        if (
          ip === "0100007F" ||
          ip === "00000000" ||
          ip.endsWith("00000000000000000000000001000000") ||
          ip === "00000000000000000000000001000000" ||
          /^0+$/.test(ip)
        ) {
          ports.add(port)
        }
      }
    }
    return [...ports]
  }

  async function promptViaHttp(nativeId, parts, extra = {}) {
    const candidates = []
    const known = resolveClientBaseUrl()
    if (known) candidates.push(String(known).replace(/\/$/, ""))
    for (const envKey of ["OPENCODE_URL", "OPENCODE_SERVER_URL"]) {
      if (process.env[envKey]) {
        candidates.push(String(process.env[envKey]).replace(/\/$/, ""))
      }
    }
    candidates.push("http://127.0.0.1:4096", "http://127.0.0.1:4097")
    for (const port of listLoopbackListenPorts()) {
      if (port === 53 || port === 6379 || port === 11434) continue
      candidates.push(`http://127.0.0.1:${port}`)
    }

    const tried = new Set()
    let lastError = "no reachable OpenCode HTTP endpoint"
    const knownNorm = known ? String(known).replace(/\/$/, "") : ""
    for (const base of candidates) {
      if (!base || tried.has(base)) continue
      tried.add(base)
      // Prefer PluginInput.serverUrl; health-gate only speculative ports.
      if (base !== knownNorm) {
        try {
          const h = await fetch(`${base}/global/health`, {
            signal: AbortSignal.timeout(800),
          })
          if (!(h.ok || h.status === 200)) continue
        } catch {
          continue
        }
      }
      const r = await promptViaHttpAt(base, nativeId, parts, extra)
      if (r.ok) return r
      lastError = r.error || lastError
    }
    return { ok: false, error: lastError }
  }

  async function promptViaHttpAt(base, nativeId, parts, extra = {}) {
    try {
      const u = new URL(`${base}/session/${encodeURIComponent(nativeId)}/prompt_async`)
      if (workspaceDir) u.searchParams.set("directory", workspaceDir)
      const headers = { "Content-Type": "application/json" }
      if (workspaceDir) {
        headers["x-opencode-directory"] = encodeURIComponent(workspaceDir)
      }
      const deliveryMessageId = String(
        extra.messageID || extra.messageId || "",
      ).trim()
      const res = await fetch(u.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify({ parts, ...extra }),
        signal: AbortSignal.timeout(15000),
      })
      if (res.ok || res.status === 204) {
        return {
          ok: true,
          channel: "http.prompt_async",
          status: res.status,
          base,
          deliveryMessageId: deliveryMessageId || undefined,
        }
      }
      const text = await res.text().catch(() => "")
      return {
        ok: false,
        error: `http.prompt_async ${res.status} @ ${base}: ${text.slice(0, 120)}`,
      }
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  }

  async function deliverSteer(s) {
    const text = String(s.steer || "")
    if (!text) {
      return { ok: false, steered: false, channel: "empty", error: "empty_steer" }
    }
    s.steer = ""
    s.idleArrivedEarly = false
    const prompted = await callSessionPrompt(
      s.nativeId,
      [{ type: "text", text }],
      { preferSync: true },
    )
    if (prompted.ok) {
      s.phase = "steered"
      return withDeliveryAnchor(
        {
          ok: true,
          steered: true,
          channel: prompted.channel || "session.prompt",
        },
        prompted,
        "ras_steering",
      )
    }
    // Keep text for a later idle retry.
    s.steer = text
    s.phase = "awaiting_idle"
    console.error("[insight-ras] steer prompt failed", prompted.error)
    return {
      ok: false,
      steered: false,
      channel: "session.prompt",
      error: prompted.error,
    }
  }

  async function pushSteering(s, message) {
    s.steer = String(message || "")
    if (
      s.phase === "idle" ||
      s.phase === "steered" ||
      s.phase === "aborting" ||
      s.phase === "failed"
    ) {
      s.phase = "awaiting_idle"
    }
    // Common race: session.idle fires while applyActions is still on abort /
    // notice, before push_steering runs — inject immediately.
    if (s.idleArrivedEarly || s.phase === "idle") {
      return deliverSteer(s)
    }
    return { ok: true, channel: "pending_until_idle" }
  }

  async function sessionLooksIdle(nativeId) {
    const statusFn = client?.session?.status
    if (typeof statusFn !== "function") return null
    try {
      const raw = await statusFn.call(client.session, {})
      const data = raw?.data ?? raw
      const st = data?.[nativeId] ?? data?.[String(nativeId)]
      if (st == null) return null
      if (st === "idle") return true
      if (typeof st === "object") {
        const t = st.type || st.status
        return t === "idle" || t === "retry"
      }
      return false
    } catch {
      return null
    }
  }

  /**
   * After wire actions: wait briefly for abort→idle, then force-inject steering.
   * Do not rely solely on session.idle events (they often arrive before steer is set
   * and never fire again).
   */
  async function flushSteerIfPending(nativeId) {
    const s = state(nativeId)
    if (!s.steer) return { ok: true, steered: false, channel: "none" }

    const gaps = [0, 100, 200, 500, 700]
    for (const gap of gaps) {
      if (gap) await new Promise((r) => setTimeout(r, gap))
      if (!s.steer) return { ok: true, steered: false, channel: "none" }
      if (s.idleArrivedEarly || s.phase === "idle") {
        return deliverSteer(s)
      }
      const idle = await sessionLooksIdle(nativeId)
      if (idle === true) {
        s.idleArrivedEarly = true
        return deliverSteer(s)
      }
    }

    // Last resort: session may stay "busy"/null after abort; still inject recovery.
    if (s.steer) {
      console.error(
        "[insight-ras] forcing steer inject after abort (idle event missing)",
        s.nativeId,
      )
      return deliverSteer(s)
    }
    return { ok: true, steered: false, channel: "pending_until_idle" }
  }

  async function flushPendingNotice(s) {
    const text = s.pendingNotice
    if (!text) return
    s.pendingNotice = ""
    await injectNoReplyNotice(s, text)
  }

  async function onSessionIdle(nativeId) {
    const s = state(nativeId)
    const steer = s.steer
    s.abortAttempts = 0
    s.failedNotified = false
    const wasRecovering =
      s.phase === "aborting" ||
      s.phase === "awaiting_idle" ||
      s.phase === "failed"
    s.phase = "idle"

    await flushPendingNotice(s)

    if (!steer) {
      // Steer action may still be in-flight in applyActions — remember idle.
      if (wasRecovering) {
        s.idleArrivedEarly = true
        s.phase = "awaiting_idle"
      }
      return { steered: false, wasRecovering, waitingForSteer: wasRecovering }
    }

    s.steer = steer
    return deliverSteer(s)
  }

  function isAborting(nativeId) {
    const s = sessions.get(String(nativeId))
    return s?.phase === "aborting" || s?.phase === "failed"
  }

  return {
    forSession,
    onPartGrowth,
    onSessionIdle,
    flushSteerIfPending,
    isAborting,
    setHostMessages,
    _state: state,
  }
}

export default createOpenCodeHost
