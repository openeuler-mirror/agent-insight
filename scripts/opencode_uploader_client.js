import http from "node:http"
import https from "node:https"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { URL } from "node:url"

function parseDotEnvText(text) {
  const out = {}
  const lines = String(text || "").split(/\r?\n/)
  for (const line of lines) {
    const s = line.trim()
    if (!s || s.startsWith("#")) continue
    const idx = s.indexOf("=")
    if (idx <= 0) continue
    const k = s.slice(0, idx).trim()
    let v = s.slice(idx + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[k] = v
  }
  return out
}

function loadSkillInsightEnv() {
  const env = { ...process.env }
  try {
    const file = path.join(os.homedir(), ".skill-insight", ".env")
    if (fs.existsSync(file)) {
      const txt = fs.readFileSync(file, "utf8")
      const parsed = parseDotEnvText(txt)
      for (const [k, v] of Object.entries(parsed)) {
        if (env[k] === undefined) env[k] = v
      }
    }
  } catch {}
  return env
}

function toMsTimestamp(v) {
  if (v == null) return null
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string") {
    const s = v.trim()
    if (!s) return null
    if (/^\d+$/.test(s)) {
      const n = Number(s)
      return Number.isFinite(n) ? n : null
    }
    const t = Date.parse(s)
    return Number.isFinite(t) ? t : null
  }
  return null
}

