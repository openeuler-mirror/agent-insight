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

import { parseParameterJson, type JsonObject, type JsonValue } from '../../../packages/agent-runtime/index.cjs'

export type JsonEditorType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'
export type JsonEditorNode = {
  id: string
  key: string
  type: JsonEditorType
  text: string
  children: JsonEditorNode[]
}
export type JsonParameterDifference = { path: string; before: JsonValue | undefined; after: JsonValue | undefined }

let nextNodeId = 0

export const parameterEditorTypes: readonly JsonEditorType[] = ['string', 'number', 'boolean', 'object', 'array', 'null']

export function readParameterDraft(raw: string): { value?: JsonObject; error: string | null } {
  try { return { value: parseParameterJson(raw), error: null } } catch (error) {
    return { error: error instanceof Error ? error.message : 'JSON 格式不正确' }
  }
}

export function newParameterNode(type: JsonEditorType = 'string', key = ''): JsonEditorNode {
  return { id: `parameter-${++nextNodeId}`, key, type, text: type === 'number' ? '0' : type === 'boolean' ? 'false' : '', children: [] }
}

function valueNode(key: string, value: JsonValue, id: string): JsonEditorNode {
  const type: JsonEditorType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value as Exclude<JsonEditorType, 'array' | 'null'>
  return {
    id, key, type,
    text: type === 'object' || type === 'array' || value === null ? '' : String(value),
    children: Array.isArray(value) ? value.map((item, index) => valueNode(String(index), item, `${id}/${index}`))
      : value !== null && typeof value === 'object' ? Object.entries(value).map(([name, item], index) => valueNode(name, item, `${id}/${index}`)) : [],
  }
}

export function parameterNodesFromObject(value: JsonObject): JsonEditorNode[] {
  return Object.entries(value).map(([key, item], index) => valueNode(key, item, `root/${index}`))
}

function serializeContainer(nodes: JsonEditorNode[], type: 'object' | 'array', depth: number, pretty = true): string {
  const [open, close] = type === 'object' ? ['{', '}'] : ['[', ']']
  if (!nodes.length) return open + close
  if (!pretty) return `${open}${nodes.map(node => `${type === 'object' ? `${JSON.stringify(node.key)}:` : ''}${serializeNode(node, depth + 1, false)}`).join(',')}${close}`
  return `${open}\n${nodes.map(node => `${'  '.repeat(depth + 1)}${type === 'object' ? `${JSON.stringify(node.key)}: ` : ''}${serializeNode(node, depth + 1)}`).join(',\n')}\n${'  '.repeat(depth)}${close}`
}

function serializeNode(node: JsonEditorNode, depth: number, pretty = true): string {
  if (node.type === 'object' || node.type === 'array') return serializeContainer(node.children, node.type, depth, pretty)
  if (node.type === 'string') return JSON.stringify(node.text)
  if (node.type === 'null') return 'null'
  if (node.type === 'number' && !isParameterNumber(node.text)) return `!${JSON.stringify(node.text)}`
  return node.text
}

export function isParameterNumber(text: string): boolean {
  return /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(text) && Number.isFinite(Number(text))
}

export function serializeParameterNodes(nodes: JsonEditorNode[]): string {
  const pretty = serializeContainer(nodes, 'object', 0)
  return new TextEncoder().encode(pretty).length <= 256 * 1024 ? pretty : serializeContainer(nodes, 'object', 0, false)
}

export function updateParameterNode(nodes: JsonEditorNode[], id: string, update: (node: JsonEditorNode) => JsonEditorNode): JsonEditorNode[] {
  return nodes.map(node => node.id === id ? update(node) : { ...node, children: updateParameterNode(node.children, id, update) })
}

export function removeParameterNode(nodes: JsonEditorNode[], id: string): JsonEditorNode[] {
  return nodes.filter(node => node.id !== id).map(node => ({ ...node, children: removeParameterNode(node.children, id) }))
}

export function moveParameterNode(nodes: JsonEditorNode[], id: string, direction: -1 | 1): JsonEditorNode[] {
  const index = nodes.findIndex(node => node.id === id)
  if (index >= 0) {
    if (index + direction < 0 || index + direction >= nodes.length) return nodes
    const moved = [...nodes]
    ;[moved[index], moved[index + direction]] = [moved[index + direction], moved[index]]
    return moved
  }
  return nodes.map(node => ({ ...node, children: moveParameterNode(node.children, id, direction) }))
}

export function changeParameterType(node: JsonEditorNode, type: JsonEditorType): JsonEditorNode {
  if (node.type === type) return node
  const text = type === 'string' ? serializeNode(node, 0).replace(/^"|"$/g, '')
    : type === 'number' ? isParameterNumber(node.text) ? node.text : '0'
      : type === 'boolean' ? node.text === 'true' ? 'true' : 'false' : ''
  return { ...node, type, text, children: [] }
}

export function parameterPointer(parent: string, key: string): string {
  return `${parent}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
}

export function diffParameterObjects(before: JsonObject, after: JsonObject): JsonParameterDifference[] {
  const changes: JsonParameterDifference[] = []
  function visit(left: JsonValue | undefined, right: JsonValue | undefined, path: string) {
    if (left === right) return
    const leftObject = left !== null && typeof left === 'object'
    const rightObject = right !== null && typeof right === 'object'
    if (leftObject && rightObject && Array.isArray(left) === Array.isArray(right)) {
      const keys = new Set([...Object.keys(left), ...Object.keys(right)])
      for (const key of keys) {
        const leftValue = Array.isArray(left) ? left[Number(key)] : Object.hasOwn(left, key) ? (left as JsonObject)[key] : undefined
        const rightValue = Array.isArray(right) ? right[Number(key)] : Object.hasOwn(right, key) ? (right as JsonObject)[key] : undefined
        visit(leftValue, rightValue, parameterPointer(path, key))
      }
    } else changes.push({ path: path || '/', before: left, after: right })
  }
  visit(before, after, '')
  return changes
}
