const fs = require("fs")
const path = require("path")
const os = require("os")
const crypto = require("crypto")

function sha256Hex(text: any): string {
  try {
    return crypto.createHash("sha256").update(String(text)).digest("hex")
  } catch {
    return ""
  }
}

const SECRET_KEYS = new Set(
  [
    "apiKey",
    "api_key",
    "apikey",
    "authorization",
    "Authorization",
    "token",
    "accessToken",
    "refreshToken",
    "secret",
    "clientSecret",
    "privateKey",
    "password",
  ].map((s) => String(s).toLowerCase()),
)

function isSecretKey(key: any): boolean {
  const k = String(key || "").toLowerCase()
  if (SECRET_KEYS.has(k)) return true
  if (k.endsWith("_key") || k.endsWith("_token") || k.endsWith("_secret")) return true
  return false
}

function redactJson(value: any): any {
  if (value === null) return value
  const t = typeof value
  if (t === "string" || t === "number" || t === "boolean") return value
  if (Array.isArray(value)) return value.map(redactJson)
  if (t !== "object") return null
  const out: any = {}
  for (const [k, v] of Object.entries(value)) {
    if (isSecretKey(k)) out[k] = "***"
    else out[k] = redactJson(v)
  }
  return out
}

function nowIso() {
  return new Date().toISOString()
}

function safeMkdirp(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {}
}