function usageTotalsFromTokens(tokens) {
  const input = Number(tokens?.input ?? 0) || 0
  const rawOutput = Number(tokens?.output ?? 0) || 0
  const reasoning = Number(tokens?.reasoning ?? 0) || 0
  const cacheRead = Number(tokens?.cache?.read ?? 0) || 0
  const cacheWrite = Number(tokens?.cache?.write ?? 0) || 0
  const output = reasoning > 0 && rawOutput < reasoning ? rawOutput + reasoning : rawOutput
  return { input, output, reasoning, cacheRead, cacheWrite, total: input + output + reasoning + cacheRead + cacheWrite }
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function loadDeletedSessionIds(env) {
  const file = env.SKILL_INSIGHT_OPENCODE_DELETED_SESSIONS || path.join(os.homedir(), ".skill-insight", "opencode_deleted_sessions.json")
  try {
    if (!fs.existsSync(file)) return new Set()
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"))
    const rawIds = Array.isArray(parsed) ? parsed : parsed?.sessionIds
    if (!Array.isArray(rawIds)) return new Set()
    return new Set(rawIds.map((id) => String(id || "").trim()).filter(Boolean))
  } catch {
    return new Set()
  }
}

function pickFirstString(...values) {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return ""
}

function extractSessionIdFromText(text) {
  if (typeof text !== "string" || !text) return ""
  const patterns = [
    /<task_metadata>[\s\S]*?session_id:\s*(ses_[A-Za-z0-9_-]+)/i,
    /session_id:\s*(ses_[A-Za-z0-9_-]+)/i,
    /sessionID:\s*(ses_[A-Za-z0-9_-]+)/i,
    /sessionId:\s*(ses_[A-Za-z0-9_-]+)/i,
    /task\(\s*session_id\s*=\s*["'](ses_[A-Za-z0-9_-]+)["']/i,
    /task_id:\s*(ses_[A-Za-z0-9_-]+)/i,
  ]
  for (const re of patterns) {
    const m = text.match(re)
    if (m?.[1]) return m[1]
  }
  return ""
}

function partIdentity(part) {
  if (!part) return ""
  const type = String(part.type || "").toLowerCase()
  if (type === "tool") {
    const callId = pickFirstString(part.callID, part.callId, part.call_id, part.state?.callID, part.state?.callId, part.state?.call_id)
    if (callId) return `tool-call:${callId}`
    const tool = pickFirstString(part.tool, part.name)
    const input = stableStringify(part.state?.input || part.input || {})
    if (tool) return `tool:${tool}:${input}`
  }
  return pickFirstString(part.id) || stableStringify(part)
}

function stableStringify(value) {
  if (value == null) return ""
  if (typeof value === "string") return value
  try {
    const seen = new WeakSet()
    return JSON.stringify(value, (_key, v) => {
      if (v && typeof v === "object") {
        if (seen.has(v)) return "[Circular]"
        seen.add(v)
        if (!Array.isArray(v)) {
          const out = {}
          for (const k of Object.keys(v).sort()) out[k] = v[k]
          return out
        }
      }
      return v
    })
  } catch {
    return String(value)
  }
}

function extractTaskChildSessionId(part) {
  if (!part || part.tool !== "task") return ""
  const state = part.state || {}
  const direct = pickFirstString(
    state.sessionID,
    state.sessionId,
    state.session_id,
    state.output?.sessionID,
    state.output?.sessionId,
    state.output?.session_id,
  )
  if (direct.startsWith("ses_")) return direct

  const candidates = [
    state.output,
    state.result,
    state.text,
    part.output,
    part.result,
    part.text,
  ]
  for (const c of candidates) {
    if (typeof c === "string") {
      const sid = extractSessionIdFromText(c)
      if (sid) return sid
    } else if (c && typeof c === "object") {
      const sid = pickFirstString(c.sessionID, c.sessionId, c.session_id)
      if (sid.startsWith("ses_")) return sid
      const fromJson = extractSessionIdFromText(JSON.stringify(c))
      if (fromJson) return fromJson
    }
  }
  return ""
}

function getSessionInfoFromEvent(record, event) {
  const props = event?.properties || {}
  const payload = event?.payload || {}
  const info = props.info || props.session || payload.info || payload.session || event?.info || event?.session || {}
  const sid = pickFirstString(
    info.id,
    info.sessionID,
    info.sessionId,
    info.session_id,
    props.sessionID,
    props.sessionId,
    props.session_id,
    payload.sessionID,
    payload.sessionId,
    payload.session_id,
    record?.sessionID,
  )
  const pid = pickFirstString(
    info.parentID,
    info.parentId,
    info.parent_id,
    props.parentID,
    props.parentId,
    props.parent_id,
    payload.parentID,
    payload.parentId,
    payload.parent_id,
  )
  const agent = pickFirstString(info.agent, info.name, props.agent, props.name, payload.agent, payload.name)
  return { sid, pid, agent }
}

function listJsonlFiles(spoolDir) {
  const out = []
  try {
    const days = fs.readdirSync(spoolDir, { withFileTypes: true }).filter((d) => d.isDirectory())
    for (const d of days) {
      const dir = path.join(spoolDir, d.name)
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
      for (const f of files) out.push(path.join(dir, f))
    }
  } catch {}
  out.sort()
  return out
}

// Returns the newest mtime (ms) across all .jsonl files in the spool dir, or 0 if none.
// Used as a fast-skip gate: if no file has been touched since the last scan, the
// uploader can exit immediately without parsing any data.
function newestSpoolMtime(spoolDir) {
  let newest = 0
  try {
    const days = fs.readdirSync(spoolDir, { withFileTypes: true }).filter((d) => d.isDirectory())
    for (const d of days) {
      const dir = path.join(spoolDir, d.name)
      let files
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
      } catch {
        continue
      }
      for (const f of files) {
        try {
          const st = fs.statSync(path.join(dir, f))
          if (st.mtimeMs > newest) newest = st.mtimeMs
        } catch {}
      }
    }
  } catch {}
  return newest
}

function readJsonl(file) {
  const records = []
  try {
    const text = fs.readFileSync(file, "utf8")
    const lines = text.split("\n")
    let pluginPid = null
    for (const line of lines) {
      if (!line || !line.trim()) continue
      const obj = safeJsonParse(line)
      if (!obj) continue
      if (obj.kind === "plugin.start") {
        const pid = Number(obj?.payload?.pid)
        if (Number.isFinite(pid) && pid > 0) pluginPid = pid
      }
      obj.__sourceFile = file
      if (pluginPid) obj.__pluginPid = pluginPid
      records.push(obj)
    }
  } catch {}
  return records
}

function isPidAlive(pid) {
  const n = Number(pid)
  if (!Number.isFinite(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch {
    return false
  }
}

function shouldSkipProxy(targetHostname) {
  const noProxy = process.env.no_proxy || process.env.NO_PROXY
  if (!noProxy) return false
  const segments = noProxy.split(",").map((s) => s.trim().toLowerCase())
  return segments.some((s) => s === "*" || targetHostname.toLowerCase().endsWith(s))
}

function getRequestOptions(targetUrl, apiKey, bodyLength) {
  const protocol = targetUrl.protocol
  const proxy =
    (protocol === "https:"
      ? process.env.https_proxy || process.env.HTTPS_PROXY
      : process.env.http_proxy || process.env.HTTP_PROXY) ||
    process.env.all_proxy ||
    process.env.ALL_PROXY

  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (protocol === "https:" ? 443 : 80),
    path: (() => {
      const base = targetUrl.pathname === "/" ? "" : targetUrl.pathname.replace(/\/$/, "")
      if (base.endsWith("/api")) return base + "/upload"
      return base + "/api/upload"
    })(),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": bodyLength,
      "x-witty-api-key": apiKey,
    },
  }

  if (proxy && !shouldSkipProxy(targetUrl.hostname)) {
    try {
      const proxyUrl = new URL(proxy)
      if (protocol === "http:") {
        options.hostname = proxyUrl.hostname
        options.port = proxyUrl.port || 80
        options.path = targetUrl.origin + options.path
        if (proxyUrl.username) {
          const auth = Buffer.from(`${proxyUrl.username}:${proxyUrl.password}`).toString("base64")
          options.headers["Proxy-Authorization"] = `Basic ${auth}`
        }
      }
    } catch {}
  }

  return options
}

function postJson(host, apiKey, payload) {
  return new Promise((resolve) => {
    let targetUrl
    try {
      targetUrl = new URL(host.match(/^https?:\/\//) ? host : `http://${host}`)
    } catch {
      resolve({ ok: false, status: 0, body: "bad host" })
      return
    }

    const body = Buffer.from(JSON.stringify(payload))
    const options = getRequestOptions(targetUrl, apiKey, body.length)
    const reqModule = targetUrl.protocol === "https:" ? https : http

    const req = reqModule.request(options, (res) => {
      let resBody = ""
      res.on("data", (chunk) => {
        resBody += chunk
      })
      res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: resBody }))
    })
    req.on("error", (err) => resolve({ ok: false, status: 0, body: err.message }))
    req.setTimeout(15000, () => {
      try {
        req.destroy()
      } catch {}
      resolve({ ok: false, status: 0, body: "timeout" })
    })
    req.end(body)
  })
}

function loadCheckpoint(file) {
  try {
    if (!fs.existsSync(file)) return {}
    const txt = fs.readFileSync(file, "utf8")
    if (!txt || !txt.trim()) return {}
    const obj = JSON.parse(txt)
    return obj && typeof obj === "object" ? obj : {}
  } catch {
    return {}
  }
}

function saveCheckpoint(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(obj, null, 2))
  } catch {}
}

