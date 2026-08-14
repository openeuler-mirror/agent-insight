/**
 * Agent RAS OpenCode Host plugin (L3 thin adapter).
 *
 * Observation hooks → in-process RAS runtime.
 * Recovery: applyActions(common) → OpenCode HostControl (platform APIs only here).
 */

import { createRasClient } from "../common/ras_client.js"
import { applyActions } from "../common/host_actions.js"
import { createOpenCodeHost } from "./host_control.js"
import { runSkillJudge } from "./skill_judge.js"
import {
  resolvePlatformCapabilityFromRas,
  syncCapabilityConfigFromInsight,
} from "./config_sync.js"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const PLUGIN_REGISTRY = Symbol.for("agent-insight.ras.opencode-plugin-registry")

function claimPluginInstance(directory, serverUrl) {
  const registry = globalThis[PLUGIN_REGISTRY] || new Set()
  globalThis[PLUGIN_REGISTRY] = registry
  const key = `${directory || process.cwd()}|${serverUrl || ""}`
  if (registry.has(key)) return false
  registry.add(key)
  return true
}

function sessionKey(platform, nativeId) {
  return `${platform}:${nativeId || "session"}`
}

function extractText(event) {
  const props = event?.properties || event || {}
  const part = props.part || props.info || props
  const texts = []
  if (typeof part?.text === "string") texts.push(part.text)
  if (typeof part?.reasoning === "string") texts.push(part.reasoning)
  if (typeof props?.message?.content === "string") texts.push(props.message.content)
  const parts = props?.parts || props?.message?.parts
  if (Array.isArray(parts)) {
    for (const p of parts) {
      if (typeof p?.text === "string") texts.push(p.text)
      if (p?.type === "reasoning" && typeof p?.text === "string") texts.push(p.text)
    }
  }
  return texts.filter(Boolean).join("\n")
}

/** Only assistant text/reasoning should feed the detector — never the user prompt. */
function isAssistantPartEvent(event, messageRoles) {
  const props = event?.properties || {}
  const type = String(event?.type || "")
  if (type.includes("message.updated") && !type.includes("part")) {
    const role = props.info?.role
    if (props.info?.id && role) messageRoles.set(props.info.id, role)
    // message.updated carries metadata, not streaming tokens — do not observe.
    return false
  }
  const part = props.part
  if (!part || typeof part !== "object") return false
  // Synthetic / ignored parts often echo the user prompt before the model thinks.
  if (part.synthetic === true || part.ignored === true) return false
  const ptype = String(part.type || "")
  if (ptype && ptype !== "text" && ptype !== "reasoning") return false
  const messageID = part.messageID || props.messageID
  if (messageID && messageRoles.has(messageID)) {
    return messageRoles.get(messageID) === "assistant"
  }
  // Reasoning is assistant-only. Unknown text parts are skipped so the user
  // prompt (often the first text part) cannot trip thinking-loop detection.
  return ptype === "reasoning"
}

/** True when assistant snapshot is still just the user prompt echo (pre-think). */
function isUserPromptEcho(assistantText, userText) {
  const a = String(assistantText || "").trim()
  const u = String(userText || "").trim()
  if (!a || !u) return false
  if (a === u) return true
  // Assistant still within ~user prompt size and fully contained in it.
  if (a.length <= u.length + 32 && u.includes(a)) return true
  // User prompt fully contained and assistant hasn't grown much past it yet.
  if (u.length >= 64 && a.includes(u) && a.length <= Math.floor(u.length * 1.15)) {
    return true
  }
  return false
}

