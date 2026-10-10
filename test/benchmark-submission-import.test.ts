import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { AgentTaskEnvelope, BuildAgentTaskInput, JsonValue } from '../packages/benchmark-protocol/src/contracts'
import type { BuildEvaluationRequestInput, ValidateSubmissionInput } from '../packages/benchmark-protocol/src/evaluation-contracts'
import { BenchmarkProtocolError } from '../packages/benchmark-protocol/src/errors'
import { AbstractBenchmarkAdapter } from '../src/lib/benchmark/adapter-base'
import { decodeImportedSubmission, readBoundedImportJson, MAX_IMPORT_BODY_BYTES } from '../src/lib/benchmark/import-submission'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-submission-import-'))
process.env.AGENT_INSIGHT_HOME = directory
process.env.DATABASE_URL = `file:${path.join(directory, 'test.db')}`
fs.closeSync(fs.openSync(path.join(directory, 'test.db'), 'a'))

const publicSchema = { type: 'object', required: ['id', 'description'], properties: { id: { type: 'string' }, description: { type: 'string' } }, additionalProperties: false, 'x-agent-visibility': 'public' }
type FixtureCase = { public: { id: string; description: string }; private: { oracle: string } }
class FixtureAdapter extends AbstractBenchmarkAdapter<FixtureCase, FixtureCase['public'], FixtureCase['private'], JsonValue> {
  readonly manifest = {
    adapterKey: 'import-fixture', displayName: 'Import fixture', supportsAgentExecution: false,
    protocols: { agentTask: 'agent-task/v1' as const, evaluation: 'benchmark-evaluation/v1' as const }, requiredCapabilities: [], defaultTimeoutSeconds: 30,
    requiredArtifacts: [{ name: 'answer.txt', mediaType: 'text/plain', maxBytes: 128, collector: 'imported-submission/v1' }],
    schemas: { case: { type: 'object', required: ['public', 'private'], properties: { public: publicSchema, private: { type: 'object', properties: { oracle: { type: 'string' } }, 'x-agent-visibility': 'private' } } }, rawResult: { type: 'object' } },
    evaluation: { evaluatorKey: 'import-fixture', defaultTimeoutSeconds: 30, defaultResources: { cpu: 1, memoryMiB: 128 } },
    result: { primaryMetric: { key: 'passed', aggregation: 'boolean-rate' as const } },
  }
  protected splitCase(raw: FixtureCase) { return { externalCaseId: raw.public.id, publicPayload: raw.public, privatePayload: raw.private, catalogProjection: { input: raw.public.description, values: {} } } }
  protected createAgentTask(_input: BuildAgentTaskInput<FixtureCase['public']>): AgentTaskEnvelope { throw new Error('No agent execution') }
  protected async validateBenchmarkSubmission(input: ValidateSubmissionInput) { assert.ok(input.submission); assert.equal(input.task, undefined) }
  protected createEvaluationRequest(input: BuildEvaluationRequestInput<FixtureCase['public'], FixtureCase['private']>) {
    return { protocolVersion: 'benchmark-evaluation/v1' as const, evaluationId: input.context.evaluationRunId, executionRunId: input.context.executionRunId,
      context: { experimentId: input.context.experimentId, caseId: input.context.caseId, datasetContentHash: input.context.datasetContentHash },
      benchmark: { key: this.manifest.adapterKey }, evaluator: { key: input.runConfig.evaluatorKey }, artifacts: [...input.artifacts],
      payload: { ...input.privatePayload, caseId: input.publicPayload.id }, limits: { timeoutSeconds: input.runConfig.timeoutSeconds, cpu: input.runConfig.cpu, memoryMiB: input.runConfig.memoryMiB } }
  }
  protected createNormalizedResult(): never { throw new Error('Fixture does not run a judge') }
}