function buildState(records) {
  const sessions = new Map()
  const sessionParent = new Map()
  const sessionAgent = new Map()
  const children = new Map()

  const msgInfo = new Map()
  const msgParts = new Map()
  const partText = new Map()
  const userTextByMsg = new Map()
  const sysPrompts = new Map()
  const cliCompletedSessions = new Set()
  const sessionPids = new Map()

  const ensureSession = (sid) => {
    if (!sessions.has(sid)) sessions.set(sid, { sessionID: sid, messageIDs: new Set() })
    return sessions.get(sid)
  }

  const recordSessionPid = (sid, r) => {
    if (!sid) return
    const pid = Number(r?.__pluginPid)
    if (!Number.isFinite(pid) || pid <= 0) return
    if (!sessionPids.has(sid)) sessionPids.set(sid, new Set())
    sessionPids.get(sid).add(pid)
  }

  const addChild = (pid, cid) => {
    if (!pid || !cid) return
    if (!children.has(pid)) children.set(pid, new Set())
    children.get(pid).add(cid)
  }

  for (const r of records) {
    const kind = r?.kind
    if (kind === "plugin.shutdown") {
      const sid = r.sessionID
      if (sid) {
        ensureSession(sid)
        recordSessionPid(sid, r)
        cliCompletedSessions.add(sid)
      }
      continue
    }

    if (kind === "system.prompt") {
      const sid = r.sessionID
      if (!sid) continue
      recordSessionPid(sid, r)
      if (!sysPrompts.has(sid)) sysPrompts.set(sid, [])
      const arr = sysPrompts.get(sid)
      const sha = r?.payload?.sha256 || ""
      if (sha && arr.some((x) => x.sha256 === sha)) continue
      arr.push({ ...r.payload, providerID: r.providerID, modelID: r.modelID })
      continue
    }

    if (kind === "chat.message") {
      const sid = r.sessionID
      if (!sid) continue
      recordSessionPid(sid, r)
      const mid = r?.payload?.messageID
      if (mid) userTextByMsg.set(mid, r?.payload?.text || "")
      ensureSession(sid)
      continue
    }

    if (kind === "text.complete") {
      const sid = r.sessionID
      if (!sid) continue
      recordSessionPid(sid, r)
      const mid = r?.payload?.messageID
      const pid = r?.payload?.partID
      if (mid && pid) partText.set(`${mid}:${pid}`, r?.payload?.text || "")
      ensureSession(sid)
      continue
    }

    if (kind !== "event") continue
    const t = r?.payload?.type
    const ev = r?.payload?.event
    if (!t || !ev) continue

    if (t === "session.created" || t === "session.updated") {
      const { sid, pid, agent } = getSessionInfoFromEvent(r, ev)
      if (sid) {
        ensureSession(sid)
        recordSessionPid(sid, r)
        if (pid && pid !== sid) {
          sessionParent.set(sid, pid)
          addChild(pid, sid)
        }
        if (agent) sessionAgent.set(sid, agent)
      }
      continue
    }

    if (t === "message.updated") {
      const info = ev?.properties?.info
      const sid = info?.sessionID || ev?.properties?.sessionID || r.sessionID
      const mid = info?.id
      if (!sid || !mid) continue
      ensureSession(sid).messageIDs.add(mid)
      recordSessionPid(sid, r)
      msgInfo.set(mid, info)
      continue
    }

    if (t === "message.part.updated") {
      const p = ev?.properties?.part
      // opencode actually nests messageID/sessionID INSIDE the part object,
      // not at the top-level properties. Fall back to the nested form so we
      // don't drop assistant text parts.
      const mid = ev?.properties?.messageID || p?.messageID
      const sid = ev?.properties?.sessionID || p?.sessionID || r.sessionID
      const pid = p?.id || ev?.properties?.partID
      if (!sid || !mid || !pid) continue
      ensureSession(sid).messageIDs.add(mid)
      recordSessionPid(sid, r)
      if (!msgParts.has(mid)) msgParts.set(mid, [])
      const arr = msgParts.get(mid)
      const nextPart = { ...p, id: pid }
      const nextKey = partIdentity(nextPart)
      const idx = arr.findIndex((x) => partIdentity(x) === nextKey)
      if (idx >= 0) arr[idx] = { ...arr[idx], ...nextPart }
      else arr.push(nextPart)

      const childSid = extractTaskChildSessionId(p)
      if (childSid && childSid !== sid) {
        ensureSession(childSid)
        sessionParent.set(childSid, sid)
        addChild(sid, childSid)
        const subagentType = p?.state?.input?.subagent_type || p?.state?.input?.subagentType
        if (typeof subagentType === "string" && subagentType.trim() && !sessionAgent.has(childSid)) {
          sessionAgent.set(childSid, subagentType.trim())
        }
      }
      continue
    }
  }

  return { sessions, sessionParent, sessionAgent, children, msgInfo, msgParts, partText, userTextByMsg, sysPrompts, cliCompletedSessions, sessionPids }
}

