'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { inspectArtifacts } = require('./artifact-evidence.cjs')
const { canonical, fail, expand, inside, real, fileHash, treeFiles, validateDocument } = require('./common.cjs')

async function runCommand(spec, context, deadline = Infinity) {
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
      let child, timer, forceTimer, pendingFinish, ended = false, bytes = 0, reason = '', cancelled = false, logTruncated = false
      const maxLogBytes = spec.maxLogBytes ?? 8 * 1024 * 1024
      const terminate = () => {
        if (!child?.pid || forceTimer) return
        try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM') } catch {}
        forceTimer = setTimeout(() => {
          try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch {}
          forceTimer = null
          if (pendingFinish) finish(...pendingFinish)
        }, (spec.terminationGraceSeconds ?? 5) * 1000)
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
        resolve({ exitCode, signal, reason, cancelled, logTruncated, logBytes: bytes })
      }
      const write = fd => chunk => {
        const remaining = Math.max(0, maxLogBytes - bytes)
        bytes += chunk.length
        if (chunk.length > remaining) logTruncated = true
        if (remaining) fs.writeSync(fd, chunk.subarray(0, remaining))
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
  const ids = new Set(), caseIds = new Set()
  for (const item of value.cases) {
    if (ids.has(item.id)) fail(`评分样本 ID 重复：${item.id}`)
    ids.add(item.id); caseIds.add(item.caseId)
    if (!plan.scope.caseIds.includes(item.caseId)) fail(`评分含范围外 Case：${item.caseId}`)
    if (item.status === 'infrastructure_error') fail(`评分基础设施失败：${item.id}`)
    checkMetrics(item.metrics)
    if (item.status === 'completed' && !Object.keys(item.metrics).length) fail(`已完成样本缺少指标：${item.id}`)
  }
  if (canonical([...caseIds].sort()) !== canonical([...plan.scope.caseIds].sort())) fail('评分结果缺少声明范围内的 Case')
  if (value.aggregate !== undefined) checkMetrics(value.aggregate)
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
  const knownMetrics = new Set([...official.cases.flatMap(item => Object.keys(item.metrics)), ...Object.keys(official.aggregate || {})])
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
  if (Object.hasOwn(official, 'aggregate') !== Object.hasOwn(candidate, 'aggregate')) differences.push('aggregate: 声明范围不同')
  else if (official.aggregate !== undefined) metrics(official.aggregate, candidate.aggregate, 'aggregate')
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
  const evidence = new Set(value.evidence)
  const verifiedEvidence = new Map()
  for (const name of value.evidence) {
    const file = real(path.resolve(root, name))
    const output = context.output || path.join(root, 'result.json')
    if (path.isAbsolute(name) || !inside(root, file) || file === (fs.existsSync(output) ? real(output) : path.resolve(output))) fail('检查证据必须是本次检查目录内的独立文件')
    const digest = fileHash(file)
    verifiedEvidence.set(name, { file, digest, stat: fs.statSync(file) })
    if (value.evidenceDigests?.[name] != null && value.evidenceDigests[name] !== digest) fail(`证据摘要不匹配：${name}`)
    if ((spec.category === 'runtime' || spec.stage === 'evaluation') && value.evidenceDigests?.[name] !== digest) fail(`运行证据缺少摘要：${name}`)
  }
  if (spec.stage === 'evaluation') {
    const facts = value.facts || {}
    if (facts.mode !== 'live' || facts.submissionSource !== 'frozen') fail('评分服务分段必须使用冻结提交经过实际服务，不能用 Mock、健康检查或函数对照代替')
    for (const step of ['request', 'terminal', 'result']) if (!evidence.has(facts.serviceEvidence?.[step])) fail(`评分服务缺少实际请求、终态或回传证据：${step}`)
    if (typeof facts.scoresFile !== 'string' || !evidence.has(facts.scoresFile)) fail('评分服务必须引用已声明的实际服务标准评分结果 scoresFile')
    if (!context.officialScoresFile) fail('评分服务一致性校验需要冻结的官方评分基线')
    const scoresFile = real(path.resolve(root, facts.scoresFile))
    const officialFile = real(context.officialScoresFile)
    if (scoresFile === officialFile) fail('实际服务评分与官方基线不能引用同一个文件')
    const scoreRows = JSON.parse(fs.readFileSync(scoresFile, 'utf8')).cases
    const comparison = compareScores(JSON.parse(fs.readFileSync(officialFile, 'utf8')), JSON.parse(fs.readFileSync(scoresFile, 'utf8')), plan)
    return {
      status: comparison.status, facts, scoreComparison: comparison,
      ...(comparison.status === 'pass' ? { artifactComparison: inspectArtifacts(value, scoreRows.map(item => ({ sampleId: item.id, caseId: item.caseId, submissionDigest: item.submissionDigest })), { ...context, verifiedEvidence }) } : {}),
      ...(comparison.status === 'fail' ? { reason: `实际评分服务与官方基线不一致：${comparison.differences.join('；')}` } : {}),
    }
  }
  if (spec.category === 'runtime') {
    const facts = value.facts || {}
    if (facts.mode !== 'live') fail('运行验收需要真实链路证据，Mock 或 Fixture 不可替代')
    if (canonical([...(facts.caseIds || [])].sort()) !== canonical([...plan.scope.caseIds].sort())) fail('运行证据 Case 范围不匹配')
    for (const step of ['dataset', 'execution', 'submission', 'evaluation', 'evidence', 'cleanup']) {
      if (facts.steps?.[step]?.status !== 'pass' || typeof facts.steps[step].reference !== 'string' || !facts.steps[step].reference.trim()) fail(`运行证据缺少步骤或实际记录引用：${step}`)
      if (!Array.isArray(facts.steps[step].evidence) || !facts.steps[step].evidence.length || facts.steps[step].evidence.some(name => !evidence.has(name))) fail(`运行步骤缺少已声明的证据文件：${step}`)
    }
    if (!Array.isArray(facts.cases) || canonical(facts.cases.map(item => item.caseId).sort()) !== canonical([...plan.scope.caseIds].sort())) fail('运行逐 Case 证据范围不匹配')
    for (const item of facts.cases) {
      if (typeof item.runId !== 'string' || !item.runId.trim() || typeof item.evaluationId !== 'string' || !item.evaluationId.trim() || item.evaluatedRunId !== item.runId) fail(`执行与评分任务关联不匹配：${item.caseId}`)
      if (!evidence.has(item.submissionFile) || !evidence.has(item.executionEvidence) || !evidence.has(item.evaluationEvidence)) fail(`Case 缺少提交、执行或评分证据：${item.caseId}`)
      if (item.submissionDigest !== value.evidenceDigests[item.submissionFile] || item.evaluatedSubmissionDigest !== item.submissionDigest) fail(`提交与评分摘要不匹配：${item.caseId}`)
    }
    const artifactComparison = inspectArtifacts(value, facts.cases, { ...context, verifiedEvidence })
    if (context.run) {
      const jobs = require('./record-job.cjs')
      const state = jobs.reconcile(context.run, JSON.parse(fs.readFileSync(path.join(context.run, 'run.json'), 'utf8')))
      for (const item of facts.cases) {
        const task = state.jobs.find(job => job.requestId === item.requestId)
        const cleanup = state.jobs.find(job => job.requestId === `${item.requestId}:cleanup`)
        if (!item.requestId || task?.state !== 'completed' || task.platformId !== item.runId || cleanup?.state !== 'completed' || cleanup.platformId !== item.runId) fail(`Case 缺少匹配的已完成任务及清理登记：${item.caseId}`)
      }
    }
    return { status: 'pass', facts, artifactComparison }
  }
  return { status: 'pass', facts: value.facts || {} }
}

module.exports = { runCommand, loadScores, compareScores, inspectCheck }