function loadThinkingConfig() {
  try {
    const rasHome = process.env.AGENT_INSIGHT_RAS_HOME || join(homedir(), ".agent-insight", "ras")
    const p = join(rasHome, "config.json")
    // Default L3 on (matches LlmThinkingLoopConfig); explicit false still wins via ...loop.
    let loop = {}
    if (existsSync(p)) {
      const cfg = JSON.parse(readFileSync(p, "utf8"))
      const ras = cfg?.agent_ras || {}
      const platformSlice = resolvePlatformCapabilityFromRas(ras, "opencode")
      loop =
        platformSlice?.detectors?.llm_thinking_loop ||
        ras.llm_thinking_loop ||
        ras.detectors?.llm_thinking_loop ||
        {}
      loop = {
        semantic_content_enabled: true,
        ...loop,
        // Plugin breadcrumbs only; not sent to core detectors.
        debug: Boolean(ras.debug || loop.debug),
      }
    } else {
      loop = { semantic_content_enabled: true }
    }
    // Optional RAS process-env overrides (RAS-owned; not set by FI).
    const envInt = (key) => {
      const raw = process.env[key]
      if (!raw || !String(raw).trim()) return null
      const n = Number(raw)
      return Number.isFinite(n) && n > 0 ? n : null
    }
    const start = envInt("RAS_DETECTION_START_CHARS")
    if (start != null) loop.detection_start_chars = start
    const window = envInt("RAS_WINDOW_MAX_CHARS")
    if (window != null) loop.window_max_chars = window
    const threshold = envInt("RAS_LOOP_REPEAT_THRESHOLD")
    if (threshold != null) loop.loop_repeat_threshold = threshold
    const semanticEval = envInt("RAS_SEMANTIC_EVAL_CHARS")
    if (semanticEval != null) loop.semantic_eval_chars = semanticEval
    return loop
  } catch {
    return { semantic_content_enabled: true }
  }
}

function shouldObserveText(text, prevLen, { detectionStart, aborting }) {
  if (!text || text.length < 32) return false
  const growth = text.length - prevLen
  if (growth <= 0) return false
  const start = Number(detectionStart) || 30000
  if (aborting) return false
  // OpenCode 1.18 streams many message.part.delta tokens — cadence ~40 chars
  // so we still sample before window_max without per-token HTTP flood.
  if (text.length >= Math.max(100, start * 0.8)) {
    return growth >= 40
  }
  if (growth < 80 && text.length < 500) return false
  return true
}

/**
 * OpenCode 1.18+: live tokens arrive as message.part.delta
 * ({ sessionID, messageID, partID, field, delta }); part.updated is sparse
 * (often empty start + full snapshot at end). Without delta we only detect
 * after the model finishes — too late to abort.
 */
function isPartDeltaEvent(type) {
  const t = String(type || "")
  return t.includes("message.part.delta") || t.endsWith("part.delta")
}

function isPartUpdatedEvent(type) {
  const t = String(type || "")
  return (
    t.includes("message.part.updated") ||
    t.endsWith("part.updated") ||
    (t.includes("message.updated") && !t.includes("part"))
  )
}

