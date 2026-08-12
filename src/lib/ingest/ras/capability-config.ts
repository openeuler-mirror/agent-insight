/**
 * Agent RAS capability config: types, defaults, validation, export helpers.
 * Shape aligns with agent_ras/core/config.py AgentRASConfig.
 */

export const RAS_CAPABILITY_PLATFORMS = [
  'opencode',
  'openjiuwen',
  'xiaoo',
] as const

export type RasCapabilityPlatformId = (typeof RAS_CAPABILITY_PLATFORMS)[number]

export type RasRepeatToolConfig = {
  enabled: boolean
  warning_threshold: number
  critical_threshold: number
  global_breaker_threshold: number
  unknown_tool_threshold: number
}

export type RasLlmThinkingLoopConfig = {
  enabled: boolean
  detection_start_chars: number
  window_max_chars: number
  loop_repeat_threshold: number
  similar_clause_sim_threshold: number
  semantic_eval_chars: number
  semantic_content_enabled: boolean
}

export type RasCapabilityConfigBody = {
  enabled: boolean
  detectors: Record<string, Record<string, unknown>>
  recovery: {
    notify_user_on_warning: boolean
  }
}

export type RasCapabilityConfigEnvelope = {
  platform: RasCapabilityPlatformId
  syncEnabled: boolean
  revision: number
  updatedAt: string
  config: RasCapabilityConfigBody
  platformExtras?: Record<string, unknown>
}

export function defaultRepeatToolConfig(): RasRepeatToolConfig {
  return {
    enabled: true,
    warning_threshold: 5,
    critical_threshold: 10,
    global_breaker_threshold: 10,
    unknown_tool_threshold: 10,
  }
}

export function defaultLlmThinkingLoopConfig(): RasLlmThinkingLoopConfig {
  return {
    enabled: true,
    detection_start_chars: 30000,
    window_max_chars: 2000,
    loop_repeat_threshold: 5,
    similar_clause_sim_threshold: 0.95,
    semantic_eval_chars: 10000,
    semantic_content_enabled: true,
  }
}

export function defaultCapabilityConfigBody(): RasCapabilityConfigBody {
  return {
    enabled: true,
    detectors: {
      repeat_tool: defaultRepeatToolConfig() as unknown as Record<string, unknown>,
      llm_thinking_loop: defaultLlmThinkingLoopConfig() as unknown as Record<string, unknown>,
    },
    recovery: {
      notify_user_on_warning: true,
    },
  }
}

export function defaultEnvelope(
  platform: RasCapabilityPlatformId,
  now = new Date(),
): RasCapabilityConfigEnvelope {
  return {
    platform,
    syncEnabled: false,
    revision: 0,
    updatedAt: now.toISOString(),
    config: defaultCapabilityConfigBody(),
  }
}

export function isRasCapabilityPlatformId(value: unknown): value is RasCapabilityPlatformId {
  return typeof value === 'string' && (RAS_CAPABILITY_PLATFORMS as readonly string[]).includes(value)
}

/** Platforms that can receive automatic client sync. */
export function platformSupportsSync(platform: RasCapabilityPlatformId): boolean {
  return platform === 'opencode' || platform === 'xiaoo'
}

function asFiniteNumber(value: unknown, fallback: number): number | null {
  if (value === undefined || value === null || value === '') return fallback
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return null
  return n
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  return fallback
}

export type ValidateCapabilityResult =
  | { ok: true; config: RasCapabilityConfigBody }
  | { ok: false; error: string }

