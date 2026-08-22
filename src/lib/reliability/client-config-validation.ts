/**
 * Browser-safe config validation shared by accessconfig UI and server APIs.
 * Keep free of node:fs / child_process — client-config-model pulls catalog/yaml.
 */

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
