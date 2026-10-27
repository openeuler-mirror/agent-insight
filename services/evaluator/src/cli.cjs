#!/usr/bin/env node
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
  const deadline = Date.now() + Number(options.timeoutMs || 30_000)
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
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
  const descriptor = generatedEvaluatorDescriptors.find((item) => item.benchmarkKey === evaluatorKey)
    || generatedEvaluatorDescriptors.find((item) => item.key === evaluatorKey)
  if (!descriptor) throw new Error(`未找到 Benchmark 或 Evaluator：${evaluatorKey}`)
  const evaluator = registry().get(descriptor.key, descriptor.benchmarkKey)
  return evaluator.smoke(runtime())
}

function option(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function formatDoctorOutput(output, summary = false) {
  if (!summary) return JSON.stringify(output)
  const evaluators = output.evaluators || []
  const ready = evaluators.filter((item) => item.ready === true).length
  const lines = [`Doctor 检查${output.ok ? '通过' : '失败'}：评测器就绪 ${ready}/${evaluators.length}。`]
  if (output.reason) lines.push(`Controller：${output.reason}`)
  for (const [check, passed] of Object.entries(output.checks || {})) {
    if (!passed) lines.push(`检查未通过：${check}`)
  }
  for (const evaluator of evaluators.filter((item) => item.ready !== true)) {
    lines.push(`评测器 ${evaluator.key} 未就绪：${evaluator.reason || '请手动执行 Doctor 查看详情'}`)
  }
  return lines.join('\n')
}

async function main(args = process.argv.slice(2)) {
  const command = args[0] || 'doctor'
  let output
  if (command === 'doctor') output = await doctor()
  else if (command === 'smoke') output = await smoke(option(args, '--evaluator'))
  else throw new Error('usage: cli.cjs doctor | cli.cjs smoke --evaluator <key>')
  process.stdout.write(`${command === 'doctor' ? formatDoctorOutput(output, args.includes('--summary')) : JSON.stringify(output)}\n`)
  return output.ok === false || output.succeeded === false ? 1 : 0
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code }).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`)
    process.exitCode = 1
  })
}

module.exports = { doctor, fetchHealth, main, smoke, formatDoctorOutput }
