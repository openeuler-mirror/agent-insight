'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { verifyStandalone } = require('./verify-standalone.cjs')

const VERSION = 2
const SOURCE_DIRS = ['src', 'public', 'prisma', 'scripts', 'generated', 'benchmarks', 'config', 'packages', 'services', 'skills', 'agent_ras', 'agent_fault_injection', 'integrations', 'bin']
const IGNORED = new Set(['.git', '.cache', '__pycache__', '.pytest_cache'])
const sha = value => createHash('sha256').update(value).digest('hex')

function digestTree(root, entries, cacheFile) {
  const cached = cacheFile ? readJson(cacheFile) : null
  const previous = cached?.version === VERSION ? cached.files : {}
  const updated = {}
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(256 * 1024)
  function visit(relative, ancestors = new Set()) {
    const target = path.resolve(root, relative)
    hash.update(JSON.stringify(relative))
    let stat
    try { stat = fs.lstatSync(target, { bigint: true }) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      hash.update('missing')
      return
    }
    if (stat.isSymbolicLink()) {
      hash.update(`link:${fs.readlinkSync(target)}`)
      const real = fs.realpathSync(target)
      if (ancestors.has(real)) throw new Error(`Circular build input: ${relative}`)
      visit(real, new Set([...ancestors, real]))
    } else if (stat.isDirectory()) {
      hash.update('directory')
      for (const name of fs.readdirSync(target).sort()) {
        if (!IGNORED.has(name) && !name.endsWith('.pyc')) visit(path.join(relative, name), ancestors)
      }
    } else if (stat.isFile()) {
      const identity = [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs].join(':')
      let digest = previous?.[relative]?.identity === identity ? previous[relative].digest : null
      if (!digest) {
        const fileHash = createHash('sha256')
        const fd = fs.openSync(target, 'r')
        try {
          let count
          while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) fileHash.update(buffer.subarray(0, count))
        } finally { fs.closeSync(fd) }
        digest = fileHash.digest('hex')
      }
      if (cacheFile) updated[relative] = { identity, digest }
      hash.update(`file:${stat.size}:${stat.mode & 0o777n}:${digest}`)
    } else {
      throw new Error(`Unsupported build input: ${relative}`)
    }
  }
  for (const entry of [...entries].sort()) visit(entry)
  if (cacheFile) writeJson(cacheFile, { version: VERSION, files: updated })
  return hash.digest('hex')
}

function inputState(root, env = process.env) {
  const configs = fs.readdirSync(root).filter(name =>
    /^(package.*\.json|.*lock.*|.*config\.(json|[cm]?[jt]s)|tsconfig.*\.json|\.npmrc|\.env(?:\..*)?|\.browserslistrc|\.babelrc(?:\..*)?|\.gitignore)$/.test(name))
  const managedEnv = path.join(env.AGENT_INSIGHT_HOME || path.join(require('node:os').homedir(), '.agent-insight'), '.env')
  const buildEnv = Object.fromEntries(Object.keys(env).filter(name =>
    /^(NEXT_PUBLIC_|PRISMA_|NEXT_)/.test(name) || ['NODE_ENV', 'BABEL_ENV', 'CI'].includes(name)
  ).sort().map(name => [name, env[name]]))
  return {
    version: VERSION,
    source: digestTree(root, SOURCE_DIRS),
    config: digestTree(root, [...configs, managedEnv]),
    dependencies: digestTree(root, ['node_modules'], path.join(root, 'node_modules/.cache/agent-insight/dependency-hashes.json')),
    environment: sha(JSON.stringify([root, process.version, process.platform, process.arch, buildEnv])),
  }
}

function statePaths(root) {
  return {
    build: path.join(root, '.next/start-build-state.json'),
    pending: path.join(root, '.next/cache/agent-insight/start-input.json'),
    prisma: path.join(root, 'node_modules/.cache/agent-insight/start-prisma-state.json'),
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
  fs.renameSync(temporary, file)
}

function standaloneDir(root) {
  const base = path.join(root, '.next/standalone')
  if (fs.existsSync(path.join(base, 'server.js'))) return base
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (entry.isDirectory() && fs.existsSync(path.join(base, entry.name, 'server.js'))) return path.join(base, entry.name)
  }
  throw new Error('Missing standalone server.js')
}

