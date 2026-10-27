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

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createRequire } from 'node:module'
import { createBenchmarkExperiment } from '../../src/lib/benchmark/experiment-service'
import { prisma } from '../../src/lib/storage/prisma'
import { inspectBenchmarkExecutionTargets } from '../../src/lib/benchmark/execution-targets'
import { zsoftL1Adapter, type ZsoftCase } from '../../benchmarks/zsoft-l1/adapter'
import type { ArtifactDescriptor, EvaluationJob, ReadonlySubmissionArtifact } from '../../packages/benchmark-protocol/src/evaluation-contracts'
import type { BenchmarkEvaluationCompletion, NormalizeBenchmarkResultInput } from '../../packages/benchmark-protocol/src/evaluator-contracts'
import type { JsonValue } from '../../packages/benchmark-protocol/src/contracts'

const require = createRequire(import.meta.url)

const raw: ZsoftCase = {
  public: { taskId: 'synthetic-contract-case', title: 'Synthetic task', description: 'Synthetic adapter contract only', submissionKind: 'python', maxBytes: 128, tags: ['userspace', 'python'] },
  private: { revision: 'a'.repeat(40), sourceTaskDigest: `sha256:${'c'.repeat(64)}` },
}
const bytes = Buffer.from('synthetic text; never executed')
const descriptor: ArtifactDescriptor = { artifactId: 'artifact-one', executionRunId: 'run-one', name: 'poc', mediaType: 'application/octet-stream', sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, sizeBytes: bytes.length }
const artifact: ReadonlySubmissionArtifact = { descriptor, readBytes: async () => bytes }
function job(): EvaluationJob {
  return zsoftL1Adapter.buildEvaluationRequest({ context: { evaluationRunId: 'eval-one', executionRunId: 'run-one', experimentId: 'experiment-one', caseId: 'case-one', datasetContentHash: 'dataset-one' }, publicPayload: raw.public, privatePayload: raw.private, artifacts: [descriptor], runConfig: { evaluatorKey: 'zsoft-l1', timeoutSeconds: 900, cpu: 4, memoryMiB: 8192 } })
}
function result(status: 'completed' | 'invalid_submission' | 'infrastructure_error', success: boolean): NormalizeBenchmarkResultInput {
  const projected: JsonValue = { taskId: raw.public.taskId, submissionSha256: descriptor.sha256, sourceTaskDigest: raw.private.sourceTaskDigest, bundleDigest: `sha256:${'b'.repeat(64)}`, taskDigest: `sha256:${'e'.repeat(64)}`, status, success }
  const completion: BenchmarkEvaluationCompletion = { status: status === 'completed' ? 'completed' : status === 'invalid_submission' ? 'submission_invalid' : 'failed', rawResult: projected, evidenceArtifactIds: ['report-one'], runtimeFacts: {}, cleanup: { status: 'succeeded' } }
  return { evaluationId: 'eval-one', evaluatorKey: 'zsoft-l1', evaluationJob: job(), completion, evidenceArtifacts: [{ artifactId: 'report-one', evaluationId: 'eval-one', name: 'report.json', kind: 'official-report', mediaType: 'application/json', sha256: `sha256:${'d'.repeat(64)}`, sizeBytes: 100, jsonContent: structuredClone(projected) }] }
}

function officialResult(status: 'completed' | 'invalid_submission', success: boolean): NormalizeBenchmarkResultInput {
  const input = result(status, success)
  const official = { schema_version: '0.1', status, success, summary: 'Official full summary', checks: [{ id: 'variant-check', passed: success, message: 'Original check message' }], details: { original: 'kept verbatim' } }
  const record = { task_id: raw.public.taskId, submission_sha256: descriptor.sha256.slice(7), submission_bytes: descriptor.sizeBytes, phase: 'final', submission_kind: 'final', evaluator_timed_out: false, cleanup_timed_out: false, cleanup_exit_code: 0, result: official }
  input.evidenceArtifacts = [
    { ...input.evidenceArtifacts[0], name: 'evaluation.json', jsonContent: structuredClone(official) },
    { ...input.evidenceArtifacts[0], artifactId: 'record-one', name: 'record.json', kind: 'official-record', jsonContent: structuredClone(record) },
    { ...input.evidenceArtifacts[0], artifactId: 'empty-log', name: 'judge-evidence/vuln.stderr', kind: 'test-output', mediaType: 'text/plain', sizeBytes: 0, jsonContent: undefined },
  ]
  input.completion.evidenceArtifactIds = input.evidenceArtifacts.map(item => item.artifactId)
  return input
}

