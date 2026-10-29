#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const C = require('./common.cjs')
const { runCommand, loadScores, compareScores, inspectCheck } = require('./checks.cjs')
const jobs = require('./record-job.cjs')

const categories = ['source', 'visibility', 'runtime', 'regression']
const stages = ['discovery', 'analysis', 'capabilities', 'design', 'implementation']
const now = () => new Date().toISOString()
const contextFor = (run, directory, attempt) => ({ repo: run.project.repo, run: directory, skill: C.skillRoot, attempt })
const stateFile = directory => path.join(directory, 'run.json')
function save(directory, run) { C.validateDocument(run, 'run'); C.atomicJson(stateFile(directory), run) }
function readRun(directory) { C.outsideSkill(directory); return jobs.reconcile(directory, C.validateDocument(C.readJson(stateFile(directory)), 'run')) }
function deadline(run) { return Date.parse(run.createdAt) + run.budget.maxSeconds * 1000 }
function usedAttempts(run) { return run.baselines.length + run.attempts.length }
function budgetReason(run) {
  if (Date.now() >= deadline(run)) return '总耗时预算已用尽'
  if (usedAttempts(run) >= run.budget.maxAttempts) return '运行尝试预算已用尽'
  return null
}
function pendingJobs(run) { return run.jobs.filter(job => ['unknown', 'running'].includes(job.state)) }
function activeFile(repo) { return path.join(os.tmpdir(), 'agent-insight-benchmark-onboarding-locks', `${C.hash(repo).slice(7)}.active.json`) }
function claim(repo, directory) {
  const file = activeFile(repo)
  if (fs.existsSync(file)) {
    const previous = C.readJson(file)
    if (previous.directory !== directory) {
      let old
      try { old = readRun(previous.directory) } catch { C.fail(`活动运行记录缺失或损坏：${previous.directory}；先核对并恢复记录`) }
      if (!['accepted', 'failed', 'cancelled'].includes(old.status) || pendingJobs(old).length) C.fail(`工作副本已有未结束运行：${previous.directory}；先续接或取消该运行`)
    }
  }
  C.atomicJson(file, { directory, updatedAt: now() })
}
function checkProject(run) {
  const current = C.project(run.project.repo, run.project.address)
  if (current.identity !== run.project.identity) C.fail('运行记录中的项目身份已变化')
  return current
}
function baselineFor(run) { return run.baselines.find(item => item.id === run.activeBaseline) }
function baselineDrift(run) {
  const baseline = baselineFor(run)
  if (!baseline || baseline.status !== 'pass') return ['缺少已通过的官方评分基线']
  const issues = C.staleFiles([...baseline.inputs, ...baseline.evidence])
  if (C.treeHash(C.skillRoot) !== baseline.skillDigest) issues.push('Skill 内容已变化，重新冻结并保留变更原因')
  return issues
}
function readPlan(baseline) { return C.validateDocument(C.readJson(baseline.planFile), 'plan') }
function ensurePlan(plan) {
  C.validateDocument(plan, 'plan')
  C.publicReference(plan.source.url)
  if (plan.source.caseCount < plan.scope.caseIds.length) C.fail('试验 Case 数不能超过来源样本数')
  const ids = new Set(['catalog', 'scoring', 'inputs', 'workflow'])
  for (const check of plan.checks) {
    if (ids.has(check.id)) C.fail(`检查 ID 重复或保留：${check.id}`)
    ids.add(check.id)
    if (check.resultMode === 'exit-code' && check.category !== 'regression') C.fail('仅回归检查可只依据命令退出码；其他类别必须输出结构化证据')
  }
  if (plan.baseline.argv.length && C.canonical(plan.baseline) === C.canonical(plan.candidate)) C.fail('官方评分与接入评分不能使用完全相同的命令配置来验证自身')
  return plan
}
function readCheckedOutput(command, directory) {
  const output = command.output
  if (!output || !C.inside(C.real(directory), C.real(output))) C.fail('命令没有产生本次运行目录内的结果文件')
  if (fs.statSync(output).size > 8 * 1024 * 1024) C.fail('结构化结果超过 8 MiB')
  return C.readJson(output)
}
function guard(run, ignoreBudget = false) {
  if (run.status === 'cancelled') C.fail('运行已取消；需要新任务时初始化新的 runId')
  if (pendingJobs(run).length) C.fail('存在在途或状态未知的平台任务；先查询并记录结果，不能重复提交')
  const reason = budgetReason(run)
  if (reason && !ignoreBudget) C.fail(reason)
}
function artifactCopy(directory, source, name) {
  const target = path.join(directory, name)
  C.outsideSkill(target)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  fs.copyFileSync(C.real(source), target, fs.constants.COPYFILE_EXCL)
  fs.chmodSync(target, 0o600)
  return { path: target, digest: C.fileHash(target) }
}

