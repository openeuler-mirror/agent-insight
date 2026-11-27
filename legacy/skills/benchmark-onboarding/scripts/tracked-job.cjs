'use strict'

const path = require('node:path')
const crypto = require('node:crypto')
const C = require('./common.cjs')
const jobs = require('./record-job.cjs')

const terminal = state => ['completed', 'failed', 'cancelled'].includes(state)
const blocked = message => Object.assign(new Error(message), { blocked: true })
function normalizeState(rawState, mapState) {
  const state = mapState ? mapState(rawState) : rawState
  if (!['unknown', 'running', 'completed', 'failed', 'cancelled'].includes(state)) throw blocked(`平台状态未适配：${rawState}；请依据目标状态定义提供 mapState，不能当作 running 等待`)
  return state
}

function positiveMs(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) C.fail(`${name} 必须为有效的正整数毫秒数`)
}

async function boundedCall(callback, context, timeoutMs, label) {
  const controller = new AbortController()
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(() => callback({ ...context, signal: controller.signal })),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = blocked(`${label}超时；先核对原任务，不能重新提交`)
          reject(error)
          controller.abort(error)
        }, timeoutMs)
      }),
    ])
  } finally { clearTimeout(timer) }
}

async function waitForJob({ query, mapState, context = {}, timeoutMs = 120000, requestTimeoutMs = 10000, pollIntervalMs = 1000, onObservation = () => {} }) {
  for (const [name, value] of Object.entries({ timeoutMs, requestTimeoutMs, pollIntervalMs })) positiveMs(value, name)
  if (typeof query !== 'function') C.fail('query 必须是单次查询函数')
  const deadline = performance.now() + timeoutMs
  while (true) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw blocked('任务等待超时；先核对原任务，不能重新提交')
    const value = await boundedCall(query, context, Math.min(remaining, requestTimeoutMs), '任务查询')
    const rawState = value?.rawState || value?.state
    let state
    try { state = normalizeState(value?.state, mapState) }
    catch (error) { await onObservation({ ...value, rawState, state: 'unknown' }); throw error }
    const observed = { ...value, rawState, state }
    await onObservation(observed)
    if (terminal(state)) return observed
    if (state === 'unknown') throw blocked('任务状态未知；先核对原任务，不能继续等待或重新提交')
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(pollIntervalMs, deadline - performance.now()))))
  }
}