test('ZSoft full official evidence keeps summaries and supports pass, fail and invalid submissions', () => {
  for (const [status, success] of [['completed', true], ['completed', false], ['invalid_submission', false]] as const) {
    const normalized = zsoftL1Adapter.normalizeResult(officialResult(status, success))
    assert.equal(normalized.score, status === 'invalid_submission' ? null : success ? 100 : 0)
    assert.equal(normalized.summary, 'Official full summary')
  }
  const withDefaults = officialResult('completed', true)
  const report = withDefaults.evidenceArtifacts[0].jsonContent as Record<string, JsonValue>
  const record = withDefaults.evidenceArtifacts[1].jsonContent as Record<string, JsonValue>
  const checks = (record.result as Record<string, JsonValue>).checks as Array<Record<string, JsonValue>>
  delete (report.checks as Array<Record<string, JsonValue>>)[0].message
  checks[0].message = null
  assert.equal(zsoftL1Adapter.normalizeResult(withDefaults).score, 100)
})

test('ZSoft rejects altered official reports, records, identities and unsafe final outcomes', () => {
  const mutations: Array<(input: NormalizeBenchmarkResultInput) => void> = [
    input => { input.evidenceArtifacts = input.evidenceArtifacts.slice(1) },
    input => { input.evidenceArtifacts = input.evidenceArtifacts.filter(item => item.name !== 'record.json') },
    input => { input.evidenceArtifacts = [...input.evidenceArtifacts, input.evidenceArtifacts[0]] },
    input => { input.evidenceArtifacts[2].evaluationId = 'stale-evaluation' },
    ...['success', 'summary', 'checks', 'details'].map(field => (input: NormalizeBenchmarkResultInput) => {
      const report = input.evidenceArtifacts[0].jsonContent as Record<string, JsonValue>
      report[field] = field === 'success' ? false : 'tampered'
    }),
    ...['task_id', 'submission_sha256', 'submission_bytes', 'phase', 'submission_kind', 'evaluator_timed_out', 'cleanup_timed_out', 'cleanup_exit_code'].map(field => (input: NormalizeBenchmarkResultInput) => {
      const record = input.evidenceArtifacts[1].jsonContent as Record<string, JsonValue>
      record[field] = field.endsWith('_timed_out') ? true : 'tampered'
    }),
  ]
  for (const mutate of mutations) {
    const input = officialResult('completed', true)
    mutate(input)
    assert.throws(() => zsoftL1Adapter.normalizeResult(input), /报告证据/)
  }
  const failed = officialResult('completed', true)
  failed.completion.status = 'failed'
  failed.completion.rawResult = {}
  failed.completion.error = { code: 'ZSOFT_CLEANUP_FAILED', message: 'Cleanup failed', retryable: true }
  const normalized = zsoftL1Adapter.normalizeResult(failed)
  assert.equal(normalized.score, null)
  assert.equal(normalized.status, 'failed')
  assert.deepEqual((normalized.evidence as Record<string, JsonValue>).artifactIds, failed.completion.evidenceArtifactIds)
})

