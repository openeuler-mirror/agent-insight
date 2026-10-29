'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { canonical, fail, expand, inside, real, fileHash, treeFiles, validateDocument } = require('./common.cjs')

async function runCommand(spec, context, deadline) {
  const startedAt = new Date().toISOString()
  if (!spec.argv.length) return { status: 'blocked', reason: '检查命令尚未配置', startedAt, exitCode: null, durationMs: 0, evidence: [] }
  fs.mkdirSync(context.attempt, { recursive: true, mode: 0o700 })
  const output = path.join(context.attempt, 'result.json')
  const variables = { ...context, output }
  const argv = spec.argv.map(arg => expand(arg, variables))
  const cwd = real(expand(spec.cwd, variables))
  const timeoutMs = Math.min(spec.timeoutSeconds * 1000, deadline - Date.now())
  if (timeoutMs <= 0) return { status: 'blocked', reason: '总耗时预算已用尽', startedAt, exitCode: null, durationMs: 0, evidence: [] }
  const stdout = path.join(context.attempt, 'stdout.log')
  const stderr = path.join(context.attempt, 'stderr.log')
  const out = fs.openSync(stdout, 'wx', 0o600)
  const err = fs.openSync(stderr, 'wx', 0o600)
  let processResult
  try {
    processResult = await new Promise(resolve => {
      let child, timer, forceTimer, pendingFinish, ended = false, bytes = 0, reason = '', cancelled = false
      const terminate = () => {
        if (!child?.pid || forceTimer) return
        try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM') } catch {}
        forceTimer = setTimeout(() => {
          try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch {}
          forceTimer = null
          if (pendingFinish) finish(...pendingFinish)
        }, 500)
      }
      const interrupted = () => { cancelled = true; reason = '命令被取消'; terminate() }
      const finish = (exitCode, signal) => {
        if (ended) return
        if (forceTimer) { pendingFinish = [exitCode, signal]; return }
        ended = true
        clearTimeout(timer)
        clearTimeout(forceTimer)
        process.removeListener('SIGINT', interrupted)
        process.removeListener('SIGTERM', interrupted)
        resolve({ exitCode, signal, reason, cancelled })
      }
      const write = fd => chunk => {
        bytes += chunk.length
        if (bytes > 8 * 1024 * 1024) { if (!reason) { reason = '命令日志超过 8 MiB 上限'; terminate() }; return }
        fs.writeSync(fd, chunk)
      }
      child = spawn(argv[0], argv.slice(1), { cwd, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BENCHMARK_ONBOARDING_JOB_JOURNAL: path.join(context.attempt, 'platform-jobs') } })
      child.stdout.on('data', write(out))
      child.stderr.on('data', write(err))
      child.on('error', error => { reason = `命令无法启动：${error.code || 'UNKNOWN'}` })
      child.on('close', finish)
      process.on('SIGINT', interrupted)
      process.on('SIGTERM', interrupted)
      timer = setTimeout(() => { reason = '命令超时'; terminate() }, timeoutMs)
    })
  } finally { fs.closeSync(out); fs.closeSync(err) }
  const evidence = treeFiles(context.attempt).map(file => ({ path: file, digest: fileHash(file) }))
  const result = {
    status: processResult.cancelled ? 'blocked' : processResult.reason || processResult.exitCode !== 0 ? 'fail' : 'pass',
    argv, cwd, startedAt, durationMs: Date.now() - Date.parse(startedAt), ...processResult, evidence, output,
  }
  if (result.status !== 'pass') result.reason ||= `命令退出码 ${processResult.exitCode}`
  return result
}