async function init(options) {
  const project = C.project(required(options, 'repo'), required(options, 'project'))
  const source = C.publicReference(required(options, 'source'))
  const runId = options.id || `${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(runId)) C.fail('runId 只能使用小写字母、数字、连字符，长度 1～80')
  const root = path.resolve(options['run-root'] || path.join(os.homedir(), '.agent-insight', 'data', 'benchmark-onboarding'))
  C.outsideSkill(root)
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const directory = path.join(C.real(root), runId)
  return C.withLock(project.repo, async () => {
    if (fs.existsSync(stateFile(directory))) {
      const previous = readRun(directory)
      if (previous.project.repo !== project.repo || previous.project.identity !== project.identity || previous.source !== source) C.fail('runId 已属于其他任务')
      return { directory, reused: true, runId, status: previous.status }
    }
    if (fs.existsSync(directory)) C.fail('运行目录已存在但缺少 run.json，保留现场并使用新的 runId')
    const run = {
      schemaVersion: 'benchmark-onboarding-run/v1', runId, project, source,
      createdAt: now(), budget: { maxAttempts: Number(options['max-attempts'] || 5), maxSeconds: Number(options['max-seconds'] || 3600) },
      status: 'running', stage: 'discovery', baselines: [], attempts: [], checkpoints: [], jobs: [],
    }
    C.validateDocument(run, 'run')
    claim(project.repo, directory)
    save(directory, run)
    return { directory, runId, status: run.status, project }
  })
}

async function freeze(directory, run, options) {
  guard(run, true)
  const plan = ensurePlan(C.readJson(required(options, 'plan')))
  const context = contextFor(run, directory)
  const inputs = C.inputSnapshot(plan.baselineInputs, context)
  const prior = baselineFor(run)
  const planDigest = C.hash(C.canonical(plan))
  if (prior?.status === 'pass' && prior.planDigest === planDigest && !baselineDrift(run).length && C.canonical(prior.inputs) === C.canonical(inputs)) return { reused: true, baseline: prior.id, status: 'pass' }
  guard(run)
  if (run.baselines.length && !options.reason?.trim()) C.fail('重新冻结必须通过 --reason 记录来源、规则或计划变化原因；旧尝试会保留')
  const id = String(run.baselines.length + 1).padStart(4, '0')
  const attemptDir = path.join(directory, 'baselines', id)
  const planFile = path.join(attemptDir, 'plan.json')
  const baseline = { id, startedAt: now(), status: 'running', planFile, planDigest, inputs, skillDigest: C.treeHash(C.skillRoot), reason: options.reason || '首次冻结', evidence: [] }
  run.baselines.push(baseline); delete run.activeBaseline
  run.status = 'running'; run.stage = 'baseline'; delete run.stopReason
  save(directory, run)
  C.atomicJson(planFile, plan)
  try {
    const command = await runCommand(plan.baseline, contextFor(run, directory, path.join(attemptDir, 'official')), deadline(run))
    baseline.command = command
    baseline.evidence = [{ path: planFile, digest: C.fileHash(planFile) }, ...command.evidence]
    baseline.status = command.status
    if (command.status === 'pass') {
      const scores = loadScores(readCheckedOutput(command, attemptDir), plan)
      compareScores(scores, scores, plan)
      if (C.staleFiles(inputs).length) C.fail('官方评分期间输入发生变化')
      baseline.scoresFile = command.output
      run.activeBaseline = id
    } else baseline.reason = command.reason
  } catch (error) { baseline.status = 'fail'; baseline.reason = error.message }
  baseline.finishedAt = now()
  run.status = baseline.status === 'pass' ? 'running' : 'needs_action'
  save(directory, run)
  return { status: baseline.status, baseline: id, reason: baseline.reason, directory: attemptDir }
}

function workflowCheck(run) {
  const evidence = []
  for (const stage of ['analysis', 'capabilities', 'design']) {
    const checkpoint = [...run.checkpoints].reverse().find(item => item.stage === stage)
    if (!checkpoint) return { id: 'workflow', status: 'blocked', reason: `缺少 ${stage} 阶段产物`, required: true }
    evidence.push(checkpoint.evidence)
  }
  if (C.staleFiles(evidence).length) return { id: 'workflow', status: 'blocked', reason: '分析或设计记录损坏', required: true }
  return { id: 'workflow', status: 'pass', required: true, evidence }
}

async function verify(directory, run) {
  guard(run)
  const drift = baselineDrift(run)
  if (drift.length) C.fail(`官方基线失效：${drift.join('；')}`)
  const baseline = baselineFor(run)
  const plan = ensurePlan(readPlan(baseline))
  const id = String(run.attempts.length + 1).padStart(4, '0')
  const attemptDir = path.join(directory, 'attempts', id)
  const context = contextFor(run, directory, attemptDir)
  const snapshot = C.codeSnapshot(run.project.repo, plan.benchmarkKey, plan.implementationInputs, context)
  const attempt = { id, baseline: baseline.id, startedAt: now(), status: 'running', snapshot, checks: [workflowCheck(run)] }
  run.attempts.push(attempt); run.status = 'running'; run.stage = 'verification'; delete run.stopReason
  save(directory, run)
  let interrupted = false
  try {
    const command = await runCommand({ argv: [process.execPath, path.join(C.skillRoot, 'scripts/catalog-check.cjs'), '{repo}', plan.benchmarkKey], cwd: '{repo}', timeoutSeconds: 60 }, { ...context, attempt: path.join(attemptDir, 'catalog') }, deadline(run))
    let catalog = { ...command, id: 'catalog', required: true }
    if (command.status === 'pass') {
      const result = C.readJson(path.join(attemptDir, 'catalog/stdout.log'))
      if (result.status !== 'pass' || result.key !== plan.benchmarkKey) C.fail('Catalog 命令未返回匹配的校验结果')
      catalog.packageDigest = result.digest
    }
    attempt.checks.push(catalog)
    interrupted ||= !!command.cancelled
    save(directory, run)
    const scoring = interrupted ? { status: 'blocked', reason: '运行已取消', evidence: [] } : await runCommand(plan.candidate, { ...context, attempt: path.join(attemptDir, 'scoring') }, deadline(run))
    let compared = {}
    if (scoring.status === 'pass') {
      try { compared = compareScores(C.readJson(baseline.scoresFile), readCheckedOutput(scoring, attemptDir), plan) }
      catch (error) { compared = { status: 'fail', reason: error.message } }
    }
    attempt.checks.push({ ...scoring, ...compared, id: 'scoring', required: true })
    interrupted ||= !!scoring.cancelled
    save(directory, run)
    for (const spec of plan.checks) {
      const checkContext = { ...context, attempt: path.join(attemptDir, spec.id) }
      let result
      try {
        result = interrupted ? { status: 'blocked', reason: '运行已取消', evidence: [] } : await runCommand(spec, checkContext, deadline(run))
        if (result.status === 'pass' && spec.resultMode === 'check') Object.assign(result, inspectCheck(readCheckedOutput(result, checkContext.attempt), spec, checkContext, plan))
      } catch (error) { result = { ...result, status: 'fail', reason: error.message } }
      interrupted ||= !!result.cancelled
      attempt.checks.push({ ...result, id: spec.id, category: spec.category, required: spec.required })
      save(directory, run)
    }
    for (const category of categories) if (!plan.checks.some(check => check.category === category && check.required)) attempt.checks.push({ id: `missing-${category}`, category, required: true, status: 'blocked', reason: `缺少必需 ${category} 检查` })
  } catch (error) {
    attempt.checks.push({ id: 'verification-error', required: true, status: 'fail', reason: error.message })
  }
  try {
    const after = C.codeSnapshot(run.project.repo, plan.benchmarkKey, plan.implementationInputs, context)
    attempt.checks.push({ id: 'inputs', required: true, status: C.canonical(after) === C.canonical(snapshot) && !baselineDrift(run).length ? 'pass' : 'blocked', reason: '核对检查期间代码、基线及 Skill 摘要' })
  } catch (error) { attempt.checks.push({ id: 'inputs', required: true, status: 'blocked', reason: error.message }) }
  attempt.finishedAt = now(); attempt.status = interrupted ? 'cancelled' : 'completed'
  run.status = interrupted ? 'cancelled' : 'needs_action'
  save(directory, run)
  return writeReport(directory, run)
}

function computeReport(directory, run) {
  const attempt = run.attempts.at(-1)
  const checks = attempt ? structuredClone(attempt.checks) : []
  const limitations = []
  if (['needs_action', 'cancelled'].includes(run.status) && run.stopReason) limitations.push(run.stopReason)
  let plan
  try {
    checkProject(run)
    const drift = baselineDrift(run)
    if (drift.length) limitations.push(`基线缺失或失效：${drift.join('；')}`)
    const baseline = baselineFor(run)
    if (baseline) plan = ensurePlan(readPlan(baseline))
    if (!attempt || attempt.status === 'running') limitations.push('没有已结束的验收尝试；先核对上次进程和在途平台任务')
    if (attempt && plan) {
      if (attempt.baseline !== baseline.id) limitations.push('最近尝试属于旧官方基线')
      if (C.canonical(attempt.snapshot) !== C.canonical(C.codeSnapshot(run.project.repo, plan.benchmarkKey, plan.implementationInputs, contextFor(run, directory)))) limitations.push('代码、环境输入或 Skill 已变化，需要重新验收')
      const artifacts = checks.flatMap(check => check.evidence || [])
      if (C.staleFiles(artifacts).length) limitations.push('验收证据缺失或摘要不匹配')
      if (plan.scope.mode !== 'live') limitations.push('Fixture 仅验证工具行为，不构成真实 Benchmark 接入验收')
      for (const id of ['workflow', 'catalog', 'scoring', 'inputs']) if (!checks.some(check => check.id === id && check.required)) limitations.push(`缺少必需检查：${id}`)
      for (const category of categories) if (!checks.some(check => check.category === category && check.required)) limitations.push(`缺少必需类别：${category}`)
    }
  } catch (error) { limitations.push(error.message) }
  if (pendingJobs(run).length) limitations.push('仍有在途或状态未知的平台任务，需查询而非重复提交')
  if (C.staleFiles(run.jobs.flatMap(job => job.history.filter(event => event.evidence).map(event => event.evidence))).length) limitations.push('平台任务查询证据缺失或摘要不匹配')
  const requiredChecks = checks.filter(check => check.required)
  let status = limitations.length || !requiredChecks.length || requiredChecks.some(check => ['blocked', 'skipped'].includes(check.status)) ? 'needs_action' : requiredChecks.some(check => check.status !== 'pass') ? 'failed' : 'accepted'
  if (run.status === 'cancelled' || attempt?.status === 'cancelled') status = 'cancelled'
  return C.validateDocument({ schemaVersion: 'benchmark-onboarding-report/v1', runId: run.runId, generatedAt: now(), status, project: run.project, source: plan?.source || { url: run.source }, scope: plan?.scope || null, budget: { ...run.budget, usedAttempts: usedAttempts(run), elapsedSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(run.createdAt)) / 1000)) }, checks, limitations, attempts: run.attempts.map(item => ({ id: item.id, baseline: item.baseline, status: item.status, startedAt: item.startedAt, finishedAt: item.finishedAt })), jobs: run.jobs }, 'report')
}

function writeReport(directory, run) {
  jobs.reconcile(directory, run)
  const report = computeReport(directory, run)
  run.status = report.status
  save(directory, run)
  const reportFile = path.join(directory, 'reports/report.json')
  C.atomicJson(reportFile, report)
  const cell = value => String(value || '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')
  const rows = report.checks.map(check => `| ${cell(check.id)} | ${check.required ? '必需' : '可选'} | ${check.status} | ${cell(check.reason || check.differences?.join('；'))} |`).join('\n')
  const template = fs.readFileSync(path.join(C.skillRoot, 'assets/templates/report.md.tmpl'), 'utf8')
  const rendered = template.replace(/\{\{(runId|status|scope|checks|limitations|reportPath)\}\}/g, (_, key) => ({ runId: report.runId, status: report.status, scope: cell(report.scope?.label || '未冻结'), checks: rows, limitations: report.limitations.map(item => `- ${item}`).join('\n') || '无额外限制；结论仅适用于上述冻结范围。', reportPath: reportFile })[key])
  fs.writeFileSync(path.join(directory, 'reports/report.md'), rendered, { mode: 0o600 })
  return { status: report.status, report: reportFile, markdown: path.join(directory, 'reports/report.md'), limitations: report.limitations }
}

function required(options, key) { if (!options[key]?.trim()) C.fail(`缺少 --${key}`); return options[key] }
function parse(args) {
  const result = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!/^--[a-z-]+$/.test(args[i]) || args[i + 1] == null || Object.hasOwn(result, args[i].slice(2))) C.fail('选项必须使用不重复的 --name value')
    result[args[i].slice(2)] = args[i + 1]
  }
  return result
}
const allowed = {
  init: ['project', 'repo', 'source', 'run-root', 'id', 'max-attempts', 'max-seconds'],
  status: ['run'], resume: ['run'], freeze: ['run', 'plan', 'reason'], checkpoint: ['run', 'stage', 'evidence'],
  verify: ['run'], report: ['run'], job: ['run', 'request-id', 'platform-id', 'state', 'evidence'],
  stop: ['run', 'status', 'reason'], budget: ['run', 'max-attempts', 'max-seconds', 'reason'],
}
async function main(args = process.argv.slice(2)) {
  const command = args[0]
  if (!command || ['help', '--help'].includes(command)) return { status: 'help', commands: allowed, note: '需要 Node.js 20+ 与 Git；详细用法见 references/usage.md。命令不会自动克隆、提交或启动平台服务。' }
  if (!allowed[command]) C.fail(`未知命令：${command}`)
  const options = parse(args.slice(1))
  for (const key of Object.keys(options)) if (!allowed[command].includes(key)) C.fail(`未知选项 --${key}`)
  if (command === 'init') return init(options)
  const directory = C.real(required(options, 'run'))
  const initial = readRun(directory)
  if (['status', 'resume'].includes(command)) return { ...computeReport(directory, initial), directory, stage: initial.stage, resume: { budgetReason: budgetReason(initial), pendingJobs: pendingJobs(initial), checkpoints: initial.checkpoints } }
  return C.withLock(initial.project.repo, async () => {
    const run = readRun(directory)
    checkProject(run)
    claim(run.project.repo, directory)
    if (command === 'freeze') return freeze(directory, run, options)
    if (command === 'verify') return verify(directory, run)
    if (command === 'report') return writeReport(directory, run)
    if (command === 'checkpoint') {
      if (!stages.includes(options.stage)) C.fail(`阶段只能为：${stages.join(', ')}`)
      if (options.stage === 'implementation' && baselineDrift(run).length) C.fail('实现前先冻结有效的官方基线')
      const evidence = artifactCopy(directory, required(options, 'evidence'), `analysis/${String(run.checkpoints.length + 1).padStart(4, '0')}-${options.stage}${path.extname(options.evidence) || '.txt'}`)
      run.checkpoints.push({ stage: options.stage, createdAt: now(), evidence, head: C.git(run.project.repo, ['rev-parse', 'HEAD']) })
      run.stage = options.stage
    } else if (command === 'job') {
      const requestId = required(options, 'request-id')
      jobs.validateEvent({ requestId, state: options.state, platformId: options['platform-id'], evidence: options.evidence })
      if (options.evidence) C.readJson(options.evidence)
      const existing = run.jobs.find(job => job.requestId === requestId)
      if (existing?.platformId && options['platform-id'] && existing.platformId !== options['platform-id']) C.fail('同一请求不能替换平台任务 ID')
      const evidence = options.evidence ? artifactCopy(directory, options.evidence, `evidence/job-${crypto.randomUUID()}.json`) : undefined
      const event = { state: options.state, platformId: options['platform-id'] || existing?.platformId || null, at: now(), ...(evidence ? { evidence } : {}) }
      jobs.applyEvent(run, { requestId, ...event })
    } else if (command === 'stop') {
      if (!['needs_action', 'cancelled'].includes(options.status)) C.fail('stop 只接受 needs_action 或 cancelled；accepted 必须来自验收程序')
      if (run.status === 'cancelled' && options.status !== 'cancelled') C.fail('已取消运行不能重新激活，请创建新任务')
      run.status = options.status; run.stopReason = required(options, 'reason')
    } else if (command === 'budget') {
      const next = { maxAttempts: Number(options['max-attempts'] || run.budget.maxAttempts), maxSeconds: Number(options['max-seconds'] || run.budget.maxSeconds) }
      run.budgetHistory ||= []
      run.budgetHistory.push({ previous: run.budget, next, reason: required(options, 'reason'), at: now() })
      run.budget = next
    }
    save(directory, run)
    return { status: run.status, runId: run.runId, directory, stage: run.stage }
  })
}

if (require.main === module) main().then(result => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (['verify', 'report', 'freeze'].includes(process.argv[2])) process.exitCode = ['accepted', 'pass'].includes(result.status) ? 0 : result.status === 'cancelled' ? 130 : ['failed', 'fail'].includes(result.status) ? 1 : 2
}).catch(error => { process.stderr.write(`${JSON.stringify({ status: 'needs_action', error: error.message })}\n`); process.exitCode = 2 })

module.exports = { main, computeReport, ensurePlan }
