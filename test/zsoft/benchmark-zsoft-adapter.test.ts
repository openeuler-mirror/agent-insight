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

test('ZSoft agent tasks use native tasks-dir without bundles and keep judge identities hidden', () => {
  const input = { publicPayload: raw.public, context: { runId: 'run-one', experimentId: 'experiment-one', caseId: 'case-one' }, runConfig: { platform: 'pi-mcts', agent: 'pi-mcts', timeoutSeconds: 900 } }
  assert.throws(() => zsoftL1Adapter.buildAgentTask(input), /任务目录/)
  const nativeTask = zsoftL1Adapter.buildAgentTask({ ...input, runConfig: { ...input.runConfig, tasksDir: '/srv/zsoft/tasks' } })
  assert.deepEqual(nativeTask.workspace, { provider: 'zsoft-tasks', taskId: raw.public.taskId, tasksDir: '/srv/zsoft/tasks' })
  assert.equal(JSON.stringify(nativeTask).includes('agentBundle'), false)
  const publicPayload = { ...raw.public, agentBundle: { digest: `sha256:${'d'.repeat(64)}` } }
  assert.throws(() => zsoftL1Adapter.buildAgentTask({ ...input, publicPayload }), /任务目录/)
  assert.ok(nativeTask.task.instruction.includes('submission/poc'))
  assert.equal(JSON.stringify(nativeTask).includes(raw.private.sourceTaskDigest), false)
  const kernel = zsoftL1Adapter.buildAgentTask({ ...input, runConfig: { ...input.runConfig, tasksDir: '/srv/zsoft/tasks' }, publicPayload: { ...raw.public, tags: ['kernel'], submissionKind: 'c' } })
  assert.match(kernel.task.instruction, /单文件 c/)
  assert.deepEqual(kernel.workspace, nativeTask.workspace)
  assert.throws(() => zsoftL1Adapter.buildAgentTask({ ...input, runConfig: { ...input.runConfig, tasksDir: '/srv/zsoft/tasks' }, publicPayload: { ...raw.public, tags: ['kernel'] } }), /内核题需提交 C/)
  const oldCase = { public: raw.public, private: { revision: raw.private.revision, bundleDigest: `sha256:${'b'.repeat(64)}`, taskDigest: `sha256:${'c'.repeat(64)}` } }
  assert.throws(() => zsoftL1Adapter.validateAndSplitCase(oldCase as unknown as ZsoftCase), /Schema/)
})

function executionClient(zsoftReady = true) {
  return { clientId: 'synthetic-client', name: 'synthetic', status: 'online', serviceHealth: 'healthy', lastSeenAt: new Date(), unboundAt: null,
    capabilitiesJson: JSON.stringify({ actions: ['RUN_BENCHMARK_CASE'], platforms: [{ id: 'pi-mcts', agents: ['pi-mcts'], runBenchmarkCase: { returnsTraceId: true } }],
      components: { 'agent-runtime/pi-mcts/v1': { ready: true }, 'zsoft-tasks-workspace/v2': { ready: true }, 'single-file/v1': { ready: true }, 'mcts-zsoft-export/v1': { ready: zsoftReady } } }) }
}

test('ZSoft filters MCTS targets by benchmark-specific export readiness', () => {
  const unavailable = inspectBenchmarkExecutionTargets(executionClient(false) as never, zsoftL1Adapter.manifest)
  assert.equal(unavailable[0].ready, false)
  assert.deepEqual(unavailable[0].missingCapabilities, ['mcts-zsoft-export/v1'])
  assert.equal(inspectBenchmarkExecutionTargets(executionClient() as never, zsoftL1Adapter.manifest)[0].ready, true)
  const oldClient = executionClient()
  oldClient.capabilitiesJson = oldClient.capabilitiesJson.replace('zsoft-tasks-workspace/v2', 'zsoft-tasks-workspace/v1')
  assert.deepEqual(inspectBenchmarkExecutionTargets(oldClient as never, zsoftL1Adapter.manifest)[0].missingCapabilities, ['zsoft-tasks-workspace/v2'])
})

test('experiment preflight rejects missing tasks-dir and inconsistent kernel submission kinds before writing an experiment', async (t) => {
  const datasetDelegate = prisma.benchmarkDataset
  const clientDelegate = prisma.reliabilityClient
  const originalDatasetLookup = datasetDelegate.findFirst
  const originalClientLookup = clientDelegate.findFirst
  const originalTransaction = prisma.$transaction
  const originalConfigLookup = prisma.reliabilityClientConfig.findFirst
  for (const payload of [raw.public, { ...raw.public, tags: ['kernel'] }]) {
    datasetDelegate.findFirst = t.mock.fn(async () => ({ id: 'synthetic-dataset', status: 'ready', adapterKey: 'zsoft-l1', contentHash: 'synthetic-hash', agentEvalDataset: { casesJson: '[]' }, cases: [{ id: 'synthetic-case', publicPayloadJson: JSON.stringify(payload) }] })) as unknown as typeof originalDatasetLookup
    clientDelegate.findFirst = t.mock.fn(async () => executionClient()) as unknown as typeof originalClientLookup
    prisma.reliabilityClientConfig.findFirst = t.mock.fn(async () => payload.tags.includes('kernel')
      ? { overrideJson: JSON.stringify({ tasksDir: '/srv/zsoft/tasks' }) } : null) as unknown as typeof originalConfigLookup
    const transactionMock = t.mock.fn(async () => { throw new Error('unexpected database write') })
    prisma.$transaction = transactionMock as unknown as typeof originalTransaction
    try {
      await assert.rejects(createBenchmarkExperiment({ user: 'synthetic', name: 'synthetic', datasetId: 'synthetic-dataset', clientId: 'synthetic-client', caseSelection: { mode: 'all' }, runConfig: { platform: 'pi-mcts', agent: 'pi-mcts' } }), /任务目录|内核题需提交 C/)
      assert.equal(transactionMock.mock.callCount(), 0)
    } finally {
      datasetDelegate.findFirst = originalDatasetLookup
      clientDelegate.findFirst = originalClientLookup
      prisma.$transaction = originalTransaction
      prisma.reliabilityClientConfig.findFirst = originalConfigLookup
    }
  }
})