function parseDotEnvText(text: any): Record<string, string> {
  const out: any = {}
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

function loadSkillInsightEnv(): Record<string, string | undefined> {
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

function asBool(v: any): boolean {
  const s = String(v ?? "").toLowerCase().trim()
  return s === "1" || s === "true" || s === "yes" || s === "on"
}

function asInt(v: any, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

function truncateString(s: any, max: number): string {
  if (typeof s !== "string") return s
  if (!Number.isFinite(max) || max <= 0) return ""
  if (s.length <= max) return s
  return s.slice(0, max)
}

function truncateJson(value: any, maxString: number): any {
  if (value === null) return value
  const t = typeof value
  if (t === "string") return truncateString(value, maxString)
  if (t === "number" || t === "boolean") return value
  if (Array.isArray(value)) return value.map((x) => truncateJson(x, maxString))
  const out: any = {}
  for (const [k, v] of Object.entries(value)) out[k] = truncateJson(v, maxString)
  return out
}

function buildOutFile(spoolDir: string): string {
  const d = new Date()
  const yyyy = String(d.getFullYear())
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  const dayDir = path.join(spoolDir, `${yyyy}-${mm}-${dd}`)
  safeMkdirp(dayDir)
  const runId = `${nowIso().replace(/[:.]/g, "-")}-${process.pid}`
  return path.join(dayDir, `opencode-otel-${runId}.jsonl`)
}

function createWriter(outFile: string): { enqueue: (obj: any) => void; close: () => Promise<void>; outFile: string } {
  safeMkdirp(path.dirname(outFile))
  const stream = fs.createWriteStream(outFile, { flags: "a" })
  const queue: any[] = []
  let flushing = false
  let stopped = false
  let pending: NodeJS.Timeout | null = null

  const flush = async (): Promise<void> => {
    if (flushing || stopped) return
    flushing = true
    try {
      while (queue.length > 0 && !stopped) {
        const chunk = queue.shift()
        const ok = stream.write(chunk)
        if (!ok) await new Promise((resolve) => stream.once("drain", resolve))
      }
    } catch {}
    flushing = false
  }

  const enqueue = (obj: any): void => {
    if (stopped) return
    try {
      queue.push(JSON.stringify(obj) + "\n")
    } catch {
      return
    }
    if (!pending) {
      pending = setTimeout(() => {
        pending = null
        flush()
      }, 0)
      if (pending && pending.unref) pending.unref()
    }
  }

  const close = async (): Promise<void> => {
    if (stopped) return
    try {
      if (pending) clearTimeout(pending)
    } catch {}
    try {
      await flush()
    } catch {}
    stopped = true
    try {
      stream.end()
    } catch {}
  }

  return { enqueue, close, outFile }
}

function extractTextFromParts(parts: any): string {
  try {
    if (!Array.isArray(parts)) return ""
    const buf = []
    for (const p of parts) {
      if (!p) continue
      if (typeof p === "string") buf.push(p)
      else if (typeof p.text === "string") buf.push(p.text)
      else if (typeof p.content === "string") buf.push(p.content)
      else if (typeof p.value === "string") buf.push(p.value)
    }
    return buf.join("")
  } catch {
    return ""
  }
}

export default async function WittySkillInsightOtelPlugin() {
  const env = loadSkillInsightEnv()
  const enabled = asBool(env.SKILL_INSIGHT_OPENCODE_OTEL_ENABLE ?? env.OPENCODE_MIN_CAPTURE_ENABLE ?? "true")
  if (!enabled) return {}

  const apiKey = env.SKILL_INSIGHT_API_KEY
  const spoolDir = env.SKILL_INSIGHT_OPENCODE_SPOOL_DIR || path.join(os.homedir(), ".skill-insight", "otel_data", "opencode")
  const maxToolIo = asInt(env.SKILL_INSIGHT_MAX_TOOL_IO, 4000)
  const maxEventString = asInt(env.SKILL_INSIGHT_MAX_EVENT_STRING, 20000)
  const outFile = buildOutFile(spoolDir)
  const writer = createWriter(outFile)

  const uploaderPath = env.SKILL_INSIGHT_OPENCODE_UPLOADER || path.join(os.homedir(), ".skill-insight", "opencode_uploader_client.js")
  const uploaderCooldownMs = asInt(env.SKILL_INSIGHT_OPENCODE_UPLOAD_COOLDOWN_MS, 15000)
  const lastUploadKickBySession = new Map<string, number>()
  const activeSessionIds = new Set<string>()

  const logDir = path.join(os.homedir(), ".skill-insight", "logs")
  const uploaderLogPath = path.join(logDir, "opencode_uploader.log")

  // Pick a runtime that can execute a plain .js file. Opencode bundles bun, so
  // process.execPath points at *bun* — but `bun /path/to/file.js` is interpreted
  // as `cd <path>` (errors with "Failed to change directory"). To run JS we
  // either need system `node` (preferred), or `bun run <path>` form. Resolve
  // once at plugin load and cache.
  const findInPath = (name: string): string | null => {
    const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""]
    const dirs = (process.env.PATH || "").split(path.delimiter)
    for (const dir of dirs) {
      for (const ext of exts) {
        const full = path.join(dir, name + ext)
        try {
          if (fs.existsSync(full)) return full
        } catch {}
      }
    }
    return null
  }
  const nodePath = findInPath("node")
  const bunPath = findInPath("bun")
  const runtime: { cmd: string; argsPrefix: string[] } = nodePath
    ? { cmd: nodePath, argsPrefix: [] }
    : bunPath
    ? { cmd: bunPath, argsPrefix: ["run"] }
    : { cmd: process.execPath || "node", argsPrefix: ["run"] }

  const kickUploader = (sessionID: string, force = false): void => {
    try {
      if (!fs.existsSync(uploaderPath)) return
      const now = Date.now()
      const prev = lastUploadKickBySession.get(sessionID || "") || 0
      if (!force && now - prev < uploaderCooldownMs) return
      lastUploadKickBySession.set(sessionID || "", now)

      try {
        fs.mkdirSync(logDir, { recursive: true })
      } catch {}
      let logFd: number = -1
      try {
        logFd = fs.openSync(uploaderLogPath, "a")
        const header = `\n[${nowIso()}] kickUploader sessionID=${sessionID || "(none)"} runtime=${runtime.cmd}\n`
        try { fs.writeSync(logFd, header) } catch {}
      } catch {}

      const cp = require("child_process")
      const stdio = logFd >= 0 ? ["ignore", logFd, logFd] : "ignore"
      const child = cp.spawn(runtime.cmd, [...runtime.argsPrefix, uploaderPath], {
        detached: true,
        stdio,
        windowsHide: true,
        env: {
          ...process.env,
          ...(force ? { SKILL_INSIGHT_UPLOADER_FORCE: "1" } : {}),
        },
      })
      child.unref()
      // The fd is dup'd to the child by spawn(); safe to close here.
      if (logFd >= 0) { try { fs.closeSync(logFd) } catch {} }
    } catch {}
  }

  const markSessionComplete = async (sessionID: string, completedAt: string): Promise<void> => {
    if (!sessionID || !apiKey || !env.SKILL_INSIGHT_HOST) return
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)
    try {
      const base = String(env.SKILL_INSIGHT_HOST).replace(/\/+$/, "")
      const url = base.endsWith("/api")
        ? `${base}/ingest/opencode/session-complete`
        : `${base}/api/ingest/opencode/session-complete`
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-witty-api-key": apiKey,
        },
        body: JSON.stringify({
          task_id: sessionID,
          completed_at: completedAt,
        }),
        signal: controller.signal,
      })
    } catch {
    } finally {
      clearTimeout(timeout)
    }
  }

  writer.enqueue({
    t: nowIso(),
    kind: "plugin.start",
    payload: { outFile, cwd: process.cwd(), pid: process.pid, node: process.version, platform: process.platform, arch: process.arch },
  })

  const recordSession = (sessionID: any): void => {
    if (typeof sessionID === "string" && sessionID.startsWith("ses")) {
      activeSessionIds.add(sessionID)
    }
  }

  const shutdown = async () => {
    const endedAt = nowIso()
    const sessions = Array.from(activeSessionIds)
    try {
      for (const sessionID of sessions) {
        fs.appendFileSync(outFile, JSON.stringify({
          t: endedAt,
          kind: "plugin.shutdown",
          sessionID,
          trace_id: sessionID,
          payload: { reason: "opencode-cli-exit", pid: process.pid },
        }) + "\n")
      }
    } catch {}
    await writer.close()
    try {
      if (sessions.length > 0) {
        await Promise.all(sessions.map((sessionID) => markSessionComplete(sessionID, endedAt)))
        for (const sessionID of sessions) kickUploader(sessionID, true)
      } else {
        kickUploader("", true)
      }
    } catch {}
  }
  try {
    process.once("beforeExit", shutdown)
    process.once("SIGINT", shutdown)
    process.once("SIGTERM", shutdown)
  } catch {}

  try {
    kickUploader("")
  } catch {}

  const safeEventPayload = (payload: any): any => {
    const redacted = redactJson(payload)
    const truncated = truncateJson(redacted, maxEventString)
    return truncated
  }

  const safeToolIoPayload = (payload: any): any => {
    const redacted = redactJson(payload)
    const truncated = truncateJson(redacted, maxToolIo)
    return truncated
  }

  return {
    config: async (cfg: any) => {
      try {
        const redacted = redactJson(cfg || {})
        writer.enqueue({ t: nowIso(), kind: "event", payload: { type: "config.redacted", config: truncateJson(redacted, 2000) } })
      } catch {}
    },
    "experimental.chat.system.transform": async (input: any, output: any) => {
      try {
        recordSession(input?.sessionID)
        const system = Array.isArray(output?.system) ? output.system.map((x: any) => String(x)) : []
        const joined = system.join("\n")
        writer.enqueue({
          t: nowIso(),
          kind: "system.prompt",
          sessionID: input?.sessionID,
          providerID: input?.model?.providerID,
          modelID: input?.model?.modelID,
          trace_id: input?.sessionID,
          payload: { system, length: joined.length, sha256: sha256Hex(joined) },
        })
      } catch {}
    },
    "chat.message": async (input: any, output: any) => {
      try {
        recordSession(input?.sessionID)
        const text = output?.message?.content || extractTextFromParts(output?.parts) || ""
        writer.enqueue({
          t: nowIso(),
          kind: "chat.message",
          sessionID: input?.sessionID,
          agent: input?.agent,
          providerID: input?.model?.providerID,
          modelID: input?.model?.modelID,
          trace_id: input?.sessionID,
          payload: { messageID: input?.messageID, length: String(text).length, text: String(text) },
        })
      } catch {}
    },
    "experimental.text.complete": async (input: any, output: any) => {
      try {
        recordSession(input?.sessionID)
        const text = output?.text ?? ""
        writer.enqueue({
          t: nowIso(),
          kind: "text.complete",
          sessionID: input?.sessionID,
          trace_id: input?.sessionID,
          payload: { messageID: input?.messageID, partID: input?.partID, length: String(text).length, text: String(text) },
        })
      } catch {}
    },
    event: async ({ event }: any) => {
      try {
        if (!event) return
        const type = String(event.type || "unknown")
        const sessionID = event.properties?.sessionID || event.sessionID || event.session?.id || event.session?.sessionID
        recordSession(sessionID)
        const base = {
          t: nowIso(),
          kind: "event",
          sessionID: sessionID ? String(sessionID) : undefined,
          trace_id: sessionID ? String(sessionID) : undefined,
        }

        try {
          // Trigger uploader on idle signal:
          //   - `session.idle` is the idle signal itself; it doesn't carry a status field
          //   - `session.updated` may fire many times during a session — only kick when
          //     properties.info.status === "idle" so we don't spam mid-conversation
          const status = String(
            event?.properties?.info?.status || event?.properties?.status || ""
          ).toLowerCase()
          const isIdle = type === "session.idle" || (type === "session.updated" && status === "idle")
          if (isIdle) {
            kickUploader(sessionID ? String(sessionID) : "")
          }
        } catch {}

        if (type.startsWith("tool") || type.includes("tool")) {
          writer.enqueue({ ...base, payload: { type, event: safeToolIoPayload(event) } })
          return
        }
        writer.enqueue({ ...base, payload: { type, event: safeEventPayload(event) } })
      } catch {}
    },
  }
}
