#!/usr/bin/env node
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
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  console.log(`[benchmark/evaluator] listening on http://${host}:${port}`)
  const recovered = await service.recover()
  if (recovered) console.log(`[benchmark/evaluator] recovered ${recovered} job(s)`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[benchmark/evaluator] startup failed', error)
    process.exitCode = 1
  })
}

module.exports = { main }
