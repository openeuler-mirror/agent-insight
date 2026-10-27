/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { validateParameterObject, type JsonObject } from '../../../../packages/agent-runtime/index.cjs'

export type RuntimeParameterTemplate = {
  id: string
  name: string
  revision: number
  runtimeKey: string
  definitionDigest: string
  values: JsonObject
  createdAt: string
}

export type RuntimeParameterTemplateInput = Pick<RuntimeParameterTemplate, 'name' | 'runtimeKey' | 'definitionDigest' | 'values'>

export function validateRuntimeParameterTemplateInput(input: unknown): RuntimeParameterTemplateInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('参数模板必须是对象')
  const value = input as Record<string, unknown>
  if (Object.keys(value).some(key => !['name', 'runtimeKey', 'definitionDigest', 'values'].includes(key))) {
    throw new TypeError('参数模板包含未知字段')
  }
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80) {
    throw new TypeError('模板名称需要 1～80 个字符')
  }
  if (typeof value.runtimeKey !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value.runtimeKey)) {
    throw new TypeError('模板 Runtime 不合法')
  }
  if (typeof value.definitionDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.definitionDigest)) {
    throw new TypeError('模板参数契约摘要不合法')
  }
  return {
    name: value.name.trim(), runtimeKey: value.runtimeKey, definitionDigest: value.definitionDigest,
    values: validateParameterObject(value.values),
  }
}

export function readRuntimeParameterTemplates(input: unknown): RuntimeParameterTemplate[] {
  if (!Array.isArray(input)) return []
  return input.flatMap(item => {
    try {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || item.id.length > 128
        || !Number.isSafeInteger(item.revision) || item.revision < 1
        || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))) return []
      const value = validateRuntimeParameterTemplateInput({
        name: item.name, runtimeKey: item.runtimeKey, definitionDigest: item.definitionDigest, values: item.values,
      })
      return [{ ...value, id: item.id, revision: item.revision, createdAt: item.createdAt }]
    } catch { return [] }
  })
}

export function appendRuntimeParameterTemplate(
  templates: RuntimeParameterTemplate[], input: unknown, id: string, createdAt = new Date().toISOString(),
): { template: RuntimeParameterTemplate; templates: RuntimeParameterTemplate[] } {
  const value = validateRuntimeParameterTemplateInput(input)
  if (templates.length >= 256) throw new TypeError('最多保存 256 个参数模板修订，请使用 JSON 导出保存配置')
  const revision = Math.max(0, ...templates.filter(item => item.runtimeKey === value.runtimeKey && item.name === value.name)
    .map(item => item.revision)) + 1
  const template = { ...value, id, revision, createdAt }
  return { template, templates: [...templates, template] }
}