test('ZSoft adapter keeps asset identities private and supports agent execution without requiring bundles for imports', () => {
  const split = zsoftL1Adapter.validateAndSplitCase(raw)
  assert.equal(split.externalCaseId, raw.public.taskId)
  assert.equal('bundleDigest' in split.publicPayload, false)
  assert.equal('taskDigest' in split.catalogProjection.values, false)
  assert.notEqual(zsoftL1Adapter.manifest.supportsAgentExecution, false)
  assert.equal(job().payload && (job().payload as Record<string, JsonValue>).sourceTaskDigest, raw.private.sourceTaskDigest)
  assert.throws(() => zsoftL1Adapter.validateAndSplitCase({ ...raw, private: { ...raw.private, sourceTaskDigest: '/tmp/arbitrary-script' } }), /Schema/)
})

test('ZSoft taskless submission checks encoding, exact artifact identity and per-task size without running code', async () => {
  const submission = { runId: 'run-one', publicPayload: raw.public, privatePayload: raw.private }
  await zsoftL1Adapter.validateSubmission({ submission, artifacts: [artifact] })
  await assert.rejects(zsoftL1Adapter.validateSubmission({ submission: { ...submission, runId: 'different-run' }, artifacts: [artifact] }), /不属于/)
  await assert.rejects(zsoftL1Adapter.validateSubmission({ submission: { ...submission, publicPayload: { ...raw.public, maxBytes: 1 } }, artifacts: [artifact] }), /超出/)
  const invalid = Buffer.from([0xff, 0xfe])
  const badArtifact = { descriptor: { ...descriptor, sha256: `sha256:${createHash('sha256').update(invalid).digest('hex')}` as `sha256:${string}`, sizeBytes: invalid.length }, readBytes: async () => invalid }
  await assert.rejects(zsoftL1Adapter.validateSubmission({ submission, artifacts: [badArtifact] }), /UTF-8/)
})

for (const success of [true, false]) {
  test(`ZSoft completed ${success} maps the authoritative boolean to the primary metric`, () => {
    const normalized = zsoftL1Adapter.normalizeResult(result('completed', success))
    assert.equal(normalized.status, 'done')
    assert.equal(normalized.score, success ? 100 : 0)
    assert.equal(normalized.primaryMetric?.value, success)
  })
}

test('invalid submissions and infrastructure failures do not become scored failures', () => {
  const invalid = zsoftL1Adapter.normalizeResult(result('invalid_submission', false))
  assert.equal(invalid.score, null)
  assert.equal(invalid.primaryMetric?.value, null)
  const infrastructure = zsoftL1Adapter.normalizeResult(result('infrastructure_error', false))
  assert.equal(infrastructure.status, 'failed')
  assert.equal(infrastructure.score, null)
})

test('ZSoft rejects stale task identities, mismatched evidence, and contradictory statuses', () => {
  const wrongTask = result('completed', true)
  ;(wrongTask.completion.rawResult as Record<string, JsonValue>).taskId = 'different-case'
  assert.throws(() => zsoftL1Adapter.normalizeResult(wrongTask), /不一致/)
  const wrongEvidence = result('completed', true)
  wrongEvidence.evidenceArtifacts = [{ ...wrongEvidence.evidenceArtifacts[0], jsonContent: {} }]
  assert.throws(() => zsoftL1Adapter.normalizeResult(wrongEvidence), /报告证据/)
  const wrongStatus = result('invalid_submission', false)
  wrongStatus.completion.status = 'completed'
  assert.throws(() => zsoftL1Adapter.normalizeResult(wrongStatus), /状态不一致/)
  const leaked = result('completed', true)
  ;(leaked.completion.rawResult as Record<string, JsonValue>).details = { privatePath: '/private/reference-poc' }
  assert.throws(() => zsoftL1Adapter.normalizeResult(leaked), /Schema/)
})

