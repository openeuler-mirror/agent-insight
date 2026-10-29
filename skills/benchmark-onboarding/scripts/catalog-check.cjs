'use strict'

const path = require('node:path')
const { real } = require('./common.cjs')

try {
  const [repoPath, key] = process.argv.slice(2)
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(key || '') || key === '..') throw new Error('无效 Benchmark key')
  const repo = real(repoPath)
  const { loadPackage } = require(path.join(repo, 'scripts/benchmark/generate-catalog.cjs'))
  if (typeof loadPackage !== 'function') throw new Error('目标版本未导出 loadPackage；按目标协议调整检查入口')
  const result = loadPackage(path.join(repo, 'benchmarks', key))
  if (result.key !== key) throw new Error('目录与 Manifest key 不匹配')
  process.stdout.write(`${JSON.stringify({ status: 'pass', key: result.key, digest: result.packageDigest })}\n`)
} catch (error) {
  process.stdout.write(`${JSON.stringify({ status: 'fail', reason: error.message })}\n`)
  process.exitCode = 1
}
