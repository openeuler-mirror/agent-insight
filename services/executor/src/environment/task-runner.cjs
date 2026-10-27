/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict'

const fs = require('node:fs/promises')
const syncFs = require('node:fs')
const path = require('node:path')
const { fork } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const { validateContext, contextDigest } = require('./protocol.cjs')
const { atomicJson } = require('../xgovernor/dependency-manager.cjs')
const { setTimeout: delay } = require('node:timers/promises')
const active = new Map()

function stopChild(child, signal = 'SIGTERM') {
  try { process.kill(-child.pid, signal) } catch { child.kill(signal) }
}
function runWorker(context, cfg, signal, report, lease) {
  return new Promise((resolve, reject) => {
    const log = syncFs.openSync(`${lease.record}.log`, 'a', 0o600)
    const child = fork(path.join(__dirname, 'worker.cjs'), [], { detached: process.platform !== 'win32', stdio: ['ignore', log, log, 'ipc'] })
    syncFs.closeSync(log)
    let escalation
    const abort = () => { stopChild(child); escalation = setTimeout(() => stopChild(child, 'SIGKILL'), 5000) }
    let result
    signal.addEventListener('abort', abort, { once: true })
    child.on('message', data => {
      if (data.progress) report(data.progress).catch(() => {})
      if (data.result) result = data.result
    })
    child.on('error', reject)
    child.on('close', () => {
      clearTimeout(escalation)
      signal.removeEventListener('abort', abort)
      if (signal.aborted) reject(signal.reason)
      else if (result) resolve(result)
      else reject(new Error('执行机环境准备进程中断，请再次点击“下一步”重试。'))
    })
    fs.writeFile(lease.lock, JSON.stringify({ pid: process.pid, workerPid: child.pid, taskId: lease.taskId, owner: lease.owner }), { mode: 0o600 })
      .then(() => child.send({ context, cfg, lease }))
      .catch(error => { stopChild(child); reject(error) })
    if (signal.aborted) abort()
  })
}
async function executePreparation(frame, { cfg, baseDir, report, worker = runWorker }) {
  const context = validateContext(frame.payload.context)
  if (context.clientId !== cfg.clientId || contextDigest(context) !== frame.payload.contextDigest) throw new Error('执行环境任务与本机或当前配置不匹配')
  const deadline = Date.parse(frame.expiresAt)
  if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error('环境准备请求已过期，请再次点击“下一步”。')
  const root = path.join(baseDir, 'environment-preparations')
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('运行环境准备超时，请检查执行机后重试。')), deadline - Date.now())
  active.set(frame.commandId, controller)
  const digest = frame.payload.contextDigest.slice(7)
  const lock = path.join(root, `${digest}.lock`)
  const record = path.join(root, `${digest}.json`)
  let descriptor
  const owner = randomBytes(12).toString('hex')
  try {
    let waited = false
    while (!descriptor) {
      controller.signal.throwIfAborted()
      try {
        descriptor = await fs.open(lock, 'wx', 0o600)
        await descriptor.writeFile(JSON.stringify({ pid: process.pid, taskId: frame.commandId, owner }))
      } catch (cause) {
        if (cause.code !== 'EEXIST') throw cause
        waited = true
        await report({ state: 'checking' })
        let previous
        try { previous = JSON.parse(await fs.readFile(lock, 'utf8')) } catch {}
        if (previous?.pid) {
          const living = [previous.pid, previous.workerPid].filter(Boolean).some(pid => {
            try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
          })
          if (!living) { await fs.unlink(lock).catch(() => {}); continue }
        }
        await delay(1000, undefined, { signal: controller.signal })
        try {
          await fs.access(lock)
        } catch {
          const saved = JSON.parse(await fs.readFile(record, 'utf8').catch(() => '{}'))
          if (saved.result && saved.completedAt >= Date.parse(frame.createdAt)) return saved.result
        }
      }
    }
    if (waited) await report({ state: 'checking' })
    await atomicJson(record, { taskId: frame.commandId, contextDigest: frame.payload.contextDigest, context, expiresAt: frame.expiresAt, startedAt: Date.now() })
    const result = await worker(context, cfg, controller.signal, report, { record, lock, owner, taskId: frame.commandId, contextDigest: frame.payload.contextDigest, expiresAt: frame.expiresAt })
    await atomicJson(record, { taskId: frame.commandId, contextDigest: frame.payload.contextDigest, context, expiresAt: frame.expiresAt, completedAt: Date.now(), result })
    return result
  } finally {
    clearTimeout(timer)
    active.delete(frame.commandId)
    if (descriptor) {
      await descriptor.close()
      const held = JSON.parse(await fs.readFile(lock, 'utf8').catch(() => '{}'))
      if (held.owner === owner) await fs.unlink(lock).catch(() => {})
    }
  }
}
function stopPreparations() { for (const controller of active.values()) controller.abort(new Error('客户端正在停止，环境准备已中断')) }
async function markPreparationReported(baseDir, digest, taskId) {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) return
  const file = path.join(baseDir, 'environment-preparations', `${digest.slice(7)}.json`)
  const saved = JSON.parse(await fs.readFile(file, 'utf8').catch(() => '{}'))
  if (saved.taskId === taskId && saved.result) await atomicJson(file, { ...saved, reported: true })
}
async function recoverPreparations(baseDir, report, { isActive = () => false, recheck } = {}) {
  const root = path.join(baseDir, 'environment-preparations')
  const entries = await fs.readdir(root).catch(() => [])
  const results = await Promise.allSettled(entries.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(async name => {
    let saved = JSON.parse(await fs.readFile(path.join(root, name), 'utf8').catch(() => '{}'))
    if (!saved.taskId || saved.reported || isActive(saved.taskId)) return
    const lock = path.join(root, name.replace(/\.json$/, '.lock'))
    while (!saved.result && saved.expiresAt && Date.parse(saved.expiresAt) > Date.now()) {
      const held = JSON.parse(await fs.readFile(lock, 'utf8').catch(() => '{}'))
      let alive = false
      if (held.workerPid) { try { process.kill(held.workerPid, 0); alive = true } catch {} }
      if (!alive) break
      await delay(1000)
      saved = JSON.parse(await fs.readFile(path.join(root, name), 'utf8').catch(() => '{}'))
    }
    let result = saved.result || { state: 'failed', issues: [{ code: 'ENVIRONMENT_INTERRUPTED', message: '客户端重启导致环境准备中断，请再次点击“下一步”重新检查。' }] }
    if (result.state === 'ready' && recheck) {
      result = saved.context && Date.parse(saved.expiresAt) > Date.now() ? await recheck(saved)
        : { state: 'failed', issues: [{ code: 'ENVIRONMENT_CONTEXT_EXPIRED', message: '先前检查的上下文已过期或无法确认，请再次点击“下一步”重新检查。' }] }
    }
    await report(saved.taskId, result)
    await atomicJson(path.join(root, name), { ...saved, result, reported: true })
  }))
  const failure = results.find(result => result.status === 'rejected')
  if (failure) throw failure.reason
}
module.exports = { executePreparation, stopPreparations, markPreparationReported, recoverPreparations, runWorker }
