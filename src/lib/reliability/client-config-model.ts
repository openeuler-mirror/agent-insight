/**
 * IF-N10/N11 config model: flat JSON-path defaults + overrideDiff merge.
 * Aligns with design §5.1 (textLoop / toolRepeat / notifyUserOnWarning).
 */

export type ReliabilityPlatformId = 'opencode' | 'openjiuwen' | 'xiaoo'

export type ConfigFieldSource = 'builtin' | 'client_override'

export type SchemaFieldType = 'boolean' | 'integer' | 'number' | 'string' | 'enum'

export type BuiltinSchemaField = {
  key: string
  label: string
  type: SchemaFieldType
  min?: number
  max?: number
  required?: boolean
  description?: string
}

export type BuiltinSchemaSection = {
  key: string
  title: string
  description?: string
  enabledField?: string
  fields: BuiltinSchemaField[]
}

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

const SHARED_DEFAULTS: Record<string, unknown> = {
  enabled: false,
  'textLoop.enabled': false,
  'textLoop.detectionStartChars': 300,
  'textLoop.windowMaxChars': 1000,
  'textLoop.repeatThreshold': 5,
  'toolRepeat.enabled': false,
  'toolRepeat.warningThreshold': 5,
  'toolRepeat.criticalThreshold': 10,
  notifyUserOnWarning: false,
}

const SHARED_SECTIONS: BuiltinSchemaSection[] = [
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
  {
    key: 'textLoop',
    title: '思考 / 文本循环',
    description: '检测循环文本和语义重复',
    enabledField: 'textLoop.enabled',
    fields: [
      { key: 'textLoop.enabled', label: '启用思考/文本循环检测', type: 'boolean', required: true },
      {
        key: 'textLoop.detectionStartChars',
        label: '检测起始字符数',
        type: 'integer',
        min: 1,
        max: 100000,
        required: true,
      },
      {
        key: 'textLoop.windowMaxChars',
        label: '窗口最大字符数',
        type: 'integer',
        min: 100,
        max: 100000,
        required: true,
      },
      {
        key: 'textLoop.repeatThreshold',
        label: '重复阈值',
        type: 'integer',
        min: 2,
        max: 100,
        required: true,
      },
    ],
  },
  {
    key: 'toolRepeat',
    title: '工具调用重复',
    description: '检测重复工具调用',
    enabledField: 'toolRepeat.enabled',
    fields: [
      { key: 'toolRepeat.enabled', label: '启用工具重复检测', type: 'boolean', required: true },
      {
        key: 'toolRepeat.warningThreshold',
        label: '警告阈值',
        type: 'integer',
        min: 2,
        max: 100,
        required: true,
      },
      {
        key: 'toolRepeat.criticalThreshold',
        label: '严重阈值',
        type: 'integer',
        min: 2,
        max: 100,
        required: true,
      },
    ],
  },
  {
    key: 'notify',
    title: 'LOW 警告通知用户',
    fields: [
      {
        key: 'notifyUserOnWarning',
        label: 'LOW 警告时通知用户',
        type: 'boolean',
        required: true,
      },
    ],
  },
]

const PLATFORM_TITLES: Record<ReliabilityPlatformId, string> = {
  opencode: 'OpenCode RAS',
  openjiuwen: 'openJiuwen RAS',
  xiaoo: 'xiaO RAS',
}

export function buildBuiltinConfigSchema(platform: ReliabilityPlatformId): BuiltinConfigSchema {
  return {
    schemaVersion: '1.0',
    platform,
    configVersion: `builtin-${platform}-ras@1`,
    title: PLATFORM_TITLES[platform],
    defaults: { ...SHARED_DEFAULTS },
    sections: SHARED_SECTIONS.map((section) => ({
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
  if (!overrideDiff) return out
  for (const [key, value] of Object.entries(overrideDiff)) {
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

/** Map design flat keys → agent_ras capability body for ingest bridge. */
export function flatConfigToCapabilityBody(flat: Record<string, unknown>): {
  enabled: boolean
  detectors: Record<string, Record<string, unknown>>
  recovery: { notify_user_on_warning: boolean }
} {
  return {
    enabled: Boolean(flat.enabled),
    detectors: {
      llm_thinking_loop: {
        enabled: Boolean(flat['textLoop.enabled']),
        detection_start_chars: Number(flat['textLoop.detectionStartChars'] ?? 300),
        window_max_chars: Number(flat['textLoop.windowMaxChars'] ?? 1000),
        loop_repeat_threshold: Number(flat['textLoop.repeatThreshold'] ?? 5),
        similar_clause_sim_threshold: 0.95,
        semantic_eval_chars: 10000,
        semantic_content_enabled: true,
      },
      repeat_tool: {
        enabled: Boolean(flat['toolRepeat.enabled']),
        warning_threshold: Number(flat['toolRepeat.warningThreshold'] ?? 5),
        critical_threshold: Number(flat['toolRepeat.criticalThreshold'] ?? 10),
        global_breaker_threshold: Number(flat['toolRepeat.criticalThreshold'] ?? 10),
        unknown_tool_threshold: 10,
      },
    },
    recovery: {
      notify_user_on_warning: Boolean(flat.notifyUserOnWarning),
    },
  }
}

export type ConfigFieldError = {
  key: string
  label: string
  message: string
}

/**
 * 按内置 Schema 校验配置值。
 *
 * 前后端共用同一份实现（需求文档 §5.1「服务端和客户端使用同一份规则校验」）——
 * 各写一套迟早漂移，届时页面放行的值服务端拒绝，或反之。
 *
 * 只校验传入的键：保存时提交的是 overrideDiff，未覆盖的字段继承内置默认值，
 * 不该因为「没提交」被判成缺失。
 */
export function validateConfigValues(
  // 只取校验真正需要的结构，前端页面自带的 schema 类型也能直接传进来，
  // 不必为了类型对齐而复制一份定义。
  schema: { sections: readonly { fields: readonly BuiltinSchemaField[] }[] },
  values: Record<string, unknown>,
): ConfigFieldError[] {
  const fields = new Map<string, BuiltinSchemaField>()
  for (const section of schema.sections) {
    for (const field of section.fields) fields.set(field.key, field)
  }

  const errors: ConfigFieldError[] = []
  for (const [key, raw] of Object.entries(values)) {
    const field = fields.get(key)
    // Schema 里没有的键（平台升级删掉的旧字段）交给上层迁移处理，这里不报错。
    if (!field) continue

    const fail = (message: string) => errors.push({ key, label: field.label, message })

    if (field.type === 'boolean') {
      if (typeof raw !== 'boolean') fail('必须是 true 或 false')
      continue
    }

    if (field.type === 'integer' || field.type === 'number') {
      // 空串/null 是「清空了输入框」，不是 0 —— 必填字段不允许留空。
      if (raw === '' || raw === null || raw === undefined) {
        if (field.required) fail('不能为空')
        continue
      }
      const num = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(num)) {
        fail('必须是数字')
        continue
      }
      if (field.type === 'integer' && !Number.isInteger(num)) {
        fail('必须是整数')
        continue
      }
      if (typeof field.min === 'number' && num < field.min) {
        fail(`不能小于 ${field.min}`)
        continue
      }
      if (typeof field.max === 'number' && num > field.max) {
        fail(`不能大于 ${field.max}`)
      }
      continue
    }

    if (raw === '' || raw === null || raw === undefined) {
      if (field.required) fail('不能为空')
    }
  }
  return errors
}