function artifactState(root) {
  const standalone = standaloneDir(root)
  verifyStandalone(standalone)
  const buildId = fs.readFileSync(path.join(root, '.next/BUILD_ID'), 'utf8').trim()
  if (!buildId || buildId !== fs.readFileSync(path.join(standalone, '.next/BUILD_ID'), 'utf8').trim()) throw new Error('Build ID mismatch')
  if (!fs.statSync(path.join(standalone, '.next/static')).isDirectory()) throw new Error('Missing standalone static files')
  return digestTree(root, ['.next/BUILD_ID', '.next/standalone', '.next/static'])
}

function checkBuild(root, force = false, env = process.env) {
  const files = statePaths(root)
  const input = inputState(root, env)
  writeJson(files.pending, input)
  const previous = readJson(files.build)
  let reason = force ? '--force-rebuild requested' : !previous ? 'no successful build fingerprint' : ''
  if (!reason) {
    const changed = Object.keys(input).filter(key => input[key] !== previous.input?.[key])
    if (changed.length) reason = `changed: ${changed.join(', ')}`
  }
  if (!reason) {
    try {
      if (artifactState(root) !== previous.artifacts) reason = 'build artifact contents changed'
    } catch { reason = 'build artifacts missing or incomplete' }
  }
  return { reusable: !reason, reason: reason || 'input fingerprint and build artifacts match' }
}

function prepareBuild(root) {
  const next = path.join(root, '.next')
  // Generated route types are replaced below; their old TS graph can exceed the 2 GB build heap.
  fs.rmSync(path.join(next, 'cache/.tsbuildinfo'), { force: true })
  fs.mkdirSync(next, { recursive: true })
  // Next's incremental cache is reusable; old routes and the success marker are not.
  for (const entry of fs.readdirSync(next)) {
    if (entry !== 'cache') fs.rmSync(path.join(next, entry), { recursive: true, force: true })
  }
}

function recordBuild(root, env = process.env) {
  const files = statePaths(root)
  const before = readJson(files.pending)
  const input = inputState(root, env)
  if (!before || JSON.stringify(before) !== JSON.stringify(input)) throw new Error('Build inputs changed during compilation; retry startup')
  writeJson(files.build, { input, artifacts: artifactState(root) })
}

function prismaState(root) {
  const client = path.join(root, 'node_modules/.prisma/client')
  // Prisma formats the copied schema, so input/output byte equality is not valid.
  if (!fs.readFileSync(path.join(client, 'schema.prisma'), 'utf8').trim()) throw new Error('Prisma schema missing')
  for (const file of ['index.js', 'index.d.ts', 'default.js']) {
    if (!fs.statSync(path.join(client, file)).isFile()) throw new Error('Prisma Client incomplete')
  }
  if (!fs.readdirSync(client).some(name => /^(libquery_engine|query_engine|query-engine)/.test(name))) throw new Error('Prisma engine missing')
  const environment = Object.keys(process.env).filter(key => key.startsWith('PRISMA_')).sort().map(key => [key, process.env[key]])
  return sha(JSON.stringify([process.platform, process.arch, environment, digestTree(root, ['prisma', 'node_modules/prisma', 'node_modules/@prisma', 'node_modules/.prisma'])]))
}

function checkPrisma(root) {
  try {
    const previous = readJson(statePaths(root).prisma)
    return previous?.version === VERSION && previous.node === process.version && previous.digest === prismaState(root)
  } catch { return false }
}

function recordPrisma(root) {
  writeJson(statePaths(root).prisma, { version: VERSION, node: process.version, digest: prismaState(root) })
}

module.exports = { digestTree, inputState, checkBuild, prepareBuild, recordBuild, checkPrisma, recordPrisma, statePaths }

if (require.main === module) {
  const root = process.cwd()
  try {
    switch (process.argv[2]) {
      case 'check': {
        const result = checkBuild(root, process.argv[3] === '--force-rebuild')
        console.log(`[build] ${result.reusable ? 'reuse' : 'rebuild'}: ${result.reason}`)
        process.exitCode = result.reusable ? 0 : 1
        break
      }
      case 'prepare': prepareBuild(root); break
      case 'record': recordBuild(root); break
      case 'prisma-check': process.exitCode = checkPrisma(root) ? 0 : 1; break
      case 'prisma-record': recordPrisma(root); break
      default: throw new Error('Unknown build state command')
    }
  } catch (error) {
    console.error(`[build] ${error.message}`)
    process.exitCode = 2
  }
}