function buildMessagesForSession(state, sid) {
  const { msgInfo, msgParts, partText, userTextByMsg } = state
  const messages = []

  for (const [mid, info] of msgInfo.entries()) {
    if (info?.sessionID !== sid) continue
    const role = info?.role
    const created = info?.time?.created
    const completed = info?.time?.completed

    let content = ""
    if (role === "user") {
      content = userTextByMsg.get(mid) || ""
      if (!content && typeof info?.system === "string") content = info.system
    } else {
      const parts = msgParts.get(mid) || []
      const buf = []
      for (const p of parts) {
        if ((p?.type || "").toLowerCase() === "text") {
          const key = `${mid}:${p.id}`
          const text = partText.get(key)
          const fallback = typeof p?.text === "string" ? p.text : ""
          const out = typeof text === "string" && text ? text : fallback
          if (out) buf.push(out)
        }
      }
      content = buf.join("")
    }

    const tool_calls = []
    const parts = msgParts.get(mid) || []
    for (const p of parts) {
      if ((p?.type || "").toLowerCase() !== "tool") continue
      const callID = p?.callID || p?.callId || p?.id
      const tool = p?.tool
      const st = p?.state || {}
      const state = st?.status || st?.state || ""
      const args = st?.input
      tool_calls.push({
        id: callID,
        type: "function",
        function: { name: tool, arguments: typeof args === "string" ? args : JSON.stringify(args || {}) },
        state,
        output: st?.output,
      })
    }

    const tokens = info?.tokens
    const u = tokens
      ? {
          input: tokens.input,
          output: tokens.output,
          reasoning: tokens.reasoning,
          cache: tokens.cache,
          total: usageTotalsFromTokens(tokens).total,
        }
      : undefined

    // Preserve the raw part structure so downstream can distinguish
    //   text / reasoning / tool / patch / step-start / step-finish / compaction
    // and so compaction-trigger user messages (which carry only a "compaction"
    // part with no text) are not silently dropped. messageID/sessionID on each
    // part are redundant with the enclosing message — strip them.
    const rawParts = msgParts.get(mid) || []
    const partsOut = rawParts.length
      ? rawParts.map((p) => {
          const { messageID: _mid, sessionID: _sid, ...rest } = p || {}
          // For text parts, prefer the streamed-complete text from text.complete
          // hook over whatever partial we captured on message.part.updated.
          if ((rest?.type || "").toLowerCase() === "text") {
            const key = `${mid}:${rest.id}`
            const finalText = partText.get(key)
            if (typeof finalText === "string" && finalText) rest.text = finalText
          }
          return rest
        })
      : undefined

    const m = {
      role,
      content,
      parts: partsOut,
      tool_calls: tool_calls.length ? tool_calls : undefined,
      usage: u,
      timestamp: created != null ? new Date(created).toISOString() : undefined,
      timeInfo: { created, completed },
      agent: info?.agent,
      modelID: info?.modelID,
      providerID: info?.providerID,
      cost: info?.cost,
      // Compaction signal lives here:
      //   mode === "compaction" + summary === true  →  this is a compaction-summary
      //   message and the prior context should be folded behind it.
      mode: info?.mode,
      // opencode overloads `info.summary`:
      //   - boolean `true`  → compaction marker we want
      //   - object `{diffs: [...]}` → per-turn file-diff summary (can be ~80KB);
      //     not needed for prompt rendering, and shipping it would balloon the
      //     upload payload, so drop it. If we ever want a diff-aware trace view
      //     it should go through its own channel.
      summary: info?.summary === true ? true : undefined,
      finish: info?.finish,
      variant: info?.variant,
    }
    messages.push(m)
  }

  messages.sort((a, b) => (toMsTimestamp(a.timeInfo?.created) || 0) - (toMsTimestamp(b.timeInfo?.created) || 0))
  return messages
}