test('ZSoft runtime builds after a pull miss and reuses the matching catalog artifact', async () => {
  const { ensureOciRuntime } = require('../../services/evaluator/src/evaluator-registry.cjs')
  const { generatedEvaluatorDescriptors } = require('../../generated/benchmark-catalog/evaluators.cjs')
  const runtime = generatedEvaluatorDescriptors.find((item: { benchmarkKey: string }) => item.benchmarkKey === 'zsoft-l1')
  const calls: string[][] = []
  let cached = false
  const commandRunner = async (_descriptor: unknown, args: string[]) => {
    calls.push(args)
    if (args[0] === 'image') {
      if (!cached) throw new Error('synthetic absent image')
      return { stdout: runtime.artifactDigest }
    }
    if (args[0] === 'pull') throw new Error('synthetic registry miss')
    if (args[0] === 'build') { cached = true; return { stdout: '' } }
    throw new Error(`unexpected Docker operation: ${args[0]}`)
  }
  await ensureOciRuntime(runtime, { commandRunner })
  await ensureOciRuntime(runtime, { commandRunner })
  assert.deepEqual(calls.map((args) => args[0]), ['image', 'pull', 'build', 'image', 'image'])
  const build = calls.find((args) => args[0] === 'build')!
  assert.equal(build[build.indexOf('--file') + 1], runtime.dockerfile)
  assert.equal(build[build.indexOf('--tag') + 1], runtime.image)
  assert.ok(build.includes(`EVALUATOR_ARTIFACT_DIGEST=${runtime.artifactDigest}`))
})

test('Controller cleanup removes only containers and task networks labelled for this evaluation', async () => {
  const { removeLabeledContainers } = require('../../services/evaluator/src/service.cjs')
  const calls: string[][] = []
  let containersListed = false
  let networksListed = false
  const cleanup = await removeLabeledContainers('eval-one', async (args: string[]) => {
    calls.push(args)
    assert.ok(args.includes('label=agent-insight.evaluation-id=eval-one') || args.includes('rm'))
    if (args[0] === 'ps') {
      const output = containersListed ? '' : 'aaaaaaaaaaaa'
      containersListed = true
      return output
    }
    if (args[0] === 'network' && args[1] === 'ls') {
      assert.ok(args.includes('label=agent-insight.role=zsoft-task'))
      const output = networksListed ? '' : 'bbbbbbbbbbbb'
      networksListed = true
      return output
    }
    return ''
  })
  assert.equal(cleanup.status, 'succeeded')
  assert.deepEqual(calls.filter((args) => args.includes('rm')), [['rm', '-f', 'aaaaaaaaaaaa'], ['network', 'rm', 'bbbbbbbbbbbb']])
  const failed = await removeLabeledContainers('eval-one', async () => { throw new Error('synthetic Docker failure') })
  assert.equal(failed.status, 'failed')
})

test('ZSoft agent tasks use the executor-configured native tasks-dir and keep judge identities hidden', () => {
  const input = { publicPayload: raw.public, context: { runId: 'run-one', experimentId: 'experiment-one', caseId: 'case-one' }, runConfig: { platform: 'pi-mcts', agent: 'pi-mcts', timeoutSeconds: 900 } }
  const nativeTask = zsoftL1Adapter.buildAgentTask(input)
  assert.deepEqual(nativeTask.workspace, { provider: 'zsoft-tasks', taskId: raw.public.taskId })
  assert.equal(JSON.stringify(nativeTask).includes('agentBundle'), false)
  const publicPayload = { ...raw.public, agentBundle: { digest: `sha256:${'d'.repeat(64)}` } }
  assert.ok(nativeTask.task.instruction.includes('submission/poc'))
  assert.equal(JSON.stringify(nativeTask).includes(raw.private.sourceTaskDigest), false)
  const kernel = zsoftL1Adapter.buildAgentTask({ ...input, publicPayload: { ...raw.public, tags: ['kernel'], submissionKind: 'c' } })
  assert.match(kernel.task.instruction, /单文件 c/)
  assert.deepEqual(kernel.workspace, nativeTask.workspace)
  assert.throws(() => zsoftL1Adapter.buildAgentTask({ ...input, publicPayload: { ...raw.public, tags: ['kernel'] } }), /内核题需提交 C/)
  const oldCase = { public: raw.public, private: { revision: raw.private.revision, bundleDigest: `sha256:${'b'.repeat(64)}`, taskDigest: `sha256:${'c'.repeat(64)}` } }
  assert.throws(() => zsoftL1Adapter.validateAndSplitCase(oldCase as unknown as ZsoftCase), /Schema/)
})

