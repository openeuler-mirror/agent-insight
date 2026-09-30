#!/usr/bin/env node
'use strict'

const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { EvaluatorProtocolError, SweBenchEvaluator } = require('./index.cjs')

function option(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : null
}

function safeName(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(name || ''))) {
    throw new EvaluatorProtocolError('EVALUATION_EVIDENCE_INVALID', 'Evidence 名称不合法', 500)
  }
  return name
}

async function doctor() {
  const evaluator = new SweBenchEvaluator()
  const result = await evaluator.checkReady({
    dataDir: process.env.EVALUATOR_DATA_DIR || '/data',
    hostArch: process.arch,
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
  return result.ready ? 0 : 1
}

async function evaluate(requestPath, outputPath) {
  const requestRoot = path.dirname(path.resolve(requestPath))
  const outputRoot = path.dirname(path.resolve(outputPath))
  const contractRoot = path.dirname(requestRoot)
  const workDir = path.join(contractRoot, 'work')
  const payload = JSON.parse(await fs.readFile(requestPath, 'utf8'))
  if (payload.schemaVersion !== 'evaluator-entrypoint/v1' || !payload.evaluationJob) {
    throw new EvaluatorProtocolError('EVALUATOR_REQUEST_INVALID', 'Evaluator Entrypoint 请求不合法')
  }
  await fs.mkdir(workDir, { recursive: true, mode: 0o700 })
  await fs.mkdir(path.join(outputRoot, 'evidence'), { recursive: true, mode: 0o700 })
  await fs.mkdir(path.join(outputRoot, 'logs'), { recursive: true, mode: 0o700 })
  const artifacts = new Map()
  for (const item of payload.artifacts || []) {
    const localPath = path.resolve(requestRoot, String(item.path || ''))
    if (!localPath.startsWith(`${requestRoot}${path.sep}`)) {
      throw new EvaluatorProtocolError('EVALUATOR_ARTIFACT_PATH_INVALID', 'Artifact 路径越界')
    }
    artifacts.set(item.descriptor.name, { descriptor: item.descriptor, path: localPath })
  }
  const evaluator = new SweBenchEvaluator()
  evaluator.validateJob(payload.evaluationJob)
  const abortController = new AbortController()
  const abort = () => abortController.abort()
  process.once('SIGTERM', abort)
  process.once('SIGINT', abort)
  const progressPath = path.join(outputRoot, 'logs', 'progress.jsonl')
  try {
    const result = await evaluator.evaluate({
      job: payload.evaluationJob,
      preparedImages: payload.preparedImages,
      artifacts,
      workDir,
      signal: abortController.signal,
      reportProgress: (event) => fs.appendFile(progressPath, `${JSON.stringify(event)}\n`),
    })
    const evidenceFiles = []
    for (const evidence of result.evidenceFiles) {
      const name = safeName(evidence.name)
      const target = path.join(outputRoot, 'evidence', name)
      await fs.copyFile(evidence.path, target)
      evidenceFiles.push({
        name,
        kind: evidence.kind,
        mediaType: evidence.mediaType,
        path: `evidence/${name}`,
      })
    }
    await fs.writeFile(outputPath, `${JSON.stringify({
      protocolVersion: 'evaluator-output/v1',
      completion: result.completion,
      evidenceFiles,
    }, null, 2)}\n`, { mode: 0o600 })
  } finally {
    process.removeListener('SIGTERM', abort)
    process.removeListener('SIGINT', abort)
  }
}

async function main(args = process.argv.slice(2)) {
  if (args[0] === 'doctor') return doctor()
  if (args[0] === 'evaluate') {
    const requestPath = option(args, '--request')
    const outputPath = option(args, '--output')
    if (!requestPath || !outputPath) throw new Error('evaluate 需要 --request 和 --output')
    await evaluate(requestPath, outputPath)
    return 0
  }
  throw new Error('usage: evaluator doctor | evaluator evaluate --request FILE --output FILE')
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      code: error.code || 'EVALUATOR_ENTRYPOINT_FAILED',
      message: error.message,
      platform: os.platform(),
    })}\n`)
    process.exitCode = 1
  })
}

module.exports = { evaluate, main }
