import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { getBenchmarkAdapter } from '../../../src/lib/benchmark/adapter-registry'
import { sweBenchAdapter } from '../adapter'
import type {
  EvaluationJob,
  ReadonlySubmissionArtifact,
} from '../../../packages/benchmark-protocol/src/evaluation-contracts'

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

function normalizationJob(
  evaluationId: string,
  instanceId: string,
  failToPass: string[],
  passToPass: string[],
): EvaluationJob {
  return {
    protocolVersion: 'benchmark-evaluation/v1',
    evaluationId,
    executionRunId: 'erun_normalize',
    context: {
      experimentId: 'exp_normalize',
      caseId: 'case_normalize',
      datasetContentHash: `sha256:${'a'.repeat(64)}`,
    },
    benchmark: { key: 'swe-bench' },
    evaluator: { key: 'swe-bench' },
    artifacts: [],
    payload: {
      instance: {
        instance_id: instanceId,
        FAIL_TO_PASS: failToPass,
        PASS_TO_PASS: passToPass,
      },
    },
    limits: { timeoutSeconds: 60, cpu: 1, memoryMiB: 1024 },
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
  const instanceId = 'pallets__flask-5014'
  const failToPassTests = ['test_regression']
  const passToPassTests = Array.from({ length: 59 }, (_, index) => `test_existing_${index}`)
  const evaluationJob = normalizationJob(
    'veval_result', instanceId, failToPassTests, passToPassTests,
  )
  const evidenceArtifacts = [
    { name: 'report.json', kind: 'official-report', mediaType: 'application/json' },
    { name: 'test_output.txt', kind: 'test-output', mediaType: 'text/plain' },
    { name: 'run_instance.log', kind: 'harness-log', mediaType: 'text/plain' },
  ].map((artifact, index) => ({
    ...artifact,
    artifactId: `beart_${index}`,
    evaluationId: 'veval_result',
    sha256: `sha256:${String(index + 1).repeat(64)}` as `sha256:${string}`,
    sizeBytes: 100,
  }))
  const completed = (resolved: boolean) => {
    const officialReport = {
      [instanceId]: {
        resolved,
        patch_successfully_applied: true,
        tests_status: {
          FAIL_TO_PASS: {
            success: resolved ? failToPassTests : [],
            failure: resolved ? [] : failToPassTests,
          },
          PASS_TO_PASS: { success: passToPassTests, failure: [] },
        },
      },
    }
    return sweBenchAdapter.normalizeResult({
      evaluationId: 'veval_result',
      evaluatorKey: 'swe-bench',
      evaluationJob,
      evidenceArtifacts: evidenceArtifacts.map((artifact) => artifact.name === 'report.json'
        ? { ...artifact, jsonContent: officialReport }
        : artifact),
      completion: {
      status: 'completed',
      rawResult: {
        instanceId,
        resolved,
        patchSuccessfullyApplied: true,
        failToPass: { passed: resolved ? 1 : 0, total: 1 },
        passToPass: { passed: 59, total: 59 },
        officialReport,
      },
      evidenceArtifactIds: evidenceArtifacts.map((artifact) => artifact.artifactId),
      runtimeFacts: { formalEligible: true },
      cleanup: { status: 'succeeded' },
    },
    })
  }
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
    evaluationJob,
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

test('SWE-bench adapter fails closed for ineligible, mismatched or incomplete completed results', () => {
  const instanceId = 'pallets__flask-5014'
  const evidenceArtifacts = [
    { name: 'report.json', kind: 'official-report', mediaType: 'application/json' },
    { name: 'test_output.txt', kind: 'test-output', mediaType: 'text/plain' },
    { name: 'run_instance.log', kind: 'harness-log', mediaType: 'text/plain' },
  ].map((artifact, index) => ({
    ...artifact,
    artifactId: `beart_integrity_${index}`,
    evaluationId: 'veval_integrity',
    sha256: `sha256:${String(index + 4).repeat(64)}` as `sha256:${string}`,
    sizeBytes: 100,
  }))
  const rawResult = {
    instanceId,
    resolved: true,
    patchSuccessfullyApplied: true,
    failToPass: { passed: 1, total: 1 },
    passToPass: { passed: 1, total: 1 },
    officialReport: {
      [instanceId]: {
        resolved: true,
        patch_successfully_applied: true,
        tests_status: {
          FAIL_TO_PASS: { success: ['test_regression'], failure: [] },
          PASS_TO_PASS: { success: ['test_existing'], failure: [] },
        },
      },
    },
  }
  const normalize = (overrides: {
    jobInstanceId?: string
    evidenceArtifacts?: typeof evidenceArtifacts
    rawResult?: Record<string, unknown>
    formalEligible?: boolean
  } = {}) => {
    const result = overrides.rawResult || rawResult
    const artifacts = (overrides.evidenceArtifacts || evidenceArtifacts).map((artifact) => (
      artifact.name === 'report.json'
        ? { ...artifact, jsonContent: result.officialReport }
        : artifact
    ))
    return sweBenchAdapter.normalizeResult({
      evaluationId: 'veval_integrity',
      evaluatorKey: 'swe-bench',
      evaluationJob: normalizationJob(
        'veval_integrity',
        overrides.jobInstanceId || instanceId,
        ['test_regression'],
        ['test_existing'],
      ),
      evidenceArtifacts: artifacts,
      completion: {
      status: 'completed',
      rawResult: result,
      evidenceArtifactIds: artifacts
        .map((artifact) => artifact.artifactId),
      runtimeFacts: { formalEligible: overrides.formalEligible ?? true },
      cleanup: { status: 'succeeded' },
    },
    })
  }

  assert.throws(
    () => normalize({ rawResult: { ...rawResult, resolved: 'false' } }),
    (error: Error & { code?: string }) => error.code === 'RAW_RESULT_SCHEMA_INVALID',
  )
  assert.throws(
    () => normalize({ formalEligible: false }),
    (error: Error & { code?: string }) => error.code === 'SWE_FORMAL_RESULT_INELIGIBLE',
  )
  assert.throws(
    () => normalize({ jobInstanceId: 'astropy__astropy-1' }),
    (error: Error & { code?: string }) => error.code === 'SWE_RAW_RESULT_INVALID',
  )
  assert.throws(
    () => normalize({ evidenceArtifacts: evidenceArtifacts.slice(0, 1) }),
    (error: Error & { code?: string }) => error.code === 'SWE_EVIDENCE_CONTRACT_INVALID',
  )
  assert.throws(
    () => normalize({
      evidenceArtifacts: [
        ...evidenceArtifacts,
        {
          name: 'extra.txt',
          kind: 'debug-log',
          mediaType: 'text/plain',
          artifactId: 'beart_integrity_extra',
          evaluationId: 'veval_integrity',
          sha256: `sha256:${'9'.repeat(64)}` as `sha256:${string}`,
          sizeBytes: 100,
        },
      ],
    }),
    (error: Error & { code?: string }) => error.code === 'SWE_EVIDENCE_CONTRACT_INVALID',
  )
  assert.throws(
    () => normalize({
      rawResult: {
        ...rawResult,
        officialReport: {
          [instanceId]: {
            ...(rawResult.officialReport[instanceId]),
            resolved: false,
          },
        },
      },
    }),
    (error: Error & { code?: string }) => error.code === 'SWE_RAW_RESULT_INVALID',
  )
  assert.throws(
    () => normalize({
      rawResult: {
        ...rawResult,
        failToPass: { passed: 0, total: 0 },
        passToPass: { passed: 0, total: 0 },
        officialReport: {
          [instanceId]: {
            resolved: true,
            patch_successfully_applied: true,
            tests_status: {
              FAIL_TO_PASS: { success: [], failure: [] },
              PASS_TO_PASS: { success: [], failure: [] },
            },
          },
        },
      },
    }),
    (error: Error & { code?: string }) => error.code === 'SWE_RAW_RESULT_INVALID',
  )
})
