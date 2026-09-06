import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { spawn } from "node:child_process"

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

function appendLogLine(file: string, message: string): void {
  try {
    safeMkdirp(path.dirname(file))
    fs.appendFileSync(file, `[${nowIso()}] ${message}\n`)
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
 * 上面那句 `if (env[k] === undefined)` 是「环境变量优先」——保留它是为了让一次性覆盖
 * （`AGENT_INSIGHT_HOST=... opencode`）继续可用。代价是重跑 setup 把 .env 指向新平台后，
 * 旧终端里残留的 export 会让上报**继续发往老地址**，而且此前全程无任何提示：日志里的
 * host 与 .env 明明不一致也没人吭声，只能靠翻日志倒推。这里把它显式喊出来。
 */
export function findShadowedEnvKeys(): Array<{ key: string; fromFile: string; actual: string }> {
  const out: Array<{ key: string; fromFile: string; actual: string }> = []
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
export function describeShadowedEnv(entries: Array<{ key: string; fromFile: string; actual: string }>): string {
  return entries
    .map(({ key, fromFile, actual }) =>
      /KEY|TOKEN|SECRET|PASSWORD/i.test(key)
        ? `${key}(值不同,已隐藏)`
        : `${key}(.env=${fromFile} 实际=${actual})`,
    )
    .join(" ")
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
        if (!ok) await new Promise<void>((resolve) => stream.once("drain", () => resolve()))
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

/**
 * 心跳决策（纯函数，便于单测）。
 *
 * 返回 "start-clock" 时**只能**写心跳自己的时钟，绝不能写 kickUploader 的节流表
 * (lastUploadKickBySession)。曾经为图省事复用了节流表当计时起点，等于伪造一次
 * "刚上报过"，导致紧随其后的 session.idle 上报落进冷却期被吞掉 —— 15 秒内做完的
 * 短任务因此一次都不上报。test/opencode-plugin-heartbeat.test.ts 有回归护栏。
 */
export function computeHeartbeatDecision(args: {
  now: number
  heartbeatMs: number
  /** 真实发生过的上一次 kick 时间（idle 或心跳触发），没有则 0/undefined */
  lastKickAt?: number
  /** 心跳自己的计时起点 */
  heartbeatClockAt?: number
}): "none" | "start-clock" | "kick" {
  if (!(args.heartbeatMs > 0)) return "none"
  const since = args.lastKickAt || args.heartbeatClockAt || 0
  if (since <= 0) return "start-clock"
  return args.now - since >= args.heartbeatMs ? "kick" : "none"
}

export type UploaderRuntime = {
  cmd: string
  argsPrefix: string[]
}

const COMMON_UPLOADER_RUNTIMES = [
  "/usr/local/bin/node",
  "/usr/bin/node",
  "/bin/node",
  "/opt/homebrew/bin/node",
  "/usr/local/bin/bun",
  "/usr/bin/bun",
  "/opt/homebrew/bin/bun",
]

function runtimeFromExecutable(executable: string, platform: NodeJS.Platform): UploaderRuntime | null {
  const pathApi = platform === "win32" ? path.win32 : path.posix
  const name = pathApi.basename(executable).toLowerCase().replace(/\.exe$/, "")
  if (name === "node") return { cmd: executable, argsPrefix: [] }
  if (name === "bun") return { cmd: executable, argsPrefix: ["run"] }
  return null
}

export function resolveUploaderRuntime(options: {
  platform?: NodeJS.Platform
  pathEnv?: string
  execPath?: string
  commonPaths?: string[]
  exists?: (candidate: string) => boolean
} = {}): UploaderRuntime | null {
  const platform = options.platform ?? process.platform
  const pathApi = platform === "win32" ? path.win32 : path.posix
  const delimiter = platform === "win32" ? ";" : ":"
  const extensions = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""]
  const exists = options.exists ?? fs.existsSync
  const pathEnv = options.pathEnv ?? process.env.PATH ?? ""

  const findInPath = (name: string): string | null => {
    for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
      for (const extension of extensions) {
        const candidate = pathApi.join(dir, name + extension)
        try {
          if (exists(candidate)) return candidate
        } catch {}
      }
    }
    return null
  }

  const nodePath = findInPath("node")
  if (nodePath) return { cmd: nodePath, argsPrefix: [] }

  const bunPath = findInPath("bun")
  if (bunPath) return { cmd: bunPath, argsPrefix: ["run"] }

  for (const candidate of options.commonPaths ?? COMMON_UPLOADER_RUNTIMES) {
    try {
      if (!exists(candidate)) continue
    } catch {
      continue
    }
    const runtime = runtimeFromExecutable(candidate, platform)
    if (runtime) return runtime
  }

  return runtimeFromExecutable(options.execPath ?? process.execPath ?? "", platform)
}

export function formatUploaderRuntimeForLog(runtime: UploaderRuntime | null): {
  command: string
  argsPrefix: string
} {
  if (!runtime) return { command: "(unavailable)", argsPrefix: "(none)" }
  return {
    command: runtime.cmd,
    argsPrefix: runtime.argsPrefix.join(" ") || "(none)",
  }
}

export default async function WittySkillInsightOtelPlugin() {
  const env = loadSkillInsightEnv()
  const enabled = asBool(env.AGENT_INSIGHT_OPENCODE_OTEL_ENABLE ?? env.OPENCODE_MIN_CAPTURE_ENABLE ?? "true")
  if (!enabled) return {}

  const apiKey = env.AGENT_INSIGHT_API_KEY
  const spoolDir = env.AGENT_INSIGHT_OPENCODE_SPOOL_DIR || path.join(getExistingInsightDir(), "otel_data", "opencode")
  const maxToolIo = asInt(env.AGENT_INSIGHT_MAX_TOOL_IO, 4000)
  const maxEventString = asInt(env.AGENT_INSIGHT_MAX_EVENT_STRING, 20000)
  const outFile = buildOutFile(spoolDir)
  const writer = createWriter(outFile)

  const uploaderPath = env.AGENT_INSIGHT_OPENCODE_UPLOADER || path.join(getExistingInsightDir(), "opencode_uploader_client.js")
  const uploaderCooldownMs = asInt(env.AGENT_INSIGHT_OPENCODE_UPLOAD_COOLDOWN_MS, 15000)
  // 进行中会话的心跳上报间隔。之前只有 session.idle 会触发上报，一个长时间不 idle 的
  // 任务（典型是工具死循环）整个执行期间零上报，只能等 CLI 退出才第一次落库。
  // 0 或负数 = 关闭心跳，回到"仅 idle 触发"的旧行为。
  const heartbeatMs = asInt(env.AGENT_INSIGHT_OPENCODE_HEARTBEAT_MS, 60000)
  const lastUploadKickBySession = new Map<string, number>()
  // 心跳的计时起点，必须与 lastUploadKickBySession 分开。
  // 后者是 kickUploader 的节流依据，往里写"还没真正 kick 过"的时间戳会把紧随其后的
  // session.idle 上报误判成冷却期内而吞掉 —— 短任务（15s 内做完）会因此一次都不上报。
  const heartbeatClockBySession = new Map<string, number>()
  const activeSessionIds = new Set<string>()

  const logDir = path.join(getPreferredInsightDir(), "logs")
  const pluginLogPath = path.join(logDir, "opencode_plugin.log")
  const uploaderLogPath = path.join(logDir, "opencode_uploader.log")

  const runtime = resolveUploaderRuntime()
  const runtimeLog = formatUploaderRuntimeForLog(runtime)

  appendLogLine(
    pluginLogPath,
    `plugin.init enabled=${enabled} spoolDir=${spoolDir} uploaderPath=${uploaderPath} runtime=${runtimeLog.command} argsPrefix=${runtimeLog.argsPrefix} host=${env.AGENT_INSIGHT_HOST || "(missing)"} apiKeyPresent=${apiKey ? "yes" : "no"}`,
  )

  const shadowed = findShadowedEnvKeys()
  if (shadowed.length) {
    appendLogLine(
      pluginLogPath,
      `plugin.env.shadowed 进程环境里的同名变量压过了 .env,重跑 setup 改的配置在本进程不生效: ${describeShadowedEnv(shadowed)}` +
      ` → 在启动 opencode 的终端里 unset 这些变量(或新开终端)后重启 opencode`,
    )
  }

  const kickUploader = (sessionID: string, force = false, reason = "unspecified"): void => {
    try {
      if (!fs.existsSync(uploaderPath)) {
        appendLogLine(
          pluginLogPath,
          `kickUploader.skip reason=${reason} sessionID=${sessionID || "(none)"} uploaderMissing=${uploaderPath}`,
        )
        return
      }
      if (!runtime) {
        appendLogLine(
          pluginLogPath,
          `kickUploader.skip reason=${reason} sessionID=${sessionID || "(none)"} runtimeUnavailable=1 hostExecPath=${process.execPath || "(empty)"}`,
        )
        return
      }
      const now = Date.now()
      const prev = lastUploadKickBySession.get(sessionID || "") || 0
      const sinceLast = prev > 0 ? now - prev : -1
      if (!force && sinceLast >= 0 && sinceLast < uploaderCooldownMs) {
        appendLogLine(
          pluginLogPath,
          `kickUploader.throttled reason=${reason} sessionID=${sessionID || "(none)"} sinceLastMs=${sinceLast} cooldownMs=${uploaderCooldownMs}`,
        )
        return
      }
      lastUploadKickBySession.set(sessionID || "", now)
      appendLogLine(
        pluginLogPath,
        `kickUploader.start reason=${reason} sessionID=${sessionID || "(none)"} force=${force ? "1" : "0"} runtime=${runtime.cmd} args=${[...runtime.argsPrefix, uploaderPath].join(" ")}`,
      )

      try {
        fs.mkdirSync(logDir, { recursive: true })
      } catch {}
      let logFd: number = -1
      try {
        logFd = fs.openSync(uploaderLogPath, "a")
        const header = `\n[${nowIso()}] kickUploader sessionID=${sessionID || "(none)"} runtime=${runtime.cmd}\n`
        try { fs.writeSync(logFd, header) } catch {}
      } catch {}

      const stdio: import("child_process").StdioOptions = logFd >= 0 ? ["ignore", logFd, logFd] : "ignore"
      const child = spawn(runtime.cmd, [...runtime.argsPrefix, uploaderPath], {
        detached: true,
        stdio,
        windowsHide: true,
        env: {
          ...process.env,
          AGENT_INSIGHT_UPLOADER_SPOOL_FILE: outFile,
          ...(force ? { AGENT_INSIGHT_UPLOADER_FORCE: "1" } : {}),
          // 强推限定到本 session：FORCE 是进程级开关，不限定的话 uploader 会把
          // spool 里保留期内的所有历史会话一并重传。
          ...(force && sessionID ? { AGENT_INSIGHT_UPLOADER_FORCE_SESSION: sessionID } : {}),
        },
      })
      child.unref()
      appendLogLine(
        pluginLogPath,
        `kickUploader.spawned reason=${reason} sessionID=${sessionID || "(none)"} childPid=${child.pid || "(unknown)"}`,
      )
      // The fd is dup'd to the child by spawn(); safe to close here.
      if (logFd >= 0) { try { fs.closeSync(logFd) } catch {} }
    } catch (error) {
      appendLogLine(
        pluginLogPath,
        `kickUploader.error reason=${reason} sessionID=${sessionID || "(none)"} error=${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const markSessionComplete = async (sessionID: string, completedAt: string): Promise<void> => {
    if (!sessionID || !apiKey || !env.AGENT_INSIGHT_HOST) {
      appendLogLine(
        pluginLogPath,
        `sessionComplete.skip sessionID=${sessionID || "(none)"} hostPresent=${env.AGENT_INSIGHT_HOST ? "yes" : "no"} apiKeyPresent=${apiKey ? "yes" : "no"}`,
      )
      return
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)
    try {
      const base = String(env.AGENT_INSIGHT_HOST).replace(/\/+$/, "")
      const url = base.endsWith("/api")
        ? `${base}/ingest/opencode/session-complete`
        : `${base}/api/ingest/opencode/session-complete`
      appendLogLine(pluginLogPath, `sessionComplete.request sessionID=${sessionID} url=${url} completedAt=${completedAt}`)
      const res = await fetch(url, {
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
      let body = ""
      try {
        body = truncateString(await res.text(), 1000)
      } catch {}
      appendLogLine(
        pluginLogPath,
        `sessionComplete.response sessionID=${sessionID} status=${res.status} ok=${res.ok ? "1" : "0"} body=${body || "(empty)"}`,
      )
    } catch (error) {
      appendLogLine(
        pluginLogPath,
        `sessionComplete.error sessionID=${sessionID} error=${error instanceof Error ? error.message : String(error)}`,
      )
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
    appendLogLine(pluginLogPath, `plugin.shutdown.start sessionCount=${sessions.length} endedAt=${endedAt}`)
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
        for (const sessionID of sessions) kickUploader(sessionID, true, "shutdown")
      } else {
        kickUploader("", true, "shutdown-empty-session")
      }
    } catch (error) {
      appendLogLine(
        pluginLogPath,
        `plugin.shutdown.error error=${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  try {
    process.once("beforeExit", shutdown)
    process.once("SIGINT", shutdown)
    process.once("SIGTERM", shutdown)
  } catch {}

  try {
    kickUploader("", false, "plugin-init")
  } catch (error) {
    appendLogLine(
      pluginLogPath,
      `plugin.initKick.error error=${error instanceof Error ? error.message : String(error)}`,
    )
  }

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
          // input.messageID is OPTIONAL in the opencode plugin API and newer
          // builds often omit it; output.message.id (UserMessage.id) is always
          // present. Prefer it so the uploader can key user text to the message.
          payload: {
            messageID: output?.message?.id ?? input?.messageID,
            length: String(text).length,
            text: String(text),
          },
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
            const sid = sessionID ? String(sessionID) : ""
            appendLogLine(
              pluginLogPath,
              `event.idle type=${type} status=${status || "(none)"} sessionID=${sid || "(none)"}`,
            )
            kickUploader(sid, false, `event:${type}`)
          } else if (heartbeatMs > 0 && sessionID) {
            // 心跳：会话还在产生事件、但迟迟不 idle 时，按固定间隔推一次进行中快照。
            // 只在有事件流入时才评估，会话真正空闲下来不会白跑。
            //
            // 计时起点走独立的 heartbeatClockBySession，绝不能写 lastUploadKickBySession
            // —— 那是 kickUploader 的节流依据，写进去等于伪造"刚上报过"，会让紧随其后的
            // session.idle 上报落进冷却期被吞掉，短任务因此一次都不上报。
            const sid = String(sessionID)
            const now = Date.now()
            const lastKickAt = lastUploadKickBySession.get(sid) || 0
            const heartbeatClockAt = heartbeatClockBySession.get(sid) || 0
            const decision = computeHeartbeatDecision({ now, heartbeatMs, lastKickAt, heartbeatClockAt })
            if (decision === "start-clock") {
              heartbeatClockBySession.set(sid, now)
            } else if (decision === "kick") {
              appendLogLine(
                pluginLogPath,
                `event.heartbeat type=${type} sessionID=${sid} sinceLastMs=${now - (lastKickAt || heartbeatClockAt)} heartbeatMs=${heartbeatMs}`,
              )
              heartbeatClockBySession.set(sid, now)
              kickUploader(sid, false, "heartbeat")
            }
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
