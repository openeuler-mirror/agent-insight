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

const { BenchmarkEvaluatorService } = require('./service.cjs')

async function main() {
  const host = process.env.EVALUATOR_LISTEN_HOST || '0.0.0.0'
  const port = Number(process.env.EVALUATOR_PORT || 8080)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('EVALUATOR_PORT is invalid')
  }
  const service = new BenchmarkEvaluatorService()
  const server = service.createServer()
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    server.close()
    void service.shutdown().catch((error) => console.error('[benchmark/evaluator] shutdown failed', error))
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  const recovered = await service.recover()
  const notificationTimer = setInterval(() => { void service.flushStopNotifications().catch(console.error) }, 30_000)
  notificationTimer.unref()
  server.once('close', () => clearInterval(notificationTimer))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  console.log(`[benchmark/evaluator] listening on http://${host}:${port}`)
  console.log('[benchmark/evaluator] runtime facts', JSON.stringify(service.runtimeFacts()))
  if (recovered) console.log(`[benchmark/evaluator] recovered ${recovered} job(s)`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[benchmark/evaluator] startup failed', error)
    process.exitCode = 1
  })
}

module.exports = { main }
