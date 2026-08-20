/**
 * Agent RAS capability config: types, defaults, validation, export helpers.
 * Defaults come from agent_ras_config.default.yaml; field checks from catalog configSchema.
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  getRasCapabilityCatalogSync,
  type RasCatalogDomain,
} from '@/lib/ingest/ras/catalog-engine'
import { INSIGHT_LEGACY_FLAT_ALIASES } from '@/lib/ingest/ras/insight-legacy-flat-aliases'

export const RAS_CAPABILITY_PLATFORMS = [
  'opencode',
  'openjiuwen',
  'xiaoo',
] as const

export type RasCapabilityPlatformId = (typeof RAS_CAPABILITY_PLATFORMS)[number]

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

function defaultYamlPath(): string {
  return path.join(process.cwd(), 'agent_ras', 'config', 'agent_ras_config.default.yaml')
}

/** Minimal indented YAML object parser for agent_ras_config.default.yaml shape. */
export function parseSimpleYamlObject(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  const stack: { indent: number; obj: Record<string, unknown> }[] = [{ indent: -1, obj: root }]
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '')
    if (!line.trim()) continue
    const indent = (raw.match(/^\s*/) || [''])[0].length
    const m = line.trim().match(/^([A-Za-z0-9_.]+):\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    let value: unknown = m[2]
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const parent = stack[stack.length - 1].obj
    if (value === '') {
      const child: Record<string, unknown> = {}
      parent[key] = child
      stack.push({ indent, obj: child })
      continue
    }
    if (value === 'true') value = true
    else if (value === 'false') value = false
    else if (/^-?\d+(\.\d+)?$/.test(String(value))) value = Number(value)
    else value = String(value).replace(/^["']|["']$/g, '')
    parent[key] = value
  }
  return root
}

function loadDefaultYamlRoot(): Record<string, unknown> {
  const yamlPath = defaultYamlPath()
  try {
    if (!fs.existsSync(yamlPath)) return {}
    return parseSimpleYamlObject(fs.readFileSync(yamlPath, 'utf8'))
  } catch {
    return {}
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

export function defaultCapabilityConfigBody(): RasCapabilityConfigBody {
  const root = loadDefaultYamlRoot()
  const ras = asObject(root.agent_ras)
  const detectorsIn = asObject(ras.detectors)
  const detectors: Record<string, Record<string, unknown>> = {}
  for (const [id, raw] of Object.entries(detectorsIn)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    detectors[id] = { ...(raw as Record<string, unknown>) }
  }
  const recovery = asObject(ras.recovery)
  return {
    enabled: ras.enabled !== false,
    detectors,
    recovery: {
      notify_user_on_warning: recovery.notify_user_on_warning !== false,
    },
  }
}

/** Old IF-N10 flat keys → nested detectors/recovery paths (frozen; new domains skip). */
export function legacyFlatAliases(): Record<string, string> {
  return { ...INSIGHT_LEGACY_FLAT_ALIASES }
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

type JsonSchemaNode = {
  type?: string
  properties?: Record<string, JsonSchemaNode>
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number | boolean
  exclusiveMaximum?: number | boolean
  default?: unknown
}

function catalogDomains(): RasCatalogDomain[] {
  try {
    return getRasCapabilityCatalogSync().domains || []
  } catch {
    return []
  }
}

function schemaForDomain(domainId: string): JsonSchemaNode | undefined {
  const domain = catalogDomains().find((d) => d.id === domainId)
  const schema = domain?.configSchema
  if (schema && typeof schema === 'object') return schema as JsonSchemaNode
  return undefined
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

function checkBounds(name: string, n: number, schema: JsonSchemaNode): string | null {
  if (typeof schema.minimum === 'number' && n < schema.minimum) {
    return `${name} must be >= ${schema.minimum}`
  }
  if (typeof schema.maximum === 'number' && n > schema.maximum) {
    return `${name} must be <= ${schema.maximum}`
  }
  if (typeof schema.exclusiveMinimum === 'number' && n <= schema.exclusiveMinimum) {
    return `${name} must be > ${schema.exclusiveMinimum}`
  }
  if (typeof schema.exclusiveMaximum === 'number' && n >= schema.exclusiveMaximum) {
    return `${name} must be < ${schema.exclusiveMaximum}`
  }
  return null
}

function coerceField(
  name: string,
  raw: unknown,
  schema: JsonSchemaNode,
  fallback: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const type = schema.type
  if (type === 'boolean') {
    return { ok: true, value: asBool(raw, Boolean(fallback)) }
  }
  if (type === 'integer' || type === 'number') {
    const fb = typeof fallback === 'number' ? fallback : Number(schema.default ?? 0)
    const n = asFiniteNumber(raw, fb)
    if (n === null) return { ok: false, error: `${name} must be a finite number` }
    if (type === 'integer' && !Number.isInteger(n)) {
      return { ok: false, error: `${name} must be an integer` }
    }
    const bound = checkBounds(name, n, schema)
    if (bound) return { ok: false, error: bound }
    return { ok: true, value: n }
  }
  if (type === 'string') {
    if (raw === undefined || raw === null) return { ok: true, value: fallback ?? '' }
    return { ok: true, value: String(raw) }
  }
  if (raw === undefined) return { ok: true, value: fallback }
  return { ok: true, value: raw }
}

function coerceDetector(
  domainId: string,
  raw: Record<string, unknown>,
  defaults: Record<string, unknown>,
  schema: JsonSchemaNode | undefined,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!schema || !schema.properties) {
    return { ok: true, value: { ...defaults, ...raw } }
  }
  const out: Record<string, unknown> = { ...defaults }
  for (const [field, fieldSchema] of Object.entries(schema.properties)) {
    const coerced = coerceField(
      `${domainId}.${field}`,
      raw[field] !== undefined ? raw[field] : defaults[field],
      fieldSchema,
      defaults[field] ?? fieldSchema.default,
    )
    if (!coerced.ok) return coerced
    out[field] = coerced.value
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in out)) out[key] = value
  }
  return { ok: true, value: out }
}

export type ValidateCapabilityResult =
  | { ok: true; config: RasCapabilityConfigBody }
  | { ok: false; error: string }

export function validateCapabilityConfigBody(raw: unknown): ValidateCapabilityResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'config must be an object' }
  }
  const src = raw as Record<string, unknown>
  const detectorsIn = asObject(src.detectors)
  const recoveryRaw = asObject(src.recovery)
  const defaults = defaultCapabilityConfigBody()

  const detectors: Record<string, Record<string, unknown>> = { ...defaults.detectors }
  const ids = new Set([...Object.keys(defaults.detectors), ...Object.keys(detectorsIn)])
  for (const id of ids) {
    const incoming = detectorsIn[id]
    if (incoming !== undefined && (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming))) {
      continue
    }
    const mergedRaw = {
      ...(defaults.detectors[id] || {}),
      ...asObject(incoming),
    }
    const coerced = coerceDetector(id, mergedRaw, defaults.detectors[id] || {}, schemaForDomain(id))
    if (!coerced.ok) return coerced
    detectors[id] = coerced.value
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
 * (shared file, multi-platform safe). Drops leftover top-level flat domain
 * keys and ``ras_config_revision(s)``.
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
    platforms: prevPlatforms,
  }
  const keep = new Set(['enabled', 'service', 'insight', 'detectors', 'recovery', 'platforms', 'debug'])
  for (const key of Object.keys(nextRas)) {
    if (key === 'ras_config_revisions' || key === 'ras_config_revision') {
      delete nextRas[key]
    } else if (
      !keep.has(key) &&
      nextRas[key] &&
      typeof nextRas[key] === 'object' &&
      !Array.isArray(nextRas[key])
    ) {
      delete nextRas[key]
    }
  }

  root.agent_ras = nextRas
  return root
}