export function validateCapabilityConfigBody(raw: unknown): ValidateCapabilityResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'config must be an object' }
  }
  const src = raw as Record<string, unknown>
  const detectorsIn = (src.detectors && typeof src.detectors === 'object' && !Array.isArray(src.detectors)
    ? (src.detectors as Record<string, unknown>)
    : {}) as Record<string, unknown>
  const recoveryRaw = (src.recovery && typeof src.recovery === 'object'
    ? src.recovery
    : {}) as Record<string, unknown>

  const defaults = defaultCapabilityConfigBody()
  const repeatDefault = defaults.detectors.repeat_tool as RasRepeatToolConfig
  const loopDefault = defaults.detectors.llm_thinking_loop as RasLlmThinkingLoopConfig
  const repeatRaw = (detectorsIn.repeat_tool && typeof detectorsIn.repeat_tool === 'object'
    ? detectorsIn.repeat_tool
    : {}) as Record<string, unknown>
  const loopRaw = (detectorsIn.llm_thinking_loop && typeof detectorsIn.llm_thinking_loop === 'object'
    ? detectorsIn.llm_thinking_loop
    : {}) as Record<string, unknown>

  const warning = asFiniteNumber(repeatRaw.warning_threshold, repeatDefault.warning_threshold)
  const critical = asFiniteNumber(repeatRaw.critical_threshold, repeatDefault.critical_threshold)
  const globalBreaker = asFiniteNumber(
    repeatRaw.global_breaker_threshold,
    repeatDefault.global_breaker_threshold,
  )
  const unknownTool = asFiniteNumber(
    repeatRaw.unknown_tool_threshold,
    repeatDefault.unknown_tool_threshold,
  )
  const startChars = asFiniteNumber(loopRaw.detection_start_chars, loopDefault.detection_start_chars)
  const windowMax = asFiniteNumber(loopRaw.window_max_chars, loopDefault.window_max_chars)
  const loopRepeat = asFiniteNumber(loopRaw.loop_repeat_threshold, loopDefault.loop_repeat_threshold)
  const similar = asFiniteNumber(
    loopRaw.similar_clause_sim_threshold,
    loopDefault.similar_clause_sim_threshold,
  )
  const semanticChars = asFiniteNumber(loopRaw.semantic_eval_chars, loopDefault.semantic_eval_chars)

  const nums = [
    ['warning_threshold', warning, 2],
    ['critical_threshold', critical, 2],
    ['global_breaker_threshold', globalBreaker, 2],
    ['unknown_tool_threshold', unknownTool, 2],
    ['detection_start_chars', startChars, 1],
    ['window_max_chars', windowMax, 100],
    ['loop_repeat_threshold', loopRepeat, 2],
    ['semantic_eval_chars', semanticChars, 1],
  ] as const

  for (const [name, value, min] of nums) {
    if (value === null) return { ok: false, error: `${name} must be a finite number` }
    if (value < min) return { ok: false, error: `${name} must be >= ${min}` }
  }
  if (similar === null) return { ok: false, error: 'similar_clause_sim_threshold must be a finite number' }
  if (similar < 0 || similar > 1) {
    return { ok: false, error: 'similar_clause_sim_threshold must be between 0 and 1' }
  }

  const detectors: Record<string, Record<string, unknown>> = {
    ...defaults.detectors,
  }
  for (const [key, value] of Object.entries(detectorsIn)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    detectors[key] = { ...(detectors[key] || {}), ...(value as Record<string, unknown>) }
  }
  detectors.repeat_tool = {
    enabled: asBool(repeatRaw.enabled, repeatDefault.enabled),
    warning_threshold: warning!,
    critical_threshold: critical!,
    global_breaker_threshold: globalBreaker!,
    unknown_tool_threshold: unknownTool!,
  }
  detectors.llm_thinking_loop = {
    enabled: asBool(loopRaw.enabled, loopDefault.enabled),
    detection_start_chars: startChars!,
    window_max_chars: windowMax!,
    loop_repeat_threshold: loopRepeat!,
    similar_clause_sim_threshold: similar,
    semantic_eval_chars: semanticChars!,
    semantic_content_enabled: asBool(
      loopRaw.semantic_content_enabled,
      loopDefault.semantic_content_enabled,
    ),
  }

  return {
    ok: true,
    config: {
      enabled: asBool(src.enabled, defaults.enabled),
      detectors,
      recovery: {
        notify_user_on_warning: asBool(
          recoveryRaw.notify_user_on_warning,
          defaults.recovery.notify_user_on_warning,
        ),
      },
    },
  }
}

export type PutCapabilityInput = {
  syncEnabled?: boolean
  config?: unknown
  platformExtras?: Record<string, unknown>
}

export function buildUpdatedEnvelope(
  existing: RasCapabilityConfigEnvelope,
  input: PutCapabilityInput,
  now = new Date(),
): { ok: true; envelope: RasCapabilityConfigEnvelope } | { ok: false; error: string } {
  const validated = validateCapabilityConfigBody(input.config ?? existing.config)
  if (!validated.ok) return validated

  let syncEnabled = existing.syncEnabled
  if (typeof input.syncEnabled === 'boolean') {
    syncEnabled = input.syncEnabled
  }
  if (syncEnabled && !platformSupportsSync(existing.platform)) {
    syncEnabled = false
  }

  const configChanged = JSON.stringify(validated.config) !== JSON.stringify(existing.config)
  const syncChanged = syncEnabled !== existing.syncEnabled
  const extrasChanged =
    input.platformExtras !== undefined &&
    JSON.stringify(input.platformExtras) !== JSON.stringify(existing.platformExtras ?? {})

  const revision =
    configChanged || syncChanged || extrasChanged
      ? existing.revision + 1
      : existing.revision

  return {
    ok: true,
    envelope: {
      platform: existing.platform,
      syncEnabled,
      revision,
      updatedAt: configChanged || syncChanged || extrasChanged ? now.toISOString() : existing.updatedAt,
      config: validated.config,
      platformExtras:
        input.platformExtras !== undefined ? input.platformExtras : existing.platformExtras,
    },
  }
}

