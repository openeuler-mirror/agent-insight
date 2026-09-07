#!/usr/bin/env node
'use strict'

const { generatedEvaluatorDescriptors } = require('../../../generated/benchmark-catalog/evaluators.cjs')
const { EvaluatorRegistry, FileEvaluatorEntrypoint } = require('./evaluator-registry.cjs')

function runtime() {
  return {
    dataDir: process.env.EVALUATOR_DATA_DIR || '/data',
    hostOS: process.env.EVALUATOR_HOST_OS || process.platform,
    hostArch: process.env.EVALUATOR_HOST_ARCH || process.arch,
  }
}

function registry() {
  return new EvaluatorRegistry(
    generatedEvaluatorDescriptors.map((descriptor) => new FileEvaluatorEntrypoint(descriptor)),
  )
}

async function fetchHealth(options = {}) {
  const port = Number(options.port || process.env.EVALUATOR_PORT || 8080)
  const token = options.token || process.env.EVALUATOR_PLATFORM_TOKEN || ''
  if (!token) throw new Error('EVALUATOR_PLATFORM_TOKEN is required')
  const deadline = Date.now() + Number(options.timeoutMs || 30_000)
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(2_000),
      })
      const body = await response.json()
      if (response.ok) return body
      lastError = new Error(`GET /health 返回 HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw lastError || new Error('GET /health 超时')
}

async function doctor(options = {}) {
  const health = await fetchHealth(options)
  const evaluators = Array.isArray(health.evaluators) ? health.evaluators : []
  return {
    ok: health.status === 'healthy' && health.controller?.ready === true && evaluators.length > 0,
    checks: {
      http: true,
      dockerSocket: health.controller?.ready === true,
      journal: health.controller?.ready === true,
      catalog: evaluators.length > 0,
    },
    runtime: health.runtime || {},
    busy: health.busy === true,
    evaluators,
    ...(health.controller?.reason ? { reason: health.controller.reason } : {}),
  }
}

async function smoke(evaluatorKey, options = {}) {
  if (!evaluatorKey) throw new Error('smoke 需要 --evaluator <key>')
  await fetchHealth(options)
  const evaluator = registry().get(evaluatorKey)
  return evaluator.smoke(runtime())
}

function option(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

async function main(args = process.argv.slice(2)) {
  const command = args[0] || 'doctor'
  let output
  if (command === 'doctor') output = await doctor()
  else if (command === 'smoke') output = await smoke(option(args, '--evaluator'))
  else throw new Error('usage: cli.cjs doctor | cli.cjs smoke --evaluator <key>')
  process.stdout.write(`${JSON.stringify(output)}\n`)
  return output.ok === false || output.succeeded === false ? 1 : 0
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code }).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`)
    process.exitCode = 1
  })
}

module.exports = { doctor, fetchHealth, main, smoke }
