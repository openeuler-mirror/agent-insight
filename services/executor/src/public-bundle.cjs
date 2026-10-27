'use strict'
/* eslint-disable @typescript-eslint/no-require-imports */

const { createHash } = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const HASH = /^sha256:[0-9a-f]{64}$/
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_TOTAL_BYTES = 512 * 1024 * 1024
const MAX_FILES = 100_000
const PRIVATE_NAMES = new Set(['reference-poc', 'negative-poc', 'vulnerable.fix.patch', 'source-manifest.json', 'prepare.context.json', 'evaluation.context.json', 'image-refs.json', 'submit.sh'])
const PRIVATE_DIRS = new Set(['private', 'judge', '.task-state', '.runs', '.cache', '.work', '.git', '.hg', '.svn', 'logs', '__pycache__'])

function fail(code, message) { throw Object.assign(new Error(message), { code }) }
function digest(bytes) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}` }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function validatePublicBundleSpec(spec) {
  if (!spec || spec.provider !== 'public-bundle' || !TASK_ID.test(spec.taskId) || !HASH.test(spec.digest)
    || Object.keys(spec).some(key => !['provider', 'taskId', 'digest'].includes(key))) {
    fail('TASK_WORKSPACE_INVALID', '公开任务包契约不合法')
  }
}

function validatePublicPath(relative, taskId) {
  if (typeof relative !== 'string' || relative.length > 1024 || !/^[A-Za-z0-9._/-]+$/.test(relative)
    || relative.split('/').some(part => !part || part === '.' || part === '..')) fail('PUBLIC_BUNDLE_PATH_INVALID', '公开任务文件路径不合法')
  const prefix = `tasks/${taskId}/`
  if (!relative.startsWith(prefix)) fail('PUBLIC_BUNDLE_PATH_INVALID', '公开任务文件超出题目目录')
  const parts = relative.slice(prefix.length).split('/')
  if (parts.join('/') !== 'task.json' && (parts[0] !== 'public' || parts.length < 2)) fail('PUBLIC_BUNDLE_PRIVATE_FILE', '公开包只能包含 task.json 和 public 文件')
  if ((parts[0] === 'public' && PRIVATE_DIRS.has(parts[1])) || parts.some(part => ['.git', '.hg', '.svn'].includes(part))
    || PRIVATE_NAMES.has(parts.at(-1)) || /\.(pyc|pyo|pyd)$/i.test(parts.at(-1))) fail('PUBLIC_BUNDLE_PRIVATE_FILE', '公开包包含禁止分发的文件')
}

async function safeRegularFile(root, relative) {
  let current = root
  const parts = relative.split('/')
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index])
    const stat = await fsp.lstat(current)
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) fail('PUBLIC_BUNDLE_FILE_INVALID', '文件或目录包含符号链接或特殊文件')
  }
  return current
}

async function readBoundedFile(root, relative, maxBytes) {
  const target = await safeRegularFile(root, relative)
  const handle = await fsp.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maxBytes) fail('ARTIFACT_SIZE_INVALID', '文件超过大小限制或不是普通文件')
    const buffer = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > maxBytes || bytesRead !== stat.size) fail('ARTIFACT_SIZE_INVALID', '文件大小在读取期间发生变化')
    return buffer.subarray(0, bytesRead)
  } finally { await handle.close() }
}

async function listFiles(root, directory = '') {
  const files = []
  for (const entry of await fsp.readdir(path.join(root, directory), { withFileTypes: true })) {
    const relative = directory ? `${directory}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...await listFiles(root, relative))
    else if (entry.isFile()) files.push(relative)
    else fail('PUBLIC_BUNDLE_FILE_INVALID', '公开包包含符号链接或特殊文件')
    if (files.length > MAX_FILES + 1) fail('PUBLIC_BUNDLE_TOO_LARGE', '公开任务文件数量超限')
  }
  return files.sort()
}

class PublicBundleWorkspaceProvider {
  constructor(rootDir, bundleDir) { this.rootDir = rootDir; this.bundleDir = path.resolve(bundleDir) }