let prisma: typeof import('../src/lib/storage/prisma').prisma
let service: typeof import('../src/lib/benchmark/import-submission-service')
let preparation: typeof import('../src/lib/benchmark/evaluation-preparation-service')
let route: typeof import('../src/app/api/benchmark/v1/submissions/import/route')
let datasetId: string
let datasetCaseId: string
let otherCaseId: string
let publicDatasetId: string

function requestBody(key: string, content = 'answer') {
  return { name: 'Imported answers', datasetId, idempotencyKey: key, cases: [{ caseId: datasetCaseId, artifacts: [{ name: 'answer.txt', contentBase64: Buffer.from(content).toString('base64') }] }] }
}
function imported(key: string, content?: string) { return { ...decodeImportedSubmission(requestBody(key, content)), user: 'import-user', callbackOrigin: 'http://platform.test' } }

async function settledDispatches() {
  for (let index = 0; index < 300; index += 1) {
    if (!await prisma.benchmarkEvaluationDispatchOutbox.count({ where: { OR: [{ status: 'sending' }, { status: 'pending', attemptCount: 0 }] } })) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('dispatch did not settle')
}

test.before(async () => {
  const schema = spawnSync(process.execPath, [path.resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--schema', path.resolve('prisma/schema.prisma'), '--skip-generate'], { env: process.env, encoding: 'utf8', timeout: 30000 })
  assert.equal(schema.status, 0, schema.stderr)
  ;({ prisma } = await import('../src/lib/storage/prisma'))
  const { registerBenchmarkAdapter } = await import('../src/lib/benchmark/adapter-registry')
  registerBenchmarkAdapter(new FixtureAdapter())
  const scheduler = await import('../src/lib/benchmark/evaluation-scheduler')
  scheduler.setEvaluatorTargetResolverForTest({ resolve: (key) => ({ targetKey: 'fixture', baseUrl: 'http://evaluator.test', evaluatorKey: key }) })
  scheduler.setBenchmarkEvaluationDispatchFetchForTest(async () => new Response(JSON.stringify({ status: 'healthy', busy: true, evaluators: [{ key: 'import-fixture', ready: true }] }), { status: 200 }))
  service = await import('../src/lib/benchmark/import-submission-service')
  preparation = await import('../src/lib/benchmark/evaluation-preparation-service')
  route = await import('../src/app/api/benchmark/v1/submissions/import/route')
  const { importBenchmarkDataset } = await import('../src/lib/benchmark/dataset-service')
  const dataset = await importBenchmarkDataset({ user: 'import-user', name: 'Import fixture', adapterKey: 'import-fixture', cases: [
    { public: { id: 'fixture-one', description: 'First task' }, private: { oracle: 'hidden-oracle-one' } },
    { public: { id: 'fixture-two', description: 'Second task' }, private: { oracle: 'hidden-oracle-two' } },
  ] })
  datasetId = dataset.id
  const stored = await prisma.benchmarkDataset.findUniqueOrThrow({ where: { id: datasetId }, include: { cases: { orderBy: { ordinal: 'asc' } } } })
  datasetCaseId = stored.cases[0].id
  otherCaseId = stored.cases[1].id
  publicDatasetId = stored.agentEvalDatasetId
})

test.after(async () => { await settledDispatches(); await prisma?.$disconnect(); fs.rmSync(directory, { recursive: true, force: true }) })

test('import parser rejects remote instructions, duplicates, malformed base64 and oversized bodies', async () => {
  const value = requestBody('parser-key')
  assert.throws(() => decodeImportedSubmission({ ...value, evaluatorScript: '/tmp/untrusted.py' }), /导入参数不合法/)
  assert.throws(() => decodeImportedSubmission({ ...value, cases: [...value.cases, ...value.cases] }), /重复 Case/)
  for (const encoded of ['!!!!', 'YQ=', '====', 'YR==', 'YQ==\n']) {
    const invalid = requestBody('parser-key')
    invalid.cases[0].artifacts[0].contentBase64 = encoded
    assert.throws(() => decodeImportedSubmission(invalid))
  }
  await assert.rejects(readBoundedImportJson(new Request('http://platform.test', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(MAX_IMPORT_BODY_BYTES + 1) }, body: '{}' })), /过大/)
  assert.deepEqual(await readBoundedImportJson(new Request('http://platform.test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"valid":true}' })), { valid: true })
})