function mergeGraph(state, rootSid) {
  const { children, sessionAgent, sysPrompts } = state
  const merged = []
  const stack = [rootSid]
  const seen = new Set()
  while (stack.length) {
    const sid = stack.pop()
    if (!sid || seen.has(sid)) continue
    seen.add(sid)

    // Build per-session system prompt entries (one entry per distinct sha256).
    // Each becomes a synthetic role="system" message at the head of the session's
    // slice, tagged with subagent_session_id so the UI can group it under the
    // right agent node. The frontend renders these as a collapsed card on the
    // selected agent, separate from the event flow.
    const sysEntries = sysPrompts.get(sid) || []
    const sysMessages = []
    for (const entry of sysEntries) {
      const text = Array.isArray(entry?.system) ? entry.system.join("\n") : ""
      if (!text) continue
      const base = {
        role: "system",
        content: text,
        trace_id: rootSid,
        system_prompt_sha256: entry?.sha256,
        system_prompt_length: entry?.length,
        system_prompt_modelID: entry?.modelID,
        system_prompt_providerID: entry?.providerID,
      }
      sysMessages.push(
        sid === rootSid
          ? base
          : { ...base, subagent_name: sessionAgent.get(sid) || sid, subagent_session_id: sid },
      )
    }

    const msgs = buildMessagesForSession(state, sid).map((m) => ({ ...m, trace_id: rootSid }))
    if (sid === rootSid) {
      merged.push(...sysMessages, ...msgs)
    } else {
      const name = sessionAgent.get(sid) || sid
      merged.push(...sysMessages)
      for (const m of msgs) {
        if (m.role === "user") merged.push({ ...m, role: "opencode", subagent_name: name, subagent_session_id: sid })
        else merged.push({ ...m, role: "subagent", subagent_name: name, subagent_session_id: sid })
      }
    }

    const next = children.get(sid)
    if (next) for (const c of Array.from(next)) stack.push(c)
  }
  return merged
}

