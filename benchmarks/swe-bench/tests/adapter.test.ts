import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { getBenchmarkAdapter } from '../../../src/lib/benchmark/adapter-registry'
import { sweBenchAdapter } from '../adapter'
import type { ReadonlySubmissionArtifact } from '../../../packages/benchmark-protocol/src/evaluation-contracts'

const fixture = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../fixtures/smoke-case.json'), 'utf8'),
)

test('SWE-bench adapter splits public and private fields', () => {
  const result = sweBenchAdapter.validateAndSplitCase(fixture)
  assert.equal(result.externalCaseId, 'example__project-1')
  assert.equal(result.publicPayload.repo, 'example/project')
  assert.equal(result.privatePayload.failToPass[0], 'test_hidden_regression')
  const publicJson = JSON.stringify(result.publicPayload)
  for (const field of ['patch', 'test_patch', 'FAIL_TO_PASS', 'PASS_TO_PASS', 'hidden answer', 'hidden test']) {
    assert.equal(publicJson.includes(field), false, `public payload leaked ${field}`)
  }
})

test('SWE-bench adapter builds the public task deterministically', () => {
  const split = sweBenchAdapter.validateAndSplitCase(fixture)
  const input = {
    publicPayload: split.publicPayload,
    runConfig: { platform: 'opencode', agent: 'build', model: 'configured-default', timeoutSeconds: 1800 },
    context: { runId: 'erun_1', experimentId: 'exp_1', caseId: 'case_1' },
  }
  const first = sweBenchAdapter.buildAgentTask(input)
  const second = sweBenchAdapter.buildAgentTask(input)
  assert.deepEqual(first, second)
  assert.equal(first.workspace.repository, 'https://github.com/example/project.git')
  assert.equal(first.submission.requiredArtifacts[0].name, 'model.patch')
  assert.equal(JSON.stringify(first).includes('hidden answer'), false)
})

test('public issue text may legitimately repeat a hidden test name', () => {
  const testName = 'tests/test_publicly_reported_regression.py::test_failure'
  const split = sweBenchAdapter.validateAndSplitCase({
    ...fixture,
    problem_statement: `The public issue report names ${testName}.`,
    FAIL_TO_PASS: [testName],
    environment_setup_commit: fixture.base_commit,
  })
  assert.equal(split.publicPayload.problemStatement.includes(testName), true)
  assert.equal(split.privatePayload.failToPass[0], testName)
})

test('SWE-bench adapter rejects missing required fields', () => {
  const invalid = { ...fixture }
  delete invalid.base_commit
  assert.throws(() => sweBenchAdapter.validateAndSplitCase(invalid), /base_commit/)
})

test('registry exposes the SWE-bench adapter by stable key', () => {
  assert.equal(getBenchmarkAdapter('swe-bench'), sweBenchAdapter)
  assert.throws(() => getBenchmarkAdapter('missing'), /未注册/)
})

function submissionArtifact(runId: string, patch: string): ReadonlySubmissionArtifact {
  const bytes = Buffer.from(patch)
  return {
    descriptor: {
      artifactId: 'bart_1',
      executionRunId: runId,
      name: 'model.patch',
      mediaType: 'text/x-diff',
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      sizeBytes: bytes.byteLength,
    },
    async readBytes() { return bytes },
  }
}

test('SWE-bench adapter validates model.patch and rejects repository escapes', async () => {
  const split = sweBenchAdapter.validateAndSplitCase(fixture)
  const task = sweBenchAdapter.buildAgentTask({
    publicPayload: split.publicPayload,
    runConfig: { platform: 'opencode', agent: 'build', timeoutSeconds: 60 },
    context: { runId: 'erun_patch', experimentId: 'exp_patch', caseId: 'case_patch' },
  })
  await sweBenchAdapter.validateSubmission({
    task,
    artifacts: [submissionArtifact('erun_patch', 'diff --git a/src/a.py b/src/a.py\n--- a/src/a.py\n+++ b/src/a.py\n')],
  })
  await assert.rejects(
    () => sweBenchAdapter.validateSubmission({
      task,
      artifacts: [submissionArtifact('erun_patch', 'diff --git a/../secret b/../secret\n--- a/../secret\n+++ b/../secret\n')],
    }),
    (error: Error & { code?: string }) => error.code === 'SWE_PATCH_PATH_INVALID',
  )
})

