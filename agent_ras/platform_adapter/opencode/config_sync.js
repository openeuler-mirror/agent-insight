/**
 * OpenCode-side helpers: pull Insight capability config and merge into local ras config.json.
 * Fail-open — never throw into the host plugin.
 *
 * Local layout (shared file, per-platform slices):
 *   agent_ras.platforms.<platform>              # enabled / detectors / recovery
 *   agent_ras.platforms.<platform>.syncedFrom   # Insight provenance (not a decision cursor)
 *
 * Merge decision is content-fingerprint only (Insight wins on drift).
 * Top-level detectors/recovery remain a legacy mirror of the last merged platform;
 * readers should prefer platforms.<platform>.
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

function capabilitySlice(body) {
  const detectors = body?.detectors && typeof body.detectors === "object" ? body.detectors : {}
  const repeatTool =
    detectors.repeat_tool && typeof detectors.repeat_tool === "object" ? detectors.repeat_tool : {}
  const thinking =
    detectors.llm_thinking_loop && typeof detectors.llm_thinking_loop === "object"
      ? detectors.llm_thinking_loop
      : {}
  const recovery = body?.recovery && typeof body.recovery === "object" ? body.recovery : {}
  return {
    enabled: Boolean(body?.enabled ?? true),
    detectors: {
      repeat_tool: { ...repeatTool },
      llm_thinking_loop: { ...thinking },
    },
    recovery: { ...recovery },
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`
  }
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`
}

export function capabilityFingerprint(body) {
  if (!body || typeof body !== "object") return ""
  return stableStringify(capabilitySlice(body))
}

export function capabilityContentHash(body) {
  const fp = capabilityFingerprint(body)
  if (!fp) return ""
  return createHash("sha256").update(fp).digest("hex").slice(0, 16)
}

/**
 * @param {Record<string, unknown> | null | undefined} ras
 * @param {string} platform
 * @returns {{ enabled: boolean, detectors: object, recovery: object } | null}
 */
export function resolvePlatformCapabilityFromRas(ras, platform) {
  if (!ras || typeof ras !== "object") return null
  const platforms = ras.platforms
  if (platforms && typeof platforms === "object" && !Array.isArray(platforms)) {
    const slot = platforms[platform]
    if (slot && typeof slot === "object" && ("detectors" in slot || "recovery" in slot || "enabled" in slot)) {
      return capabilitySlice(slot)
    }
    if (Object.keys(platforms).length > 0) return null
  }
  if (ras.detectors != null || ras.recovery != null) {
    return capabilitySlice(ras)
  }
  return null
}

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
 * @param {{ revision?: number, updatedAt?: string, contentHash?: string } | number | null | undefined} syncMeta
 * @param {string} [platform]
 */
