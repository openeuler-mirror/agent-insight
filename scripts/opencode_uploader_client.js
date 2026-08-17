import http from "node:http"
import https from "node:https"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { URL } from "node:url"

function getPreferredInsightDir() {
  return path.join(os.homedir(), ".agent-insight")
}

function getLegacyInsightDir() {
  return path.join(os.homedir(), ".skill-insight")
}

function getExistingInsightDir() {
  const preferred = getPreferredInsightDir()
  const legacy = getLegacyInsightDir()
  if (fs.existsSync(preferred)) return preferred
  if (fs.existsSync(legacy)) return legacy
  return preferred
}

function getInsightEnvCandidates() {
  return [
    path.join(getPreferredInsightDir(), ".env"),
    path.join(getLegacyInsightDir(), ".env"),
  ]
}

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
    for (const file of getInsightEnvCandidates()) {
      if (!fs.existsSync(file)) continue
      const txt = fs.readFileSync(file, "utf8")
      const parsed = parseDotEnvText(txt)
      for (const [k, v] of Object.entries(parsed)) {
        if (env[k] === undefined) env[k] = v
      }
    }
  } catch {}
  return env
}

/**
 * .env 里写了、却被进程环境里的同名变量压住的键（值不同才算）。
 *
 * 上面那句 `if (env[k] === undefined)` 是「环境变量优先」——保留它是为了让一次性覆盖继续
 * 可用。代价是重跑 setup 把 .env 指向新平台后，旧终端里残留的 export 会让上报**继续发往
 * 老地址**，而且此前全程无任何提示：日志里的 host 与 .env 明明不一致也没人吭声。
 */
function findShadowedEnvKeys() {
  const out = []
  try {
    for (const file of getInsightEnvCandidates()) {
      if (!fs.existsSync(file)) continue
      const parsed = parseDotEnvText(fs.readFileSync(file, "utf8"))
      for (const [k, v] of Object.entries(parsed)) {
        const actual = process.env[k]
        if (actual === undefined || actual === v) continue
        if (out.some((x) => x.key === k)) continue
        out.push({ key: k, fromFile: v, actual })
      }
    }
  } catch {}
  return out
}

/** 拼成一行日志。含 KEY/TOKEN/SECRET 的键只报键名，不打值。 */
function describeShadowedEnv(entries) {
  return entries
    .map(({ key, fromFile, actual }) =>
      /KEY|TOKEN|SECRET|PASSWORD/i.test(key)
        ? `${key}(值不同,已隐藏)`
        : `${key}(.env=${fromFile} 实际=${actual})`,
    )
    .join(" ")
}

function nowIso() {
  return new Date().toISOString()
}

function safeMkdirp(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {}
}

