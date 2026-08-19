/**
 * IF-N10/N11 config model: flat JSON-path defaults + overrideDiff merge.
 * Sections / defaults come from catalog configSchema + yaml.
 * overrideDiff keys are catalog paths (`detectors.<id>.*`, `recovery.*`, top-level `enabled`).
 */

import { defaultCapabilityConfigBody } from '@/lib/ingest/ras/capability-config'
import {
  getRasCapabilityCatalogSync,
  type RasCatalogDomain,
} from '@/lib/ingest/ras/catalog-engine'
import type {
  BuiltinSchemaField,
  BuiltinSchemaSection,
  SchemaFieldType,
} from '@/lib/reliability/client-config-validation'
import { validateConfigValues } from '@/lib/reliability/client-config-validation'

export type {
  BuiltinSchemaField,
  BuiltinSchemaSection,
  ConfigFieldError,
  SchemaFieldType,
} from '@/lib/reliability/client-config-validation'
export { validateConfigValues }

export type ReliabilityPlatformId = 'opencode' | 'openjiuwen' | 'xiaoo'

export type ConfigFieldSource = 'builtin' | 'client_override'

export type BuiltinConfigSchema = {
  schemaVersion: string
  platform: ReliabilityPlatformId
  configVersion: string
  title: string
  defaults: Record<string, unknown>
  sections: BuiltinSchemaSection[]
  editable: false
  source: 'builtin'
  updatedWithProductVersion: string
}

const PLATFORMS: ReliabilityPlatformId[] = ['opencode', 'openjiuwen', 'xiaoo']

export function isReliabilityPlatformId(value: unknown): value is ReliabilityPlatformId {
  return typeof value === 'string' && (PLATFORMS as string[]).includes(value)
}

export function listReliabilityPlatformIds(): ReliabilityPlatformId[] {
  return [...PLATFORMS]
}

function yamlFlatDefaults(): Record<string, unknown> {
  const body = defaultCapabilityConfigBody()
  const nested: Record<string, unknown> = {
    enabled: body.enabled,
    detectors: body.detectors,
    recovery: body.recovery,
  }
  return flattenEffectiveConfig(nested)
}

function schemaTypeOf(node: Record<string, unknown>): SchemaFieldType {
  const t = node.type
  if (t === 'boolean') return 'boolean'
  if (t === 'integer') return 'integer'
  if (t === 'number') return 'number'
  if (t === 'string') return 'string'
  return 'string'
}

function fieldFromSchema(
  pathKey: string,
  name: string,
  node: Record<string, unknown>,
): BuiltinSchemaField {
  const field: BuiltinSchemaField = {
    key: pathKey,
    label: String(node.title || node.description || name),
    type: schemaTypeOf(node),
    required: true,
  }
  if (typeof node.minimum === 'number') field.min = node.minimum
  if (typeof node.maximum === 'number') field.max = node.maximum
  if (typeof node.description === 'string' && node.description !== field.label) {
    field.description = node.description
  }
  return field
}

function sectionForDomain(domain: RasCatalogDomain): BuiltinSchemaSection {
  const schema = (domain.configSchema || {}) as Record<string, unknown>
  const properties = (schema.properties || {}) as Record<string, Record<string, unknown>>
  const fields: BuiltinSchemaField[] = []
  for (const [name, node] of Object.entries(properties)) {
    if (!node || typeof node !== 'object') continue
    fields.push(fieldFromSchema(`detectors.${domain.id}.${name}`, name, node))
  }
  const title =
    (domain.label && (domain.label.zh || domain.label.en)) || domain.id
  const enabledField = properties.enabled
    ? `detectors.${domain.id}.enabled`
    : undefined
  return {
    key: `detectors.${domain.id}`,
    title,
    enabledField,
    fields,
  }
}

function buildSectionsAndDefaults(): {
  defaults: Record<string, unknown>
  sections: BuiltinSchemaSection[]
} {
  const defaults = yamlFlatDefaults()
  const sections: BuiltinSchemaSection[] = [
    {
      key: 'enabled',
      title: '启用 Agent RAS',
      fields: [
        {
          key: 'enabled',
          label: '启用 Agent RAS',
          type: 'boolean',
          required: true,
          description: '总开关关闭时，各分组参数保留但不生效',
        },
      ],
    },
  ]
  try {
    const catalog = getRasCapabilityCatalogSync()
    const domains = [...(catalog.domains || [])].sort(
      (a, b) => (a.order ?? a.priority ?? 100) - (b.order ?? b.priority ?? 100),
    )
    for (const domain of domains) {
      sections.push(sectionForDomain(domain))
    }
  } catch {
    for (const key of Object.keys(defaults)) {
      if (!key.startsWith('detectors.')) continue
      const parts = key.split('.')
      if (parts.length !== 3) continue
      const sectionKey = `detectors.${parts[1]}`
      let section = sections.find((s) => s.key === sectionKey)
      if (!section) {
        section = { key: sectionKey, title: parts[1], fields: [] }
        sections.push(section)
      }
      const value = defaults[key]
      const type: SchemaFieldType =
        typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'string'
      section.fields.push({
        key,
        label: parts[2],
        type,
        required: true,
      })
    }
  }
  sections.push({
    key: 'notify',
    title: 'LOW 警告通知用户',
    fields: [
      {
        key: 'recovery.notify_user_on_warning',
        label: 'LOW 警告时通知用户',
        type: 'boolean',
        required: true,
      },
    ],
  })
  return { defaults, sections }
}