function deriveFields(interactions) {
  let totalTokens = 0
  let totalLatencyMs = 0
  let model = ""
  let finalResult = ""
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCacheReadInputTokens = 0
  let totalCacheCreationInputTokens = 0
  let totalReasoningTokens = 0
  let llmCallCount = 0
  let toolCallCount = 0
  let toolCallErrorCount = 0
  let maxSingleCallTokens = 0

  for (const m of interactions || []) {
    if (!m) continue
    const role = m.role
    const isCompletion = role === "assistant" || role === "subagent"
    if (role === "assistant") {
      const c = typeof m.content === "string" ? m.content : ""
      if (c && c.trim()) finalResult = c
      if (typeof m.modelID === "string" && m.modelID) model = m.modelID
    }
    if (!isCompletion) continue
    llmCallCount++
    const u = m.usage
    if (u) {
      const input = Number(u.input || 0) || 0
      const rawOutput = Number(u.output || 0) || 0
      const cacheRead = Number(u.cache?.read || 0) || 0
      const cacheWrite = Number(u.cache?.write || 0) || 0
      const reasoning = Number(u.reasoning || 0) || 0
      const output = reasoning > 0 && rawOutput < reasoning ? rawOutput + reasoning : rawOutput
      const total = Number(u.total) || input + output + cacheRead + cacheWrite
      totalTokens += total
      totalInputTokens += input
      totalOutputTokens += output
      totalCacheReadInputTokens += cacheRead
      totalCacheCreationInputTokens += cacheWrite
      totalReasoningTokens += reasoning
      const callTotal = input + output + cacheRead + cacheWrite
      if (callTotal > maxSingleCallTokens) maxSingleCallTokens = callTotal
    }

    const created = toMsTimestamp(m.timeInfo?.created)
    const completed = toMsTimestamp(m.timeInfo?.completed)
    if (created != null && completed != null) {
      const d = completed - created
      if (d > 0 && d < 3600000) totalLatencyMs += d
    }

    if (Array.isArray(m.tool_calls)) {
      toolCallCount += m.tool_calls.length
      for (const tc of m.tool_calls) {
        if (tc?.state === "error" || tc?.state === "failed") toolCallErrorCount++
      }
    }
  }

  return {
    model: model || undefined,
    final_result: finalResult || undefined,
    tokens: Math.round(totalTokens),
    latency: totalLatencyMs / 1000,
    input_tokens: Math.round(totalInputTokens),
    output_tokens: Math.round(totalOutputTokens),
    tool_call_count: toolCallCount,
    tool_call_error_count: toolCallErrorCount,
    llm_call_count: llmCallCount,
    cache_read_input_tokens: Math.round(totalCacheReadInputTokens),
    cache_creation_input_tokens: Math.round(totalCacheCreationInputTokens),
    max_single_call_tokens: Math.round(maxSingleCallTokens),
    reasoning_tokens: Math.round(totalReasoningTokens),
  }
}

