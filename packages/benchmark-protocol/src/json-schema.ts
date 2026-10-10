import type { JsonValue } from './contracts'
import { BenchmarkProtocolError } from './errors'

type JsonObject = { [key: string]: JsonValue }

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function valueType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

function matchesType(value: unknown, expected: string): boolean {
  if (expected === 'object') return isObject(value)
  if (expected === 'array') return Array.isArray(value)
  if (expected === 'null') return value === null
  if (expected === 'integer') return Number.isInteger(value)
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === expected
}

function validate(value: unknown, schemaValue: JsonValue, path: string): string | null {
  if (schemaValue === true) return null
  if (schemaValue === false) return `${path} 不允许任何值`
  if (!isObject(schemaValue)) return `${path} 的 Schema 不是对象`

  if ('const' in schemaValue && JSON.stringify(value) !== JSON.stringify(schemaValue.const)) {
    return `${path} 必须等于 ${JSON.stringify(schemaValue.const)}`
  }
  if (Array.isArray(schemaValue.enum) && !schemaValue.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    return `${path} 不在允许值范围内`
  }
  for (const keyword of ['oneOf', 'anyOf'] as const) {
    const candidates = schemaValue[keyword]
    if (Array.isArray(candidates)) {
      const matches = candidates.filter((candidate) => validate(value, candidate, path) === null).length
      if ((keyword === 'oneOf' && matches !== 1) || (keyword === 'anyOf' && matches < 1)) {
        return `${path} 不符合 ${keyword} 约束`
      }
    }
  }

  const expectedTypes = Array.isArray(schemaValue.type)
    ? schemaValue.type.filter((item): item is string => typeof item === 'string')
    : typeof schemaValue.type === 'string' ? [schemaValue.type] : []
  if (expectedTypes.length && !expectedTypes.some((expected) => matchesType(value, expected))) {
    return `${path} 类型应为 ${expectedTypes.join('|')}，实际为 ${valueType(value)}`
  }

  if (typeof value === 'string') {
    if (typeof schemaValue.minLength === 'number' && value.length < schemaValue.minLength) {
      return `${path} 长度小于 ${schemaValue.minLength}`
    }
    if (typeof schemaValue.maxLength === 'number' && value.length > schemaValue.maxLength) {
      return `${path} 长度超过 ${schemaValue.maxLength}`
    }
    if (typeof schemaValue.pattern === 'string' && !new RegExp(schemaValue.pattern).test(value)) {
      return `${path} 不符合格式约束`
    }
  }
  if (typeof value === 'number') {
    if (typeof schemaValue.minimum === 'number' && value < schemaValue.minimum) return `${path} 小于最小值`
    if (typeof schemaValue.maximum === 'number' && value > schemaValue.maximum) return `${path} 大于最大值`
  }
  if (Array.isArray(value)) {
    if (typeof schemaValue.minItems === 'number' && value.length < schemaValue.minItems) return `${path} 元素不足`
    if (typeof schemaValue.maxItems === 'number' && value.length > schemaValue.maxItems) return `${path} 元素过多`
    if (schemaValue.items !== undefined) {
      for (let index = 0; index < value.length; index += 1) {
        const issue = validate(value[index], schemaValue.items, `${path}[${index}]`)
        if (issue) return issue
      }
    }
  }
  if (isObject(value)) {
    const properties = isObject(schemaValue.properties) ? schemaValue.properties : {}
    const required = Array.isArray(schemaValue.required)
      ? schemaValue.required.filter((item): item is string => typeof item === 'string')
      : []
    for (const key of required) {
      if (!(key in value)) return `${path}.${key} 为必填字段`
    }
    for (const [key, item] of Object.entries(value)) {
      if (key in properties) {
        const issue = validate(item, properties[key], `${path}.${key}`)
        if (issue) return issue
      } else if (schemaValue.additionalProperties === false) {
        return `${path}.${key} 是未知字段`
      } else if (isObject(schemaValue.additionalProperties)) {
        const issue = validate(item, schemaValue.additionalProperties, `${path}.${key}`)
        if (issue) return issue
      }
    }
  }
  return null
}

export function assertJsonSchema(
  value: unknown,
  schema: JsonValue,
  code: string,
  label: string,
): void {
  const issue = validate(value, schema, '$')
  if (issue) throw new BenchmarkProtocolError(code, `${label}：${issue}`)
}

function scalarStrings(value: unknown, output: Set<string>): void {
  if (typeof value === 'string' && value.length >= 4) output.add(value)
  else if (Array.isArray(value)) value.forEach((item) => scalarStrings(item, output))
  else if (isObject(value)) Object.values(value).forEach((item) => scalarStrings(item, output))
}

export function assertAgentVisibilityBoundary(
  rawCase: unknown,
  publicPayload: JsonValue,
  schema: JsonValue,
): void {
  if (!isObject(rawCase) || !isObject(schema) || !isObject(schema.properties)) return
  const publicSourceStrings = new Set<string>()
  const privateSourceStrings = new Set<string>()
  const privateKeys = new Set<string>()
  for (const [key, propertySchema] of Object.entries(schema.properties)) {
    if (!isObject(propertySchema)) continue
    const visibility = propertySchema['x-agent-visibility']
    if (visibility === 'private') {
      privateKeys.add(key.toLowerCase())
      scalarStrings(rawCase[key], privateSourceStrings)
    } else if (visibility === 'public') {
      scalarStrings(rawCase[key], publicSourceStrings)
    }
  }
  const publicJson = JSON.stringify(publicPayload)
  const scanKeys = (value: JsonValue): void => {
    if (Array.isArray(value)) return value.forEach(scanKeys)
    if (!isObject(value)) return
    for (const [key, item] of Object.entries(value)) {
      if (privateKeys.has(key.toLowerCase())) {
        throw new BenchmarkProtocolError('PRIVATE_FIELD_EXPOSED', `私有字段进入 publicPayload：${key}`)
      }
      scanKeys(item)
    }
  }
  scanKeys(publicPayload)
  for (const secret of privateSourceStrings) {
    const legitimatelyPublic = [...publicSourceStrings].some((text) => text.includes(secret))
    if (!legitimatelyPublic && publicJson.includes(secret)) {
      throw new BenchmarkProtocolError('PRIVATE_FIELD_EXPOSED', '私有字段内容进入 publicPayload')
    }
  }
}
