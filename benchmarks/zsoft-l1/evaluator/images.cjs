'use strict'
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const hash = /^sha256:[a-f0-9]{64}$/
const registryImage = /^[a-z0-9][a-z0-9.:-]*\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function fingerprint(value) { return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}` }

function sourceTaskDigest(root, taskId) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tasks', taskId, 'task.json'), 'utf8'))
  const publicFiles = {}
  const visit = relative => {
    const file = path.join(root, relative)
    const stat = fs.lstatSync(file)
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(`${relative}/${name}`)
    } else if (stat.isFile()) publicFiles[relative] = `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`
    else throw new Error('ZSOFT_ASSET_PATH_INVALID')
  }
  visit(`tasks/${taskId}/public`)
  return fingerprint({ manifest, publicFiles })
}

function describeImages(payload, arch, context = {}) {
  const normalizedArch = { amd64: 'x86_64', x86_64: 'x86_64' }[arch]
  if (!normalizedArch) throw new Error('ZSOFT_IMAGE_ARCH_UNSUPPORTED: only linux/amd64 is supported')
  const root = context.assetsDir || process.env.EVALUATOR_ASSETS_DIR || process.env.ZSOFT_L1_ASSETS_DIR || '/data/benchmark-assets/zsoft-l1'
  const inventory = JSON.parse(fs.readFileSync(path.join(root, 'agent-insight-assets.json'), 'utf8'))
  const { bundleDigest, ...content } = inventory
  if (inventory.schemaVersion !== 'zsoft-assets/v1' || fingerprint(content) !== bundleDigest
    || (payload?.revision && payload.revision !== inventory.revision)) {
    throw new Error('ZSOFT_BUNDLE_MISMATCH')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(payload?.taskId || '')) throw new Error('ZSOFT_TASK_MISMATCH')
  const task = inventory.tasks?.[payload.taskId]
  if (!task) throw new Error('ZSOFT_TASK_NOT_INSTALLED')
  const identity = Object.fromEntries(['public', 'files', 'stateFiles', 'images', ...(task.registryImages ? ['registryImages'] : []), 'sourceTaskDigest'].map(key => [key, task[key]]))
  if (fingerprint(identity) !== task.taskDigest || task.sourceTaskDigest !== payload.sourceTaskDigest
    || sourceTaskDigest(root, payload.taskId) !== payload.sourceTaskDigest
    || task.public.taskId !== payload.taskId || task.public.maxBytes !== payload.maxBytes
    || task.public.submissionKind !== payload.submissionKind) throw new Error('ZSOFT_TASK_MISMATCH')
  if (task.public.tags.includes('userspace') === task.public.tags.includes('kernel')
    || (task.public.tags.includes('kernel') && task.public.submissionKind !== 'c')) throw new Error('ZSOFT_TASK_TRACK_INVALID')
  const images = Object.entries(task.images || {})
  if (!images.length || images.some(([, id]) => !hash.test(id))) throw new Error('ZSOFT_IMAGES_NOT_PINNED')
  if (task.registryImages && (Object.keys(task.registryImages).length !== images.length
    || images.some(([tag]) => !registryImage.test(task.registryImages[tag] || '')))) throw new Error('ZSOFT_REGISTRY_IMAGES_INVALID')
  return images.map(([tag, expectedImageId]) => ({
    key: tag, arch: normalizedArch,
    references: [task.registryImages?.[tag] || expectedImageId],
    context: { expectedImageId },
  }))
}

module.exports = { describeImages }
