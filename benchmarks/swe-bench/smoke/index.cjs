#!/usr/bin/env node
'use strict'

const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const { SweBenchEvaluator } = require('../evaluator/index.cjs')

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

async function runSmoke(options = {}) {
  const fixturePath = options.fixturePath || path.join(__dirname, 'case.json')
  const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'))
  const runId = `deployment_smoke_swe_bench_${Date.now()}`
  const dataDir = options.dataDir || process.env.EVALUATOR_DATA_DIR || '/data'
  const workDir = path.join(dataDir, 'smoke', 'swe-bench', runId)
  await fs.mkdir(workDir, { recursive: true, mode: 0o700 })
  const patch = Buffer.from(fixture.patch, 'utf8')
  const patchPath = path.join(workDir, 'model.patch')
  await fs.writeFile(patchPath, patch, { mode: 0o400 })
  const artifact = {
    artifactId: `smoke_patch_${runId}`,
    evaluationId: runId,
    executionRunId: `smoke_execution_${runId}`,
    name: 'model.patch',
    kind: 'submission',
    mediaType: 'text/x-diff',
    sha256: digest(patch),
    sizeBytes: patch.length,
  }
  const job = {
    protocolVersion: 'benchmark-evaluation/v1',
    evaluationId: runId,
    executionRunId: artifact.executionRunId,
    context: {
      experimentId: `deployment_smoke_${runId}`,
      caseId: fixture.instance_id,
      datasetContentHash: digest(Buffer.from(JSON.stringify(fixture))),
      purpose: 'deployment_smoke',
    },
    benchmark: { key: 'swe-bench' },
    evaluator: { key: 'swe-bench' },
    artifacts: [artifact],
    payload: {
      instance: {
        instance_id: fixture.instance_id,
        repo: fixture.repo,
        base_commit: fixture.base_commit,
        version: fixture.version,
        image: fixture.image,
        eval_script: fixture.eval_script,
        eval_type: fixture.eval_type,
        log_parser: fixture.log_parser,
        FAIL_TO_PASS: fixture.FAIL_TO_PASS,
        PASS_TO_PASS: fixture.PASS_TO_PASS,
      },
      prediction: {
        instance_id: fixture.instance_id,
        model_name_or_path: 'agent-insight/deployment-smoke-gold',
        model_patch_artifact_id: artifact.artifactId,
      },
    },
    limits: { timeoutSeconds: 1800, cpu: 4, memoryMiB: 16384 },
  }
  const evaluator = options.evaluator || new SweBenchEvaluator()
  evaluator.validateJob(job)
  const progress = []
  const result = await evaluator.evaluate({
    job,
    artifacts: new Map([['model.patch', { descriptor: artifact, path: patchPath }]]),
    workDir,
    signal: new AbortController().signal,
    async reportProgress(event) { progress.push(event.stage) },
  })
  const succeeded = result.completion.status === 'completed'
    && result.completion.rawResult?.resolved === true
    && result.completion.cleanup?.status === 'succeeded'
    && /^.+@sha256:[0-9a-f]{64}$/i.test(String(result.completion.runtimeFacts?.caseImage || ''))
  const output = {
    purpose: 'deployment_smoke',
    evaluatorKey: 'swe-bench',
    succeeded,
    runId,
    caseId: fixture.instance_id,
    progress,
    verdict: result.completion.rawResult?.resolved === true ? 'pass' : 'fail',
    runtimeFacts: result.completion.runtimeFacts,
    cleanup: result.completion.cleanup,
    evidence: result.evidenceFiles.map((item) => item.name),
  }
  if (!succeeded) {
    const error = new Error(`SWE-bench Gold Smoke 未通过：${result.completion.error?.message || result.completion.status}`)
    error.output = output
    throw error
  }
  return output
}

if (require.main === module) {
  runSmoke().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`)
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      purpose: 'deployment_smoke',
      evaluatorKey: 'swe-bench',
      succeeded: false,
      error: error.message,
      ...(error.output || {}),
    })}\n`)
    process.exitCode = 1
  })
}

module.exports = { runSmoke }
