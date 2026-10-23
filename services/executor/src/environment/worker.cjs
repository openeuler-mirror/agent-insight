'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { validateContext } = require('./protocol.cjs')
const { createServices } = require('./services.cjs')
const { prepareEnvironment, checkEnvironment } = require('./registry.cjs')
const { atomicJson } = require('../xgovernor/dependency-manager.cjs')
const local = path.resolve(__dirname, '../../reliability-client.cjs')
const client = require(fs.existsSync(local) ? local : path.resolve(__dirname, '../../../../scripts/reliability-client.cjs'))

process.removeAllListeners('SIGTERM')
process.removeAllListeners('SIGINT')
process.once('message', async ({ context: input, cfg, lease }) => {
  const controller = new AbortController()
  const stop = () => controller.abort(new Error('环境准备已停止'))
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  const timer = setTimeout(stop, Math.max(1, Date.parse(lease.expiresAt) - Date.now()))
  const finish = async (result, exitCode) => {
    clearTimeout(timer)
    result = { ...result, hostname: os.hostname() }
    await atomicJson(lease.record, { taskId: lease.taskId, contextDigest: lease.contextDigest, context: input, expiresAt: lease.expiresAt, completedAt: Date.now(), result })
    const held = JSON.parse(await fs.promises.readFile(lease.lock, 'utf8').catch(() => '{}'))
    if (held.owner === lease.owner) await fs.promises.unlink(lease.lock).catch(() => {})
    if (process.connected) process.send({ result }, () => process.exit(exitCode))
    else process.exit(exitCode)
  }
  try {
    const context = validateContext(input)
    const services = createServices({ cfg, client, signal: controller.signal })
    const result = await (lease.checkOnly ? checkEnvironment : prepareEnvironment)(context, services,
      async progress => { if (process.connected) process.send({ progress }, () => {}) })
    await finish(result.state === 'ready' ? { ...result, ...services.capabilityUpdate() } : result, 0)
  } catch (cause) {
    const code = cause.code || 'ENVIRONMENT_PREPARATION_FAILED'
    const message = /^(?:ENVIRONMENT_|MODEL_)/.test(code) ? cause.message : '运行环境准备失败，请检查执行机网络、磁盘和权限后再次点击“下一步”。'
    await finish({ state: 'failed', issues: [{ code, message }] }, 1)
  }
})
