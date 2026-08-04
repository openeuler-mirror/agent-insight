/**
 * OpenCode-side helpers: pull Insight capability config and merge into local ras config.json.
 * Fail-open — never throw into the host plugin.
 */
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

/**
 * @param {Record<string, unknown>} localConfig
 * @param {{
 *   enabled: boolean
 *   detectors: {
 *     repeat_tool: Record<string, unknown>
 *     llm_thinking_loop: Record<string, unknown>
 *   }
 *   recovery: Record<string, unknown>
 * }} body
 * @param {number} revision
 */
export function mergeCapabilityIntoLocalRasConfig(localConfig, body, revision) {
  const root = { ...localConfig }
  const prevRas =
    root.agent_ras && typeof root.agent_ras === "object" && !Array.isArray(root.agent_ras)
      ? { ...root.agent_ras }
      : {}

  root.agent_ras = {
    ...prevRas,
    enabled: body.enabled,
    detectors: {
      repeat_tool: { ...body.detectors.repeat_tool },
      llm_thinking_loop: { ...body.detectors.llm_thinking_loop },
    },
    recovery: { ...body.recovery },
    ras_config_revision: revision,
    llm_thinking_loop: { ...body.detectors.llm_thinking_loop },
  }
  return root
}

export function resolveRasHome() {
  return (
    process.env.AGENT_INSIGHT_RAS_HOME ||
    join(homedir(), ".agent-insight", "ras")
  )
}

export function resolveConfigPath(rasHome = resolveRasHome()) {
  return join(rasHome, "config.json")
}

function isLoopbackUrl(urlStr) {
  try {
    const host = new URL(urlStr).hostname
    return host === "localhost" || host === "127.0.0.1" || host === "::1"
  } catch {
    return false
  }
}

/**
 * Default fetch that bypasses HTTP(S)_PROXY for loopback Insight URLs.
 * Corporate proxies often 502 localhost and would silently skip sync (fail-open).
 */
export async function defaultRasConfigFetch(url, init = {}) {
  if (isLoopbackUrl(url)) {
    try {
      const { execFileSync } = await import("node:child_process")
      const headers = init.headers || {}
      const args = ["--noproxy", "*", "-sS", "-f", "-X", init.method || "GET"]
      for (const [k, v] of Object.entries(headers)) {
        args.push("-H", `${k}: ${v}`)
      }
      args.push(String(url))
      const out = execFileSync("curl", args, {
        encoding: "utf8",
        env: {
          ...process.env,
          http_proxy: "",
          https_proxy: "",
          HTTP_PROXY: "",
          HTTPS_PROXY: "",
          ALL_PROXY: "",
          all_proxy: "",
        },
      })
      return {
        ok: true,
        status: 200,
        async json() {
          return JSON.parse(out)
        },
        async text() {
          return out
        },
      }
    } catch (err) {
      // fall through to native fetch
      if (!globalThis.fetch) throw err
    }
  }
  if (!globalThis.fetch) {
    throw new Error("no_fetch")
  }
  return globalThis.fetch(url, init)
}

/**
 * Derive ras-config URL from insight.events_url or env.
 * @param {Record<string, unknown> | null} insight
 */
export function resolveRasConfigUrl(insight) {
  const fromEnv =
    process.env.AGENT_INSIGHT_RAS_CONFIG_URL ||
    process.env.AGENT_INSIGHT_RAS_INGEST_URL ||
    ""
  if (fromEnv) {
    return String(fromEnv).replace(/ras-events\/?$/, "ras-config")
  }
  const eventsUrl = insight && typeof insight.events_url === "string" ? insight.events_url : ""
  if (eventsUrl) {
    return eventsUrl.replace(/ras-events\/?$/, "ras-config")
  }
  return ""
}

/**
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {string} [opts.rasHome]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ applied: boolean, reason: string, revision?: number }>}
 */
export async function syncCapabilityConfigFromInsight(opts = {}) {
  const log = opts.log || (() => {})
  const fetchImpl = opts.fetchImpl || defaultRasConfigFetch
  const rasHome = opts.rasHome || resolveRasHome()
  const configPath = resolveConfigPath(rasHome)

  try {
    if (!existsSync(configPath)) {
      return { applied: false, reason: "no_local_config" }
    }

    let local
    try {
      local = JSON.parse(readFileSync(configPath, "utf8"))
    } catch {
      return { applied: false, reason: "local_config_parse_error" }
    }

    const ras = local?.agent_ras && typeof local.agent_ras === "object" ? local.agent_ras : {}
    const insight = ras.insight && typeof ras.insight === "object" ? ras.insight : {}
    if (insight.enabled === false) {
      return { applied: false, reason: "insight_disabled" }
    }

    const urlBase = resolveRasConfigUrl(insight)
    if (!urlBase) {
      return { applied: false, reason: "no_config_url" }
    }

    const apiKey =
      (typeof insight.api_key === "string" && insight.api_key) ||
      process.env.AGENT_INSIGHT_API_KEY ||
      ""
    if (!apiKey) {
      return { applied: false, reason: "no_api_key" }
    }

    const url = new URL(urlBase)
    if (!url.searchParams.has("platform")) {
      url.searchParams.set("platform", "opencode")
    }

    const res = await fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        "x-witty-api-key": apiKey,
        Accept: "application/json",
      },
    })
    if (!res.ok) {
      log(`[insight-ras] ras-config HTTP ${res.status}`)
      return { applied: false, reason: `http_${res.status}` }
    }

    const payload = await res.json()
    if (!payload || payload.syncEnabled !== true || !payload.config) {
      return { applied: false, reason: "sync_disabled_or_empty", revision: payload?.revision }
    }

    const remoteRevision = Number(payload.revision) || 0
    const localRevision = Number(ras.ras_config_revision) || 0
    if (remoteRevision <= localRevision) {
      return { applied: false, reason: "already_current", revision: localRevision }
    }

    const merged = mergeCapabilityIntoLocalRasConfig(local, payload.config, remoteRevision)
    mkdirSync(dirname(configPath), { recursive: true })
    const tmp = `${configPath}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf8")
    renameSync(tmp, configPath)
    log(`[insight-ras] ras-config applied revision=${remoteRevision}`)
    return { applied: true, reason: "merged", revision: remoteRevision }
  } catch (err) {
    log(`[insight-ras] ras-config sync failed: ${err?.message || err}`)
    return { applied: false, reason: "exception" }
  }
}