test('import freezes a taskless submission, persists an immutable artifact and queues evaluation without an executor', async () => {
  const first = await service.importBenchmarkSubmission(imported('create-key'))
  await settledDispatches()
  assert.equal(first.reused, false)
  const run = await prisma.benchmarkCaseRun.findUniqueOrThrow({ where: { id: first.evaluations[0].runId }, include: { artifacts: true, dispatch: true, evaluations: true } })
  assert.equal(run.clientId, null)
  assert.equal(run.submissionSource, 'imported')
  assert.equal(run.taskEnvelopeJson, null)
  assert.equal(run.dispatch, null)
  assert.equal(run.status, 'submitted')
  assert.equal(JSON.parse(run.publicPayloadJson).oracle, undefined)
  assert.equal(JSON.parse(run.privatePayloadJson).oracle, 'hidden-oracle-one')
  assert.equal(fs.readFileSync(path.join(directory, 'data', run.artifacts[0].storagePath), 'utf8'), 'answer')
  assert.equal(JSON.parse(run.evaluations[0].requestJson).payload.oracle, 'hidden-oracle-one')
  assert.equal(run.evaluations[0].status, 'queued')
  assert.equal(await prisma.experimentEvalResult.count({ where: { experimentId: first.experimentId, status: 'pending' } }), 1)
  const second = await service.importBenchmarkSubmission(imported('create-key'))
  assert.equal(second.reused, true)
  assert.equal(second.experimentId, first.experimentId)
  assert.deepEqual(second.evaluations, first.evaluations)
  assert.equal(await prisma.benchmarkEvaluation.count({ where: { caseRunId: run.id } }), 1)
  await assert.rejects(service.importBenchmarkSubmission(imported('create-key', 'different')), (error: unknown) => error instanceof BenchmarkProtocolError && error.code === 'SUBMISSION_IMPORT_CONFLICT')
})

test('ownership, per-artifact limits and case membership fail before creating an experiment', async () => {
  await assert.rejects(service.importBenchmarkSubmission({ ...imported('foreign-user-key'), user: 'other-user' }), /数据集不存在/)
  const unknown = imported('unknown-case-key')
  unknown.cases[0].caseId = 'unknown-case'
  await assert.rejects(service.importBenchmarkSubmission(unknown), /不属于/)
  await assert.rejects(service.importBenchmarkSubmission(imported('too-large-key', 'x'.repeat(129))), /大小不合法/)
  assert.equal(await prisma.experiment.count({ where: { user: 'other-user' } }), 0)
})

test('concurrent network retries produce one experiment, one artifact and one evaluation', async () => {
  const [first, second] = await Promise.all([
    service.importBenchmarkSubmission(imported('concurrent-key')),
    service.importBenchmarkSubmission(imported('concurrent-key')),
  ])
  assert.equal(first.experimentId, second.experimentId)
  assert.deepEqual(first.evaluations, second.evaluations)
  assert.ok(first.reused || second.reused)
  assert.equal(await prisma.benchmarkCaseRun.count({ where: { experimentId: first.experimentId } }), 1)
  assert.equal(await prisma.benchmarkArtifact.count({ where: { runId: first.evaluations[0].runId } }), 1)
  assert.equal(await prisma.benchmarkEvaluation.count({ where: { caseRunId: first.evaluations[0].runId } }), 1)
})