  async prepare(spec, context) {
    validatePublicBundleSpec(spec)
    if (!/^erun_[0-9a-f]{32}$/.test(context.runId)) fail('TASK_CONTEXT_MISMATCH', '运行 ID 不合法')
    let source
    try { source = await safeDirectory(this.bundleDir, spec.digest.slice(7)) }
    catch (error) { if (error.code === 'ENOENT') fail('PUBLIC_BUNDLE_MISSING', '执行器缺少指定公开任务包，请同步到配置的任务包目录'); throw error }
    const lock = JSON.parse((await readBoundedFile(source, 'bundle.json', 32 * 1024 * 1024)).toString('utf8'))
    if (lock.schemaVersion !== 'public-bundle/v1' || lock.taskId !== spec.taskId || digest(canonical(lock)) !== spec.digest
      || !lock.files || typeof lock.files !== 'object' || Array.isArray(lock.files)) fail('PUBLIC_BUNDLE_DIGEST_MISMATCH', '公开任务包与冻结指纹不一致')
    const names = Object.keys(lock.files).sort()
    if (!names.length || names.length > MAX_FILES || canonical(await listFiles(source)) !== canonical([...names, 'bundle.json'].sort())) fail('PUBLIC_BUNDLE_CONTENT_MISMATCH', '公开任务包文件集合已变化')
    let total = 0
    for (const name of names) {
      validatePublicPath(name, spec.taskId)
      const file = lock.files[name]
      if (!file || !HASH.test(file.sha256) || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || typeof file.executable !== 'boolean') fail('PUBLIC_BUNDLE_LOCK_INVALID', '公开任务包文件清单不合法')
      total += file.sizeBytes
    }
    if (total > MAX_TOTAL_BYTES || !names.includes(`tasks/${spec.taskId}/task.json`)
      || !names.includes(`tasks/${spec.taskId}/public/README.md`)) fail('PUBLIC_BUNDLE_LOCK_INVALID', '公开任务包超限或缺少任务说明')
    const workspace = path.join(this.rootDir, context.runId)
    await fsp.mkdir(this.rootDir, { recursive: true, mode: 0o700 })
    await fsp.mkdir(workspace, { mode: 0o700 })
    try {
      for (const name of names) {
        context.signal?.throwIfAborted()
        const file = lock.files[name]
        const bytes = await readBoundedFile(source, name, file.sizeBytes)
        if (bytes.length !== file.sizeBytes || digest(bytes) !== file.sha256) fail('PUBLIC_BUNDLE_CONTENT_MISMATCH', '公开任务文件指纹不一致')
        const target = path.join(workspace, name)
        await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
        await fsp.writeFile(target, bytes, { flag: 'wx', mode: file.executable ? 0o700 : 0o600 })
      }
      await fsp.mkdir(path.join(workspace, 'submission'), { mode: 0o700 })
      return { path: workspace, bundleDigest: spec.digest }
    } catch (error) { await fsp.rm(workspace, { recursive: true, force: true }); throw error }
  }
}

async function safeDirectory(root, relative) {
  const target = path.join(root, relative)
  if (!(await fsp.lstat(target)).isDirectory()) fail('PUBLIC_BUNDLE_FILE_INVALID', '公开任务包目录不合法')
  return target
}

class SingleFileCollector {
  async collect(contract, context) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(contract.name)) fail('ARTIFACT_CONTRACT_INVALID', '提交物名称不合法')
    let bytes
    try { bytes = await readBoundedFile(context.workspace.path, `submission/${contract.name}`, contract.maxBytes) }
    catch (error) { if (error.code === 'ENOENT') fail('AGENT_NO_OUTPUT', `Agent 未生成 submission/${contract.name}`); throw error }
    if (!bytes.length) fail('ARTIFACT_SIZE_INVALID', '提交物为空')
    return { name: contract.name, mediaType: contract.mediaType, bytes, sha256: digest(bytes) }
  }
}

module.exports = { PublicBundleWorkspaceProvider, SingleFileCollector, validatePublicBundleSpec, validatePublicPath, readBoundedFile, canonical, digest }
