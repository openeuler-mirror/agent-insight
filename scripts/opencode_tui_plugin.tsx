// @ts-nocheck
/** @jsxImportSource @opentui/solid */
import { Show, createEffect, createMemo, createSignal } from "solid-js"
import fs from "fs"
import path from "path"
import { spawn } from "child_process"
import { getExistingInsightDir, getInsightEnvCandidates } from "./insight-paths.js"

function parseBool(input: unknown, defaultValue: boolean) {
  if (input === undefined || input === null) return defaultValue
  const value = String(input).trim().toLowerCase()
  if (!value) return defaultValue
  if (value === "1" || value === "true" || value === "yes" || value === "y" || value === "on") return true
  if (value === "0" || value === "false" || value === "no" || value === "n" || value === "off") return false
  return defaultValue
}

function loadSkillInsightConfig() {
  const config: Record<string, string> = {}
  try {
    for (const envPath of getInsightEnvCandidates()) {
      if (!fs.existsSync(envPath)) continue
      const content = fs.readFileSync(envPath, "utf8")
      for (const line of content.split("\n")) {
        const match = line.match(/^\s*([\w_]+)\s*=\s*(.*)?\s*$/)
        if (!match) continue
        const key = match[1]
        const raw = (match[2] || "").trim()
        const value = raw.replace(/^['"](.*)['"]$/, "$1")
        config[key] = value
      }
    }
  } catch {}

  const apiKey = config["AGENT_INSIGHT_API_KEY"] || process.env.AGENT_INSIGHT_API_KEY
  const host = config["AGENT_INSIGHT_HOST"] || process.env.AGENT_INSIGHT_HOST
  const showTaskStats = parseBool(
    config["AGENT_INSIGHT_SHOW_TASK_STATS"] ?? process.env.AGENT_INSIGHT_SHOW_TASK_STATS,
    true,
  )

  return { apiKey, host, showTaskStats }
}

function normalizeHost(host: string) {
  const raw = host.trim()
  if (!raw) return null
  try {
    const urlStr = raw.match(/^https?:\/\//) ? raw : `http://${raw}`
    const u = new URL(urlStr)
    return u
  } catch {
    return null
  }
}

function formatLatencySeconds(input: unknown) {
  const n = typeof input === "number" ? input : Number(input)
  if (!Number.isFinite(n) || n < 0) return "-"
  if (n < 10) return `${n.toFixed(2)}s`
  if (n < 60) return `${n.toFixed(1)}s`
  return `${Math.round(n)}s`
}

function formatNumber(input: unknown) {
  const n = typeof input === "number" ? input : Number(input)
  if (!Number.isFinite(n)) return "-"
  return new Intl.NumberFormat("en-US").format(n)
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms))
}

async function fetchTaskStats(base: URL, taskId: string, apiKey?: string) {
  const url = new URL("/api/task-stats", base)
  url.searchParams.set("taskId", taskId)
  url.searchParams.set("framework", "opencode")
  const headers: Record<string, string> = {}
  if (apiKey) headers["x-witty-api-key"] = apiKey

  const res = await fetch(url, { headers })
  if (!res.ok) return null
  const json = (await res.json()) as any
  if (!json || json.found !== true) return null
  return json
}

function buildDetailsUrl(base: URL, taskId: string) {
  const u = new URL("/trace", base)
  u.searchParams.set("taskId", taskId)
  return u.toString()
}

function openUrl(url: string) {
  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref()
      return true
    }
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true, windowsHide: true }).unref()
      return true
    }
    spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref()
    return true
  } catch {
    return false
  }
}

function formatStatsMessage(stats: any, detailsUrl: string) {
  const latency = formatLatencySeconds(stats?.latency)
  const tokens = formatNumber(stats?.tokens)
  const inputTokens = formatNumber(stats?.input_tokens)
  const outputTokens = formatNumber(stats?.output_tokens)
  const toolCalls = formatNumber(stats?.tool_call_count)
  const llmCalls = formatNumber(stats?.llm_call_count)
  return [
    `时延: ${latency}`,
    `Token: ${tokens} (入: ${inputTokens}, 出: ${outputTokens})`,
    `LLM: ${llmCalls} | 工具: ${toolCalls}`,
    `详情: ${detailsUrl}`,
  ].join("\n")
}

