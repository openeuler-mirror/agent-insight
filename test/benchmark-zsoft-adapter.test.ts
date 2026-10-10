import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { zsoftL1Adapter, type ZsoftCase } from '../benchmarks/zsoft-l1/adapter'
import type { ArtifactDescriptor, EvaluationJob, ReadonlySubmissionArtifact } from '../packages/benchmark-protocol/src/evaluation-contracts'
import type { BenchmarkEvaluationCompletion, NormalizeBenchmarkResultInput } from '../packages/benchmark-protocol/src/evaluator-contracts'
import type { JsonValue } from '../packages/benchmark-protocol/src/contracts'

const raw: ZsoftCase = {
  public: { taskId: 'synthetic-contract-case', title: 'Synthetic task', description: 'Synthetic adapter contract only', submissionKind: 'python', maxBytes: 128, tags: ['userspace', 'python'] },
  private: { revision: 'a'.repeat(40), bundleDigest: `sha256:${'b'.repeat(64)}`, taskDigest: `sha256:${'c'.repeat(64)}` },
}
const bytes = Buffer.from('synthetic text; never executed')
const descriptor: ArtifactDescriptor = { artifactId: 'artifact-one', executionRunId: 'run-one', name: 'poc', mediaType: 'application/octet-stream', sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, sizeBytes: bytes.length }
const artifact: ReadonlySubmissionArtifact = { descriptor, readBytes: async () => bytes }
function job(): EvaluationJob {
  return zsoftL1Adapter.buildEvaluationRequest({ context: { evaluationRunId: 'eval-one', executionRunId: 'run-one', experimentId: 'experiment-one', caseId: 'case-one', datasetContentHash: 'dataset-one' }, publicPayload: raw.public, privatePayload: raw.private, artifacts: [descriptor], runConfig: { evaluatorKey: 'zsoft-l1', timeoutSeconds: 900, cpu: 4, memoryMiB: 8192 } })
}
function result(status: 'completed' | 'invalid_submission' | 'infrastructure_error', success: boolean): NormalizeBenchmarkResultInput {
  const projected: JsonValue = { taskId: raw.public.taskId, submissionSha256: descriptor.sha256, bundleDigest: raw.private.bundleDigest, taskDigest: raw.private.taskDigest, status, success }
  const completion: BenchmarkEvaluationCompletion = { status: status === 'completed' ? 'completed' : status === 'invalid_submission' ? 'submission_invalid' : 'failed', rawResult: projected, evidenceArtifactIds: ['report-one'], runtimeFacts: {}, cleanup: { status: 'succeeded' } }
  return { evaluationId: 'eval-one', evaluatorKey: 'zsoft-l1', evaluationJob: job(), completion, evidenceArtifacts: [{ artifactId: 'report-one', evaluationId: 'eval-one', name: 'report.json', kind: 'official-report', mediaType: 'application/json', sha256: `sha256:${'d'.repeat(64)}`, sizeBytes: 100, jsonContent: structuredClone(projected) }] }
}

test('ZSoft adapter keeps asset identities private and exposes an import-only manifest', () => {
  const split = zsoftL1Adapter.validateAndSplitCase(raw)
  assert.equal(split.externalCaseId, raw.public.taskId)
  assert.equal('bundleDigest' in split.publicPayload, false)
  assert.equal('taskDigest' in split.catalogProjection.values, false)
  assert.equal(zsoftL1Adapter.manifest.supportsAgentExecution, false)
  assert.equal(job().payload && (job().payload as Record<string, JsonValue>).taskDigest, raw.private.taskDigest)
  assert.throws(() => zsoftL1Adapter.validateAndSplitCase({ ...raw, private: { ...raw.private, taskDigest: '/tmp/arbitrary-script' } }), /Schema/)
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

test('prebuilt runtime mode cannot pull or build images during evaluation', async () => {
  const { ensureOciRuntime } = require('../services/evaluator/src/evaluator-registry.cjs')
  const calls: string[][] = []
  await assert.rejects(ensureOciRuntime({
    image: 'synthetic-runtime:prebuilt-only', artifactDigest: `sha256:${'e'.repeat(64)}`, requiresPrebuiltRuntime: true,
  }, { commandRunner: async (_descriptor: unknown, args: string[]) => { calls.push(args); throw new Error('synthetic absent image') } }), /预先构建/)
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [['image', 'inspect']])
})

test('Controller cleanup removes only containers and task networks labelled for this evaluation', async () => {
  const { removeLabeledContainers } = require('../services/evaluator/src/service.cjs')
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
