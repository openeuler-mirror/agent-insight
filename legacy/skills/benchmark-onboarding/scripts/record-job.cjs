#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const C = require('./common.cjs')

function validateEvent(event) {
  if (typeof event.requestId !== 'string' || !event.requestId.trim()) C.fail('平台任务需要稳定的 requestId')
  if (!['unknown', 'running', 'completed', 'cancelled', 'failed'].includes(event.state)) C.fail('任务状态必须先按目标项目语义映射为 unknown/running/completed/cancelled/failed；原始状态保存在 rawState 和查询证据中')
  if (event.rawState !== undefined && (typeof event.rawState !== 'string' || !event.rawState.trim())) C.fail('原始平台状态必须为非空字符串')
  if (event.notCreated !== undefined && event.notCreated !== true) C.fail('notCreated 只能明确声明为 true')
  if (event.notCreated) {
    const cleanup = event.requestId.endsWith(':cleanup')
    if (event.platformId || event.state !== (cleanup ? 'completed' : 'failed') || !event.evidence) C.fail('未创建任务只能登记有拒绝证据的失败及无需清理，不能提供平台 ID')
    const evidence = C.readJson(typeof event.evidence === 'string' ? event.evidence : event.evidence.path)
    const requestId = cleanup ? event.requestId.slice(0, -8) : event.requestId
    if (evidence.requestId !== requestId || evidence.taskCreated !== false || typeof evidence.contract !== 'string' || !evidence.contract.trim() || !evidence.response || typeof evidence.response !== 'object') C.fail('拒绝证据需要匹配 requestId、taskCreated: false、未创建任务的接口合同依据 contract 和原始 response')
  }
  if (!event.notCreated && event.state !== 'unknown' && (typeof event.platformId !== 'string' || !event.platformId.trim())) C.fail('已知平台任务状态必须携带平台任务 ID')
  if (['completed', 'cancelled', 'failed'].includes(event.state) && !event.evidence) C.fail('终态任务需要平台查询结果证据')
}

function applyEvent(run, event) {
  validateEvent(event)
  const existing = run.jobs.find(job => job.requestId === event.requestId)
  if (event.notCreated && existing?.platformId) C.fail('已有平台任务 ID，不能改记为未创建任务')
  if (existing?.notCreated && !event.notCreated) C.fail('已确认拒绝的请求不能改记为已创建任务；新提交需新的请求标识')
  if (existing?.platformId && event.platformId && existing.platformId !== event.platformId) C.fail('同一请求不能替换平台任务 ID')
  const next = { ...event, platformId: event.platformId || existing?.platformId || null }
  if (existing) Object.assign(existing, next, { history: [...existing.history, next] })
  else run.jobs.push({ ...next, history: [next] })
}

function reconcile(directory, run) {
  const imported = run.importedJobEvents || []
  if (C.staleFiles(imported).length) C.fail('平台任务事件记录缺失或摘要不匹配')
  const seen = new Set(imported.map(item => item.path))
  const commands = run.baselines.map(item => path.join(directory, 'baselines', item.id, 'official'))
  for (const attempt of run.attempts) {
    const root = path.join(directory, 'attempts', attempt.id)
    if (fs.existsSync(root)) for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) commands.push(path.join(root, entry.name))
    }
  }
  for (const command of commands) {
    const journal = path.join(command, 'platform-jobs')
    if (!fs.existsSync(journal)) continue
    if (!C.inside(C.real(directory), C.real(journal))) C.fail('平台任务事件目录必须在本次运行内')
    for (const name of fs.readdirSync(journal).filter(name => name.endsWith('.event.json')).sort()) {
      const file = path.join(journal, name)
      if (seen.has(file)) continue
      const digest = C.fileHash(file)
      const event = C.readJson(file)
      if (event.evidence) {
        if (!C.inside(C.real(journal), C.real(event.evidence.path)) || C.staleFiles([event.evidence]).length) C.fail('平台任务查询证据无效')
        C.readJson(event.evidence.path)
      }
      applyEvent(run, event)
      imported.push({ path: file, digest }); seen.add(file)
    }
  }
  run.importedJobEvents = imported
  return run
}

function record(args = process.argv.slice(2), journal = process.env.BENCHMARK_ONBOARDING_JOB_JOURNAL) {
  if (!journal) C.fail('record-job 只能由验收命令使用；宿主使用 onboard.cjs job')
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '')
    if (!args[i].startsWith('--') || !['request-id', 'platform-id', 'state', 'raw-state', 'evidence', 'not-created'].includes(key) || !args[i + 1] || Object.hasOwn(options, key)) C.fail('record-job 需要不重复的 --name value 选项')
    options[key] = args[i + 1]
  }
  if (options['not-created'] !== undefined && options['not-created'] !== 'true') C.fail('--not-created 只接受 true')
  const event = { requestId: options['request-id'], platformId: options['platform-id'] || null, state: options.state, ...(options['not-created'] ? { notCreated: true } : {}), ...(options['raw-state'] ? { rawState: options['raw-state'] } : {}), at: new Date().toISOString(), ...(options.evidence ? { evidence: options.evidence } : {}) }
  validateEvent(event)
  C.outsideSkill(journal)
  fs.mkdirSync(journal, { recursive: true, mode: 0o700 })
  const root = C.real(journal)
  const lock = path.join(root, '.write.lock')
  let fd
  try { fd = fs.openSync(lock, 'wx', 0o600) } catch { C.fail('平台任务事件正在写入或上次写入中断；先核对记录，不提交新任务') }
  try {
    const ids = fs.readdirSync(root).filter(name => /^\d+\.event\.json$/.test(name)).map(name => Number(name.split('.')[0]))
    const sequence = String(Math.max(0, ...ids) + 1).padStart(6, '0')
    if (options.evidence) {
      C.readJson(options.evidence)
      const target = path.join(root, `${sequence}-${crypto.randomUUID()}.evidence.json`)
      fs.copyFileSync(C.real(options.evidence), target, fs.constants.COPYFILE_EXCL)
      fs.chmodSync(target, 0o600)
      event.evidence = { path: target, digest: C.fileHash(target) }
    }
    C.atomicJson(path.join(root, `${sequence}.event.json`), event)
    return { status: 'recorded', requestId: event.requestId, state: event.state }
  } finally { fs.closeSync(fd); fs.unlinkSync(lock) }
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(record())}\n`) }
  catch (error) { process.stderr.write(`${JSON.stringify({ status: 'needs_action', error: error.message })}\n`); process.exitCode = 2 }
}

module.exports = { record, reconcile, applyEvent, validateEvent }