async function trackedJob({ run, caseId, operation, inputDigest, submit, query, cleanup, mapState, timeoutMs = 120000, requestTimeoutMs = 10000, pollIntervalMs = 1000, cleanupTimeoutMs = 10000, journal = process.env.BENCHMARK_ONBOARDING_JOB_JOURNAL }) {
  if (!run || !journal || !caseId || !operation || !/^sha256:[0-9a-f]{64}$/.test(inputDigest || '') || ![submit, query, cleanup].every(fn => typeof fn === 'function')) C.fail('trackedJob 需要运行目录、Case、操作名、输入摘要、事件目录及 submit/query/cleanup 回调')
  for (const [name, value] of Object.entries({ timeoutMs, requestTimeoutMs, pollIntervalMs, cleanupTimeoutMs })) positiveMs(value, name)
  const state = jobs.reconcile(run, C.readJson(path.join(run, 'run.json')))
  const requestId = `job-${C.hash(C.canonical({ runId: state.runId, caseId, operation, inputDigest })).slice(7)}`
  const cleanupId = `${requestId}:cleanup`
  const previous = state.jobs.find(job => job.requestId === requestId)
  const previousCleanup = state.jobs.find(job => job.requestId === cleanupId)
  if (state.jobs.some(job => ![requestId, cleanupId].includes(job.requestId) && ['unknown', 'running'].includes(job.state))) throw blocked('存在其他未确认任务或清理记录，先查询恢复，不能提交新任务')
  const record = (id, status, platformId, evidence, rawState, notCreated = false) => jobs.record(['--request-id', id, '--state', status, ...(platformId ? ['--platform-id', platformId] : []), ...(evidence ? ['--evidence', evidence] : []), ...(rawState ? ['--raw-state', rawState] : []), ...(notCreated ? ['--not-created', 'true'] : [])], journal)
  const observe = (value, evidence) => {
    const rawState = value.rawState || value.state
    try { return { ...value, rawState, state: normalizeState(value.state, mapState) } }
    catch (error) { record(requestId, 'unknown', platformId, evidence, rawState); throw error }
  }
  let platformId = previous?.platformId
  let observed
  let primaryError
  let cleanupError
  if (previous?.notCreated) {
    if (previousCleanup?.state !== 'completed') record(cleanupId, 'completed', null, previous.evidence.path, undefined, true)
    throw new Error('提交已明确拒绝且未创建任务；修复原因后显式使用新的 operation 重试')
  }
  try {
    if (!previous) {
      const binding = path.join(journal, `binding-${crypto.randomUUID()}.json`)
      C.atomicJson(binding, { runId: state.runId, requestId, caseId, operation, inputDigest })
      record(requestId, 'unknown', null, binding)
      record(cleanupId, 'unknown', null, binding)
      // 结果未知时保留 unknown，恢复必须先按稳定请求标识查询，不能再次 submit。
      const submitted = await boundedCall(submit, { requestId, caseId }, requestTimeoutMs, '提交')
      if (submitted?.rejected === true) {
        if (submitted.platformId) throw blocked('拒绝响应同时返回任务 ID，须先查询确认')
        record(requestId, 'failed', null, submitted.evidence, undefined, true)
        record(cleanupId, 'completed', null, submitted.evidence, undefined, true)
        throw new Error('提交已明确拒绝且未创建任务；请查看拒绝证据并修复原因')
      }
      platformId = submitted?.platformId
      if (typeof platformId !== 'string' || !platformId.trim()) throw blocked('提交未返回平台任务 ID，先按 requestId 查询')
      record(requestId, 'running', platformId)
      record(cleanupId, 'unknown', platformId)
    }
    if (previous && !previousCleanup) record(cleanupId, 'unknown', platformId)
    observed = await waitForJob({ query: args => query({ ...args, platformId }), mapState, context: { requestId, caseId }, timeoutMs, requestTimeoutMs, pollIntervalMs,
      onObservation(value) {
        if (!value.platformId || (platformId && platformId !== value.platformId)) throw blocked('查询未确认任务身份，保留记录并停止重提')
        platformId = value.platformId
        if (!value.evidence) throw blocked('任务查询缺少原始证据文件')
        observed = value
        record(requestId, value.state, platformId, value.evidence, value.rawState)
      },
    })
    if (observed.state !== 'completed') {
      const error = new Error(`任务尚未成功完成：${observed.state}`)
      error.blocked = !terminal(observed.state)
      throw error
    }
  } catch (error) { primaryError = error }
  finally {
    if (platformId && previousCleanup?.state !== 'completed') {
      try {
        let cleared = await boundedCall(cleanup, { requestId, platformId, caseId, observed }, cleanupTimeoutMs, '清理')
        if (cleared?.platformId !== platformId || !cleared.taskEvidence || !cleared.evidence) throw blocked('清理必须提供任务终态及资源清理查询证据')
        cleared = observe(cleared, cleared.taskEvidence)
        if (!terminal(cleared.state)) throw blocked('清理必须确认任务终态')
        if (terminal(observed?.state) && cleared.state !== observed.state) throw blocked('清理查询不能改写已观察到的任务终态')
        record(requestId, cleared.state, platformId, cleared.taskEvidence, cleared.rawState)
        record(cleanupId, 'completed', platformId, cleared.evidence)
      } catch (error) {
        const file = path.join(journal, `cleanup-error-${crypto.randomUUID()}.json`)
        C.atomicJson(file, { requestId, platformId, error: error.message })
        record(cleanupId, 'unknown', platformId, file)
        cleanupError = blocked(`清理尚未确认，禁止重复提交：${error.message}`)
      }
    }
  }
  if (cleanupError) {
    if (primaryError) { cleanupError.message = `${primaryError.message}；${cleanupError.message}`; cleanupError.cause = primaryError }
    throw cleanupError
  }
  if (primaryError) throw primaryError
  return { ...observed, requestId, platformId }
}

module.exports = { trackedJob, normalizeState, waitForJob }
