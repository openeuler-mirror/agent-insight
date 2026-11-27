/* Copyright (c) 2026 Huawei Technologies Co., Ltd. SPDX-License-Identifier: Apache-2.0 */
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const { getAgentInsightHome } = require('./agent-insight-home.cjs')

const clientHome = path.join(getAgentInsightHome(), 'client')
const script = path.join(clientHome, 'runtime', 'reliability-client.cjs')
const pidFile = path.join(clientHome, 'background.json')
const logFile = path.join(clientHome, 'client.log')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function backgroundStatus() {
  let record
  try { record = JSON.parse(fs.readFileSync(pidFile, 'utf8')) } catch { return { running: false } }
  const { pid, instanceId } = record
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || typeof instanceId !== 'string') return { running: false }
  const args = [process.execPath, script, `--agent-insight-instance=${instanceId}`]
  try {
    // 校验随机实例标识和完整命令，避免 PID 被复用后误停其他进程。
    if (fs.existsSync(`/proc/${pid}/cmdline`)) {
      const actual = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
      return { running: JSON.stringify(actual) === JSON.stringify(args), pid }
    }
    const ps = ['/bin/ps', '/usr/bin/ps'].find(file => fs.existsSync(file))
    const result = spawnSync(ps || 'ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
    return { running: result.status === 0 && result.stdout.trim() === args.join(' '), pid }
  } catch { return { running: false } }
}

async function stopBackgroundClient() {
  const state = backgroundStatus()
  if (state.running) {
    process.kill(state.pid, 'SIGTERM')
    const deadline = Date.now() + 10_000
    while (backgroundStatus().running && Date.now() < deadline) await wait(50)
    if (backgroundStatus().running) throw new Error(`后台客户端未退出 (pid=${state.pid})，请检查 ${logFile}`)
  }
  fs.rmSync(pidFile, { force: true })
}

async function startBackgroundClient() {
  await stopBackgroundClient()
  fs.mkdirSync(clientHome, { recursive: true, mode: 0o700 })
  const instanceId = randomUUID()
  const env = { ...process.env, AGENT_INSIGHT_SUPERVISOR: 'background' }
  delete env.NOTIFY_SOCKET
  delete env.WATCHDOG_PID
  delete env.WATCHDOG_USEC
  const log = fs.openSync(logFile, 'a', 0o600)
  let child
  try {
    child = spawn(process.execPath, [script, `--agent-insight-instance=${instanceId}`], {
      cwd: clientHome, env, detached: true, stdio: ['ignore', log, log, 'ipc'],
    })
  } finally { fs.closeSync(log) }
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('后台客户端启动超时')), 15_000)
      const finish = (error) => {
        clearTimeout(timeout)
        child.removeListener('error', onError)
        child.removeListener('exit', onExit)
        child.removeListener('message', onMessage)
        if (error) reject(error)
        else resolve()
      }
      const onError = error => finish(error)
      const onExit = (code, signal) => finish(new Error(`后台客户端启动失败 (exit=${code}, signal=${signal})`))
      const onMessage = message => {
        if (message?.type === 'agent-insight-client-ready') finish()
      }
      child.once('error', onError)
      child.once('exit', onExit)
      child.on('message', onMessage)
    })
    const temporary = `${pidFile}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify({ pid: child.pid, instanceId }), { mode: 0o600 })
    fs.renameSync(temporary, pidFile)
    if (child.connected) child.disconnect()
    child.unref()
    return child.pid
  } catch (error) {
    child.kill('SIGTERM')
    if (child.connected) child.disconnect()
    child.unref()
    throw new Error(`${error.message}；日志: ${logFile}`)
  }
}

module.exports = { backgroundStatus, startBackgroundClient, stopBackgroundClient }

if (require.main === module) {
  const action = process.argv[2]
  ;(async () => {
    if (action === 'start') console.log(`background: running (pid=${await startBackgroundClient()})`)
    else if (action === 'stop') { await stopBackgroundClient(); console.log('background: stopped') }
    else if (action === 'status') {
      const state = backgroundStatus()
      console.log(`background: ${state.running ? `running (pid=${state.pid})` : 'stopped'}`)
    } else throw new Error('用法: node client-process.cjs start|stop|status')
  })().catch(error => { console.error(error.message); process.exitCode = 1 })
}