export function mergeCapabilityIntoLocalRasConfig(localConfig, body, syncMeta, platform = "opencode") {
  const root = { ...localConfig }
  const prevRas =
    root.agent_ras && typeof root.agent_ras === "object" && !Array.isArray(root.agent_ras)
      ? { ...root.agent_ras }
      : {}

  const slice = capabilitySlice(body)
  const prevPlatforms =
    prevRas.platforms && typeof prevRas.platforms === "object" && !Array.isArray(prevRas.platforms)
      ? { ...prevRas.platforms }
      : {}

  const metaIn =
    syncMeta && typeof syncMeta === "object" && !Array.isArray(syncMeta)
      ? syncMeta
      : typeof syncMeta === "number"
        ? { revision: syncMeta }
        : {}
  const contentHash =
    typeof metaIn.contentHash === "string" && metaIn.contentHash
      ? metaIn.contentHash
      : capabilityContentHash(slice)
  const syncedFrom = {
    contentHash,
  }
  if (typeof metaIn.revision === "number" && Number.isFinite(metaIn.revision)) {
    syncedFrom.revision = metaIn.revision
  }
  if (typeof metaIn.updatedAt === "string" && metaIn.updatedAt) {
    syncedFrom.updatedAt = metaIn.updatedAt
  }

  prevPlatforms[platform] = {
    ...slice,
    syncedFrom,
  }

  const nextRas = {
    ...prevRas,
    enabled: slice.enabled,
    detectors: {
      repeat_tool: { ...slice.detectors.repeat_tool },
      llm_thinking_loop: { ...slice.detectors.llm_thinking_loop },
    },
    recovery: { ...slice.recovery },
    llm_thinking_loop: { ...slice.detectors.llm_thinking_loop },
    platforms: prevPlatforms,
  }
  // Drop legacy integer revision maps — fingerprint + syncedFrom replace them.
  delete nextRas.ras_config_revisions
  delete nextRas.ras_config_revision

  root.agent_ras = nextRas
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

/** Loopback ras-config curl connect timeout (seconds). Keep short: runs on OpenCode plugin init. */
export const RAS_CONFIG_CURL_CONNECT_S = 2
/** Loopback ras-config curl total timeout (seconds). */
export const RAS_CONFIG_CURL_MAX_S = 3
/** execFileSync hard cap (ms); slightly above curl max so curl exits first. */
export const RAS_CONFIG_CURL_EXEC_MS = 4000
/** Fallback fetch AbortSignal timeout when curl binary is missing (ms). */
export const RAS_CONFIG_FETCH_FALLBACK_MS = 3000

/**
 * Default fetch that bypasses HTTP(S)_PROXY for loopback Insight URLs.
 * Corporate proxies often 502 localhost and would silently skip sync (fail-open).
 * Hard timeouts so a down Insight board cannot block OpenCode plugin load (~2min curl default).
 */
export async function defaultRasConfigFetch(url, init = {}) {
  if (isLoopbackUrl(url)) {
    try {
      const { execFileSync } = await import("node:child_process")
      const headers = init.headers || {}
      const args = [
        "--noproxy",
        "*",
        "-sS",
        "-f",
        "--connect-timeout",
        String(RAS_CONFIG_CURL_CONNECT_S),
        "--max-time",
        String(RAS_CONFIG_CURL_MAX_S),
        "-X",
        init.method || "GET",
      ]
      for (const [k, v] of Object.entries(headers)) {
        args.push("-H", `${k}: ${v}`)
      }
      args.push(String(url))
      const out = execFileSync("curl", args, {
        encoding: "utf8",
        timeout: RAS_CONFIG_CURL_EXEC_MS,
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
      // curl missing → timed native fetch. Any other failure (down board, timeout):
      // rethrow so syncCapabilityConfigFromInsight fail-opens without proxied fetch hang.
      const code = err && typeof err === "object" ? err.code : undefined
      if (code !== "ENOENT") throw err
      if (!globalThis.fetch) throw err
      const signal =
        init.signal ||
        (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(RAS_CONFIG_FETCH_FALLBACK_MS)
          : undefined)
      return globalThis.fetch(url, { ...init, signal })
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
 * @param {string} [opts.platform]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ applied: boolean, reason: string, revision?: number, contentHash?: string }>}
 */
export async function syncCapabilityConfigFromInsight(opts = {}) {
  const log = opts.log || (() => {})
  const fetchImpl = opts.fetchImpl || defaultRasConfigFetch
  const rasHome = opts.rasHome || resolveRasHome()
  const platform = opts.platform || "opencode"
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
      url.searchParams.set("platform", platform)
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
    const remoteUpdatedAt = typeof payload.updatedAt === "string" ? payload.updatedAt : undefined
    const remoteCfg = payload.config && typeof payload.config === "object" ? payload.config : {}
    const localSlice = resolvePlatformCapabilityFromRas(ras, platform)
    const remoteFp = capabilityFingerprint(remoteCfg)
    const localFp = capabilityFingerprint(localSlice)
    const contentHash = capabilityContentHash(remoteCfg)

    const platforms =
      ras.platforms && typeof ras.platforms === "object" && !Array.isArray(ras.platforms)
        ? ras.platforms
        : null
    const slot = platforms && platforms[platform] && typeof platforms[platform] === "object"
      ? platforms[platform]
      : null
    const hasSyncedFrom =
      Boolean(slot?.syncedFrom) &&
      typeof slot.syncedFrom === "object" &&
      typeof slot.syncedFrom.contentHash === "string" &&
      slot.syncedFrom.contentHash.length > 0
    const hasLegacyRevisionKeys =
      Object.prototype.hasOwnProperty.call(ras, "ras_config_revisions") ||
      Object.prototype.hasOwnProperty.call(ras, "ras_config_revision")

    if (localFp && localFp === remoteFp && hasSyncedFrom && !hasLegacyRevisionKeys) {
      return {
        applied: false,
        reason: "already_current",
        revision: remoteRevision,
        contentHash,
      }
    }

    const merged = mergeCapabilityIntoLocalRasConfig(
      local,
      remoteCfg,
      { revision: remoteRevision, updatedAt: remoteUpdatedAt, contentHash },
      platform,
    )
    mkdirSync(dirname(configPath), { recursive: true })
    const tmp = `${configPath}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf8")
    renameSync(tmp, configPath)
    let reason = "merged"
    if (localFp && localFp === remoteFp) reason = "layout_migrate"
    else if (localFp) reason = "content_drift"
    log(
      `[insight-ras] ras-config applied platform=${platform} contentHash=${contentHash} reason=${reason}`,
    )
    return { applied: true, reason, revision: remoteRevision, contentHash }
  } catch (err) {
    log(`[insight-ras] ras-config sync failed: ${err?.message || err}`)
    return { applied: false, reason: "exception" }
  }
}