function executionClient(zsoftReady = true) {
  return { clientId: 'synthetic-client', name: 'synthetic', status: 'online', serviceHealth: 'healthy', lastSeenAt: new Date(), unboundAt: null,
    capabilitiesJson: JSON.stringify({ actions: ['RUN_BENCHMARK_CASE'], platforms: [{ id: 'pi-mcts', agents: ['pi-mcts'], runBenchmarkCase: { returnsTraceId: true } }],
      components: { 'agent-runtime/pi-mcts/v1': { ready: true }, 'zsoft-tasks-workspace/v3': { ready: true }, 'single-file/v1': { ready: true }, 'mcts-zsoft-export/v1': { ready: zsoftReady } } }) }
}

test('ZSoft filters MCTS targets by benchmark-specific export readiness', () => {
  const unavailable = inspectBenchmarkExecutionTargets(executionClient(false) as never, zsoftL1Adapter.manifest)
  assert.equal(unavailable[0].ready, false)
  assert.deepEqual(unavailable[0].missingCapabilities, ['mcts-zsoft-export/v1'])
  assert.equal(inspectBenchmarkExecutionTargets(executionClient() as never, zsoftL1Adapter.manifest)[0].ready, true)
  const oldClient = executionClient()
  oldClient.capabilitiesJson = oldClient.capabilitiesJson.replace('zsoft-tasks-workspace/v3', 'zsoft-tasks-workspace/v2')
  assert.deepEqual(inspectBenchmarkExecutionTargets(oldClient as never, zsoftL1Adapter.manifest)[0].missingCapabilities, ['zsoft-tasks-workspace/v3'])
})

test('experiment preflight does not require a frontend tasks-dir and still rejects inconsistent kernel submissions', async (t) => {
  const datasetDelegate = prisma.benchmarkDataset
  const clientDelegate = prisma.reliabilityClient
  const originalDatasetLookup = datasetDelegate.findFirst
  const originalClientLookup = clientDelegate.findFirst
  const originalTransaction = prisma.$transaction
  for (const payload of [raw.public, { ...raw.public, tags: ['kernel'] }]) {
    datasetDelegate.findFirst = t.mock.fn(async () => ({ id: 'synthetic-dataset', status: 'ready', adapterKey: 'zsoft-l1', contentHash: 'synthetic-hash', agentEvalDataset: { casesJson: '[]' }, cases: [{ id: 'synthetic-case', publicPayloadJson: JSON.stringify(payload) }] })) as unknown as typeof originalDatasetLookup
    clientDelegate.findFirst = t.mock.fn(async () => executionClient()) as unknown as typeof originalClientLookup
    const transactionMock = t.mock.fn(async () => { throw new Error('unexpected database write') })
    prisma.$transaction = transactionMock as unknown as typeof originalTransaction
    try {
      if (payload.tags.includes('kernel')) {
        await assert.rejects(createBenchmarkExperiment({ user: 'synthetic', name: 'synthetic', datasetId: 'synthetic-dataset', clientId: 'synthetic-client', caseSelection: { mode: 'all' }, runConfig: { platform: 'pi-mcts', agent: 'pi-mcts' } }), /内核题需提交 C/)
        assert.equal(transactionMock.mock.callCount(), 0)
      } else {
        await assert.rejects(createBenchmarkExperiment({ user: 'synthetic', name: 'synthetic', datasetId: 'synthetic-dataset', clientId: 'synthetic-client', caseSelection: { mode: 'all' }, runConfig: { platform: 'pi-mcts', agent: 'pi-mcts' } }), /unexpected database write/)
        assert.equal(transactionMock.mock.callCount(), 1)
      }
    } finally {
      datasetDelegate.findFirst = originalDatasetLookup
      clientDelegate.findFirst = originalClientLookup
      prisma.$transaction = originalTransaction
    }
  }
})
