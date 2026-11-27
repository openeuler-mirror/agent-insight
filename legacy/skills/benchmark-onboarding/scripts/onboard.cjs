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
const now = () => new Date().toISOString()
const contextFor = (run, directory, attempt) => ({ repo: run.project.repo, run: directory, skill: C.skillRoot, attempt })
const stateFile = directory => path.join(directory, 'run.json')
function save(directory, run) { C.validateDocument(run, 'run'); C.atomicJson(stateFile(directory), run) }
function readRun(directory) { C.outsideSkill(directory); return jobs.reconcile(directory, C.validateDocument(C.readJson(stateFile(directory)), 'run')) }
function deadline(run) { return run.budget.maxSeconds == null ? Infinity : Date.parse(run.createdAt) + run.budget.maxSeconds * 1000 }
function usedAttempts(run) { return run.baselines.length + run.attempts.length }
function budgetReason(run) {
  if (Date.now() >= deadline(run)) return '总耗时预算已用尽'
  if (run.budget.maxAttempts != null && usedAttempts(run) >= run.budget.maxAttempts) return '运行尝试预算已用尽'
  return null
}
function configuredBudget(options, previous = {}) {
  const next = { ...previous }
  for (const [option, field] of [['max-attempts', 'maxAttempts'], ['max-seconds', 'maxSeconds']]) {
    if (!Object.hasOwn(options, option)) continue
    if (options[option] === 'unlimited') delete next[field]
    else next[field] = Number(options[option])
  }
  return next
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
  return issues
}
function scoringIdentity(plan) {
  return C.hash(C.canonical({ benchmarkKey: plan.benchmarkKey, source: plan.source, caseIds: plan.scope.caseIds, baseline: plan.baseline }))
}
function readPlan(baseline) { return C.readJson(baseline.planFile) }
function ensurePlan(plan) {
  if (Object.hasOwn(plan, 'candidate')) C.fail('candidate 评分入口已移除；删除该字段及旧 scoring 依赖，用 stage: evaluation 的真实服务结果对照官方基线，保存新计划后 freeze --reason')
  C.validateDocument(plan, 'plan')
  C.publicReference(plan.source.url)
  if (plan.source.caseCount < plan.scope.caseIds.length) C.fail('试验 Case 数不能超过来源样本数')
  const ids = new Set(['catalog', 'inputs', 'workflow'])
  const available = new Set(['workflow', 'catalog'])
  const ancestors = new Map()
  for (const check of plan.checks) {
    if (ids.has(check.id)) C.fail(`检查 ID 重复或保留：${check.id}`)
    ids.add(check.id)
    if (check.resultMode === 'exit-code' && check.category !== 'regression') C.fail('仅回归检查可只依据命令退出码；其他类别必须输出结构化证据')
    const parents = new Set()
    for (const id of check.dependsOn || []) {
      if (!available.has(id)) C.fail(`依赖必须引用之前的检查，不能缺失、前向引用或成环：${check.id} -> ${id}`)
      parents.add(id)
      for (const ancestor of ancestors.get(id) || []) parents.add(ancestor)
    }
    ancestors.set(check.id, parents)
    available.add(check.id)
    if (check.stage && (!check.required || check.category !== 'regression')) C.fail('分段检查必须是必需 regression 检查')
    if (check.stage === 'evaluation' && (check.resultMode !== 'check' || !plan.checks.some(item => item.stage === 'interfaces' && parents.has(item.id)))) C.fail('真实评分服务检查需要结构化结果且依赖接口检查')
    if (check.stage === 'delivery' && !plan.checks.some(item => item.category === 'runtime' && parents.has(item.id))) C.fail('交付回归必须依赖已完成的真实链路')
    if (check.category === 'runtime') {
      for (const id of ['workflow', 'catalog']) if (!parents.has(id)) C.fail(`runtime 缺少前置依赖：${id}`)
      for (const stage of ['interfaces', 'evaluation']) if (!plan.checks.some(item => item.stage === stage && parents.has(item.id))) C.fail(`runtime 缺少分层前置检查：${stage}`)
      for (const item of plan.checks.filter(item => item.required && item.category !== 'runtime' && item.stage !== 'delivery')) if (!parents.has(item.id)) C.fail(`runtime 缺少必需检查依赖：${item.id}`)
    }
  }
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
      createdAt: now(), budget: configuredBudget(options),
      status: 'running', stage: 'discovery', baselines: [], attempts: [], jobs: [],
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
    const reusable = prior?.status === 'pass' && !C.staleFiles([...prior.inputs, ...prior.evidence]).length
      && C.canonical(prior.inputs) === C.canonical(inputs) && scoringIdentity(C.readJson(prior.planFile)) === scoringIdentity(plan)
    const command = reusable ? prior.command : await runCommand(plan.baseline, contextFor(run, directory, path.join(attemptDir, 'official')), deadline(run))
    if (reusable) baseline.reusedFrom = prior.id
    baseline.command = command
    baseline.evidence = [{ path: planFile, digest: C.fileHash(planFile) }, ...(reusable ? prior.evidence : command.evidence)]
    baseline.status = command.status
    if (command.status === 'pass') {
      const scores = loadScores(reusable ? C.readJson(prior.scoresFile) : readCheckedOutput(command, attemptDir), plan)
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
  const attempt = { id, baseline: baseline.id, startedAt: now(), status: 'running', snapshot, checks: [{ id: 'workflow', status: 'pass', required: true, evidence: C.inputSnapshot(plan.analysisInputs, context) }] }
  run.attempts.push(attempt); run.status = 'running'; run.stage = 'verification'; delete run.stopReason
  save(directory, run)
  let interrupted = false
  try {
    const command = await runCommand(plan.catalog || { argv: [process.execPath, path.join(C.skillRoot, 'scripts/catalog-check.cjs'), '{repo}', plan.benchmarkKey], cwd: '{repo}', timeoutSeconds: 60 }, { ...context, attempt: path.join(attemptDir, 'catalog') }, deadline(run))
    let catalog = { ...command, id: 'catalog', required: true }
    if (command.status === 'pass') {
      const result = plan.catalog ? readCheckedOutput(command, path.join(attemptDir, 'catalog')) : C.readJson(path.join(attemptDir, 'catalog/stdout.log'))
      if (result.status !== 'pass' || result.key !== plan.benchmarkKey) C.fail('Catalog 命令未返回匹配的校验结果')
      catalog.packageDigest = result.digest
    }
    attempt.checks.push(catalog)
    interrupted ||= !!command.cancelled
    save(directory, run)
    for (const spec of plan.checks) {
      const checkContext = { ...context, attempt: path.join(attemptDir, spec.id) }
      let result
      try {
        const dependencies = new Set()
        const collect = id => {
          if (dependencies.has(id)) return
          dependencies.add(id)
          for (const parent of plan.checks.find(item => item.id === id)?.dependsOn || []) collect(parent)
        }
        for (const id of spec.dependsOn || []) collect(id)
        const unmet = [...dependencies].filter(id => attempt.checks.find(item => item.id === id)?.status !== 'pass')
        let reason = interrupted ? '运行已取消' : unmet.length ? `前置检查未通过：${unmet.join('、')}` : null
        if (!reason && dependencies.size) {
          const evidence = attempt.checks.filter(item => dependencies.has(item.id)).flatMap(item => item.evidence || [])
          if (C.staleFiles(evidence).length) reason = '前置检查证据已变化或缺失'
          else if (baselineDrift(run).length || !C.sameSnapshot(snapshot, C.codeSnapshot(run.project.repo, plan.benchmarkKey, plan.implementationInputs, context))) reason = '前置检查后输入或版本已变化，需要重新验收'
        }
        result = reason ? { status: 'blocked', reason, evidence: [] } : await runCommand(spec, checkContext, deadline(run))
        if (result.status === 'pass' && spec.resultMode === 'check') Object.assign(result, inspectCheck(readCheckedOutput(result, checkContext.attempt), spec, { ...checkContext, officialScoresFile: baseline.scoresFile }, plan))
      } catch (error) { result = { ...result, status: 'fail', reason: error.message } }
      interrupted ||= !!result.cancelled
      attempt.checks.push({ ...result, id: spec.id, category: spec.category, stage: spec.stage, dependsOn: spec.dependsOn || [], required: spec.required })
      save(directory, run)
    }
    for (const category of categories) if (!plan.checks.some(check => check.category === category && check.required)) attempt.checks.push({ id: `missing-${category}`, category, required: true, status: 'blocked', reason: `缺少必需 ${category} 检查` })
  } catch (error) {
    attempt.checks.push({ id: 'verification-error', required: true, status: 'fail', reason: error.message })
  }
  try {
    const after = C.codeSnapshot(run.project.repo, plan.benchmarkKey, plan.implementationInputs, context)
    attempt.checks.push({ id: 'inputs', required: true, status: C.sameSnapshot(after, snapshot) && !baselineDrift(run).length ? 'pass' : 'blocked', reason: '核对检查期间相关实现、基线及验收程序摘要' })
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
      if (!C.sameSnapshot(attempt.snapshot, C.codeSnapshot(run.project.repo, plan.benchmarkKey, plan.implementationInputs, contextFor(run, directory)))) limitations.push('相关代码、环境输入或验收程序已变化，需要重新验收')
      const artifacts = checks.flatMap(check => check.evidence || [])
      if (C.staleFiles(artifacts).length) limitations.push('验收证据缺失或摘要不匹配')
      if (plan.scope.mode !== 'live') limitations.push('Fixture 仅验证工具行为，不构成真实 Benchmark 接入验收')
      for (const id of ['workflow', 'catalog', 'inputs']) if (!checks.some(check => check.id === id && check.required)) limitations.push(`缺少必需检查：${id}`)
      for (const spec of plan.checks.filter(item => item.required)) if (!checks.some(check => check.id === spec.id && check.required)) limitations.push(`缺少计划中的必需检查：${spec.id}`)
      for (const category of categories) if (!checks.some(check => check.category === category && check.required)) limitations.push(`缺少必需类别：${category}`)
    }
  } catch (error) { limitations.push(error.message) }
  if (pendingJobs(run).length) limitations.push('仍有在途或状态未知的平台任务，需查询而非重复提交')
  if (C.staleFiles(run.jobs.flatMap(job => job.history.filter(event => event.evidence).map(event => event.evidence))).length) limitations.push('平台任务查询证据缺失或摘要不匹配')
  const requiredChecks = checks.filter(check => check.required)
  let status = limitations.length || !requiredChecks.length ? 'needs_action' : requiredChecks.some(check => check.status === 'fail') ? 'failed' : requiredChecks.some(check => check.status !== 'pass') ? 'needs_action' : 'accepted'
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
  const rows = report.checks.map(check => {
    const artifacts = check.artifactComparison
    const note = artifacts ? `产物核对 ${artifacts.checkedOutputs} 件／${artifacts.checkedEvaluations} 次评测；${artifacts.presentation === 'pass' ? '页面已验证' : '页面未验证（仅核对接口下载）'}` : ''
    return `| ${cell(check.id)} | ${check.required ? '必需' : '可选'} | ${check.status} | ${cell((check.reason || check.differences?.join('；') || note) + (check.logTruncated ? '；命令日志已截断，正式评测证据另行完整保存' : ''))} |`
  }).join('\n')
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
  status: ['run'], resume: ['run'], freeze: ['run', 'plan', 'reason'],
  verify: ['run'], report: ['run'], job: ['run', 'request-id', 'platform-id', 'state', 'raw-state', 'evidence', 'not-created'],
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
  if (['status', 'resume'].includes(command)) return { ...computeReport(directory, initial), directory, stage: initial.stage, resume: { budgetReason: budgetReason(initial), pendingJobs: pendingJobs(initial) } }
  return C.withLock(initial.project.repo, async () => {
    const run = readRun(directory)
    checkProject(run)
    claim(run.project.repo, directory)
    if (command === 'freeze') return freeze(directory, run, options)
    if (command === 'verify') return verify(directory, run)
    if (command === 'report') return writeReport(directory, run)
    if (command === 'job') {
      const requestId = required(options, 'request-id')
      if (options['not-created'] !== undefined && options['not-created'] !== 'true') C.fail('--not-created 只接受 true')
      jobs.validateEvent({ requestId, state: options.state, platformId: options['platform-id'], evidence: options.evidence, rawState: options['raw-state'], ...(options['not-created'] ? { notCreated: true } : {}) })
      if (options.evidence) C.readJson(options.evidence)
      const existing = run.jobs.find(job => job.requestId === requestId)
      if (existing?.platformId && options['platform-id'] && existing.platformId !== options['platform-id']) C.fail('同一请求不能替换平台任务 ID')
      const evidence = options.evidence ? artifactCopy(directory, options.evidence, `evidence/job-${crypto.randomUUID()}.json`) : undefined
      const event = { state: options.state, ...(options['not-created'] ? { notCreated: true } : {}), ...(options['raw-state'] ? { rawState: options['raw-state'] } : {}), platformId: options['platform-id'] || existing?.platformId || null, at: now(), ...(evidence ? { evidence } : {}) }
      jobs.applyEvent(run, { requestId, ...event })
    } else if (command === 'stop') {
      if (!['needs_action', 'cancelled'].includes(options.status)) C.fail('stop 只接受 needs_action 或 cancelled；accepted 必须来自验收程序')
      if (run.status === 'cancelled' && options.status !== 'cancelled') C.fail('已取消运行不能重新激活，请创建新任务')
      run.status = options.status; run.stopReason = required(options, 'reason')
    } else if (command === 'budget') {
      if (!Object.hasOwn(options, 'max-attempts') && !Object.hasOwn(options, 'max-seconds')) C.fail('预算调整至少需要指定一个上限；解除限制使用 unlimited')
      const next = configuredBudget(options, run.budget)
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