test('SWE-bench evaluation request keeps hidden tests but excludes gold patch', () => {
  const split = sweBenchAdapter.validateAndSplitCase(fixture)
  const artifact = submissionArtifact('erun_eval', 'diff --git a/a b/a\n--- a/a\n+++ b/a\n').descriptor
  const job = sweBenchAdapter.buildEvaluationRequest({
    context: {
      evaluationRunId: 'veval_1',
      executionRunId: 'erun_eval',
      experimentId: 'exp_eval',
      caseId: 'case_eval',
      datasetContentHash: `sha256:${'a'.repeat(64)}`,
    },
    publicPayload: split.publicPayload,
    privatePayload: {
      ...split.privatePayload,
      evaluation: {
        image: 'swebench/sweb.eval.fixture:latest',
        script: 'pytest -q',
        type: 'pass_and_fail',
        logParser: 'parse_log_pytest',
      },
    },
    artifacts: [artifact],
    runConfig: {
      evaluatorKey: 'swe-bench',
      timeoutSeconds: 1800,
      cpu: 4,
      memoryMiB: 16_384,
      agentModel: 'deepseek/deepseek-v4-flash',
    },
  })
  assert.deepEqual(job.payload.instance.FAIL_TO_PASS, split.privatePayload.failToPass)
  assert.equal(job.payload.prediction.model_patch_artifact_id, 'bart_1')
  assert.equal(JSON.stringify(job).includes('goldPatch'), false)
  assert.equal(JSON.stringify(job).includes('hidden answer'), false)
})

test('SWE-bench adapter normalizes resolved, unresolved and infrastructure results', () => {
  const evidenceArtifacts = [{
    artifactId: 'beart_report',
    evaluationId: 'veval_result',
    name: 'report.json',
    kind: 'official-report',
    mediaType: 'application/json',
    sha256: `sha256:${'a'.repeat(64)}` as const,
    sizeBytes: 100,
  }]
  const completed = (resolved: boolean) => sweBenchAdapter.normalizeResult({
    evaluationId: 'veval_result',
    evaluatorKey: 'swe-bench',
    evidenceArtifacts,
    completion: {
      status: 'completed',
      rawResult: {
        instanceId: 'pallets__flask-5014',
        resolved,
        patchSuccessfullyApplied: true,
        failToPass: { passed: resolved ? 1 : 0, total: 1 },
        passToPass: { passed: 59, total: 59 },
        officialReport: { hiddenHarnessDetail: true },
      },
      evidenceArtifactIds: ['beart_report'],
      runtimeFacts: {},
      cleanup: { status: 'succeeded' },
    },
  })
  assert.deepEqual(
    { verdict: completed(true).verdict, score: completed(true).score },
    { verdict: 'pass', score: 100 },
  )
  assert.deepEqual(
    { verdict: completed(false).verdict, score: completed(false).score },
    { verdict: 'fail', score: 0 },
  )
  assert.deepEqual(completed(true).primaryMetric, {
    key: 'resolved', value: true, aggregation: 'boolean-rate',
  })
  assert.equal(JSON.stringify(completed(true).nativeMetrics).includes('officialReport'), false)
  assert.deepEqual(
    (completed(true).evidence as Record<string, unknown>).cleanup,
    { status: 'succeeded' },
  )
  const failed = sweBenchAdapter.normalizeResult({
    evaluationId: 'veval_result',
    evaluatorKey: 'swe-bench',
    evidenceArtifacts,
    completion: {
      status: 'failed',
      rawResult: { instanceId: 'pallets__flask-5014', resolved: false },
      evidenceArtifactIds: ['beart_report'],
      runtimeFacts: {},
      cleanup: { status: 'succeeded' },
      error: { code: 'SWE_IMAGE_UNAVAILABLE', message: 'image unavailable', retryable: true },
    },
  })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.score, null)
})