function appendUploaderLog(message) {
  try {
    const file = path.join(getPreferredInsightDir(), "logs", "opencode_uploader.log")
    safeMkdirp(path.dirname(file))
    fs.appendFileSync(file, `[${nowIso()}] ${message}\n`)
  } catch {}
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
  const file = env.AGENT_INSIGHT_OPENCODE_DELETED_SESSIONS || path.join(getExistingInsightDir(), "opencode_deleted_sessions.json")
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

  const headers = {
    "Content-Type": "application/json",
    "Content-Length": bodyLength,
  }
  // keyless 共享账号模式：apiKey 为空时【不带】x-witty-api-key，让服务端按
  // AGENT_INSIGHT_DEFAULT_INGEST_USER 归属。若强行带上空/undefined 值，服务端会把它
  // 当成一把无效 key → 401，反而上不去。
  if (apiKey) headers["x-witty-api-key"] = apiKey
  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (protocol === "https:" ? 443 : 80),
    path: (() => {
      const base = targetUrl.pathname === "/" ? "" : targetUrl.pathname.replace(/\/$/, "")
      if (base.endsWith("/api")) return base + "/upload"
      return base + "/api/upload"
    })(),
    method: "POST",
    headers,
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
    appendUploaderLog(
      `postJson.request host=${targetUrl.origin} path=${options.path} task_id=${payload?.task_id || "(none)"} bodyBytes=${body.length}`,
    )

    const req = reqModule.request(options, (res) => {
      let resBody = ""
      res.on("data", (chunk) => {
        resBody += chunk
      })
      res.on("end", () => {
        appendUploaderLog(
          `postJson.response task_id=${payload?.task_id || "(none)"} status=${res.statusCode || 0} ok=${res.statusCode >= 200 && res.statusCode < 300 ? "1" : "0"} body=${String(resBody || "").slice(0, 1000) || "(empty)"}`,
        )
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: resBody })
      })
    })
    req.on("error", (err) => {
      appendUploaderLog(`postJson.error task_id=${payload?.task_id || "(none)"} error=${err.message}`)
      resolve({ ok: false, status: 0, body: err.message })
    })
    req.setTimeout(15000, () => {
      try {
        req.destroy()
      } catch {}
      appendUploaderLog(`postJson.timeout task_id=${payload?.task_id || "(none)"}`)
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
  const partDeltas = new Map()
  const seenDeltaEventIds = new Set()
  const userTextByMsg = new Map()
  const sysPrompts = new Map()
  const cliCompletedSessions = new Set()
  const sessionPids = new Map()
  const sessionIdleAt = new Map()
  // 每个 session 落到 spool 的原始记录条数。只增不减，是"这个会话还在干活"的唯一
  // 可靠信号——工具死循环时消息条数/终稿文本/时间戳全都不变，只有它会涨。
  const sessionRecordCounts = new Map()

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

  const recordSessionIdle = (sid, r) => {
    if (!sid) return
    const ms = toMsTimestamp(r?.t) || Date.now()
    const prev = sessionIdleAt.get(sid) || 0
    if (ms > prev) sessionIdleAt.set(sid, ms)
  }

  for (const r of records) {
    const kind = r?.kind
    const recordSid = typeof r?.sessionID === "string" ? r.sessionID : ""
    if (recordSid) sessionRecordCounts.set(recordSid, (sessionRecordCounts.get(recordSid) || 0) + 1)
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

    const statusType = String(ev?.properties?.status?.type || ev?.properties?.status || "").toLowerCase()
    if (t === "session.idle" || (t === "session.status" && statusType === "idle")) {
      const sid = r.sessionID || ev?.properties?.sessionID
      if (sid) {
        ensureSession(sid)
        recordSessionPid(sid, r)
        recordSessionIdle(sid, r)
      }
      continue
    }

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

    if (t === "message.part.delta") {
      const props = ev?.properties || {}
      const mid = props.messageID
      const sid = props.sessionID || r.sessionID
      const pid = props.partID
      const field = typeof props.field === "string" && props.field ? props.field : "text"
      const delta = typeof props.delta === "string" ? props.delta : ""
      if (!sid || !mid || !pid || !delta) continue
      const eventId = typeof ev?.id === "string" ? ev.id : ""
      if (eventId && seenDeltaEventIds.has(eventId)) continue
      if (eventId) seenDeltaEventIds.add(eventId)
      ensureSession(sid).messageIDs.add(mid)
      recordSessionPid(sid, r)
      const key = `${mid}:${pid}:${field}`
      partDeltas.set(key, `${partDeltas.get(key) || ""}${delta}`)
      continue
    }
  }

  return { sessions, sessionParent, sessionAgent, children, msgInfo, msgParts, partText, partDeltas, userTextByMsg, sysPrompts, cliCompletedSessions, sessionPids, sessionIdleAt, sessionRecordCounts }
}

// 一个 root 会话的所有 session id（含 task 工具派生的子会话）。sig 里的记录数要按整棵
// 树求和，否则子 agent 里的工具循环不会体现在 root 的指纹上。
function collectSessionSubtree(state, rootSid) {
  const out = []
  const stack = [rootSid]
  const seen = new Set()
  while (stack.length) {
    const sid = stack.pop()
    if (!sid || seen.has(sid)) continue
    seen.add(sid)
    out.push(sid)
    const next = state.children?.get(sid)
    if (next) for (const c of Array.from(next)) stack.push(c)
  }
  return out
}

function subtreeRecordCount(state, rootSid) {
  let total = 0
  for (const sid of collectSessionSubtree(state, rootSid)) {
    total += state.sessionRecordCounts?.get(sid) || 0
  }
  return total
}

// sig = 内容指纹，checkpoint 用它判断"跟上次上报比有没有变化"。
//
// 前 5 位是历史格式，后 3 位是本次新增的单调量。新增的原因：工具死循环发生在
// 「同一条 assistant message 内部反复更新 tool part」，前 5 位一个都不会变
// （消息条数不涨 / 无新终稿文本 / message 时间戳不动），导致整个循环期间
// 每轮都命中 checkpoint 被 skip，数据要等 CLI 退出才第一次上报。
function buildSignature({ interactionCount, finalResultLength, lastTs, traceCompletedAt, cliCompleted, toolCallCount, tokens, recordCount, completed }) {
  const base = [
    interactionCount,
    finalResultLength,
    lastTs,
    traceCompletedAt || "",
    cliCompleted ? 1 : 0,
  ]
  // 会话已结束就不再附加单调量：它们的作用是识别"还在推进"，对已完成的 trace 只会
  // 因为 spool 里的杂事件而无谓地翻新指纹，触发重传 + 重跑 LLM 分析。
  if (completed) return base.join("|")
  return [...base, toolCallCount || 0, tokens || 0, recordCount || 0].join("|")
}

// 本轮对话是否已经跑完：有终稿输出，且这次 idle 发生在最后一次活动之后。
//
// 只判「有终稿 && 有过 idle」是不够的 —— 多轮会话里第 1 轮答完就有终稿和 idle，
// 第 2 轮陷入工具循环时这两个条件依然成立，会把进行中的快照误判成已结束，
// 让服务端对每一次心跳快照都跑一整轮 LLM 分析。
const ROUND_IDLE_TOLERANCE_MS = 2000
function isRoundCompleted({ finalResult, idleMs, lastTs }) {
  if (!finalResult) return false
  if (!(idleMs > 0)) return false
  // 容差吸收 idle 事件与消息完成时间之间的顺序抖动；循环场景里两者相差远大于容差。
  return idleMs + ROUND_IDLE_TOLERANCE_MS >= (lastTs || 0)
}

// 升级兼容：老 checkpoint 里存的是 5 段式 sig。若直接跟 8 段式比对必然失配，
// 会把 spool 里保留期内（默认 3 天）的所有历史会话重传一遍，并在服务端触发
// 一整轮 LLM 分析风暴。所以老格式只比对公共的前 5 段，相等就视为未变化。
//
// 注意配套逻辑：命中这条兼容分支时，main() 会把 checkpoint 原地升级成新格式再 skip。
// 否则一个正处在工具循环中的会话（前 5 段恒定不变）会被这条兼容规则永久压住 ——
// 而它恰恰是本次要救的对象。升级后下一轮扫描 recordCount/toolCallCount 已推进，
// 立即放行，代价只有一个心跳周期。
function isSignatureUnchanged(prevSig, nextSig) {
  if (!prevSig) return false
  if (prevSig === nextSig) return true
  const prev = String(prevSig).split("|")
  if (prev.length >= 8) return false
  const next = String(nextSig).split("|")
  return prev.length === 5 && prev.join("|") === next.slice(0, 5).join("|")
}

// Join all text-type parts of a message into one string. Prefers the
// streamed-complete text (text.complete hook) over the partial captured on
// message.part.updated. Shared by user and assistant message rendering.
function resolvePartField(part, mid, partText, partDeltas, field = "text") {
  const key = `${mid}:${part.id}`
  const completed = field === "text" ? partText.get(key) : undefined
  if (typeof completed === "string" && completed) return completed

  const snapshot = typeof part?.[field] === "string" ? part[field] : ""
  const streamed = partDeltas.get(`${key}:${field}`) || ""
  if (!streamed) return snapshot
  if (!snapshot) return streamed
  if (snapshot === streamed || snapshot.includes(streamed)) return snapshot
  if (streamed.includes(snapshot)) return streamed
  return streamed.length >= snapshot.length ? streamed : snapshot
}

function collectTextPartContent(parts, mid, partText, partDeltas) {
  const buf = []
  for (const p of parts || []) {
    if ((p?.type || "").toLowerCase() !== "text") continue
    const out = resolvePartField(p, mid, partText, partDeltas)
    if (out) buf.push(out)
  }
  return buf.join("")
}

function buildMessagesForSession(state, sid) {
  const { msgInfo, msgParts, partText, partDeltas, userTextByMsg } = state
  const messages = []

  for (const [mid, info] of msgInfo.entries()) {
    if (info?.sessionID !== sid) continue
    const role = info?.role
    const created = info?.time?.created
    const completed = info?.time?.completed

    let content = ""
    if (role === "user") {
      // The real user query lives in this message's own text part(s), and
      // message.part.updated reliably carries messageID, so reading from parts
      // is version-proof. The legacy sources are unreliable on newer opencode:
      //   - userTextByMsg is keyed off the chat.message hook's input.messageID,
      //     an OPTIONAL field newer opencode often omits → key is null → the
      //     user text is never recorded.
      //   - info.system (last-ditch fallback) is now null on user messages —
      //     and was the system prompt, not the query, anyway.
      // With both broken the query uploaded empty. Keep them only as fallbacks.
      content = collectTextPartContent(msgParts.get(mid) || [], mid, partText, partDeltas)
      if (!content) content = userTextByMsg.get(mid) || ""
      if (!content && typeof info?.system === "string") content = info.system
    } else {
      content = collectTextPartContent(msgParts.get(mid) || [], mid, partText, partDeltas)
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
          // For text and reasoning parts, preserve deltas when interruption
          // prevents OpenCode from emitting a final part snapshot.
          const partType = (rest?.type || "").toLowerCase()
          if (partType === "text" || partType === "reasoning") {
            const resolvedText = resolvePartField(rest, mid, partText, partDeltas)
            if (resolvedText) rest.text = resolvedText
          }
          return rest
        })
      : undefined

    const m = {
      role,
      content,
      messageID: mid,
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
  const days = Number(retentionDays) || 3
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
  const apiKey = env.AGENT_INSIGHT_API_KEY
  const host = env.AGENT_INSIGHT_HOST
  appendUploaderLog(
    `main.start host=${host || "(missing)"} apiKeyPresent=${apiKey ? "yes" : "no"} force=${process.env.AGENT_INSIGHT_UPLOADER_FORCE === "1" ? "1" : "0"}`,
  )
  const shadowed = findShadowedEnvKeys()
  if (shadowed.length) {
    appendUploaderLog(
      `main.env.shadowed 进程环境里的同名变量压过了 .env,重跑 setup 改的配置在本进程不生效: ${describeShadowedEnv(shadowed)}` +
      ` → 在启动 opencode 的终端里 unset 这些变量(或新开终端)后重启 opencode`,
    )
  }
  if (!host) {
    appendUploaderLog(`main.skip missingConfig hostPresent=no apiKeyPresent=${apiKey ? "yes" : "no"}`)
    process.exit(0)
  }
  if (!apiKey) {
    // keyless 共享账号模式：无 key 也照常上报（不带 x-witty-api-key），由服务端
    // AGENT_INSIGHT_DEFAULT_INGEST_USER 归属。以前这里 `!apiKey` 直接 skip，导致无 key 上不去。
    appendUploaderLog(`main.keyless no api key — uploading anyway (server attributes via AGENT_INSIGHT_DEFAULT_INGEST_USER)`)
  }

  const spoolDir = env.AGENT_INSIGHT_OPENCODE_SPOOL_DIR || path.join(getExistingInsightDir(), "otel_data", "opencode")
  // 账号级隔离: spool / checkpoint 都按 API key 分目录(setup 写入 per-account 路径),
  // 否则同一台机器切账号会复用机器级 spool/checkpoint, 把历史 trace 错误归到当前 key。
  // 旧 .env 没有这两个变量时回退到机器级路径, 保持向后兼容。
  const checkpointFile = env.AGENT_INSIGHT_OPENCODE_CHECKPOINT || path.join(getPreferredInsightDir(), "opencode_uploader_checkpoint.json")
  // 时间门: 只上传本次账号安装(setup)之后才有活动的 session。早于安装时间的历史会话一律
  // skip, 这样即使 spool 里残留别的账号/本机历史, 也不会被当前 key 回放上去(展示成“最近上传”)。
  const uploadSinceMs = Number(env.AGENT_INSIGHT_OPENCODE_UPLOAD_SINCE_MS || 0) || 0
  // 保留天数:默认 3 天(原来 10 天 + 上传量大时 spool 堆到 GB 级,是 OOM 诱因之一)。
  // 同时兼容旧前缀 SKILL_INSIGHT_RETENTION_DAYS(部署的 .env 里用的是这个,旧版只读 AGENT_INSIGHT_ → 没生效)。
  const retentionDays = env.AGENT_INSIGHT_RETENTION_DAYS || env.SKILL_INSIGHT_RETENTION_DAYS || "3"
  const deletedSessionIds = loadDeletedSessionIds(env)
  // 需要无视 checkpoint 强推的 session（plugin shutdown / 人工排障时按 id 指定）。
  const forceSessions = new Set(
    String(process.env.AGENT_INSIGHT_UPLOADER_FORCE_SESSION || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )
  appendUploaderLog(
    `main.config spoolDir=${spoolDir} checkpoint=${checkpointFile} retentionDays=${retentionDays} deletedSessions=${deletedSessionIds.size}`,
  )

  cleanupOldFiles(spoolDir, retentionDays)

  const ckpt = loadCheckpoint(checkpointFile)

  // Fast-skip gate: if no spool file has been touched since the last scan, exit
  // immediately without reading/parsing any data. This keeps the polling daemon
  // cheap (~5ms) when opencode is idle. Force=1 bypasses for manual debugging.
  const newestMtime = newestSpoolMtime(spoolDir)
  const lastScanMtime = ckpt.__lastScanMtime || 0
  if (newestMtime > 0 && newestMtime <= lastScanMtime && process.env.AGENT_INSIGHT_UPLOADER_FORCE !== "1") {
    appendUploaderLog(
      `main.fastSkip newestMtime=${newestMtime} lastScanMtime=${lastScanMtime} spoolDir=${spoolDir}`,
    )
    process.exit(0)
  }

  // 单例锁: 同一时刻只允许一个 uploader 真正干活。plugin 每个 opencode event 都会 kick 一个
  // FORCE 实例, 叠加 5min cron, 高峰能堆出几十个进程啃同一份积压、吃爆内存(实测 75 个)。
  // 用 pid 锁文件去重: 已有存活 uploader 持锁就直接退出; 陈旧锁(pid 已死)则接管; 退出时释放自己的锁。
  const lockFile = path.join(getPreferredInsightDir(), ".uploader.lock")
  try {
    const prevPid = Number((fs.readFileSync(lockFile, "utf8") || "").trim())
    if (prevPid && prevPid !== process.pid) {
      try {
        process.kill(prevPid, 0) // 存活 → 让位
        appendUploaderLog(`main.skip alreadyRunning pid=${prevPid}`)
        process.exit(0)
      } catch {
        /* prevPid 已死, 锁陈旧, 接管 */
      }
    }
  } catch {
    /* 无锁文件, 继续 */
  }
  try { fs.writeFileSync(lockFile, String(process.pid)) } catch {}
  process.on("exit", () => {
    try {
      if (Number((fs.readFileSync(lockFile, "utf8") || "").trim()) === process.pid) {
        fs.rmSync(lockFile, { force: true })
      }
    } catch {}
  })

  const files = listJsonlFiles(spoolDir)
  appendUploaderLog(`main.scan files=${files.length} newestMtime=${newestMtime} lastScanMtime=${lastScanMtime}`)

  // 注意：用 push.apply 或 spread (...readJsonl(f)) 在大文件下会触发
  // "Maximum call stack size exceeded"——args 数量受调用栈限制。
  // playground 一次会话经常落 30K+ 条事件到 jsonl，必须逐条 push。
  const allRecords = []
  for (const f of files) {
    const records = readJsonl(f)
    appendUploaderLog(`main.read file=${f} records=${records.length}`)
    for (const r of records) allRecords.push(r)
  }
  appendUploaderLog(`main.records total=${allRecords.length}`)

  const state = buildState(allRecords)

  const roots = []
  for (const sid of state.sessions.keys()) {
    if (!state.sessionParent.get(sid)) roots.push(sid)
  }
  appendUploaderLog(`main.sessions total=${state.sessions.size} roots=${roots.length}`)

  for (const rootSid of roots) {
    if (deletedSessionIds.has(rootSid)) {
      appendUploaderLog(`session.skip deleted task_id=${rootSid}`)
      continue
    }
    const interactions = mergeGraph(state, rootSid)
    if (!interactions.length) {
      appendUploaderLog(`session.skip emptyInteractions task_id=${rootSid}`)
      continue
    }
    const query = interactions.find((m) => m.role === "user" && m.content)?.content || `OpenCode Session ${rootSid}`
    const derived = deriveFields(interactions)

    // System prompts are now unshifted inside mergeGraph() per session
    // (root + sub-agents), so no extra unshift needed here. Keep `sys` for
    // backward-compatibility on payload.system_prompts metadata.
    const sys = state.sysPrompts.get(rootSid) || []
    const pids = Array.from(state.sessionPids.get(rootSid) || [])
    const opencodeCliCompleted = state.cliCompletedSessions.has(rootSid)
      || (pids.length > 0 && pids.every((pid) => !isPidAlive(pid)))
    const idleMs = state.sessionIdleAt.get(rootSid) || 0
    let lastTs = 0
    for (const m of interactions) {
      const t1 = toMsTimestamp(m.timestamp) || 0
      const t2 = toMsTimestamp(m.timeInfo?.completed) || 0
      const t3 = toMsTimestamp(m.timeInfo?.created) || 0
      lastTs = Math.max(lastTs, t1, t2, t3)
    }
    const traceCompletedAt = isRoundCompleted({ finalResult: derived.final_result, idleMs, lastTs })
      ? new Date(idleMs).toISOString()
      : undefined
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
      trace_completed_at: traceCompletedAt,
      opencode_cli_completed: opencodeCliCompleted,
      timestamp: new Date().toISOString(),
    }

    const lastAssistant = String(payload.final_result || "")
    const sig = buildSignature({
      interactionCount: interactions.length,
      finalResultLength: lastAssistant.length,
      lastTs,
      traceCompletedAt: payload.trace_completed_at,
      cliCompleted: payload.opencode_cli_completed,
      toolCallCount: derived.tool_call_count,
      tokens: derived.tokens,
      recordCount: subtreeRecordCount(state, rootSid),
      // 已结束的会话回到旧的 5 段式指纹：单调量只在"进行中"才需要。否则一条已完成的
      // trace 只要 spool 里再落进任何杂事件（recordCount+1）就会重传，而它带着
      // trace_completed_at，服务端会再跑一整轮 LLM 分析。
      completed: Boolean(payload.trace_completed_at) || Boolean(payload.opencode_cli_completed),
    })
    appendUploaderLog(
      `session.prepare task_id=${rootSid} interactions=${interactions.length} query=${String(query).slice(0, 120).replace(/\s+/g, " ")} ` +
      `traceCompletedAt=${payload.trace_completed_at || "(none)"} cliCompleted=${payload.opencode_cli_completed ? "1" : "0"} sig=${sig}`,
    )

    // 账号级时间门: session 最后活动时间早于本账号安装时间(uploadSinceMs)就 skip,
    // 防止切账号后历史 trace 被当前 key 回放。写入 checkpoint 以免每次扫描重复评估。
    // 仅在能解析出活动时间(activityMs>0)时启用门, 解析不到时不拦截、走正常上传, 避免误杀。
    const activityMs = Math.max(lastTs, idleMs)
    if (uploadSinceMs > 0 && activityMs > 0 && activityMs < uploadSinceMs) {
      appendUploaderLog(
        `session.skip before-upload-since task_id=${rootSid} activityMs=${activityMs} sinceMs=${uploadSinceMs} sig=${sig}`,
      )
      ckpt[rootSid] = sig
      saveCheckpoint(checkpointFile, ckpt)
      continue
    }

    // 强推信号之前只绕过 fastSkip，到这里照样被 checkpoint 拦掉，Ctrl+C 兜底和手动
    // 排障都推不上去。这里放行，但**只对指定 session**——FORCE=1 是进程级的，如果让它
    // 绕过所有 session 的 checkpoint，shutdown 那一次强推会把 spool 里保留期内的所有
    // 历史会话重传一遍，并在服务端触发一整轮 LLM 分析。
    if (!forceSessions.has(rootSid) && isSignatureUnchanged(ckpt[rootSid], sig)) {
      appendUploaderLog(`session.skip checkpoint task_id=${rootSid} sig=${sig} prevSig=${ckpt[rootSid]}`)
      // 老格式 checkpoint 原地升级成新格式（见 isSignatureUnchanged 的注释）。
      if (ckpt[rootSid] !== sig) {
        ckpt[rootSid] = sig
        saveCheckpoint(checkpointFile, ckpt)
        appendUploaderLog(`session.checkpointUpgraded task_id=${rootSid} sig=${sig}`)
      }
      continue
    }

    const res = await postJson(host, apiKey, payload)
    if (res.ok) {
      ckpt[rootSid] = sig
      saveCheckpoint(checkpointFile, ckpt)
      appendUploaderLog(`session.uploaded task_id=${rootSid} status=${res.status} sig=${sig}`)
    } else {
      appendUploaderLog(
        `session.uploadFailed task_id=${rootSid} status=${res.status} body=${String(res.body || "").slice(0, 1000) || "(empty)"}`,
      )
    }
  }

  // Record that we've scanned up to this mtime. Next invocation will short-circuit
  // unless a JSONL file has been modified after this point.
  if (newestMtime > 0) {
    ckpt.__lastScanMtime = newestMtime
    saveCheckpoint(checkpointFile, ckpt)
    appendUploaderLog(`main.checkpointUpdated lastScanMtime=${newestMtime}`)
  }
}

export {
  buildMessagesForSession,
  buildSignature,
  buildState,
  getRequestOptions,
  findShadowedEnvKeys,
  describeShadowedEnv,
  collectSessionSubtree,
  isRoundCompleted,
  isSignatureUnchanged,
  subtreeRecordCount,
  deriveFields,
  extractSessionIdFromText,
  extractTaskChildSessionId,
  getSessionInfoFromEvent,
  mergeGraph,
}

if (process.env.AGENT_INSIGHT_UPLOADER_NO_MAIN !== "1") {
  main().catch((err) => {
    // 不能 silent exit——之前 spread 大数组爆栈导致整条 trace 链路停摆几小时，
    // 日志里只有 plugin 写的 kickUploader 头，看不到任何 uploader 自身报错。
    // stderr 会被 plugin 那边 dup 到 ~/.agent-insight/logs/opencode_uploader.log，
    // 失败也好让运维一眼看到。仍然 exit(0)：失败的 batch 下次轮询继续，无需 retry。
    try {
      const msg = err && err.stack ? err.stack : String(err)
      appendUploaderLog(`main.error ${msg}`)
      process.stderr.write(`[uploader main err] ${msg}\n`)
    } catch {}
    process.exit(0)
  })
}
