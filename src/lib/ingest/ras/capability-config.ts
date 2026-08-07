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
  detectors: {
    repeat_tool: RasRepeatToolConfig
    llm_thinking_loop: RasLlmThinkingLoopConfig
  }
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
      repeat_tool: defaultRepeatToolConfig(),
      llm_thinking_loop: defaultLlmThinkingLoopConfig(),
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
  const detectors = (src.detectors && typeof src.detectors === 'object'
    ? (src.detectors as Record<string, unknown>)
    : {}) as Record<string, unknown>
  const repeatRaw = (detectors.repeat_tool && typeof detectors.repeat_tool === 'object'
    ? detectors.repeat_tool
    : {}) as Record<string, unknown>
  const loopRaw = (detectors.llm_thinking_loop && typeof detectors.llm_thinking_loop === 'object'
    ? detectors.llm_thinking_loop
    : {}) as Record<string, unknown>
  const recoveryRaw = (src.recovery && typeof src.recovery === 'object'
    ? src.recovery
    : {}) as Record<string, unknown>

  const defaults = defaultCapabilityConfigBody()
  const warning = asFiniteNumber(repeatRaw.warning_threshold, defaults.detectors.repeat_tool.warning_threshold)
  const critical = asFiniteNumber(repeatRaw.critical_threshold, defaults.detectors.repeat_tool.critical_threshold)
  const globalBreaker = asFiniteNumber(
    repeatRaw.global_breaker_threshold,
    defaults.detectors.repeat_tool.global_breaker_threshold,
  )
  const unknownTool = asFiniteNumber(
    repeatRaw.unknown_tool_threshold,
    defaults.detectors.repeat_tool.unknown_tool_threshold,
  )
  const startChars = asFiniteNumber(
    loopRaw.detection_start_chars,
    defaults.detectors.llm_thinking_loop.detection_start_chars,
  )
  const windowMax = asFiniteNumber(
    loopRaw.window_max_chars,
    defaults.detectors.llm_thinking_loop.window_max_chars,
  )
  const loopRepeat = asFiniteNumber(
    loopRaw.loop_repeat_threshold,
    defaults.detectors.llm_thinking_loop.loop_repeat_threshold,
  )
  const similar = asFiniteNumber(
    loopRaw.similar_clause_sim_threshold,
    defaults.detectors.llm_thinking_loop.similar_clause_sim_threshold,
  )
  const semanticChars = asFiniteNumber(
    loopRaw.semantic_eval_chars,
    defaults.detectors.llm_thinking_loop.semantic_eval_chars,
  )

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

  return {
    ok: true,
    config: {
      enabled: asBool(src.enabled, defaults.enabled),
      detectors: {
        repeat_tool: {
          enabled: asBool(repeatRaw.enabled, defaults.detectors.repeat_tool.enabled),
          warning_threshold: warning!,
          critical_threshold: critical!,
          global_breaker_threshold: globalBreaker!,
          unknown_tool_threshold: unknownTool!,
        },
        llm_thinking_loop: {
          enabled: asBool(loopRaw.enabled, defaults.detectors.llm_thinking_loop.enabled),
          detection_start_chars: startChars!,
          window_max_chars: windowMax!,
          loop_repeat_threshold: loopRepeat!,
          similar_clause_sim_threshold: similar,
          semantic_eval_chars: semanticChars!,
          semantic_content_enabled: asBool(
            loopRaw.semantic_content_enabled,
            defaults.detectors.llm_thinking_loop.semantic_content_enabled,
          ),
        },
      },
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
  const rt = c.detectors.repeat_tool
  const loop = c.detectors.llm_thinking_loop
  return [
    'agent_ras:',
    `  enabled: ${c.enabled}`,
    '  detectors:',
    '    repeat_tool:',
    `      enabled: ${rt.enabled}`,
    `      warning_threshold: ${rt.warning_threshold}`,
    `      critical_threshold: ${rt.critical_threshold}`,
    `      global_breaker_threshold: ${rt.global_breaker_threshold}`,
    `      unknown_tool_threshold: ${rt.unknown_tool_threshold}`,
    '    llm_thinking_loop:',
    `      enabled: ${loop.enabled}`,
    `      semantic_content_enabled: ${loop.semantic_content_enabled}`,
    `      detection_start_chars: ${loop.detection_start_chars}`,
    `      window_max_chars: ${loop.window_max_chars}`,
    `      loop_repeat_threshold: ${loop.loop_repeat_threshold}`,
    `      similar_clause_sim_threshold: ${loop.similar_clause_sim_threshold}`,
    `      semantic_eval_chars: ${loop.semantic_eval_chars}`,
    '  recovery:',
    `    notify_user_on_warning: ${c.recovery.notify_user_on_warning}`,
    '',
  ].join('\n')
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

  const slice: Record<string, unknown> = {
    enabled: body.enabled,
    detectors: {
      repeat_tool: { ...body.detectors.repeat_tool },
      llm_thinking_loop: { ...body.detectors.llm_thinking_loop },
    },
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
    detectors: {
      repeat_tool: { ...body.detectors.repeat_tool },
      llm_thinking_loop: { ...body.detectors.llm_thinking_loop },
    },
    recovery: { ...body.recovery },
    // Keep flat llm_thinking_loop in sync for older plugin readers.
    llm_thinking_loop: { ...body.detectors.llm_thinking_loop },
    platforms: prevPlatforms,
  }
  delete nextRas.ras_config_revisions
  delete nextRas.ras_config_revision

  root.agent_ras = nextRas
  return root
}