function StatsFooter(props: {
  api: any
  sessionId: string
  getEntry: (sid: string) => any
  ensure: (sid: string) => void
  config: { host?: string; apiKey?: string }
}) {
  const theme = () => props.api.theme.current

  createEffect(() => {
    if (!props.sessionId) return
    props.ensure(props.sessionId)
  })

  const entry = createMemo(() => {
    if (!props.sessionId) return null
    return props.getEntry(props.sessionId)
  })

  const title = createMemo(() => {
    return "Agent Insight"
  })

  return (
    <box gap={1}>
      <Show when={!props.config.host}>
        <box
          backgroundColor={theme().backgroundElement}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
          flexDirection="column"
          gap={0}
        >
          <text fg={theme().text}>
            <b>Agent Insight</b>
          </text>
          <text fg={theme().textMuted}>未配置 AGENT_INSIGHT_HOST</text>
          <text fg={theme().textMuted}>请在 {path.join(getExistingInsightDir(), ".env")} 设置 AGENT_INSIGHT_HOST</text>
        </box>
      </Show>
      <Show when={entry()}>
        {(x: any) => (
          <box
            backgroundColor={theme().backgroundElement}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            paddingRight={2}
            flexDirection="column"
            gap={0}
          >
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().text}>
                <b>{title()}</b>
              </text>
            </box>
            <Show when={x().state === "loading"}>
              <text fg={theme().textMuted}>等待任务执行完毕</text>
            </Show>
            <Show when={x().state === "error"}>
              <text fg={theme().textMuted}>统计暂不可用</text>
            </Show>
            <Show when={x().state === "ready"}>
              <text fg={theme().textMuted}>时延: {formatLatencySeconds(x().stats?.latency)}</text>
              <text fg={theme().textMuted}>
                Token: {formatNumber(x().stats?.tokens)} (入: {formatNumber(x().stats?.input_tokens)}, 出:{" "}
                {formatNumber(x().stats?.output_tokens)})
              </text>
              <text fg={theme().textMuted}>
                LLM: {formatNumber(x().stats?.llm_call_count)} | 工具: {formatNumber(x().stats?.tool_call_count)}
              </text>
              <text
                fg={theme().primary}
                onMouseDown={() => {
                  const ok = openUrl(x().detailsUrl)
                  if (!ok) props.api.ui.toast({ message: "打开失败（可复制链接到浏览器）", variant: "error" })
                }}
              >
                <b>查看详情 ↗</b> <span style={{ fg: theme().textMuted }}>(点击打开)</span>
              </text>
            </Show>
          </box>
        )}
      </Show>
      <Show when={!entry()}>
        <text fg={theme().textMuted}>Agent Insight：暂无任务统计</text>
      </Show>
    </box>
  )
}

const tui = async (api: any) => {
  const [entries, setEntries] = createSignal({})

  const getEntry = (sid: string) => entries()[sid]
  const setEntry = (sid: string, value: any) => {
    const prev = entries()
    setEntries({ ...prev, [sid]: value })
  }

  const ensure = async (sessionId: string, opts?: { force?: boolean }) => {
    const existing = getEntry(sessionId)
    if (existing?.state === "loading") return
    if (!opts?.force && existing?.state === "ready") return

    const cfg = loadSkillInsightConfig()
    if (!cfg.showTaskStats) return
    if (!cfg.host) return
    const base = normalizeHost(cfg.host)
    if (!base) return

    const detailsUrl = buildDetailsUrl(base, sessionId)
    setEntry(sessionId, {
      sessionId,
      state: "loading",
      detailsUrl,
      updatedAt: Date.now(),
      prevTimestamp: existing?.stats?.timestamp,
    })

    let stats: any = null
    const maxAttempts = 8
    for (let i = 0; i < maxAttempts; i++) {
      stats = await fetchTaskStats(base, sessionId, cfg.apiKey)
      if (stats) {
        if (opts?.force && existing?.stats?.timestamp && stats.timestamp) {
          const prevMs = Date.parse(existing.stats.timestamp)
          const curMs = Date.parse(stats.timestamp)
          if (Number.isFinite(prevMs) && Number.isFinite(curMs) && curMs <= prevMs) {
            stats = null
          }
        }
      }
      if (stats) break
      await sleep(i < 2 ? 800 : 1200)
    }

    if (!stats) {
      setEntry(sessionId, { sessionId, state: "error", detailsUrl, updatedAt: Date.now() })
      return
    }

    setEntry(sessionId, { sessionId, state: "ready", detailsUrl, stats, updatedAt: Date.now() })
  }

  api.slots.register({
    order: 80,
    slots: {
      sidebar_content(_ctx: any, props: any) {
        const cfg = loadSkillInsightConfig()
        if (!cfg.showTaskStats) return null
        const sid = props?.session_id
        if (!sid || typeof sid !== "string") return null
        return <StatsFooter api={api} sessionId={sid} getEntry={getEntry} ensure={ensure} config={cfg} />
      },
    },
  })

  api.event.on("session.idle", async (evt: any) => {
    const sessionId =
      evt?.properties?.sessionId ||
      evt?.properties?.sessionID ||
      evt?.properties?.session_id ||
      evt?.session_id ||
      evt?.payload?.session_id

    if (!sessionId || typeof sessionId !== "string") return
    if (!sessionId.startsWith("ses")) return
    api.kv.set("agent_insight_latest_session_id", sessionId)
    ensure(sessionId, { force: true })
  })
}

const plugin = {
  id: "witty-skill-insight-task-stats",
  tui,
}

export default plugin
