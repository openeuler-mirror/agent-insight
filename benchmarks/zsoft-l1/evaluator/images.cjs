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

'use strict'
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { fingerprintSource, legacySourceDigest } = require('./source-identity.cjs')

function imageError(code, message = code) {
  return Object.assign(new Error(message), { code, status: 422, retryable: false })
}

const hash = /^sha256:[a-f0-9]{64}$/
const registryImage = /^[a-z0-9][a-z0-9.:-]*\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function fingerprint(value) { return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}` }

function sourceIdentity(root, taskId) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tasks', taskId, 'task.json'), 'utf8'))
  const publicFiles = {}
  const visit = relative => {
    const file = path.join(root, relative)
    const stat = fs.lstatSync(file)
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(`${relative}/${name}`)
    } else if (stat.isFile()) publicFiles[relative] = `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`
    else throw imageError('ZSOFT_ASSET_PATH_INVALID')
  }
  visit(`tasks/${taskId}/public`)
  return { manifest, publicFiles }
}

function describeImages(payload, arch, context = {}) {
  const normalizedArch = { amd64: 'x86_64', x86_64: 'x86_64' }[arch]
  if (!normalizedArch) throw imageError('ZSOFT_IMAGE_ARCH_UNSUPPORTED', 'ZSOFT_IMAGE_ARCH_UNSUPPORTED: only linux/amd64 is supported')
  const root = context.assetsDir || process.env.EVALUATOR_ASSETS_DIR
  if (!root) throw imageError('ZSOFT_ASSET_ROOT_MISSING', 'ZSOFT_ASSET_ROOT_MISSING: Controller must resolve the configured asset release directory')
  const inventory = JSON.parse(fs.readFileSync(path.join(root, 'agent-insight-assets.json'), 'utf8'))
  const { bundleDigest, ...content } = inventory
  if (inventory.schemaVersion !== 'zsoft-assets/v1' || fingerprint(content) !== bundleDigest
    || (payload?.revision && payload.revision !== inventory.revision)) {
    throw imageError('ZSOFT_BUNDLE_MISMATCH')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(payload?.taskId || '')) throw imageError('ZSOFT_TASK_MISMATCH')
  const task = inventory.tasks?.[payload.taskId]
  if (!task) throw imageError('ZSOFT_TASK_NOT_INSTALLED')
  const identity = Object.fromEntries(['public', 'files', 'stateFiles', 'images', ...(task.registryImages ? ['registryImages'] : []), 'sourceTaskDigest'].map(key => [key, task[key]]))
  const source = sourceIdentity(root, payload.taskId)
  const sourceDigest = fingerprintSource(source)
  if (fingerprint(identity) !== task.taskDigest || task.sourceTaskDigest !== sourceDigest
    || task.public.taskId !== payload.taskId || task.public.maxBytes !== payload.maxBytes
    || task.public.submissionKind !== payload.submissionKind) throw imageError('ZSOFT_TASK_MISMATCH')
  if (payload.sourceTaskDigest !== sourceDigest) {
    if (payload.sourceTaskDigest === legacySourceDigest(source)) {
      throw imageError('ZSOFT_TASK_DIGEST_LEGACY', 'ZSOFT_TASK_DIGEST_LEGACY: 题目摘要使用旧版排序规则，请用 --refresh --name 导入匹配官方来源的新数据集并新建实验；历史实验不自动改写')
    }
    throw imageError('ZSOFT_TASK_MISMATCH', 'ZSOFT_TASK_MISMATCH: 题目内容摘要与评测资产不一致，请核对数据集及评测资产版本')
  }
  if (task.public.tags.includes('userspace') === task.public.tags.includes('kernel')
    || (task.public.tags.includes('kernel') && task.public.submissionKind !== 'c')) throw imageError('ZSOFT_TASK_TRACK_INVALID')
  const images = Object.entries(task.images || {})
  if (!images.length || images.some(([, id]) => !hash.test(id))) throw imageError('ZSOFT_IMAGES_NOT_PINNED')
  if (task.registryImages && (Object.keys(task.registryImages).length !== images.length
    || images.some(([tag]) => !registryImage.test(task.registryImages[tag] || '')))) throw imageError('ZSOFT_REGISTRY_IMAGES_INVALID')
  return images.map(([tag, expectedImageId]) => ({
    key: tag, arch: normalizedArch,
    references: [task.registryImages?.[tag] || expectedImageId],
    context: { expectedImageId },
  }))
}

module.exports = { describeImages }