const PLATFORM_TITLES: Record<ReliabilityPlatformId, string> = {
  opencode: 'OpenCode RAS',
  openjiuwen: 'openJiuwen RAS',
  xiaoo: 'xiaO RAS',
}

export function buildBuiltinConfigSchema(platform: ReliabilityPlatformId): BuiltinConfigSchema {
  const { defaults, sections } = buildSectionsAndDefaults()
  return {
    schemaVersion: '1.0',
    platform,
    configVersion: `builtin-${platform}-ras@1`,
    title: PLATFORM_TITLES[platform],
    defaults,
    sections: sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) => ({ ...field })),
    })),
    editable: false,
    source: 'builtin',
    updatedWithProductVersion: '1.8.0',
  }
}

export function applyOverrideDiff(
  defaults: Record<string, unknown>,
  overrideDiff: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...defaults }
  for (const [key, value] of Object.entries(overrideDiff || {})) {
    if (value === undefined) continue
    out[key] = value
  }
  return out
}

export function buildFieldSources(
  defaults: Record<string, unknown>,
  overrideDiff: Record<string, unknown> | null | undefined,
): Record<string, ConfigFieldSource> {
  const sources: Record<string, ConfigFieldSource> = {}
  for (const key of Object.keys(defaults)) {
    sources[key] =
      overrideDiff && Object.prototype.hasOwnProperty.call(overrideDiff, key)
        ? 'client_override'
        : 'builtin'
  }
  if (overrideDiff) {
    for (const key of Object.keys(overrideDiff)) {
      if (!(key in sources)) sources[key] = 'client_override'
    }
  }
  return sources
}

export function deleteOverridePath(
  overrideDiff: Record<string, unknown>,
  pathKey?: string | null,
): Record<string, unknown> {
  if (!pathKey) return {}
  const next = { ...overrideDiff }
  const prefix = `${pathKey}.`
  for (const key of Object.keys(next)) {
    if (key === pathKey || key.startsWith(prefix)) delete next[key]
  }
  return next
}

/** Flat path map → nested object for IF-N11 effectiveConfig. */
export function nestEffectiveConfig(flat: Record<string, unknown>): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  for (const [pathKey, value] of Object.entries(flat)) {
    const parts = pathKey.split('.')
    let cursor: Record<string, unknown> = root
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]
      const existing = cursor[part]
      if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
        cursor[part] = {}
      }
      cursor = cursor[part] as Record<string, unknown>
    }
    cursor[parts[parts.length - 1]] = value
  }
  return root
}

/** Nested object → flat path map (only leaf values). */
export function flattenEffectiveConfig(
  nested: Record<string, unknown>,
  prefix = '',
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(nested)) {
    const pathKey = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flattenEffectiveConfig(value as Record<string, unknown>, pathKey))
    } else {
      out[pathKey] = value
    }
  }
  return out
}

/** Flat path map → capability body. Nested `detectors` keys pass through. */
export function flatConfigToCapabilityBody(flat: Record<string, unknown>): {
  enabled: boolean
  detectors: Record<string, Record<string, unknown>>
  recovery: { notify_user_on_warning: boolean }
} {
  const defaults = defaultCapabilityConfigBody()
  const nested = nestEffectiveConfig(flat)
  const detectorsIn = (nested.detectors && typeof nested.detectors === 'object' && !Array.isArray(nested.detectors)
    ? (nested.detectors as Record<string, unknown>)
    : {}) as Record<string, unknown>
  const detectors: Record<string, Record<string, unknown>> = {}
  const ids = new Set([...Object.keys(defaults.detectors), ...Object.keys(detectorsIn)])
  for (const id of ids) {
    const base = defaults.detectors[id] || {}
    const extra = detectorsIn[id]
    detectors[id] = {
      ...base,
      ...(extra && typeof extra === 'object' && !Array.isArray(extra)
        ? (extra as Record<string, unknown>)
        : {}),
    }
  }
  const recoveryNested = (nested.recovery && typeof nested.recovery === 'object'
    ? (nested.recovery as Record<string, unknown>)
    : {}) as Record<string, unknown>
  const notify =
    recoveryNested.notify_user_on_warning !== undefined
      ? Boolean(recoveryNested.notify_user_on_warning)
      : defaults.recovery.notify_user_on_warning
  return {
    enabled: flat.enabled !== undefined ? Boolean(flat.enabled) : defaults.enabled,
    detectors,
    recovery: { notify_user_on_warning: notify },
  }
}

