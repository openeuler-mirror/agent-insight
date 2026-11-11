'use strict'

const path = require('node:path')
const { real } = require('./common.cjs')

try {
  const [repoPath, key] = process.argv.slice(2)
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(key || '') || key === '..') throw new Error('无效 Benchmark key')
  const repo = real(repoPath)
  const { loadPackageForOnboarding } = require(path.join(repo, 'scripts/benchmark/generate-catalog.cjs'))
  if (typeof loadPackageForOnboarding !== 'function') throw new Error('目标版本未导出 loadPackageForOnboarding 新接入校验入口；请查询当前严格校验能力，在计划 catalog 中配置等价桥接并列入 implementationInputs，不能退回兼容构建校验，也不要求修改目标项目来适配 Skill')
  const result = loadPackageForOnboarding(path.join(repo, 'benchmarks', key))
  if (result.key !== key) throw new Error('目录与 Manifest key 不匹配')
  process.stdout.write(`${JSON.stringify({ status: 'pass', key: result.key, digest: result.packageDigest })}\n`)
} catch (error) {
  process.stdout.write(`${JSON.stringify({ status: 'fail', reason: error.message })}\n`)
  process.exitCode = 1
}
