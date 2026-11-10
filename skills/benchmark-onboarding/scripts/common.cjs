'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const skillRoot = fs.realpathSync(path.resolve(__dirname, '..'))
const hash = value => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`
const canonical = value => JSON.stringify(sort(value))
function sort(value) {
  if (Array.isArray(value)) return value.map(sort)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])]))
  return value
}
function fail(message) { throw new Error(message) }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')) }
function inside(root, file) { const rel = path.relative(root, file); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)) }
function real(file) { return fs.realpathSync(path.resolve(file)) }
function outsideSkill(file) {
  let parent = path.resolve(file)
  while (!fs.existsSync(parent)) parent = path.dirname(parent)
  if (inside(skillRoot, real(parent))) fail('运行产物必须位于 Skill 包外')
}
function atomicJson(file, value) {
  outsideSkill(file)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  try { fs.renameSync(temporary, file) } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
}
function fileHash(file) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile()) fail(`只接受普通文件：${file}`)
  const fd = fs.openSync(file, 'r')
  const buffer = Buffer.alloc(1024 * 1024)
  const digest = crypto.createHash('sha256')
  try { for (;;) { const size = fs.readSync(fd, buffer, 0, buffer.length, null); if (!size) break; digest.update(buffer.subarray(0, size)) } }
  finally { fs.closeSync(fd) }
  return `sha256:${digest.digest('hex')}`
}
function treeFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1).flatMap(entry => {
    if (['.git', 'node_modules', '__pycache__', '.DS_Store'].includes(entry.name) || /\.py[co]$/.test(entry.name)) return []
    const file = path.join(root, entry.name)
    if (entry.isSymbolicLink()) fail(`摘要输入不允许符号链接：${file}`)
    return entry.isDirectory() ? treeFiles(file) : [file]
  })
}
function treeHash(root) { return hash(canonical(treeFiles(root).map(file => [path.relative(root, file).split(path.sep).join('/'), fileHash(file)]))) }
function git(repo, args) {
  try { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, maxBuffer: 32 * 1024 * 1024 }).trim() }
  catch { fail(`Git 查询失败：${args[0]}；检查工作副本、权限及输出大小`) }
}
function repositoryAddress(value) {
  if (typeof value !== 'string' || !value.trim()) fail('项目地址不能为空')
  if (fs.existsSync(value)) return `file:${real(value)}`
  let address = value
  if (/^[^/@\s]+@[^/:\s]+:.+/.test(address)) address = address.replace(/^([^@]+)@([^:]+):/, 'ssh://$1@$2/')
  let url
  try { url = new URL(address) } catch { fail('项目地址必须是存在的本地目录或 Git 仓库 URL') }
  if (!['https:', 'http:', 'ssh:'].includes(url.protocol)) fail('不支持的项目地址协议')
  if (url.password || (url.username && url.protocol !== 'ssh:') || url.search || url.hash) fail('项目地址不得包含凭据、查询参数或片段；版本单独记录')
  return `${url.host.toLowerCase()}/${url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')}`
}
function publicReference(value) {
  if (typeof value !== 'string' || !value.trim()) fail('来源地址不能为空')
  if (fs.existsSync(value)) return real(value)
  let url
  try { url = new URL(value) } catch { fail('来源需要有效 URL 或本地路径') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || [...url.searchParams.keys()].some(k => /token|password|secret|key|signature|credential/i.test(k))) fail('来源地址需要公开 HTTP(S) URL，凭据使用环境引用')
  return url.href
}
function project(repoPath, address) {
  const repo = real(repoPath)
  if (real(git(repo, ['rev-parse', '--show-toplevel'])) !== repo) fail('--repo 必须指向 Git 工作副本根目录')
  const identity = repositoryAddress(address)
  const remotes = git(repo, ['remote']).split('\n').filter(Boolean).map(name => {
    const url = git(repo, ['remote', 'get-url', name])
    return { name, identity: repositoryAddress(url) }
  })
  if (identity.startsWith('file:') ? identity !== `file:${repo}` : !remotes.some(r => r.identity === identity)) fail('项目地址与工作副本不匹配；请定位正确副本，不自动拉取或切换分支')
  return { repo, address: identity.startsWith('file:') ? repo : address, identity, remotes, head: git(repo, ['rev-parse', 'HEAD']), branch: git(repo, ['branch', '--show-current']) || null }
}
function expand(value, context) {
  return value.replace(/\{(repo|run|attempt|output|skill)\}/g, (_, key) => context[key] ?? fail(`缺少路径变量：${key}`))
}
function inputSnapshot(files, context) {
  return files.map(file => { const absolute = real(expand(file, context)); return { path: absolute, digest: fileHash(absolute) } })
}
function staleFiles(files) {
  return files.filter(file => { try { return fileHash(file.path) !== file.digest } catch { return true } }).map(file => file.path)
}
function codeSnapshot(repo, key, inputs, context) {
  const packageDir = path.join(repo, 'benchmarks', key)
  return {
    head: git(repo, ['rev-parse', 'HEAD']),
    trackedChanges: hash(git(repo, ['diff', 'HEAD', '--binary'])),
    packageDigest: fs.existsSync(packageDir) ? treeHash(packageDir) : null,
    inputs: inputSnapshot(inputs, context),
    verifierDigest: hash(canonical(['scripts', 'assets/schemas'].map(name => [name, treeHash(path.join(skillRoot, name))]))),
  }
}
function snapshotDigest(snapshot) {
  if (!snapshot || typeof snapshot.verifierDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(snapshot.verifierDigest)) fail('实现快照缺少有效 verifierDigest；不支持旧快照，请按当前输入重新验收')
  return hash(canonical({ packageDigest: snapshot.packageDigest, inputs: snapshot.inputs, verifierDigest: snapshot.verifierDigest }))
}
function sameSnapshot(a, b) { return snapshotDigest(a) === snapshotDigest(b) }
function validate(value, schema, at = '$') {
  if (schema.const !== undefined && canonical(value) !== canonical(schema.const)) fail(`${at}: const 不匹配`)
  if (schema.enum && !schema.enum.some(item => canonical(value) === canonical(item))) fail(`${at}: 不在允许范围`)
  const type = schema.type
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${at}: 需要对象`)
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) fail(`${at}.${key}: 缺少必填字段`)
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) validate(child, schema.properties[key], `${at}.${key}`)
      else if (schema.additionalProperties === false) fail(`${at}.${key}: 未知字段`)
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validate(child, schema.additionalProperties, `${at}.${key}`)
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) fail(`${at}: 需要数组`)
    if (value.length < (schema.minItems || 0)) fail(`${at}: 数组过短`)
    if (schema.maxItems != null && value.length > schema.maxItems) fail(`${at}: 数组过长`)
    if (schema.uniqueItems && new Set(value.map(canonical)).size !== value.length) fail(`${at}: 包含重复项`)
    value.forEach((item, index) => validate(item, schema.items || {}, `${at}[${index}]`))
  } else if (type === 'string') {
    if (typeof value !== 'string' || value.length < (schema.minLength || 0) || (schema.pattern && !new RegExp(schema.pattern).test(value))) fail(`${at}: 字符串不合法`)
  } else if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value)) || (schema.minimum != null && value < schema.minimum) || (schema.maximum != null && value > schema.maximum)) fail(`${at}: 数字不合法`)
  } else if (type === 'boolean' && typeof value !== 'boolean') fail(`${at}: 需要布尔值`)
}
function validateDocument(value, name) {
  validate(value, readJson(path.join(skillRoot, 'assets', 'schemas', `${name}.schema.json`)))
  if (name === 'run' && !Number.isFinite(Date.parse(value.createdAt))) fail('运行记录的开始时间无效')
  return value
}
async function withLock(repo, callback) {
  repo = real(repo)
  const directory = path.join(os.tmpdir(), 'agent-insight-benchmark-onboarding-locks')
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const lock = path.join(directory, `${hash(repo).slice(7)}.lock`)
  let fd
  try { fd = fs.openSync(lock, 'wx', 0o600) } catch { fail(`工作副本正在运行命令，或存在中断遗留锁：${lock}；确认记录中的进程已退出后处理`) }
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), repo, createdAt: new Date().toISOString() }))
  try { return await callback() } finally { fs.closeSync(fd); fs.unlinkSync(lock) }
}

module.exports = { skillRoot, hash, canonical, fail, readJson, inside, real, outsideSkill, atomicJson, fileHash, treeFiles, treeHash, git, repositoryAddress, publicReference, project, expand, inputSnapshot, staleFiles, codeSnapshot, snapshotDigest, sameSnapshot, validate, validateDocument, withLock }