/** Shape returned to OpenCode / ingest clients. */
export function toIngestPayload(envelope: RasCapabilityConfigEnvelope): {
  syncEnabled: boolean
  revision: number
  updatedAt: string
  platform: RasCapabilityPlatformId
  config: RasCapabilityConfigBody | null
} {
  return {
    syncEnabled: envelope.syncEnabled && platformSupportsSync(envelope.platform),
    revision: envelope.revision,
    updatedAt: envelope.updatedAt,
    platform: envelope.platform,
    config: envelope.syncEnabled && platformSupportsSync(envelope.platform) ? envelope.config : null,
  }
}

export function exportCapabilityJson(envelope: RasCapabilityConfigEnvelope): string {
  return JSON.stringify(
    {
      agent_ras: {
        enabled: envelope.config.enabled,
        detectors: envelope.config.detectors,
        recovery: envelope.config.recovery,
      },
    },
    null,
    2,
  )
}

export function exportCapabilityYaml(envelope: RasCapabilityConfigEnvelope): string {
  const c = envelope.config
  const lines = ['agent_ras:', `  enabled: ${c.enabled}`, '  detectors:']
  for (const [domainId, raw] of Object.entries(c.detectors)) {
    lines.push(`    ${domainId}:`)
    const fields = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    for (const [k, v] of Object.entries(fields)) {
      lines.push(`      ${k}: ${v}`)
    }
  }
  lines.push('  recovery:')
  lines.push(`    notify_user_on_warning: ${c.recovery.notify_user_on_warning}`)
  lines.push('')
  return lines.join('\n')
}

export type RasCapabilitySyncMeta = {
  revision?: number
  updatedAt?: string
  contentHash?: string
}

/**
 * Merge Insight capability config into a local ras config.json object.
 * Preserves service / insight / unknown keys; stores per-platform slices under
 * ``platforms.<platform>`` with optional ``syncedFrom`` provenance
 * (shared file, multi-platform safe). Legacy ``ras_config_revision(s)`` are dropped.
 */
export function mergeCapabilityIntoLocalRasConfig(
  localConfig: Record<string, unknown>,
  body: RasCapabilityConfigBody,
  syncMeta: RasCapabilitySyncMeta | number = {},
  platform: RasCapabilityPlatformId = 'opencode',
): Record<string, unknown> {
  const root = { ...localConfig }
  const prevRas =
    root.agent_ras && typeof root.agent_ras === 'object' && !Array.isArray(root.agent_ras)
      ? ({ ...(root.agent_ras as Record<string, unknown>) } as Record<string, unknown>)
      : {}

  const meta: RasCapabilitySyncMeta =
    typeof syncMeta === 'number' ? { revision: syncMeta } : syncMeta ?? {}

  const syncedFrom: Record<string, unknown> = {}
  if (typeof meta.contentHash === 'string' && meta.contentHash) {
    syncedFrom.contentHash = meta.contentHash
  }
  if (typeof meta.revision === 'number' && Number.isFinite(meta.revision)) {
    syncedFrom.revision = meta.revision
  }
  if (typeof meta.updatedAt === 'string' && meta.updatedAt) {
    syncedFrom.updatedAt = meta.updatedAt
  }

  const detectorsOut: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body.detectors || {})) {
    detectorsOut[key] = { ...(value as Record<string, unknown>) }
  }

  const slice: Record<string, unknown> = {
    enabled: body.enabled,
    detectors: detectorsOut,
    recovery: { ...body.recovery },
  }
  if (Object.keys(syncedFrom).length > 0) {
    slice.syncedFrom = syncedFrom
  }

  const prevPlatforms =
    prevRas.platforms && typeof prevRas.platforms === 'object' && !Array.isArray(prevRas.platforms)
      ? ({ ...(prevRas.platforms as Record<string, unknown>) } as Record<string, unknown>)
      : {}

  prevPlatforms[platform] = slice

  const nextRas: Record<string, unknown> = {
    ...prevRas,
    enabled: body.enabled,
    detectors: detectorsOut,
    recovery: { ...body.recovery },
    // Keep flat llm_thinking_loop in sync for older plugin readers.
    llm_thinking_loop: {
      ...((body.detectors.llm_thinking_loop as Record<string, unknown>) || {}),
    },
    platforms: prevPlatforms,
  }
  delete nextRas.ras_config_revisions
  delete nextRas.ras_config_revision

  root.agent_ras = nextRas
  return root
}
