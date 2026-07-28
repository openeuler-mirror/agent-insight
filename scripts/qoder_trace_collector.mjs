import crypto from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const DEFAULT_MAX_CONTENT_CHARS = 2000
const SECRET_KEY = /(^|[._-])(api[_-]?key|access[_-]?key|secret|token|password|passwd|authorization|cookie|private[_-]?key)($|[._-])/i

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function toMs(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  const parsed = Date.parse(String(value || ""))
  return Number.isFinite(parsed) ? parsed : fallback
}

function firstNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue
    const number = Number(value)
    if (Number.isFinite(number) && number >= 0) return number
  }
  return 0
}

function toNano(ms) {
  return (BigInt(Math.max(0, Math.trunc(ms))) * 1_000_000n).toString()
}

function stableHex(parts, length) {
  return crypto.createHash("sha256").update(parts.map((part) => String(part ?? "")).join("\0")).digest("hex").slice(0, length)
}

function truncateText(value, maxChars = DEFAULT_MAX_CONTENT_CHARS) {
  const text = String(value ?? "")
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…[truncated ${text.length - maxChars} chars]`
}

function redactText(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/\b(?:LTAI|AKID)[A-Za-z0-9]{12,}\b/g, "<redacted-access-key>")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "<redacted-api-key>")
}

export function redactAndTruncate(value, maxChars = DEFAULT_MAX_CONTENT_CHARS, key = "") {
  if (SECRET_KEY.test(key)) return "<redacted>"
  if (value === null || value === undefined) return value
  if (typeof value === "string") return truncateText(redactText(value), maxChars)
  if (typeof value !== "object") return value
  if (Array.isArray(value)) return value.map((item) => redactAndTruncate(item, maxChars))
  const out = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    out[childKey] = redactAndTruncate(childValue, maxChars, childKey)
  }
  return out
}

function safeJson(value, maxChars) {
  try {
    return truncateText(JSON.stringify(redactAndTruncate(value, maxChars)), maxChars)
  } catch {
    return truncateText(redactText(String(value ?? "")), maxChars)
  }
}

function parseJsonValue(value) {
  if (typeof value !== "string") return value
  const trimmed = value.trim()
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

export function resolveQoderLocalTokenDatabase(product, options = {}) {
  const normalizedProduct = normalizeQoderProduct(product)
  if (options.databasePath) return path.resolve(options.databasePath)
  const homeDir = options.homeDir || os.homedir()
  if (normalizedProduct === "jetbrains") {
    return path.join(homeDir, ".qoder", "shared_client", "cache", "db", "local.db")
  }
  if (normalizedProduct !== "desktop") return undefined
  const platform = options.platform || process.platform
  if (platform === "win32") {
    const appDataDir = options.appDataDir || process.env.APPDATA || path.join(homeDir, "AppData", "Roaming")
    return path.join(appDataDir, "QoderCN", "SharedClientCache", "cache", "db", "local.db")
  }
  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "QoderCN", "SharedClientCache", "cache", "db", "local.db")
  }
  const configDir = options.configDir || process.env.XDG_CONFIG_HOME || path.join(homeDir, ".config")
  return path.join(configDir, "QoderCN", "SharedClientCache", "cache", "db", "local.db")
}

function parseLocalTokenRow(row) {
  const tokenInfo = asObject(parseJsonValue(row?.token_info))
  const modelInfo = asObject(parseJsonValue(row?.model_info))
  const inputTokens = firstNumber(tokenInfo.prompt_tokens, tokenInfo.input_tokens)
  const outputTokens = firstNumber(tokenInfo.completion_tokens, tokenInfo.output_tokens)
  const cacheReadTokens = firstNumber(tokenInfo.cached_tokens, tokenInfo.cache_read_input_tokens)
  if (inputTokens + outputTokens + cacheReadTokens <= 0) return undefined
  return {
    messageId: firstString(row?.id),
    sessionId: firstString(row?.session_id),
    requestId: firstString(row?.request_id),
    timestampMs: firstNumber(row?.gmt_create),
    model: firstString(modelInfo.model_key, modelInfo.model, modelInfo.name),
    inputTokens,
    outputTokens,
    reasoningTokens: firstNumber(tokenInfo.reasoning_tokens),
    cacheReadTokens,
    cacheWriteTokens: firstNumber(tokenInfo.cache_creation_input_tokens, tokenInfo.cache_write_tokens),
  }
}

export async function readQoderLocalTokenUsage(product, sessionId, options = {}) {
  const normalizedProduct = normalizeQoderProduct(product)
  if (!sessionId || !["desktop", "jetbrains"].includes(normalizedProduct)) return []
  const databasePath = resolveQoderLocalTokenDatabase(normalizedProduct, options)
  if (!databasePath || !fs.existsSync(databasePath)) return []
  let sqlite = options.sqliteModule
  if (!sqlite) {
    try {
      sqlite = await import("node:sqlite")
    } catch {
      return []
    }
  }
  let database
  try {
    database = new sqlite.DatabaseSync(databasePath, { readOnly: true })
    database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=250")
    const columns = new Set(database.prepare("SELECT name FROM pragma_table_info('chat_message')").all().map((row) => row.name))
    if (!["id", "session_id", "request_id", "role", "token_info", "model_info", "gmt_create"].every((name) => columns.has(name))) {
      return []
    }
    return database.prepare(`
      SELECT id, session_id, request_id, token_info, model_info, gmt_create
      FROM chat_message
      WHERE session_id = ? AND role = 'assistant'
      ORDER BY gmt_create, id
    `).all(sessionId).map(parseLocalTokenRow).filter(Boolean)
  } catch {
    return []
  } finally {
    try { database?.close() } catch {}
  }
}

export function parseJsonLines(text) {
  const records = []
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {}
  }
  return records
}

export function normalizeQoderTranscriptRecords(records, sessionId, localTokenUsage = []) {
  const source = Array.isArray(records) ? records : []
  const assistantCount = source.filter((record) =>
    !record?.type && String(record?.role || "").toLowerCase() === "assistant").length
  const assistantTimestamps = (Array.isArray(localTokenUsage) ? localTokenUsage : [])
    .map((usage) => Number(usage?.timestampMs))
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0)
    .sort((a, b) => a - b)
    .slice(-assistantCount)
  let assistantIndex = 0
  return source.map((record) => {
    if (record?.type) return record
    const role = String(record?.role || "").toLowerCase()
    if (!["user", "assistant"].includes(role)) return record
    const timestamp = role === "assistant" ? assistantTimestamps[assistantIndex++] : undefined
    return {
      ...record,
      type: role,
      sessionId: firstString(record?.sessionId, record?.session_id, sessionId),
      timestamp: firstString(record?.timestamp, timestamp ? new Date(timestamp).toISOString() : undefined),
      message: asObject(record?.message),
    }
  })
}

function normalizeHookEntries(entries) {
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    if (entry?.event && typeof entry.event === "object") {
      return { capturedAt: firstString(entry.capturedAt, entry.captured_at), event: entry.event }
    }
    return { capturedAt: firstString(entry?.capturedAt, entry?.captured_at), event: asObject(entry) }
  })
}

function messageText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (typeof part === "string") return part
      if (part?.type === "text") return String(part.text || "")
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function skillManifestVersion(filePath) {
  if (typeof filePath !== "string" || !/[\\/]\.(?:qoder|lingma)[\\/]skills[\\/][^\\/]+[\\/]SKILL\.md$/i.test(filePath)) {
    return undefined
  }
  try {
    const source = fs.readFileSync(filePath, "utf8")
    const frontmatter = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
    const raw = frontmatter?.match(/^version\s*:\s*["']?([^"'#\r\n]+)["']?\s*$/im)?.[1]?.trim()
    if (!raw) return undefined
    const numeric = Number(raw)
    return Number.isFinite(numeric) ? numeric : raw
  } catch {
    return undefined
  }
}

function skillSlashCommand(record) {
  let name
  let filePath
  let rawVersion
  if (record?.type === "session_meta" && record?.data?.meta_type === "slash_command") {
    const content = asObject(record.data.content)
    if (String(content.type || "").toLowerCase() !== "skill") return undefined
    name = firstString(content.name, content.skill, content.skill_name, content.skillName)
    filePath = firstString(content.filePath, content.file_path)
    rawVersion = content.version
  } else if (record?.type === "system" && record?.subtype === "informational") {
    name = String(record.content || "").match(/^Skill\s+\*\*([A-Za-z0-9][A-Za-z0-9._-]*)\*\*\s+activated\.\s*$/i)?.[1]
    if (name && record.cwd) {
      const candidates = [
        path.join(record.cwd, ".qoder", "skills", name, "SKILL.md"),
        path.join(record.cwd, ".lingma", "skills", name, "SKILL.md"),
      ]
      filePath = candidates.find((candidate) => fs.existsSync(candidate))
    }
  } else {
    return undefined
  }
  if (!name) return undefined
  const resolvedVersion = rawVersion ?? skillManifestVersion(filePath)
  const numericVersion = resolvedVersion === undefined || resolvedVersion === null || resolvedVersion === "" ? undefined : Number(resolvedVersion)
  return {
    name,
    version: Number.isFinite(numericVersion) ? numericVersion : resolvedVersion,
    triggerMode: "manual",
    timestampMs: toMs(record.timestamp),
  }
}

function estimationText(value) {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(estimationText).filter(Boolean).join("\n")
  if (typeof value !== "object") return String(value)
  if (value.type === "text" || value.type === "reasoning" || value.type === "thinking") {
    return firstString(value.text, value.reasoning, value.thinking, value.content, "") || ""
  }
  if (value.type === "tool_use") {
    return safeJson({ name: value.name, input: value.input }, Number.MAX_SAFE_INTEGER)
  }
  if (value.type === "tool_result") {
    return estimationText(value.content ?? value.result ?? value.output)
  }
  return safeJson(value, Number.MAX_SAFE_INTEGER)
}

export function estimateQoderVisibleTokens(value) {
  const text = estimationText(value).normalize("NFKC")
  if (!text.trim()) return 0
  const units = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[A-Za-z]+(?:'[A-Za-z]+)?|\d+(?:\.\d+)?|[^\s]/gu) || []
  let count = 0
  for (const unit of units) {
    if (/^[A-Za-z]/.test(unit)) count += Math.max(1, Math.ceil(unit.length / 4))
    else if (/^\d/.test(unit)) count += Math.max(1, Math.ceil(unit.length / 3))
    else count += [...unit].length
  }
  count += Math.ceil((text.match(/\n/g) || []).length / 3)
  return Math.max(1, count)
}

function estimateAssistantUsage(record, transcript) {
  const indexes = Array.isArray(record?._qoderTranscriptIndexes) ? record._qoderTranscriptIndexes : []
  const firstIndex = indexes.length ? Math.min(...indexes) : -1
  if (firstIndex < 0) return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  const visibleContext = transcript.slice(0, firstIndex).filter((item) => item?.message?.content !== undefined)
  const inputTokens = visibleContext.reduce((total, item) => {
    const contentTokens = estimateQoderVisibleTokens(item.message.content)
    return total + contentTokens + (contentTokens > 0 ? 4 : 0)
  }, 0)
  const outputContentTokens = estimateQoderVisibleTokens(record?.message?.content)
  const outputTokens = outputContentTokens + (outputContentTokens > 0 ? 4 : 0)
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
}

function attributeValue(value) {
  if (typeof value === "boolean") return { boolValue: value }
  if (typeof value === "number" && Number.isFinite(value)) return { intValue: String(Math.trunc(value)) }
  return { stringValue: typeof value === "string" ? value : JSON.stringify(value ?? null) }
}

function attributes(values) {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ({ key, value: attributeValue(value) }))
}

function otlpSpan({ traceId, spanId, parentSpanId, name, startMs, endMs, attrs, error = false }) {
  return {
    traceId,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    name,
    kind: 1,
    startTimeUnixNano: toNano(startMs),
    endTimeUnixNano: toNano(Math.max(startMs, endMs)),
    attributes: attributes(attrs),
    status: { code: error ? 2 : 1 },
  }
}

function latestHook(entries, name) {
  return [...entries].reverse().find((entry) => entry.event?.hook_event_name === name)
}

function toolError(event) {
  const response = asObject(event?.tool_response)
  const exitCode = Number(response.exitCode)
  return Boolean(event?.error || response.isError || (Number.isFinite(exitCode) && exitCode !== 0))
}

function diagnosticModelPairs(records) {
  const starts = new Map()
  const pairs = []
  for (const record of Array.isArray(records) ? records : []) {
    if (record?.type === "model.request.started" && record.request_id) starts.set(record.request_id, record)
    if (record?.type !== "model.response.completed") continue
    const start = starts.get(record.request_id)
    const startMs = toMs(start?.ts, toMs(record.ts))
    const endMs = toMs(record.ts, startMs)
    pairs.push({ start, response: record, startMs, endMs })
  }
  return pairs.sort((a, b) => a.startMs - b.startMs)
}

function closestAssistant(records, targetMs, claimed) {
  let best
  let bestDistance = Number.POSITIVE_INFINITY
  for (const record of records) {
    if (claimed.has(record)) continue
    const distance = Math.abs(toMs(record.timestamp) - targetMs)
    if (distance < bestDistance) {
      best = record
      bestDistance = distance
    }
  }
  if (best && bestDistance <= 2000) {
    claimed.add(best)
    return best
  }
  return undefined
}

function mergeAssistantRecords(records) {
  const merged = []
  const byMessageId = new Map()
  let fallbackTurn = 0
  let activeFallbackKey
  let lastUserTimestamp
  for (const [recordIndex, record] of (Array.isArray(records) ? records : []).entries()) {
    if (record?.type === "user") {
      lastUserTimestamp = record.timestamp
      activeFallbackKey = undefined
      continue
    }
    if (record?.type !== "assistant") continue
    const message = asObject(record?.message)
    const messageId = firstString(message.id)
    if (!messageId && !activeFallbackKey) activeFallbackKey = `turn:${fallbackTurn++}`
    const key = messageId ? `message:${messageId}` : activeFallbackKey
    const content = Array.isArray(message.content) ? message.content : message.content == null ? [] : [message.content]
    const existing = byMessageId.get(key)
    if (!existing) {
      const copy = {
        ...record,
        _qoderTurnStartTimestamp: lastUserTimestamp,
        _qoderTranscriptIndexes: [recordIndex],
        message: { ...message, content: [...content] },
      }
      byMessageId.set(key, copy)
      merged.push(copy)
      continue
    }
    existing.message = { ...existing.message, ...message, content: [...existing.message.content, ...content] }
    existing._qoderTranscriptIndexes.push(recordIndex)
    if (toMs(record?.timestamp) >= toMs(existing.timestamp)) existing.timestamp = record.timestamp
  }
  return merged
}

function normalizeQoderProduct(value) {
  const product = String(value || "").trim().toLowerCase()
  if (product.includes("work")) return "work"
  if (product.includes("jetbrains") || product === "jb") return "jetbrains"
  if (product.includes("desktop") || product === "ide") return "desktop"
  return "cli"
}

function qoderAgentName(product) {
  if (product === "desktop") return "Qoder CN Desktop"
  if (product === "jetbrains") return "Qoder for JetBrains"
  if (product === "work") return "Qoder Work"
  return "Qoder CN CLI"
}

function qoderServiceName(product) {
  if (product === "desktop") return "qoder-cn-desktop"
  if (product === "cli") return "qoder-cn-cli"
  return `qoder-${product}`
}

function subagentIdentity(event) {
  return firstString(event.agent_id, event.subagent_id, event.child_session_id, event.subagent_session_id)
}

function subagentParentIdentity(event, rootSessionId) {
  const id = firstString(
    event.parent_agent_id,
    event.parent_subagent_id,
    event.parent_child_session_id,
    event.parent_session_id,
  )
  return id && id !== rootSessionId ? id : undefined
}

function toolOwnerIdentity(event, rootSessionId) {
  const id = firstString(
    event.owner_agent_id,
    event.current_agent_id,
    event.agent_id,
    event.subagent_id,
    event.agent_session_id,
    event.subagent_session_id,
  )
  return id && id !== rootSessionId ? id : undefined
}

function mcpToolIdentity(event, qualifiedToolName, toolInput) {
  const context = asObject(event?.mcp_context)
  const input = asObject(toolInput ?? event?.tool_input)
  const nested = asObject(input.mcp)
  const wrapperName = String(qualifiedToolName || "")
  const normalizedWrapperName = wrapperName.toLowerCase()
  // QoderWork CN lazily exposes MCP tools through qw_mcp_get/qw_mcp_call.
  // The schema lookup is ordinary infrastructure; only qw_mcp_call executes
  // the target MCP tool and should be represented as an MCP invocation.
  if (normalizedWrapperName.endsWith("__qw_mcp_get") || normalizedWrapperName.endsWith("__qw_mcp_list")) {
    return undefined
  }
  const rawToolName = firstString(
    context.tool_name,
    context.toolName,
    input.tool_name,
    input.toolName,
    nested.tool_name,
    nested.toolName,
  )
  const match = /^mcp__(.+?)__(.+)$/.exec(String(rawToolName || ""))
    || /^mcp__(.+?)__(.+)$/.exec(wrapperName)
  const explicitServerName = firstString(
    context.server_name,
    context.serverName,
    input.server_name,
    input.serverName,
    nested.server_name,
    nested.serverName,
  )
  const serverName = firstString(explicitServerName, match?.[1])
  const toolName = firstString(match?.[2], rawToolName)
  const args = input.arguments ?? nested.arguments ?? input.params ?? nested.params ?? input
  return serverName && toolName ? { serverName, toolName, arguments: args } : undefined
}

function connectorToolIdentity(mcpTool) {
  if (!mcpTool?.serverName?.startsWith("builtin_")) return undefined
  const connectorName = mcpTool.serverName.slice("builtin_".length)
  return connectorName ? { connectorName, toolName: mcpTool.toolName } : undefined
}

/**
 * @param {{
 *   hookEvents?: Array<any>,
 *   transcriptRecords?: Array<any>,
 *   diagnosticRecords?: Array<any>,
 *   localTokenUsage?: Array<any>,
 *   expertAgents?: Array<any>,
 *   product?: string,
 *   estimateVisibleTokens?: boolean,
 *   maxContentChars?: number,
 *   capturedAt?: string
 * }} input
 */
export function buildQoderOtlpPayload({
  hookEvents = [],
  transcriptRecords = [],
  diagnosticRecords = [],
  localTokenUsage = [],
  expertAgents = [],
  product,
  estimateVisibleTokens = false,
  maxContentChars = DEFAULT_MAX_CONTENT_CHARS,
  capturedAt,
} = {}) {
  const hooks = normalizeHookEntries(hookEvents)
  const stop = latestHook(hooks, "Stop") || latestHook(hooks, "SessionEnd") || latestHook(hooks, "StopFailure")
  const prompt = latestHook(hooks, "UserPromptSubmit")
  const sessionId = firstString(stop?.event?.session_id, prompt?.event?.session_id, hooks[0]?.event?.session_id)
  if (!sessionId) throw new Error("Qoder hook data is missing session_id")

  const allTranscript = (Array.isArray(transcriptRecords) ? transcriptRecords : []).filter((record) => record?.sessionId === sessionId || !record?.sessionId)
  const promptCapturedMs = toMs(prompt?.capturedAt)
  const allSkillCommands = allTranscript
    .map((record) => ({ record, command: skillSlashCommand(record) }))
    .filter((item) => item.command)
  const skillCommands = promptCapturedMs
    ? allSkillCommands.filter((item) => Math.abs(item.command.timestampMs - promptCapturedMs) <= 10_000)
    : allSkillCommands.slice(-1)
  const primarySkillCommand = skillCommands.at(-1)?.command
  const allUserRecords = allTranscript.filter((record) => record?.type === "user" && typeof record?.message?.content === "string" && record?.origin?.kind !== "hook")
  const promptText = firstString(prompt?.event?.prompt)
  const currentUser = [...allUserRecords].reverse().find((record) => !promptText || record.message.content === promptText)
    || [...allUserRecords].reverse()[0]
  const currentTurnStartMs = toMs(currentUser?.timestamp, toMs(prompt?.capturedAt))
  // Qoder CN Desktop can reuse one session id across several chat submissions.
  // A completed snapshot must contain only the current user turn, otherwise old
  // LLM/tool spans inflate duration and counts in the latest execution record.
  const transcript = currentTurnStartMs
    ? allTranscript.filter((record) => toMs(record?.timestamp, currentTurnStartMs) >= currentTurnStartMs)
    : allTranscript
  const userRecords = transcript.filter((record) => record?.type === "user" && typeof record?.message?.content === "string" && record?.origin?.kind !== "hook")
  // Qoder writes one transcript row per streamed content block. Rows from the
  // same model response share message.id and must be treated as one LLM turn;
  // otherwise later tool/text blocks create duplicate zero-duration spans.
  const assistantRecords = mergeAssistantRecords(transcript)
  const query = firstString(
    prompt?.event?.prompt,
    [...userRecords].reverse()[0]?.message?.content,
    primarySkillCommand ? `/${primarySkillCommand.name}` : undefined,
    "Qoder session",
  )
  const finalResult = firstString(stop?.event?.last_assistant_message, messageText([...assistantRecords].reverse()[0]?.message?.content), "")
  const startMs = toMs(prompt?.capturedAt, toMs([...userRecords].reverse()[0]?.timestamp, Date.now()))
  const endMs = toMs(stop?.capturedAt, toMs([...assistantRecords].reverse()[0]?.timestamp, startMs))
  const snapshotId = stableHex([sessionId, stop?.capturedAt, stop?.event?.parent_request_set_id, finalResult], 16)
  const traceId = stableHex(["qoder", sessionId], 32)
  const rootSpanId = stableHex(["qoder", sessionId, snapshotId, "agent"], 16)
  const productInfo = asObject(stop?.event?.parent_business_info)
  const productName = normalizeQoderProduct(firstString(product, productInfo.product))
  const agentName = qoderAgentName(productName)
  const sessionMeta = [...allTranscript].reverse().find((record) =>
    record?.type === "session_meta"
    && record?.data?.meta_type === "session_info"
    && (!currentTurnStartMs || toMs(record?.timestamp, currentTurnStartMs) <= currentTurnStartMs))
  const sessionMode = firstString(sessionMeta?.data?.content?.mode, stop?.event?.mode, prompt?.event?.mode)
  const isQuest = ["plan", "quest"].includes(String(sessionMode || "").toLowerCase())
  const expertsMode = String(sessionMode || "").toLowerCase() === "experts"
  const expertList = Array.isArray(expertAgents) ? expertAgents : []
  // Quest planning can launch an Experts team without changing the session mode
  // away from `plan`. Treat concrete expert records as stronger evidence than the
  // top-level mode so a single session can retain both Quest and Expert traces.
  const isExperts = expertsMode || expertList.length > 0
  const turnRecords = (Array.isArray(diagnosticRecords) ? diagnosticRecords : []).filter((record) => record?.type === "turn.started")
  const selectedModel = firstString(
    stop?.event?.model,
    prompt?.event?.model,
    [...turnRecords].reverse()[0]?.data?.model,
    [...(Array.isArray(localTokenUsage) ? localTokenUsage : [])].reverse()[0]?.model,
    [...assistantRecords].reverse()[0]?.message?.model,
    "unknown",
  )
  const common = {
    "qoder.snapshot.id": snapshotId,
    "qoder.snapshot.completed_at_ms": endMs,
    "qoder.session.id": sessionId,
  }

  const spans = [otlpSpan({
    traceId,
    spanId: rootSpanId,
    name: "qoder.agent",
    startMs,
    endMs,
    attrs: {
      ...common,
      "openinference.span.kind": "AGENT",
      "qoder.span.type": "agent",
      "qoder.product": productName,
      "qoder.distribution": "cn",
      "qoder.agent.name": agentName,
      "qoder.session.mode": sessionMode,
      "qoder.quest.enabled": isQuest,
      "qoder.experts.enabled": isExperts,
      "qoder.version": firstString(productInfo.version, allTranscript.find((record) => record?.version)?.version),
      "qoder.trace.completed": Boolean(stop),
      "gen_ai.system": "qoder",
      "gen_ai.request.model": selectedModel,
      "gen_ai.prompt": truncateText(redactText(query), maxContentChars),
      "gen_ai.completion": truncateText(redactText(finalResult), maxContentChars),
      "input.value": truncateText(redactText(query), maxContentChars),
      "output.value": truncateText(redactText(finalResult), maxContentChars),
    },
  })]

  const claimedAssistants = new Set()
  const localUsageByAssistant = new Map()
  const claimedLocalAssistants = new Set()
  const currentLocalUsage = (Array.isArray(localTokenUsage) ? localTokenUsage : [])
    .filter((usage) => (!currentTurnStartMs || Number(usage?.timestampMs) >= currentTurnStartMs - 2_000)
      && (!endMs || Number(usage?.timestampMs) <= endMs + 5_000))
    .sort((a, b) => Number(a?.timestampMs) - Number(b?.timestampMs))
  for (const usage of currentLocalUsage) {
    const record = closestAssistant(assistantRecords, Number(usage?.timestampMs), claimedLocalAssistants)
    if (record) localUsageByAssistant.set(record, usage)
  }
  const llmSpanByToolId = new Map()
  const assistantSpanByRecord = new Map()
  const modelPairs = diagnosticModelPairs(diagnosticRecords)
  const appendLlmSpan = ({ record, pair, localUsage: explicitLocalUsage, localStartMs, index }) => {
    const localUsage = explicitLocalUsage || (record ? localUsageByAssistant.get(record) : undefined)
    const requestId = firstString(pair?.response?.request_id, localUsage?.requestId, record?.message?.id, record?.uuid, `llm-${index}`)
    const spanIdentity = firstString(pair?.response?.request_id, localUsage?.messageId, record?.message?.id, record?.uuid, `llm-${index}`)
    const llmSpanId = stableHex([sessionId, snapshotId, "llm", spanIdentity], 16)
    const llmStart = pair?.startMs ?? localStartMs ?? toMs(record?._qoderTurnStartTimestamp, toMs(record?.timestamp, startMs))
    const llmEnd = pair?.endMs ?? (Number(localUsage?.timestampMs) || toMs(record?.timestamp, llmStart))
    const responseData = asObject(pair?.response?.data)
    const model = firstString(responseData.model, localUsage?.model, record?.message?.model, selectedModel, "unknown")
    const output = messageText(record?.message?.content)
    const diagnosticInputTokens = Number(responseData.input_tokens) || 0
    const diagnosticOutputTokens = Number(responseData.output_tokens) || 0
    const diagnosticReasoningTokens = Number(responseData.reasoning_tokens) || 0
    const diagnosticCacheReadTokens = Number(responseData.cache_read_input_tokens) || 0
    const diagnosticCacheWriteTokens = Number(responseData.cache_creation_input_tokens) || 0
    const diagnosticUsageAvailable = diagnosticInputTokens + diagnosticOutputTokens + diagnosticReasoningTokens + diagnosticCacheReadTokens + diagnosticCacheWriteTokens > 0
    const localUsageAvailable = Boolean(!diagnosticUsageAvailable && localUsage
      && localUsage.inputTokens + localUsage.outputTokens + localUsage.reasoningTokens + localUsage.cacheReadTokens + localUsage.cacheWriteTokens > 0)
    const exactUsageAvailable = diagnosticUsageAvailable || localUsageAvailable
    const inputTokens = diagnosticUsageAvailable ? diagnosticInputTokens : localUsageAvailable ? localUsage.inputTokens : 0
    const outputTokens = diagnosticUsageAvailable ? diagnosticOutputTokens : localUsageAvailable ? localUsage.outputTokens : 0
    const reasoningTokens = diagnosticUsageAvailable ? diagnosticReasoningTokens : localUsageAvailable ? localUsage.reasoningTokens : 0
    const cacheReadTokens = diagnosticUsageAvailable ? diagnosticCacheReadTokens : localUsageAvailable ? localUsage.cacheReadTokens : 0
    const cacheWriteTokens = diagnosticUsageAvailable ? diagnosticCacheWriteTokens : localUsageAvailable ? localUsage.cacheWriteTokens : 0
    const estimateUsage = estimateVisibleTokens && !exactUsageAvailable && (productName === "desktop" || productName === "jetbrains") && record
      ? estimateAssistantUsage(record, transcript)
      : { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    const estimatedUsageAvailable = estimateUsage.totalTokens > 0
    const requestData = asObject(pair?.start?.data)
    const provider = firstString(responseData.provider, responseData.provider_id, requestData.provider, requestData.provider_id, "qoder-cn")
    spans.push(otlpSpan({
      traceId,
      spanId: llmSpanId,
      parentSpanId: rootSpanId,
      name: `qoder.llm.${model}`,
      startMs: llmStart,
      endMs: llmEnd,
      attrs: {
        ...common,
        "openinference.span.kind": "LLM",
        "qoder.span.type": "llm",
        "qoder.llm.request_id": requestId,
        "qoder.llm.turn_id": firstString(pair?.response?.turn_id),
        "qoder.token_usage.available": exactUsageAvailable,
        "qoder.token_usage.estimated": estimatedUsageAvailable,
        "qoder.token_usage.source": exactUsageAvailable
          ? diagnosticUsageAvailable ? "diagnostics" : "local_sqlite"
          : estimatedUsageAvailable ? "local_visible_transcript" : "unavailable",
        "qoder.token_usage.scope": estimatedUsageAvailable ? "visible_transcript" : undefined,
        "qoder.token_usage.missing_context": estimatedUsageAvailable,
        "qoder.token_usage.estimator": estimatedUsageAvailable ? "visible_transcript_heuristic_v1" : undefined,
        "qoder.token_usage.estimated_input_tokens": estimatedUsageAvailable ? estimateUsage.inputTokens : undefined,
        "qoder.token_usage.estimated_output_tokens": estimatedUsageAvailable ? estimateUsage.outputTokens : undefined,
        "qoder.token_usage.estimated_total_tokens": estimatedUsageAvailable ? estimateUsage.totalTokens : undefined,
        "gen_ai.system": provider,
        "gen_ai.request.model": model,
        "gen_ai.response.finish_reasons": firstString(responseData.stop_reason),
        "gen_ai.usage.input_tokens": inputTokens,
        "gen_ai.usage.output_tokens": outputTokens,
        "gen_ai.usage.reasoning_tokens": reasoningTokens,
        "qoder.cache_read_input_tokens": cacheReadTokens,
        "qoder.cache_creation_input_tokens": cacheWriteTokens,
        "input.value": index === 0 ? truncateText(redactText(query), maxContentChars) : "",
        "output.value": truncateText(redactText(output), maxContentChars),
      },
    }))
    if (record) {
      assistantSpanByRecord.set(record, llmSpanId)
      for (const part of Array.isArray(record?.message?.content) ? record.message.content : []) {
        if (part?.type === "tool_use" && part.id) llmSpanByToolId.set(String(part.id), llmSpanId)
      }
    }
  }

  if (modelPairs.length) {
    modelPairs.forEach((pair, index) => {
      const record = closestAssistant(assistantRecords, pair.endMs, claimedAssistants)
      appendLlmSpan({ record, pair, index })
    })
  } else if (currentLocalUsage.length) {
    let previousEndMs = startMs
    currentLocalUsage.forEach((usage, index) => {
      const record = [...localUsageByAssistant].find(([, candidate]) => candidate === usage)?.[0]
      if (record) claimedAssistants.add(record)
      appendLlmSpan({ record, localUsage: usage, localStartMs: previousEndMs, index })
      previousEndMs = Number(usage?.timestampMs) || previousEndMs
    })
  }
  assistantRecords.filter((record) => !claimedAssistants.has(record)).forEach((record, index) => {
    appendLlmSpan({ record, index: Math.max(modelPairs.length, currentLocalUsage.length) + index })
  })

  const preTools = new Map()
  const postTools = new Map()
  for (const entry of hooks) {
    const event = entry.event
    const id = firstString(event?.tool_use_id)
    if (!id) continue
    if (event.hook_event_name === "PreToolUse") preTools.set(id, entry)
    if (event.hook_event_name === "PostToolUse" || event.hook_event_name === "PostToolUseFailure") postTools.set(id, entry)
  }
  const transcriptTools = new Map()
  for (const record of assistantRecords) {
    for (const part of Array.isArray(record?.message?.content) ? record.message.content : []) {
      if (part?.type === "tool_use" && part.id) transcriptTools.set(String(part.id), { use: part, record })
    }
  }
  for (const record of transcript.filter((item) => item?.type === "user" && Array.isArray(item?.message?.content))) {
    for (const part of record.message.content) {
      if (part?.type !== "tool_result" || !part.tool_use_id) continue
      const current = transcriptTools.get(String(part.tool_use_id)) || {}
      transcriptTools.set(String(part.tool_use_id), { ...current, result: part, resultRecord: record, toolUseResult: record.toolUseResult })
    }
  }
  const explicitSkillNames = new Set()
  for (const tool of transcriptTools.values()) {
    if (String(tool.use?.name || "").toLowerCase() !== "skill") continue
    const input = asObject(tool.use?.input)
    const name = firstString(input.skill, input.name, input.skill_name, input.skillName)
    if (name) explicitSkillNames.add(name)
  }
  for (const entry of [...preTools.values(), ...postTools.values()]) {
    if (String(entry.event?.tool_name || "").toLowerCase() !== "skill") continue
    const input = asObject(entry.event?.tool_input)
    const name = firstString(input.skill, input.name, input.skill_name, input.skillName)
    if (name) explicitSkillNames.add(name)
  }
  skillCommands.forEach(({ command }, index) => {
    if (explicitSkillNames.has(command.name)) return
    const id = `session-meta-skill-${stableHex([sessionId, command.timestampMs, command.name, index], 16)}`
    const firstAssistant = assistantRecords.find((record) => toMs(record?.timestamp) >= command.timestampMs)
    const parentLlmSpanId = firstAssistant ? assistantSpanByRecord.get(firstAssistant) : undefined
    transcriptTools.set(id, {
      use: {
        type: "tool_use",
        id,
        name: "Skill",
        input: {
          skill: command.name,
          version: command.version,
          triggerMode: command.triggerMode,
          params: { command: `/${command.name}` },
        },
      },
      record: { timestamp: new Date(command.timestampMs || startMs).toISOString() },
      result: { type: "tool_result", tool_use_id: id, content: finalResult },
      resultRecord: { timestamp: new Date(endMs).toISOString() },
      toolUseResult: finalResult,
    })
    if (parentLlmSpanId) llmSpanByToolId.set(id, parentLlmSpanId)
  })
  const spawnedSubagents = new Map()
  const expertByToolId = new Map(expertList
    .filter((expert) => expert?.toolId)
    .map((expert) => [String(expert.toolId), expert]))
  const expertBySessionId = new Map(expertList
    .filter((expert) => expert?.sessionId)
    .map((expert) => [String(expert.sessionId), expert]))
  for (const [id, tool] of transcriptTools) {
    if (String(tool.use?.name || "").toLowerCase() !== "agent") continue
    const input = asObject(tool.use?.input)
    const expert = expertByToolId.get(id)
    const agentName = firstString(expert?.name, input.name, input.subagent_type, input.subagentType, input.agent_type, input.agentType)
    const agentType = firstString(expert?.type, input.subagent_type, input.subagentType, input.agent_type, input.agentType)
    const agentRole = firstString(expert?.role, input.role, input.agent_role, input.agentRole)
    if (!agentName && !agentType) continue
    const output = tool.toolUseResult ?? tool.result?.content ?? ""
    const outputObject = asObject(parseJsonValue(output))
    const outputText = typeof output === "string" ? output : safeJson(output, maxContentChars)
    const launchedAgentId = outputText.match(/\bagentId:\s*([A-Za-z0-9_-]+)/i)?.[1]
    const subagentSessionId = firstString(
      expert?.sessionId,
      outputObject.agentId,
      outputObject.subagent_session_id,
      outputObject.session_id,
      outputObject.agent_id,
      launchedAgentId,
      `${sessionId}:subagent:${id}`,
    )
    spawnedSubagents.set(id, {
      toolId: id,
      sessionId: subagentSessionId,
      agentName: firstString(outputObject.agentType, agentName, agentType),
      agentType: firstString(outputObject.agentType, outputObject.agent_type, agentType),
      agentRole,
      isExpert: Boolean(expert),
      description: firstString(input.description, input.prompt, ""),
      prompt: firstString(input.prompt, input.description, ""),
      result: firstString(expert?.output, outputObject.content, outputObject.result, outputText),
      status: firstString(outputObject.state, outputObject.status),
      transcriptPath: firstString(outputObject.transcriptPath, outputObject.transcript_path),
      startMs: toMs(expert?.startedAt, toMs(preTools.get(id)?.capturedAt, toMs(tool.record?.timestamp, startMs))),
      endMs: toMs(expert?.completedAt, toMs(postTools.get(id)?.capturedAt, toMs(tool.resultRecord?.timestamp, endMs))),
      error: toolError(postTools.get(id)?.event)
        || ["failed", "error", "cancelled"].includes(String(outputObject.state || outputObject.status || "").toLowerCase()),
    })
  }
  const inferSpawnOwner = (input, toolStart) => {
    const candidates = [...spawnedSubagents.values()].filter((spawn) => spawn.startMs <= toolStart && toolStart <= spawn.endMs)
    if (candidates.length === 1) return candidates[0].sessionId
    if (!candidates.length) return undefined
    const inputText = safeJson(input, maxContentChars).toLowerCase()
    const scored = candidates.map((spawn) => {
      const filenames = String(`${spawn.description} ${spawn.prompt}`).toLowerCase().match(/[a-z0-9_.-]+\.[a-z0-9]+/g) || []
      return { spawn, score: filenames.filter((name) => inputText.includes(name)).length }
    }).sort((a, b) => b.score - a.score)
    return scored[0].score > 0 && scored[0].score > (scored[1]?.score || 0) ? scored[0].spawn.sessionId : undefined
  }
  const toolIds = new Set([...preTools.keys(), ...postTools.keys(), ...transcriptTools.keys()])
  for (const id of toolIds) {
    const pre = preTools.get(id)
    const post = postTools.get(id)
    const transcriptTool = transcriptTools.get(id) || {}
    const event = { ...asObject(pre?.event), ...asObject(post?.event) }
    const toolName = firstString(event.tool_name, transcriptTool.use?.name, "tool")
    const input = event.tool_input ?? transcriptTool.use?.input ?? {}
    const output = event.tool_response ?? event.error ?? transcriptTool.toolUseResult ?? transcriptTool.result?.content ?? ""
    const transcriptToolStart = toMs(transcriptTool.record?.timestamp, Number.NaN)
    const transcriptToolEnd = toMs(transcriptTool.resultRecord?.timestamp, Number.NaN)
    const transcriptHasDuration = Number.isFinite(transcriptToolStart)
      && Number.isFinite(transcriptToolEnd)
      && transcriptToolEnd > transcriptToolStart
    const hookToolStart = toMs(pre?.capturedAt, Number.isFinite(transcriptToolStart) ? transcriptToolStart : startMs)
    const hookToolEnd = toMs(post?.capturedAt, Number.isFinite(transcriptToolEnd) ? transcriptToolEnd : hookToolStart)
    const hookHasDuration = hookToolEnd > hookToolStart
    const toolStart = hookHasDuration || !transcriptHasDuration ? hookToolStart : transcriptToolStart
    const toolEnd = hookHasDuration || !transcriptHasDuration ? hookToolEnd : transcriptToolEnd
    const transcriptResult = asObject(transcriptTool.result)
    const transcriptUseResult = asObject(transcriptTool.toolUseResult)
    const error = toolError(event) || Boolean(
      transcriptResult.is_error
      || transcriptResult.isError
      || transcriptUseResult.is_error
      || transcriptUseResult.isError,
    )
    const response = asObject(event.tool_response)
    const spawnedSubagent = spawnedSubagents.get(id)
    const ownerSubagentId = toolOwnerIdentity(event, sessionId)
      || (spawnedSubagent ? undefined : inferSpawnOwner(input, toolStart))
    const mcpTool = mcpToolIdentity(event, toolName, input)
    const connectorTool = connectorToolIdentity(mcpTool)
    const skillTool = String(toolName).toLowerCase() === "skill"
    const skillName = skillTool
      ? firstString(input.skill, input.name, input.skill_name, input.skillName)
      : undefined
    const skillVersion = skillTool ? input.version : undefined
    const skillTriggerMode = skillTool
      ? firstString(input.triggerMode, input.trigger_mode, "automatic")
      : undefined
    const toolArguments = mcpTool?.arguments ?? input
    spans.push(otlpSpan({
      traceId,
      spanId: stableHex([sessionId, snapshotId, "tool", id], 16),
      parentSpanId: llmSpanByToolId.get(id) || rootSpanId,
      name: `qoder.tool.${toolName}`,
      startMs: toolStart,
      endMs: toolEnd,
      error,
      attrs: {
        ...common,
        "openinference.span.kind": "TOOL",
        "qoder.span.type": "tool",
        "qoder.tool.use_id": id,
        "qoder.tool.is_error": error,
        "qoder.tool.exit_code": Number.isFinite(Number(response.exitCode)) ? Number(response.exitCode) : undefined,
        "qoder.tool.type": skillTool ? "skill" : connectorTool ? "connector" : mcpTool ? "mcp" : "tool",
        "qoder.skill.name": skillName,
        "qoder.skill.version": skillVersion,
        "qoder.skill.trigger_mode": skillTriggerMode,
        "qoder.skill.params": skillTool ? safeJson(input.params ?? {}, maxContentChars) : undefined,
        "qoder.skill.result": skillTool ? safeJson(output, maxContentChars) : undefined,
        "mcp.server.name": mcpTool?.serverName,
        "mcp.tool.name": mcpTool?.toolName,
        "qoder.connector.name": connectorTool?.connectorName,
        "qoder.connector.tool.name": connectorTool?.toolName,
        "qoder.subagent.session_id": ownerSubagentId,
        "qoder.subagent.name": ownerSubagentId
          ? firstString(event.agent_type, event.subagent_type, event.agent_name)
          : undefined,
        "qoder.spawned_subagent.session_id": spawnedSubagent?.sessionId,
        "qoder.spawned_subagent.name": spawnedSubagent?.agentName,
        "qoder.spawned_subagent.type": spawnedSubagent?.agentType,
        "qoder.spawned_subagent.role": spawnedSubagent?.agentRole,
        "tool.name": toolName,
        "tool.arguments": safeJson(toolArguments, maxContentChars),
        "tool.status": error ? "error" : "success",
        "input.value": safeJson(input, maxContentChars),
        "output.value": safeJson(output, maxContentChars),
      },
    }))
  }

  if (isQuest) {
    const questTools = [...transcriptTools.entries()]
      .map(([id, value]) => ({ id, ...value }))
      .filter((item) => ["creategoal", "updategoal", "todowrite"].includes(String(item.use?.name || "").toLowerCase()))
      .sort((a, b) => toMs(a.record?.timestamp, startMs) - toMs(b.record?.timestamp, startMs))
    const createGoal = questTools.find((item) => String(item.use?.name || "").toLowerCase() === "creategoal")
    const goalUpdates = questTools.filter((item) => String(item.use?.name || "").toLowerCase() === "updategoal")
    const todoUpdates = questTools.filter((item) => String(item.use?.name || "").toLowerCase() === "todowrite")
    if (createGoal || todoUpdates.length) {
      const createInput = asObject(createGoal?.use?.input)
      const createOutput = parseJsonValue(createGoal?.result?.content ?? createGoal?.toolUseResult)
      const createResult = asObject(createOutput)
      const lastGoalUpdate = goalUpdates.at(-1)
      const lastGoalInput = asObject(lastGoalUpdate?.use?.input)
      const goalId = firstString(createResult.goalId, createResult.goal_id, `${sessionId}:quest`)
      const goalStatus = firstString(lastGoalInput.status, createResult.status, stop ? "complete" : "active")
      const goalStart = toMs(createGoal?.record?.timestamp, toMs(todoUpdates[0]?.record?.timestamp, startMs))
      const goalEnd = toMs(
        lastGoalUpdate?.resultRecord?.timestamp,
        toMs(todoUpdates.at(-1)?.resultRecord?.timestamp, endMs),
      )
      const goalSpanId = stableHex([sessionId, snapshotId, "quest", goalId], 16)
      spans.push(otlpSpan({
        traceId,
        spanId: goalSpanId,
        parentSpanId: rootSpanId,
        name: "qoder.quest.goal",
        startMs: goalStart,
        endMs: goalEnd,
        error: ["failed", "error", "cancelled"].includes(String(goalStatus).toLowerCase()),
        attrs: {
          ...common,
          "openinference.span.kind": "CHAIN",
          "qoder.span.type": "quest",
          "qoder.quest.kind": "goal",
          "qoder.quest.mode": sessionMode,
          "qoder.quest.goal_id": goalId,
          "qoder.quest.objective": firstString(createInput.objective, query),
          "qoder.quest.status": goalStatus,
          "input.value": truncateText(redactText(firstString(createInput.objective, query)), maxContentChars),
          "output.value": truncateText(redactText(firstString(lastGoalUpdate?.result?.content, finalResult)), maxContentChars),
        },
      }))

      const steps = new Map()
      for (const update of todoUpdates) {
        const updateMs = toMs(update.record?.timestamp, goalStart)
        const resultMs = toMs(update.resultRecord?.timestamp, updateMs)
        for (const todo of Array.isArray(update.use?.input?.todos) ? update.use.input.todos : []) {
          const id = firstString(todo?.id, String(steps.size + 1))
          const current = steps.get(id) || { id, firstMs: updateMs }
          current.content = firstString(todo?.content, current.content, `Quest step ${id}`)
          current.status = firstString(todo?.status, current.status, "PENDING")
          current.firstMs = Math.min(current.firstMs, updateMs)
          if (["IN_PROGRESS", "RUNNING"].includes(String(todo?.status || "").toUpperCase())) current.startedMs ??= updateMs
          if (["COMPLETE", "COMPLETED", "FAILED", "CANCELLED"].includes(String(todo?.status || "").toUpperCase())) current.completedMs = resultMs
          steps.set(id, current)
        }
      }
      for (const step of steps.values()) {
        const stepStatus = String(step.status || "PENDING")
        spans.push(otlpSpan({
          traceId,
          spanId: stableHex([sessionId, snapshotId, "quest-step", step.id], 16),
          parentSpanId: goalSpanId,
          name: `qoder.quest.step.${step.id}`,
          startMs: step.startedMs ?? step.firstMs,
          endMs: step.completedMs ?? goalEnd,
          error: ["FAILED", "ERROR", "CANCELLED"].includes(stepStatus.toUpperCase()),
          attrs: {
            ...common,
            "openinference.span.kind": "CHAIN",
            "qoder.span.type": "quest",
            "qoder.quest.kind": "step",
            "qoder.quest.mode": sessionMode,
            "qoder.quest.goal_id": goalId,
            "qoder.quest.step_id": step.id,
            "qoder.quest.step_name": step.content,
            "qoder.quest.status": stepStatus,
            "input.value": truncateText(redactText(step.content), maxContentChars),
            "output.value": stepStatus,
          },
        }))
      }
    }
  }

  const subagents = new Map()
  for (const entry of hooks) {
    const name = entry.event?.hook_event_name
    if (name !== "SubagentStart" && name !== "SubagentStop") continue
    const id = subagentIdentity(entry.event)
    if (!id) continue
    const pair = subagents.get(id) || {}
    if (name === "SubagentStart") pair.start = entry
    if (name === "SubagentStop") pair.stop = entry
    subagents.set(id, pair)
  }
  for (const spawn of spawnedSubagents.values()) {
    const represented = [...subagents.entries()].some(([id, pair]) =>
      id === spawn.sessionId
      || pair.start?.event?.tool_use_id === spawn.toolId
      || pair.stop?.event?.tool_use_id === spawn.toolId)
    if (!represented) subagents.set(spawn.sessionId, { synthetic: spawn })
  }
  const subagentSpanIds = new Map(
    [...subagents.keys()].map((id) => [id, stableHex([sessionId, snapshotId, "subagent", id], 16)]),
  )
  for (const [id, pair] of [...subagents.entries()].sort((a, b) =>
    toMs(a[1].start?.capturedAt, a[1].synthetic?.startMs ?? startMs) - toMs(b[1].start?.capturedAt, b[1].synthetic?.startMs ?? startMs))) {
    const started = pair.start
    const stopped = pair.stop
    const synthetic = pair.synthetic
    const expert = expertBySessionId.get(id)
    const isExpert = expertsMode || Boolean(synthetic?.isExpert) || Boolean(expert)
    const parentId = subagentParentIdentity(stopped?.event || {}, sessionId)
      || subagentParentIdentity(started?.event || {}, sessionId)
    const agentName = firstString(
      stopped?.event?.agent_type,
      stopped?.event?.subagent_type,
      started?.event?.agent_type,
      started?.event?.subagent_type,
      expert?.name,
      synthetic?.agentName,
      "subagent",
    )
    const usage = asObject(stopped?.event?.token_usage || stopped?.event?.usage || started?.event?.token_usage || started?.event?.usage)
    const inputTokens = firstNumber(usage.input_tokens, usage.prompt_tokens, usage.input)
    const outputTokens = firstNumber(usage.output_tokens, usage.completion_tokens, usage.output)
    const reasoningTokens = firstNumber(usage.reasoning_tokens, usage.reasoning)
    const model = firstString(stopped?.event?.model, started?.event?.model)
    const provider = firstString(stopped?.event?.provider, started?.event?.provider, "qoder")
    spans.push(otlpSpan({
      traceId,
      spanId: subagentSpanIds.get(id),
      parentSpanId: subagentSpanIds.get(parentId) || rootSpanId,
      name: `qoder.subagent.${agentName}`,
      startMs: toMs(started?.capturedAt, synthetic?.startMs ?? startMs),
      endMs: toMs(stopped?.capturedAt, synthetic?.endMs ?? endMs),
      error: synthetic?.error || String(stopped?.event?.status || "").toLowerCase() === "failed",
      attrs: {
        ...common,
        "openinference.span.kind": "AGENT",
        "qoder.span.type": "subagent",
        "gen_ai.system": provider,
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.request.model": model,
        "gen_ai.usage.input_tokens": inputTokens,
        "gen_ai.usage.output_tokens": outputTokens,
        "gen_ai.usage.reasoning_tokens": reasoningTokens,
        "qoder.token_usage.available": inputTokens + outputTokens + reasoningTokens > 0,
        "qoder.subagent.session_id": id,
        "qoder.subagent.name": agentName,
        "qoder.subagent.type": firstString(expert?.type, synthetic?.agentType),
        "qoder.subagent.role": firstString(expert?.role, synthetic?.agentRole),
        "qoder.subagent.status": firstString(stopped?.event?.status, synthetic?.status),
        "qoder.subagent.transcript_path": synthetic?.transcriptPath,
        "qoder.expert.name": isExpert ? agentName : undefined,
        "qoder.expert.role": isExpert ? firstString(expert?.role, synthetic?.agentRole) : undefined,
        "qoder.subagent.parent_session_id": parentId || sessionId,
        "qoder.subagent.completed": Boolean(stopped || synthetic),
        "input.value": truncateText(redactText(firstString(started?.event?.description, started?.event?.prompt, expert?.prompt, expert?.description, synthetic?.prompt, synthetic?.description, "")), maxContentChars),
        "output.value": truncateText(redactText(firstString(stopped?.event?.result, stopped?.event?.summary, expert?.output, synthetic?.result, "")), maxContentChars),
      },
    }))
  }

  const payloadCapturedAt = firstString(capturedAt, stop?.capturedAt, new Date(endMs).toISOString())
  return {
    snapshotId,
    sessionId,
    capturedAt: payloadCapturedAt,
    resourceSpans: [{
      resource: {
        attributes: attributes({
          "service.name": qoderServiceName(productName),
          "service.version": firstString(productInfo.version, allTranscript.find((record) => record?.version)?.version, "unknown"),
          "service.instance.id": sessionId,
          "session.id": sessionId,
          "qoder.product": productName,
          "qoder.distribution": "cn",
        }),
      },
      scopeSpans: [{
        scope: { name: "agent-insight-qoder", version: "0.1.0" },
        spans,
      }],
    }],
  }
}

function parseEnvFile(file) {
  const out = {}
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const index = trimmed.indexOf("=")
      if (index <= 0) continue
      const key = trimmed.slice(0, index).trim()
      const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "")
      out[key] = value
    }
  } catch {}
  return out
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 })
  fs.renameSync(temporary, file)
}

function readJsonFiles(directory) {
  try {
    return fs.readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .flatMap((name) => {
        try {
          return [JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"))]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

function readDiagnosticRecords(qoderHome, transcriptPath, sessionId) {
  if (!transcriptPath) return []
  const projectKey = path.basename(path.dirname(transcriptPath))
  const segmentsDir = path.join(qoderHome, "logs", "sessions", projectKey, sessionId, "segments")
  try {
    return fs.readdirSync(segmentsDir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .flatMap((name) => parseJsonLines(fs.readFileSync(path.join(segmentsDir, name), "utf8")))
  } catch {
    return []
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

function toolResultText(record, part) {
  const direct = part?.content
  if (typeof direct === "string") return direct
  if (direct !== undefined) return safeJson(direct, DEFAULT_MAX_CONTENT_CHARS)
  const result = record?.toolUseResult
  if (typeof result === "string") return result
  if (result !== undefined) return safeJson(result, DEFAULT_MAX_CONTENT_CHARS)
  return ""
}

export function readQoderExpertAgents(qoderHome, transcriptPath, sessionId, transcriptRecords) {
  if (!transcriptPath || !sessionId) return []
  const sessionMeta = [...(Array.isArray(transcriptRecords) ? transcriptRecords : [])].reverse().find((record) =>
    record?.type === "session_meta" && record?.data?.meta_type === "session_info")
  const expertsMode = String(sessionMeta?.data?.content?.mode || "").toLowerCase() === "experts"
  const expertsRoot = path.resolve(qoderHome, "cache", "experts", sessionId)
  // An Experts team may be started from Quest mode. The per-session experts
  // cache is authoritative in that mixed-mode case; without either signal this
  // reader must not mistake ordinary Agent tools for experts.
  if (!expertsMode && !fs.existsSync(expertsRoot)) return []

  const resultsByToolId = new Map()
  for (const record of transcriptRecords) {
    if (record?.type !== "user" || !Array.isArray(record?.message?.content)) continue
    for (const part of record.message.content) {
      if (part?.type === "tool_result" && part.tool_use_id) {
        resultsByToolId.set(String(part.tool_use_id), toolResultText(record, part))
      }
    }
  }

  const outputRoot = path.join(expertsRoot, "agents")
  const leader = readJsonFile(path.join(expertsRoot, "inboxes", "leader.json"))
  const notifications = Array.isArray(leader?.messages) ? leader.messages : []
  const transcriptRoot = path.dirname(transcriptPath)
  const experts = []

  for (const record of transcriptRecords) {
    if (record?.type !== "assistant" || !Array.isArray(record?.message?.content)) continue
    for (const part of record.message.content) {
      if (part?.type !== "tool_use" || String(part.name || "").toLowerCase() !== "agent" || !part.id) continue
      const input = asObject(part.input)
      const launchText = resultsByToolId.get(String(part.id)) || ""
      const agentId = launchText.match(/\bagentId:\s*([A-Za-z0-9_-]+)/i)?.[1]
      if (!agentId || !/^[A-Za-z0-9_-]{8,128}$/.test(agentId)) continue

      const childTranscript = parseJsonLines((() => {
        try { return fs.readFileSync(path.join(transcriptRoot, `${agentId}.jsonl`), "utf8") } catch { return "" }
      })())
      const notification = notifications.find((message) =>
        String(message?.text || "").includes(`agentId: ${agentId}`))
      let output = ""
      let hasExpertOutput = false
      const outputFile = path.resolve(outputRoot, `${agentId}.output`)
      if (outputFile.startsWith(`${outputRoot}${path.sep}`)) {
        try {
          output = fs.readFileSync(outputFile, "utf8")
          hasExpertOutput = true
        } catch {}
      }
      if (!expertsMode && !hasExpertOutput && !notification) continue
      const firstChildTimestamp = childTranscript
        .map((child) => toMs(child?.timestamp))
        .filter((value) => value > 0)
        .sort((a, b) => a - b)[0]

      experts.push({
        toolId: String(part.id),
        sessionId: agentId,
        name: firstString(input.name, launchText.match(/\bagentName:\s*([^\r\n]+)/i)?.[1], input.subagent_type, "Expert"),
        type: firstString(input.subagent_type, input.subagentType, input.agent_type, input.agentType),
        role: firstString(input.role, input.agent_role, input.agentRole, launchText.match(/\bagentRole:\s*([^\r\n]+)/i)?.[1]),
        prompt: firstString(input.prompt, input.description),
        description: firstString(input.description, input.prompt),
        output,
        startedAt: firstChildTimestamp || record.timestamp,
        completedAt: firstString(notification?.timestamp),
        transcriptRecords: childTranscript,
      })
    }
  }
  return experts
}

function readJetBrainsMarkers(insightDir, nowMs = Date.now()) {
  const markerDir = path.join(insightDir, "qoder-jetbrains", "ide-processes")
  const markers = []
  try {
    for (const entry of fs.readdirSync(markerDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue
      try {
        const marker = JSON.parse(fs.readFileSync(path.join(markerDir, entry.name), "utf8"))
        const pid = Number(marker?.pid)
        const updatedAt = toMs(marker?.updatedAt)
        if (Number.isInteger(pid) && pid > 0 && updatedAt > 0 && nowMs - updatedAt < 120_000) {
          markers.push({ ...marker, pid, updatedAt })
        }
      } catch {}
    }
  } catch {}
  return markers
}

function jetBrainsLogContainsSession(marker, sessionId) {
  if (!sessionId || !marker?.ideLogPath) return false
  const logPath = path.join(String(marker.ideLogPath), "idea.log")
  try {
    const stat = fs.statSync(logPath)
    const maxBytes = 2 * 1024 * 1024
    const start = Math.max(0, stat.size - maxBytes)
    const length = stat.size - start
    const buffer = Buffer.alloc(length)
    const descriptor = fs.openSync(logPath, "r")
    try {
      fs.readSync(descriptor, buffer, 0, length, start)
    } finally {
      fs.closeSync(descriptor)
    }
    const sessionNeedle = `sessionId=${sessionId}`
    return buffer.toString("utf8").split(/\r?\n/).some((line) =>
      line.includes(sessionNeedle) && /com\.alibabacloud\.intellij\.qoder/i.test(line),
    )
  } catch {
    return false
  }
}

function processAncestorPids(startPid = process.ppid) {
  if (!Number.isInteger(startPid) || startPid <= 0) return []
  if (process.platform === "win32") {
    const script = [
      `$current=${startPid}`,
      "$seen=@{}",
      "$result=@()",
      "while($current -gt 0 -and -not $seen.ContainsKey($current)){",
      "$seen[$current]=$true",
      "$result+=$current",
      "$row=Get-CimInstance Win32_Process -Filter \"ProcessId=$current\" -ErrorAction SilentlyContinue",
      "if($null -eq $row){break}",
      "$current=[int]$row.ParentProcessId",
      "}",
      "$result -join ','",
    ].join(";")
    try {
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 3_000,
      })
      return String(result.stdout || "").trim().split(",").map(Number).filter((pid) => Number.isInteger(pid) && pid > 0)
    } catch {
      return []
    }
  }
  const pids = []
  let current = startPid
  const seen = new Set()
  while (current > 0 && !seen.has(current) && pids.length < 32) {
    seen.add(current)
    pids.push(current)
    try {
      if (process.platform === "linux") {
        const stat = fs.readFileSync(`/proc/${current}/stat`, "utf8")
        current = Number(stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[1])
      } else {
        const result = spawnSync("ps", ["-o", "ppid=", "-p", String(current)], { encoding: "utf8", timeout: 1_000 })
        current = Number(String(result.stdout || "").trim())
      }
    } catch {
      break
    }
  }
  return pids
}

export function detectQoderProduct(event, options = {}) {
  const explicit = firstString(event?.qoder_product, event?.product, event?.parent_business_info?.product)
  if (explicit) return normalizeQoderProduct(explicit)
  const transcriptPath = firstString(event?.transcript_path)
  if (transcriptPath && /[\\/]\.qoderwork(?:cn)?[\\/]/i.test(transcriptPath)) return "work"
  const markers = options.jetbrainsMarkers || readJetBrainsMarkers(options.insightDir || path.join(os.homedir(), ".agent-insight"), options.nowMs)
  if (markers.some((marker) => jetBrainsLogContainsSession(marker, firstString(event?.session_id)))) return "jetbrains"
  const markerPids = options.jetbrainsMarkerPids || markers.map((marker) => marker.pid)
  if (markerPids.length) {
    const ancestors = options.ancestorPids || processAncestorPids(options.parentPid)
    if (markerPids.some((pid) => ancestors.includes(pid))) return "jetbrains"
  }
  return transcriptPath && /[\\/](?:transcript|conversation-history)[\\/]/i.test(transcriptPath) ? "desktop" : "cli"
}

function qoderHomeFromTranscript(transcriptPath, product) {
  if (!transcriptPath) return undefined
  let current = path.resolve(path.dirname(transcriptPath))
  while (path.dirname(current) !== current) {
    const basename = path.basename(current).toLowerCase()
    if (basename === ".qoder-cn" || (product === "jetbrains" && basename === ".qoder")) return current
    current = path.dirname(current)
  }
  return undefined
}

function defaultQoderHome(homeDir, product, transcriptPath) {
  const transcriptHome = qoderHomeFromTranscript(transcriptPath, product)
  if (transcriptHome) return transcriptHome
  if (product === "jetbrains") return path.join(homeDir, ".qoder")
  if (product !== "work") return path.join(homeDir, ".qoder-cn")
  for (const name of [".qoderworkcn", ".qoderwork"]) {
    const candidate = path.join(homeDir, name)
    if (fs.existsSync(candidate)) return candidate
  }
  return path.join(homeDir, ".qoderwork")
}

function resolveSpoolDir({ insightDir, configuredSpoolDir, apiKeyHash, product }) {
  if (!configuredSpoolDir) return path.join(insightDir, "otel_data", "qoder", product, apiKeyHash)
  const accountDir = path.basename(configuredSpoolDir)
  const configuredProductRoot = path.dirname(configuredSpoolDir)
  const configuredFamilyRoot = path.dirname(configuredProductRoot)
  if (path.basename(configuredFamilyRoot).toLowerCase() === "qoder") {
    return path.join(configuredFamilyRoot, product, accountDir)
  }
  if (/^qoder-(?:cli|desktop|jetbrains|work)$/i.test(path.basename(configuredProductRoot))) {
    return path.join(path.dirname(configuredProductRoot), "qoder", product, accountDir)
  }
  if (product === "cli") return configuredSpoolDir
  return path.join(configuredFamilyRoot, `qoder-${product}`, accountDir)
}

function mergeSessionEventDirectories(targetDir, sourceDirs) {
  fs.mkdirSync(targetDir, { recursive: true })
  for (const sourceDir of sourceDirs) {
    if (path.resolve(sourceDir) === path.resolve(targetDir) || !fs.existsSync(sourceDir)) continue
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue
      const source = path.join(sourceDir, entry.name)
      const target = path.join(targetDir, entry.name)
      try {
        fs.renameSync(source, target)
      } catch {
        try {
          fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
          fs.unlinkSync(source)
        } catch {}
      }
    }
    try { fs.rmdirSync(sourceDir) } catch {}
  }
}

export async function collectQoderHook(event, options = {}) {
  const homeDir = options.homeDir || os.homedir()
  const insightDir = options.insightDir || path.join(homeDir, ".agent-insight")
  const config = { ...parseEnvFile(path.join(insightDir, "config")), ...process.env, ...options.env }
  const apiKeyHash = stableHex([config.AGENT_INSIGHT_API_KEY || "anonymous"], 16)
  const product = detectQoderProduct(event, {
    insightDir,
    ancestorPids: options.ancestorPids,
    jetbrainsMarkers: options.jetbrainsMarkers,
    jetbrainsMarkerPids: options.jetbrainsMarkerPids,
    nowMs: options.nowMs,
    parentPid: options.parentPid,
  })
  const qoderHome = options.qoderHome || defaultQoderHome(homeDir, product, firstString(event?.transcript_path))
  const spoolDir = options.spoolDir || resolveSpoolDir({
    insightDir,
    configuredSpoolDir: config.AGENT_INSIGHT_QODER_SPOOL_DIR,
    apiKeyHash,
    product,
  })
  const sessionId = firstString(event?.session_id)
  if (!sessionId) throw new Error("Qoder hook event is missing session_id")
  const sessionKey = stableHex([sessionId], 32)
  const capturedAt = new Date().toISOString()
  const eventDir = path.join(spoolDir, "events", sessionKey)
  if (product === "jetbrains" && !options.spoolDir) {
    const desktopSpoolDir = resolveSpoolDir({
      insightDir,
      configuredSpoolDir: config.AGENT_INSIGHT_QODER_SPOOL_DIR,
      apiKeyHash,
      product: "desktop",
    })
    mergeSessionEventDirectories(eventDir, [path.join(desktopSpoolDir, "events", sessionKey)])
  }
  const eventFile = path.join(eventDir, `${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString("hex")}.json`)
  atomicWriteJson(eventFile, { capturedAt, event: redactAndTruncate(event, Number(config.AGENT_INSIGHT_QODER_MAX_CONTENT_CHARS) || DEFAULT_MAX_CONTENT_CHARS) })

  let pendingFile
  if (["Stop", "SessionEnd", "StopFailure"].includes(event.hook_event_name)) {
    const hookEvents = readJsonFiles(eventDir)
    const transcriptPath = firstString(event.transcript_path, [...hookEvents].reverse().find((entry) => entry?.event?.transcript_path)?.event?.transcript_path)
    let transcriptRecords = []
    try {
      transcriptRecords = parseJsonLines(fs.readFileSync(transcriptPath, "utf8"))
    } catch {}
    const diagnosticRecords = readDiagnosticRecords(qoderHome, transcriptPath, sessionId)
    const localTokenUsage = await readQoderLocalTokenUsage(product, sessionId, {
      homeDir,
      databasePath: config.AGENT_INSIGHT_QODER_TOKEN_DB,
    })
    transcriptRecords = normalizeQoderTranscriptRecords(transcriptRecords, sessionId, localTokenUsage)
    const expertAgents = readQoderExpertAgents(qoderHome, transcriptPath, sessionId, transcriptRecords)
    const payload = buildQoderOtlpPayload({
      hookEvents,
      transcriptRecords,
      diagnosticRecords,
      localTokenUsage,
      expertAgents,
      product,
      estimateVisibleTokens: ["1", "true", "yes", "on"].includes(String(config.AGENT_INSIGHT_QODER_ESTIMATE_VISIBLE_TOKENS || "").trim().toLowerCase()),
      maxContentChars: Number(config.AGENT_INSIGHT_QODER_MAX_CONTENT_CHARS) || DEFAULT_MAX_CONTENT_CHARS,
      capturedAt,
    })
    pendingFile = path.join(spoolDir, "pending", `${sessionKey}-${payload.snapshotId}.json`)
    atomicWriteJson(pendingFile, payload)
    const uploaderPath = options.uploaderPath || config.AGENT_INSIGHT_QODER_UPLOADER || path.join(insightDir, "qoder_uploader_client.mjs")
    if (!options.disableUploadKick && fs.existsSync(uploaderPath)) {
      try {
        const child = spawn(process.execPath, [uploaderPath], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          env: {
            ...process.env,
            AGENT_INSIGHT_HOST: config.AGENT_INSIGHT_HOST || "",
            AGENT_INSIGHT_API_KEY: config.AGENT_INSIGHT_API_KEY || "",
            AGENT_INSIGHT_QODER_SPOOL_DIR: spoolDir,
          },
        })
        child.unref()
      } catch {}
    }
  }

  return { eventFile, pendingFile, spoolDir, apiKeyHash }
}

export async function flushQoderProduct(options = {}) {
  const homeDir = options.homeDir || os.homedir()
  const insightDir = options.insightDir || path.join(homeDir, ".agent-insight")
  const config = { ...parseEnvFile(path.join(insightDir, "config")), ...process.env, ...options.env }
  const product = normalizeQoderProduct(options.product)
  const apiKeyHash = stableHex([config.AGENT_INSIGHT_API_KEY || "anonymous"], 16)
  const spoolDir = options.spoolDir || resolveSpoolDir({
    insightDir,
    configuredSpoolDir: config.AGENT_INSIGHT_QODER_SPOOL_DIR,
    apiKeyHash,
    product,
  })
  const pendingDir = path.join(spoolDir, "pending")
  const eventsRoot = path.join(spoolDir, "events")
  let snapshotted = 0
  let snapshotFailed = 0
  let sessionDirectories = []
  try {
    sessionDirectories = fs.readdirSync(eventsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {}
  for (const entry of sessionDirectories) {
    const sessionKey = entry.name
    let hasPending = false
    try {
      hasPending = fs.readdirSync(pendingDir).some((name) => name.startsWith(`${sessionKey}-`) && name.endsWith(".json") && !name.endsWith(".retry.json"))
    } catch {}
    if (hasPending) continue
    const hookEvents = readJsonFiles(path.join(eventsRoot, sessionKey))
    const latest = [...hookEvents].reverse().find((item) => item?.event?.session_id)
    if (!latest) continue
    try {
      await collectQoderHook({
        ...latest.event,
        qoder_product: product,
        hook_event_name: "SessionEnd",
        agent_insight_flush: true,
      }, {
        homeDir,
        insightDir,
        spoolDir,
        disableUploadKick: true,
      })
      snapshotted++
    } catch {
      snapshotFailed++
    }
  }
  const uploaderPath = options.uploaderPath
    || config.AGENT_INSIGHT_QODER_UPLOADER
    || path.join(path.dirname(fileURLToPath(import.meta.url)), "qoder_uploader_client.mjs")
  const upload = options.uploadPending
    || (await import(pathToFileURL(path.resolve(uploaderPath)).href)).uploadPending
  const uploadResult = await upload({
    spoolDir,
    env: config,
    force: true,
    waitForLockMs: Number(options.waitForLockMs) || 5_000,
    ...options.uploadOptions,
  })
  return { product, spoolDir, snapshotted, snapshotFailed, ...uploadResult }
}

async function main() {
  if (process.argv.includes("--flush")) {
    const productArg = process.argv.find((arg) => arg.startsWith("--product="))
    const waitArg = process.argv.find((arg) => arg.startsWith("--wait-for-lock-ms="))
    const result = await flushQoderProduct({
      product: productArg?.slice("--product=".length),
      waitForLockMs: Number(waitArg?.slice("--wait-for-lock-ms=".length)) || 5_000,
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  let raw = ""
  process.stdin.setEncoding("utf8")
  for await (const chunk of process.stdin) raw += chunk
  if (!raw.trim()) return
  await collectQoderHook(JSON.parse(raw.replace(/^\uFEFF/, "")))
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ""
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`agent-insight-qoder: ${error?.message || String(error)}\n`)
    process.exitCode = process.argv.includes("--flush") ? 1 : 0
  })
}