export const AgentRasPlugin = async ({ client, directory, serverUrl }) => {
  if (!claimPluginInstance(directory, serverUrl)) {
    return {}
  }
  const greeted = new Set()
  const lastLen = new Map()
  /** @type {Map<string, string>} messageID -> role */
  const messageRoles = new Map()
  /** @type {Map<string, string>} native session id -> latest user prompt text */
  const lastUserText = new Map()
  /** @type {Map<string, { sessionID: string, messageID: string, partType: string, text: string }>} */
  const partState = new Map()
  /** Judge sessions must not feed back into RAS observe (anti-nest). */
  const judgeSessions = new Set()
  /** sid -> in-flight judge promise gate (one judge per main session). */
  const judgeInFlight = new Set()
  /** request_id already accepted for background judge. */
  const judgingRequestIds = new Set()
  /** sid -> latest pending observe job (coalesce; do not block OpenCode delta). */
  const observePending = new Map()
  /** sid -> observe worker running. */
  const observeInFlight = new Set()
  /** assistant message ids that already produced an anomaly */
  const handledAnomalyMessages = new Set()
  // OpenCode paints stderr red — only use console.error for real failures.
  // Set RAS_DEBUG=1 (or agent_ras.debug) for success breadcrumbs.
  const rasDebugEarly =
    process.env.RAS_DEBUG === "1" || process.env.RAS_DEBUG === "true"
  const rasLogEarly = (...args) => {
    if (rasDebugEarly) console.error(...args)
  }

  // Optional Insight → local config sync (fail-open). Must run before loadThinkingConfig.
  await syncCapabilityConfigFromInsight({ log: rasLogEarly })

  const thinkingConfig = loadThinkingConfig()
  const detectionStart = thinkingConfig.detection_start_chars
  const hostApi = createOpenCodeHost({
    client,
    directory: directory || process.cwd(),
    serverUrl: serverUrl ? String(serverUrl) : "",
    tuiAvailable:
      !process.argv.slice(1).includes("run") &&
      Boolean(process.stdout?.isTTY || process.stderr?.isTTY),
  })

  const rasDebug =
    rasDebugEarly || Boolean(thinkingConfig.debug)

  const rasLog = (...args) => {
    if (rasDebug) console.error(...args)
  }

  const ras = createRasClient({
    onActions: async (sessionId, actions, anomaly) => {
      rasLog(
        `[insight-ras] actions session=${sessionId} types=${(actions || []).map((a) => a.type).join(",")}`,
      )
      const sessionHost = hostApi.forSession(sessionId)
      await applyActions(sessionHost, actions, {
        onResult: async (result) => {
          const line = `[insight-ras] action_result ${result?.action} ok=${result?.ok} channel=${result?.channel || ""}`
          if (result?.ok) rasLog(line)
          else console.error(line, result?.error || "")
          try {
            await ras.reportActionResult(sessionId, {
              ...result,
              trace_anchor: anomaly?.trace_anchor,
              delivery_anchor: result?.delivery_anchor,
            })
          } catch {
            /* ignore */
          }
        },
      })
      // Abort often reaches idle before push_steering runs; flush if pending.
      try {
        const nativeId = String(sessionId).includes(":")
          ? String(sessionId).split(":").slice(1).join(":")
          : String(sessionId)
        const flushed = await hostApi.flushSteerIfPending(nativeId)
        if (flushed?.steered || flushed?.channel === "session.prompt") {
          await ras.reportActionResult(sessionId, {
            action: "push_steering",
            ok: Boolean(flushed.ok),
            channel: flushed.channel,
            error: flushed.error,
            trace_anchor: anomaly?.trace_anchor,
            delivery_anchor: flushed?.delivery_anchor,
          })
        }
      } catch {
        /* ignore */
      }
      try {
        await ras.flush(sessionId)
      } catch {
        /* fail open */
      }
    },
  })

  if (!ras.enabled) {
    return {}
  }

  function clearSessionParts(nativeId) {
    for (const [partID, st] of partState) {
      if (st.sessionID === nativeId) partState.delete(partID)
    }
  }

  async function runOneSkillJudge(sid, req) {
    const timeoutMs = Math.max(
      1000,
      Math.floor(Number(req.timeout || 30) * 1000),
    )
    const judged = await runSkillJudge(
      { client, directory: directory || process.cwd() },
      {
        role: req.role || "detection",
        skillName: req.skill_name || "llm-loop-detection",
        payload: req.payload || "",
        timeoutMs,
      },
    )
    if (judged.sessionID) judgeSessions.add(String(judged.sessionID))
    try {
      if (judged.ok && judged.result) {
        await ras.skillResult(sid, {
          request_id: req.request_id,
          result: judged.result,
          timeout: Math.min(8, Number(req.timeout) || 8),
        })
      } else {
        await ras.skillResult(sid, {
          request_id: req.request_id,
          error: judged.error || "judge_failed",
          timeout: 2,
        })
      }
    } catch (e) {
      console.error("[insight-ras] skill_result failed:", e?.message || e)
    }
  }

  /**
   * L3 judge must NOT block the OpenCode delta/event hook.
   * Single-flight per session; duplicate request_ids ignored; extras fail-open.
   */
  function enqueueSkillRequests(sid, skillRequests) {
    const reqs = Array.isArray(skillRequests) ? skillRequests : []
    if (!reqs.length || ras.transport !== "inproc") return

    for (const req of reqs) {
      const rid = String(req?.request_id || "")
      if (!rid) continue
      if (judgingRequestIds.has(rid)) continue

      if (judgeInFlight.has(sid)) {
        // Keep Python future from hanging until skill timeout.
        void ras
          .skillResult(sid, {
            request_id: rid,
            error: "judge_busy",
            timeout: 2,
          })
          .catch(() => {})
        continue
      }

      judgingRequestIds.add(rid)
      judgeInFlight.add(sid)
      void (async () => {
        try {
          await runOneSkillJudge(sid, req)
        } finally {
          judgingRequestIds.delete(rid)
          judgeInFlight.delete(sid)
        }
      })()
    }
  }

  async function observeAssistantText(nativeId, text, partType, messageID, partID) {
    if (!text) return
    if (judgeSessions.has(String(nativeId))) return
    if (isUserPromptEcho(text, lastUserText.get(nativeId))) return
    const sid = sessionKey("opencode", nativeId)
    const handledKey = messageID ? `${sid}:${messageID}` : ""
    const prev = lastLen.get(sid) || 0
    const aborting = hostApi.isAborting(nativeId)

    if (aborting && text.length > prev) {
      try {
        const growth = await hostApi.onPartGrowth(nativeId, text.length)
        if (growth?.escalated) {
          await ras.reportActionResult(sid, {
            action: "abort_stream",
            ok: false,
            channel: growth.channel,
            error: growth.error,
          })
        }
      } catch {
        /* ignore */
      }
    }

    if (handledKey && handledAnomalyMessages.has(handledKey)) return

    if (
      !shouldObserveText(text, prev, {
        detectionStart,
        aborting,
      })
    ) {
      return
    }
    lastLen.set(sid, text.length)

    try {
      if (!greeted.has(sid)) {
        const welcome = await ras.hello(sid, "opencode", thinkingConfig)
        if (welcome?.host_messages) {
          hostApi.setHostMessages(welcome.host_messages)
        }
        greeted.add(sid)
      }
      const channel = String(partType || "").includes("reason")
        ? "llm_reasoning"
        : "llm_output"
      const observed = await ras.observe(sid, {
        kind: "assistant_text",
        channel,
        text,
        mode: "snapshot",
        trace_anchor: {
          message_id: messageID || undefined,
          part_id: partID || undefined,
          channel,
        },
      })
      if (observed?.anomaly && handledKey) {
        handledAnomalyMessages.add(handledKey)
      }
      // Background L3 — never await judge on the streaming path.
      enqueueSkillRequests(sid, observed?.skill_requests)
    } catch (e) {
      console.error("[insight-ras] observe failed:", e?.message || e)
    }
  }

  /** Coalesce + non-blocking: delta hooks return immediately. */
  function scheduleObserveAssistantText(nativeId, text, partType, messageID, partID) {
    if (!nativeId || !text) return
    const sid = sessionKey("opencode", nativeId)
    observePending.set(sid, { nativeId, text, partType, messageID, partID })
    if (observeInFlight.has(sid)) return
    observeInFlight.add(sid)
    void (async () => {
      try {
        while (observePending.has(sid)) {
          const job = observePending.get(sid)
          observePending.delete(sid)
          if (!job) break
          await observeAssistantText(job.nativeId, job.text, job.partType, job.messageID, job.partID)
        }
      } finally {
        observeInFlight.delete(sid)
        if (observePending.has(sid)) {
          const job = observePending.get(sid)
          if (job) scheduleObserveAssistantText(job.nativeId, job.text, job.partType, job.messageID, job.partID)
        }
      }
    })()
  }

  return {
    "tool.execute.before": async (input, output) => {
      const nativeId = input?.sessionID || "session"
      const sid = sessionKey("opencode", nativeId)
      try {
        if (!greeted.has(sid)) {
          const welcome = await ras.hello(sid, "opencode", thinkingConfig)
          if (welcome?.host_messages) {
            hostApi.setHostMessages(welcome.host_messages)
          }
          greeted.add(sid)
        }
        // Tool observe is short; still avoid blocking the tool rail on L3.
        void ras
          .observe(sid, {
            kind: "tool",
            tool: {
              name: String(input?.tool || input?.name || "tool"),
              phase: "after",
              args: input?.args || output?.args,
            },
            trace_anchor: {
              message_id: input?.messageID || input?.messageId || undefined,
              part_id: input?.partID || input?.partId || undefined,
              call_id: input?.callID || input?.callId || undefined,
              channel: "tool_call",
            },
          })
          .then((observed) => {
            enqueueSkillRequests(sid, observed?.skill_requests)
          })
          .catch(() => {})
      } catch {
        /* fail-open */
      }
      return output
    },

    event: async ({ event }) => {
      const type = String(event?.type || "")
      const props = event?.properties || {}
      const nativeId =
        props.sessionID ||
        props.sessionId ||
        props.info?.sessionID ||
        props.part?.sessionID ||
        null

      if (nativeId && judgeSessions.has(String(nativeId))) {
        return
      }

      if (type.includes("session") && type.includes("idle") && nativeId) {
        const sid = sessionKey("opencode", nativeId)
        lastLen.delete(sid)
        lastUserText.delete(nativeId)
        clearSessionParts(nativeId)
        const idleResult = await hostApi.onSessionIdle(nativeId)
        try {
          await ras.reset(sid)
        } catch {
          /* ignore */
        }
        if (idleResult?.steered === false && idleResult?.ok === false) {
          try {
            await ras.reportActionResult(sid, {
              action: "push_steering",
              ok: false,
              error: idleResult.error,
            })
          } catch {
            /* ignore */
          }
        } else if (idleResult?.steered) {
          try {
            await ras.reportActionResult(sid, {
              action: "push_steering",
              ok: true,
              channel: idleResult.channel || "session.prompt",
            })
          } catch {
            /* ignore */
          }
        }
        try {
          await ras.flush(sid)
        } catch {
          /* fail open */
        }
        return
      }

      // Cache roles early (needed before deltas arrive).
      if (type.includes("message.updated") && !type.includes("part")) {
        const role = props.info?.role
        if (props.info?.id && role) messageRoles.set(props.info.id, role)
        return
      }

      // Incremental tokens (OpenCode 1.18+).
      if (isPartDeltaEvent(type)) {
        if (!nativeId) return
        const messageID = props.messageID
        const partID = props.partID
        const field = String(props.field || "text")
        const delta = props.delta
        if (!partID || typeof delta !== "string" || !delta) return
        if (field !== "text" && field !== "reasoning") return

        const role = messageID ? messageRoles.get(messageID) : null
        if (role === "user") {
          const prev = lastUserText.get(nativeId) || ""
          lastUserText.set(nativeId, prev + delta)
          return
        }
        if (role != null && role !== "assistant") return
        // Role may lag message.updated; after the user prompt is known, live
        // deltas on this turn are assistant tokens (user text rarely streams).
        if (role == null && !lastUserText.has(nativeId)) return

        let st = partState.get(partID)
        if (!st) {
          st = {
            sessionID: nativeId,
            messageID: messageID || "",
            partType: field === "reasoning" ? "reasoning" : "text",
            text: "",
          }
          partState.set(partID, st)
        }
        st.text += delta
        if (messageID) st.messageID = messageID
        scheduleObserveAssistantText(nativeId, st.text, st.partType, st.messageID, partID)
        return
      }

      if (!nativeId || !isPartUpdatedEvent(type)) {
        return
      }

      const part = props.part
      if (part?.id) {
        const existing = partState.get(part.id)
        const seeded =
          typeof part.text === "string"
            ? part.text
            : typeof part.reasoning === "string"
              ? part.reasoning
              : existing?.text || ""
        partState.set(part.id, {
          sessionID: nativeId,
          messageID: part.messageID || existing?.messageID || "",
          partType: String(part.type || existing?.partType || "text"),
          text: seeded,
        })
      }

      const partRole = part?.messageID ? messageRoles.get(part.messageID) : null
      if (partRole === "user") {
        const userText = extractText(event)
        if (userText) lastUserText.set(nativeId, userText)
        return
      }

      // Cache roles from message.updated; never treat user prompts as model output.
      if (!isAssistantPartEvent(event, messageRoles)) {
        // Race: user text part may arrive before message.updated caches role.
        if (
          partRole == null &&
          part &&
          (part.type === "text" || !part.type) &&
          !lastUserText.has(nativeId)
        ) {
          const maybeUser = extractText(event)
          if (maybeUser) lastUserText.set(nativeId, maybeUser)
        }
        return
      }

      const text =
        (part?.id && partState.get(part.id)?.text) || extractText(event)
      const partType = part?.type || (part?.id && partState.get(part.id)?.partType) || ""
      const messageID = part?.messageID || (part?.id && partState.get(part.id)?.messageID) || ""
      scheduleObserveAssistantText(nativeId, text, partType, messageID, part?.id)
    },
  }
}

export default AgentRasPlugin