function loadScores(value, plan) {
  validateDocument(value, 'scores')
  if (value.benchmarkKey !== plan.benchmarkKey) fail('评分结果 Benchmark key 不匹配')
  const ids = new Set(), kinds = new Set(), caseIds = new Set()
  for (const item of value.cases) {
    if (ids.has(item.id)) fail(`评分样本 ID 重复：${item.id}`)
    ids.add(item.id); kinds.add(item.kind); caseIds.add(item.caseId)
    if (!plan.scope.caseIds.includes(item.caseId)) fail(`评分含范围外 Case：${item.caseId}`)
    if (item.status === 'infrastructure_error') fail(`评分基础设施失败：${item.id}`)
    checkMetrics(item.metrics)
    if (item.status === 'completed' && !Object.keys(item.metrics).length) fail(`已完成样本缺少指标：${item.id}`)
  }
  if (canonical([...caseIds].sort()) !== canonical([...plan.scope.caseIds].sort())) fail('评分结果缺少声明范围内的 Case')
  for (const kind of ['correct', 'incorrect', 'invalid', 'boundary']) if (!kinds.has(kind)) fail(`缺少评分覆盖类型：${kind}`)
  checkMetrics(value.aggregate)
  if (!Object.keys(value.aggregate).length) fail('评分结果缺少聚合指标')
  return value
}

function checkMetrics(metrics) {
  for (const [key, value] of Object.entries(metrics)) {
    if (!key || (typeof value !== 'boolean' && (typeof value !== 'number' || !Number.isFinite(value)))) fail(`指标必须是有限数值或布尔值：${key}`)
  }
}

function compareScores(official, candidate, plan) {
  loadScores(official, plan); loadScores(candidate, plan)
  const differences = []
  const expected = new Map(official.cases.map(item => [item.id, item]))
  const actual = new Map(candidate.cases.map(item => [item.id, item]))
  const knownMetrics = new Set([...official.cases.flatMap(item => Object.keys(item.metrics)), ...Object.keys(official.aggregate)])
  for (const [key, tolerance] of Object.entries(plan.tolerances)) {
    if (!knownMetrics.has(key) || typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0) fail(`容差配置无效：${key}`)
  }
  function metrics(a, b, at) {
    if (canonical(Object.keys(a).sort()) !== canonical(Object.keys(b).sort())) { differences.push(`${at}: 指标集合不同`); return }
    for (const key of Object.keys(a)) {
      const same = typeof a[key] === 'number' && typeof b[key] === 'number'
        ? Math.abs(a[key] - b[key]) <= (plan.tolerances[key] || 0)
        : a[key] === b[key]
      if (!same) differences.push(`${at}.${key}: 官方=${a[key]}，接入=${b[key]}`)
    }
  }
  if (canonical([...expected.keys()].sort()) !== canonical([...actual.keys()].sort())) differences.push('评分样本 ID 集合不同')
  for (const [id, item] of expected) {
    const other = actual.get(id)
    if (!other) continue
    for (const key of ['caseId', 'kind', 'submissionDigest', 'status']) if (item[key] !== other[key]) differences.push(`${id}.${key}: 不一致`)
    metrics(item.metrics, other.metrics, id)
  }
  metrics(official.aggregate, candidate.aggregate, 'aggregate')
  return { status: differences.length ? 'fail' : 'pass', comparedSamples: expected.size, differences }
}

function inspectCheck(value, spec, context, plan) {
  validateDocument(value, 'check')
  if (value.status !== 'pass') {
    if (!value.reason?.trim()) fail('未通过检查必须提供原因')
    return { status: value.status, reason: value.reason }
  }
  if (!value.evidence.length) fail('通过检查需要本次命令产生的独立证据文件')
  const root = real(context.attempt)
  for (const name of value.evidence) {
    const file = real(path.resolve(root, name))
    if (!inside(root, file) || file === path.join(root, 'result.json')) fail('检查证据必须是本次检查目录内的独立文件')
    fileHash(file)
  }
  if (spec.category === 'runtime') {
    const facts = value.facts || {}
    if (facts.mode !== 'live') fail('运行验收需要真实链路证据，Mock 或 Fixture 不可替代')
    if (canonical([...(facts.caseIds || [])].sort()) !== canonical([...plan.scope.caseIds].sort())) fail('运行证据 Case 范围不匹配')
    for (const step of ['dataset', 'execution', 'submission', 'evaluation', 'evidence', 'cleanup']) {
      if (facts.steps?.[step]?.status !== 'pass' || typeof facts.steps[step].reference !== 'string' || !facts.steps[step].reference.trim()) fail(`运行证据缺少步骤或实际记录引用：${step}`)
    }
  }
  return { status: 'pass', facts: value.facts || {} }
}

module.exports = { runCommand, loadScores, compareScores, inspectCheck }