test('startup recovers an imported submission whose evaluation was not queued before a crash', async () => {
  const created = await service.importBenchmarkSubmission(imported('recovery-key'))
  await settledDispatches()
  await prisma.benchmarkEvaluation.delete({ where: { id: created.evaluations[0].evaluationId } })
  const { startBenchmarkExperiment } = await import('../src/lib/benchmark/scheduler')
  const recovered = await startBenchmarkExperiment({ experimentId: created.experimentId, user: 'import-user', publicCallbackOrigin: 'http://platform.test', executorCallbackOrigin: 'http://platform.test', resumeOnly: true })
  await recovered?.completion
  const evaluations = await prisma.benchmarkEvaluation.findMany({ where: { caseRunId: created.evaluations[0].runId } })
  assert.equal(evaluations.length, 1)
  assert.equal(evaluations[0].status, 'queued')
  assert.equal(await prisma.benchmarkDispatchOutbox.count({ where: { runId: created.evaluations[0].runId } }), 0)
})

test('API accepts a public dataset ID and returns the same experiment for a network retry', async () => {
  const body = { ...requestBody('route-create-key'), datasetId: publicDatasetId }
  const request = () => new Request('http://platform.test/api/benchmark/v1/submissions/import?user=import-user', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const response = await route.POST(request())
  assert.equal(response.status, 201)
  const created = await response.json()
  const retry = await route.POST(request())
  assert.equal(retry.status, 200)
  assert.equal((await retry.json()).experimentId, created.experimentId)
  assert.equal((await route.POST(new Request('http://platform.test', { method: 'POST', body: '{}' }))).status, 401)
})

test('evaluation preparation rejects changed imported contracts and corrupted artifacts without a task envelope', async () => {
  const importedRun = await service.importBenchmarkSubmission(imported('integrity-key'))
  await settledDispatches()
  const runId = importedRun.evaluations[0].runId
  const run = await prisma.benchmarkCaseRun.findUniqueOrThrow({ where: { id: runId }, include: { artifacts: true } })
  const original = run.submissionContractJson
  await prisma.benchmarkCaseRun.update({ where: { id: runId }, data: { submissionContractJson: '{}' } })
  await assert.rejects(preparation.prepareBenchmarkEvaluation(runId, { forceNewAttempt: true }), /契约已变更/)
  await prisma.benchmarkCaseRun.update({ where: { id: runId }, data: { submissionContractJson: original } })
  const artifactPath = path.join(directory, 'data', run.artifacts[0].storagePath)
  fs.chmodSync(artifactPath, 0o600)
  fs.writeFileSync(artifactPath, 'corrupt')
  await assert.rejects(preparation.prepareBenchmarkEvaluation(runId, { forceNewAttempt: true }), /内容与记录不一致/)
  assert.equal(await prisma.benchmarkEvaluation.count({ where: { caseRunId: runId } }), 1)
})

test('batch import respects the pending evaluation quota atomically', async () => {
  const previous = process.env.AGENT_INSIGHT_BENCHMARK_MAX_PENDING_EVALUATIONS_PER_USER
  process.env.AGENT_INSIGHT_BENCHMARK_MAX_PENDING_EVALUATIONS_PER_USER = '1'
  try {
    const batch = imported('quota-key')
    batch.cases.push({ caseId: otherCaseId, artifacts: [{ name: 'answer.txt', bytes: Buffer.from('second') }] })
    await assert.rejects(service.importBenchmarkSubmission(batch), (error: unknown) => error instanceof BenchmarkProtocolError && error.code === 'EVALUATION_QUOTA_WAIT')
  } finally {
    if (previous === undefined) delete process.env.AGENT_INSIGHT_BENCHMARK_MAX_PENDING_EVALUATIONS_PER_USER
    else process.env.AGENT_INSIGHT_BENCHMARK_MAX_PENDING_EVALUATIONS_PER_USER = previous
  }
})

test('native external task IDs resolve to the same frozen Case and duplicate aliases are rejected', async () => {
  const input = imported('external-task-key')
  input.cases[0].caseId = 'fixture-one'
  const first = await service.importBenchmarkSubmission(input)
  const same = await service.importBenchmarkSubmission(imported('external-task-key'))
  assert.equal(first.experimentId, same.experimentId)
  assert.equal(same.reused, true)
  const duplicate = imported('external-task-duplicate-key')
  duplicate.cases.push({ ...duplicate.cases[0], caseId: 'fixture-one' })
  await assert.rejects(service.importBenchmarkSubmission(duplicate), /重复 Case/)
})

test('a corrupted imported submission cannot reset a finished result into a permanently pending retry', async () => {
  const importedRun = await service.importBenchmarkSubmission(imported('reevaluation-corrupt-key'))
  await settledDispatches()
  const runId = importedRun.evaluations[0].runId
  const run = await prisma.benchmarkCaseRun.findUniqueOrThrow({ where: { id: runId }, include: { artifacts: true } })
  await prisma.benchmarkCaseRun.update({ where: { id: runId }, data: { status: 'evaluation_failed', submissionContractJson: '{}' } })
  await prisma.benchmarkEvaluation.update({ where: { id: importedRun.evaluations[0].evaluationId }, data: { status: 'failed', continuationStatus: 'completed' } })
  await prisma.benchmarkEvaluationDispatchOutbox.update({ where: { evaluationId: importedRun.evaluations[0].evaluationId }, data: { status: 'accepted' } })
  const result = await prisma.experimentEvalResult.findFirstOrThrow({ where: { caseId: run.experimentCaseId } })
  await prisma.experimentEvalResult.update({ where: { id: result.id }, data: { status: 'failed' } })
  await assert.rejects(preparation.retryBenchmarkEvaluation({ experimentId: importedRun.experimentId, resultId: result.id, user: 'import-user' }), /契约已变更/)
  assert.equal((await prisma.benchmarkCaseRun.findUniqueOrThrow({ where: { id: runId } })).status, 'evaluation_failed')
  assert.equal((await prisma.experimentEvalResult.findUniqueOrThrow({ where: { id: result.id } })).status, 'failed')
})

test('an imported evaluation can be retried using the same PoC without creating an agent task', async () => {
  const importedRun = await service.importBenchmarkSubmission(imported('reevaluation-valid-key'))
  await settledDispatches()
  const runId = importedRun.evaluations[0].runId
  const run = await prisma.benchmarkCaseRun.findUniqueOrThrow({ where: { id: runId } })
  await prisma.benchmarkCaseRun.update({ where: { id: runId }, data: { status: 'evaluated' } })
  await prisma.benchmarkEvaluation.update({ where: { id: importedRun.evaluations[0].evaluationId }, data: { status: 'completed', continuationStatus: 'completed' } })
  await prisma.benchmarkEvaluationDispatchOutbox.update({ where: { evaluationId: importedRun.evaluations[0].evaluationId }, data: { status: 'accepted' } })
  const result = await prisma.experimentEvalResult.findFirstOrThrow({ where: { caseId: run.experimentCaseId } })
  await prisma.experimentEvalResult.update({ where: { id: result.id }, data: { status: 'done', score: 100 } })
  const retry = await preparation.retryBenchmarkEvaluation({ experimentId: importedRun.experimentId, resultId: result.id, user: 'import-user' })
  const evaluation = await prisma.benchmarkEvaluation.findUniqueOrThrow({ where: { id: retry.evaluationRunId } })
  assert.equal(evaluation.attemptNo, 2)
  assert.equal(evaluation.retryOfEvaluationId, importedRun.evaluations[0].evaluationId)
  const retriedRun = await prisma.benchmarkCaseRun.findUniqueOrThrow({ where: { id: runId } })
  assert.equal(retriedRun.clientId, null)
  assert.equal(retriedRun.taskEnvelopeJson, null)
  assert.equal(await prisma.benchmarkArtifact.count({ where: { runId } }), 1)
})