function cleanupOldFiles(spoolDir, retentionDays) {
  const days = Number(retentionDays) || 10
  const cutoff = Date.now() - days * 24 * 3600 * 1000
  try {
    const entries = fs.readdirSync(spoolDir, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const dir = path.join(spoolDir, e.name)
      const stat = fs.statSync(dir)
      if (stat.mtimeMs < cutoff) {
        try {
          fs.rmSync(dir, { recursive: true, force: true })
        } catch {}
      }
    }
  } catch {}
}

async function main() {
  const env = loadSkillInsightEnv()
  const apiKey = env.SKILL_INSIGHT_API_KEY
  const host = env.SKILL_INSIGHT_HOST
  if (!apiKey || !host) process.exit(0)

  const spoolDir = env.SKILL_INSIGHT_OPENCODE_SPOOL_DIR || path.join(os.homedir(), ".skill-insight", "otel_data", "opencode")
  const checkpointFile = path.join(os.homedir(), ".skill-insight", "opencode_uploader_checkpoint.json")
  const retentionDays = env.SKILL_INSIGHT_RETENTION_DAYS || "10"
  const deletedSessionIds = loadDeletedSessionIds(env)

  cleanupOldFiles(spoolDir, retentionDays)

  const ckpt = loadCheckpoint(checkpointFile)

  // Fast-skip gate: if no spool file has been touched since the last scan, exit
  // immediately without reading/parsing any data. This keeps the polling daemon
  // cheap (~5ms) when opencode is idle. Force=1 bypasses for manual debugging.
  const newestMtime = newestSpoolMtime(spoolDir)
  const lastScanMtime = ckpt.__lastScanMtime || 0
  if (newestMtime > 0 && newestMtime <= lastScanMtime && process.env.SKILL_INSIGHT_UPLOADER_FORCE !== "1") {
    process.exit(0)
  }

  const files = listJsonlFiles(spoolDir)

  // 注意：用 push.apply 或 spread (...readJsonl(f)) 在大文件下会触发
  // "Maximum call stack size exceeded"——args 数量受调用栈限制。
  // playground 一次会话经常落 30K+ 条事件到 jsonl，必须逐条 push。
  const allRecords = []
  for (const f of files) {
    const records = readJsonl(f)
    for (const r of records) allRecords.push(r)
  }

  const state = buildState(allRecords)

  const roots = []
  for (const sid of state.sessions.keys()) {
    if (!state.sessionParent.get(sid)) roots.push(sid)
  }

  for (const rootSid of roots) {
    if (deletedSessionIds.has(rootSid)) continue
    const interactions = mergeGraph(state, rootSid)
    if (!interactions.length) continue
    const query = interactions.find((m) => m.role === "user" && m.content)?.content || `OpenCode Session ${rootSid}`
    const derived = deriveFields(interactions)

    // System prompts are now unshifted inside mergeGraph() per session
    // (root + sub-agents), so no extra unshift needed here. Keep `sys` for
    // backward-compatibility on payload.system_prompts metadata.
    const sys = state.sysPrompts.get(rootSid) || []
    const pids = Array.from(state.sessionPids.get(rootSid) || [])
    const opencodeCliCompleted = state.cliCompletedSessions.has(rootSid)
      || (pids.length > 0 && pids.every((pid) => !isPidAlive(pid)))
    const payload = {
      task_id: rootSid,
      query,
      framework: "opencode",
      model: derived.model,
      tokens: derived.tokens,
      latency: derived.latency,
      input_tokens: derived.input_tokens,
      output_tokens: derived.output_tokens,
      tool_call_count: derived.tool_call_count,
      tool_call_error_count: derived.tool_call_error_count,
      llm_call_count: derived.llm_call_count,
      cache_read_input_tokens: derived.cache_read_input_tokens,
      cache_creation_input_tokens: derived.cache_creation_input_tokens,
      max_single_call_tokens: derived.max_single_call_tokens,
      reasoning_tokens: derived.reasoning_tokens,
      final_result: derived.final_result,
      interactions,
      system_prompts: sys,
      trace: { trace_id: rootSid },
      opencode_cli_completed: opencodeCliCompleted,
      timestamp: new Date().toISOString(),
    }

    let lastTs = 0
    for (const m of interactions) {
      const t1 = toMsTimestamp(m.timestamp) || 0
      const t2 = toMsTimestamp(m.timeInfo?.completed) || 0
      const t3 = toMsTimestamp(m.timeInfo?.created) || 0
      lastTs = Math.max(lastTs, t1, t2, t3)
    }
    const lastAssistant = String(payload.final_result || "")
    const sig = `${interactions.length}|${lastAssistant.length}|${lastTs}|${payload.opencode_cli_completed ? 1 : 0}`
    if (ckpt[rootSid] && ckpt[rootSid] === sig) continue

    const res = await postJson(host, apiKey, payload)
    if (res.ok) {
      ckpt[rootSid] = sig
      saveCheckpoint(checkpointFile, ckpt)
    }
  }

  // Record that we've scanned up to this mtime. Next invocation will short-circuit
  // unless a JSONL file has been modified after this point.
  if (newestMtime > 0) {
    ckpt.__lastScanMtime = newestMtime
    saveCheckpoint(checkpointFile, ckpt)
  }
}

export {
  buildMessagesForSession,
  buildState,
  deriveFields,
  extractSessionIdFromText,
  extractTaskChildSessionId,
  getSessionInfoFromEvent,
  mergeGraph,
}

if (process.env.SKILL_INSIGHT_UPLOADER_NO_MAIN !== "1") {
  main().catch((err) => {
    // 不能 silent exit——之前 spread 大数组爆栈导致整条 trace 链路停摆几小时，
    // 日志里只有 plugin 写的 kickUploader 头，看不到任何 uploader 自身报错。
    // stderr 会被 plugin 那边 dup 到 ~/.skill-insight/logs/opencode_uploader.log，
    // 失败也好让运维一眼看到。仍然 exit(0)：失败的 batch 下次轮询继续，无需 retry。
    try {
      const msg = err && err.stack ? err.stack : String(err)
      process.stderr.write(`[uploader main err] ${msg}\n`)
    } catch {}
    process.exit(0)
  })
}
