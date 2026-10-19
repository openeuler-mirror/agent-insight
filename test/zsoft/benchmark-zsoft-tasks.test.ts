import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { createRequire } from 'node:module'
import { zsoftL1Adapter } from '../../benchmarks/zsoft-l1/adapter'
import { createBenchmarkExperiment } from '../../src/lib/benchmark/experiment-service'
import { getBenchmarkExecutorConfig, saveBenchmarkExecutorConfig, normalizeBenchmarkTasksDir } from '../../src/lib/benchmark/executor-config'
import { prisma } from '../../src/lib/storage/prisma'
import { GET, PUT } from '../../src/app/api/benchmark/v1/execution-targets/route'

function mockMethod(t: TestContext, target: any, method: string, implementation: (...args: any[]) => any) {
  const original = target[method]
  const mocked = t.mock.fn(implementation)
  target[method] = mocked
  t.after(() => { target[method] = original })
  return mocked
}

const require = createRequire(import.meta.url)
const { ZsoftTasksWorkspaceProvider } = require('../../services/executor/src/zsoft-tasks.cjs')
const { BenchmarkExecutionRunner, WorkspaceProviderRegistry, AgentRuntimeRegistry, ArtifactCollectorRegistry, FileRunStore, LocalPolicyEnforcer, WorkspaceCleanupManager } = require('../../services/executor/src/index.cjs')
const { SingleFileCollector } = require('../../services/executor/src/public-bundle.cjs')
const publicCase = { taskId: 'synthetic-native-task', title: 'Synthetic', description: 'Never executed', tags: ['python', 'userspace'], submissionKind: 'python' as const, maxBytes: 128 }

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zsoft-native-'))
  const tasksDir = path.join(root, 'tasks')
  const taskRoot = path.join(tasksDir, publicCase.taskId)
  fs.mkdirSync(path.join(taskRoot, 'public'), { recursive: true })
  fs.mkdirSync(path.join(taskRoot, 'private'))
  fs.writeFileSync(path.join(taskRoot, 'private', 'judge.py'), 'private judge; never executed')
  fs.writeFileSync(path.join(taskRoot, 'task.json'), JSON.stringify({ task_id: publicCase.taskId,
    title: publicCase.title, description: publicCase.description, tags: ['python'],
    submission: { max_bytes: 128 }, judge: { secret: 'private-marker' } }))
  fs.writeFileSync(path.join(taskRoot, 'public', 'README.md'), 'Synthetic public text')
  fs.writeFileSync(path.join(taskRoot, 'public', 'helper.sh'), 'Synthetic executable bytes', { mode: 0o700 })
  const provider = new ZsoftTasksWorkspaceProvider(path.join(root, 'workspaces'))
  const spec = { provider: 'zsoft-tasks', tasksDir, taskId: publicCase.taskId }
  const runId = `erun_${'a'.repeat(32)}`
  const context = { runId, benchmarkKey: 'zsoft-l1', benchmarkPayload: publicCase }
  return { root, tasksDir, taskRoot, provider, spec, runId, context }
}

test('native tasks prepare isolated public workspaces without any exported bundle', async t => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const [one, two] = await Promise.all([f.provider.prepare(f.spec, f.context),
    f.provider.prepare(f.spec, { ...f.context, runId: `erun_${'b'.repeat(32)}` })])
  const isolated = path.join(one.path, 'tasks', publicCase.taskId)
  assert.equal(fs.existsSync(path.join(isolated, 'private')), false)
  assert.equal(fs.readFileSync(path.join(isolated, 'task.json'), 'utf8').includes('private-marker'), false)
  assert.equal(fs.statSync(path.join(isolated, 'public', 'helper.sh')).mode & 0o100, 0o100)
  fs.writeFileSync(path.join(isolated, 'public', 'README.md'), 'Changed by agent')
  assert.equal(fs.readFileSync(path.join(two.path, 'tasks', publicCase.taskId, 'public', 'README.md'), 'utf8'), 'Synthetic public text')
  assert.equal(fs.readFileSync(path.join(f.taskRoot, 'public', 'README.md'), 'utf8'), 'Synthetic public text')
})

test('native tasks report missing/mismatched cases and clean failed workspace preparation', async t => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  await assert.rejects(f.provider.prepare({ ...f.spec, taskId: 'missing' }, f.context), { code: 'ZSOFT_TASK_MISSING' })
  await assert.rejects(f.provider.prepare(f.spec, { ...f.context, benchmarkPayload: { ...publicCase, maxBytes: 1 } }), { code: 'ZSOFT_TASK_MISMATCH' })
  await assert.rejects(f.provider.prepare({ ...f.spec, tasksDir: 'relative/tasks' }, f.context), { code: 'ZSOFT_TASKS_DIR_INVALID' })
  await assert.rejects(f.provider.prepare({ ...f.spec, taskId: undefined }, f.context), { code: 'ZSOFT_TASKS_DIR_INVALID' })
  fs.symlinkSync(path.join(f.taskRoot, 'private', 'judge.py'), path.join(f.taskRoot, 'public', 'linked.py'))
  await assert.rejects(f.provider.prepare(f.spec, f.context), /符号链接/)
  assert.equal(fs.existsSync(path.join(f.root, 'workspaces', f.runId)), false)
})

test('kernel tasks use an isolated public tasks-dir and a C submission without private kernel assets', async t => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const manifestPath = path.join(f.taskRoot, 'task.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, tags: ['kernel'] }))
  const payload = { ...publicCase, tags: ['kernel'], submissionKind: 'c' }
  const prepared = await f.provider.prepare(f.spec, { ...f.context, benchmarkPayload: payload })
  const taskRoot = path.join(prepared.path, 'tasks', publicCase.taskId)
  assert.deepEqual(fs.readdirSync(taskRoot).sort(), ['public', 'task.json'])
  assert.equal(JSON.parse(fs.readFileSync(path.join(taskRoot, 'task.json'), 'utf8')).submission_kind, 'c')
  await assert.rejects(f.provider.prepare(f.spec, { ...f.context, runId: `erun_${'c'.repeat(32)}`, benchmarkPayload: { ...payload, submissionKind: 'python' } }), { code: 'ZSOFT_TASK_MISMATCH' })
})

test('executor passes native metadata to workspace provider and uploads synthetic submission with Trace', async t => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const uploaded: Buffer[] = []
  const completions: any[] = []
  const task = zsoftL1Adapter.buildAgentTask({ publicPayload: publicCase,
    runConfig: { platform: 'synthetic', agent: 'synthetic', timeoutSeconds: 60, tasksDir: f.tasksDir },
    context: { runId: f.runId, experimentId: 'synthetic', caseId: 'synthetic' } })
  const runner = new BenchmarkExecutionRunner({ store: new FileRunStore(path.join(f.root, 'runs')),
    workspaceProviders: new WorkspaceProviderRegistry([['zsoft-tasks', f.provider]]),
    agentRuntimes: new AgentRuntimeRegistry([['synthetic', { run: async ({ cwd }: { cwd: string }) => {
      assert.equal(fs.existsSync(path.join(cwd, 'tasks', publicCase.taskId, 'public', 'README.md')), true)
      fs.writeFileSync(path.join(cwd, 'submission', 'poc'), 'Synthetic bytes; never executed')
      return { traceId: 'synthetic-trace', exitCode: 0 }
    } }]]), collectors: new ArtifactCollectorRegistry([['single-file/v1', new SingleFileCollector()]]),
    policyEnforcer: new LocalPolicyEnforcer(), cleanupManager: new WorkspaceCleanupManager(),
    callback: { progress: async () => {}, uploadArtifact: async (_: unknown, artifact: { bytes: Buffer }) => {
      uploaded.push(artifact.bytes); return { artifactId: 'synthetic-artifact' }
    }, complete: async (_: unknown, completion: unknown) => completions.push(completion) },
  })
  await runner.execute({ runId: f.runId, timeoutSeconds: 60, task })
  assert.equal(uploaded[0].toString(), 'Synthetic bytes; never executed')
  assert.equal(completions[0].status, 'succeeded')
  assert.equal(completions[0].runFacts.traceId, 'synthetic-trace')
  assert.equal(fs.existsSync(path.join(f.root, 'workspaces', f.runId)), false)
  assert.equal(fs.existsSync(f.taskRoot), true)
})

test('tasks-dir configuration is isolated by owner/client/Benchmark and validates absolute paths', async t => {
  const rows = new Map<string, any>()
  mockMethod(t, prisma.reliabilityClient, 'findFirst', async ({ where }: any) => where.user === 'owner' && ['one', 'two'].includes(where.clientId) ? { clientId: where.clientId } : null)
  mockMethod(t, prisma.reliabilityClientConfig, 'upsert', async ({ create, update }: any) => {
    const key = `${create.clientId}:${create.platform}`
    rows.set(key, rows.has(key) ? { ...rows.get(key), ...update } : create)
  })
  mockMethod(t, prisma.reliabilityClientConfig, 'findFirst', async ({ where }: any) => {
    const row = rows.get(`${where.clientId}:${where.platform}`)
    return row?.user === where.user ? row : null
  })
  assert.deepEqual(await saveBenchmarkExecutorConfig('owner', 'one', 'zsoft-l1', ' /srv/tasks '), { tasksDir: '/srv/tasks' })
  assert.deepEqual(await getBenchmarkExecutorConfig('owner', 'one', 'zsoft-l1'), { tasksDir: '/srv/tasks' })
  assert.equal(await getBenchmarkExecutorConfig('other', 'one', 'zsoft-l1'), null)
  assert.equal(await getBenchmarkExecutorConfig('owner', 'two', 'zsoft-l1'), null)
  assert.equal(await getBenchmarkExecutorConfig('owner', 'one', 'swe-bench'), null)
  await saveBenchmarkExecutorConfig('owner', 'one', 'zsoft-l1', '/srv/new-tasks')
  assert.equal((await getBenchmarkExecutorConfig('owner', 'one', 'zsoft-l1'))?.tasksDir, '/srv/new-tasks')
  await assert.rejects(saveBenchmarkExecutorConfig('other', 'one', 'zsoft-l1', '/srv/tasks'), { code: 'EXECUTOR_NOT_FOUND' })
  await assert.rejects(saveBenchmarkExecutorConfig('owner', 'one', 'swe-bench', '/srv/tasks'), { code: 'BENCHMARK_CONFIG_UNSUPPORTED' })
  for (const value of ['', '~/tasks', 'relative', '/srv/tasks\nother', '/srv/\0tasks']) assert.throws(() => normalizeBenchmarkTasksDir(value))
})

const client = { clientId: 'one', name: 'synthetic', user: 'owner', status: 'online', serviceHealth: 'healthy', lastSeenAt: new Date(), unboundAt: null,
  capabilitiesJson: JSON.stringify({ actions: ['RUN_BENCHMARK_CASE'], platforms: [{ id: 'pi-mcts', agents: ['pi-mcts'], runBenchmarkCase: { returnsTraceId: true } }],
    components: { 'agent-runtime/pi-mcts/v1': { ready: true }, 'zsoft-tasks-workspace/v2': { ready: true }, 'single-file/v1': { ready: true }, 'mcts-zsoft-export/v1': { ready: true } } }) }

test('configuration API accepts the wizard dataset ID and rejects datasets/clients owned by others', async t => {
  mockMethod(t, prisma.benchmarkDataset, 'findFirst', async ({ where }: any) => {
    assert.ok(where.OR.some((item: any) => item.agentEvalDatasetId === 'public-dataset'))
    return where.user.in.includes('owner') ? { adapterKey: 'zsoft-l1' } : null
  })
  mockMethod(t, prisma.reliabilityClient, 'findMany', async () => [client])
  mockMethod(t, prisma.reliabilityClient, 'findFirst', async ({ where }: any) => where.user === 'owner' && where.clientId === 'one' ? client : null)
  mockMethod(t, prisma.reliabilityClientConfig, 'findFirst', async () => ({ overrideJson: '{"tasksDir":"/srv/tasks"}' }))
  const saved = mockMethod(t, prisma.reliabilityClientConfig, 'upsert', async () => ({}))
  const response = await GET(new Request('http://insight.test/api/benchmark/v1/execution-targets?user=owner&datasetId=public-dataset'))
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).items[0].benchmarkConfig, { tasksDir: '/srv/tasks' })
  const put = (user: string, clientId: string) => PUT(new Request('http://insight.test/api/benchmark/v1/execution-targets', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user, clientId, datasetId: 'public-dataset', tasksDir: '/srv/new' }),
  }))
  assert.equal((await put('owner', 'one')).status, 200)
  assert.equal((await put('other', 'one')).status, 404)
  assert.equal((await put('owner', 'other-client')).status, 404)
  assert.equal(saved.mock.callCount(), 1)
})

test('experiment freezes saved directory in run config independently of later edits', async t => {
  let config = '/srv/original'
  mockMethod(t, prisma.benchmarkDataset, 'findFirst', async () => ({ id: 'dataset', adapterKey: 'zsoft-l1', status: 'ready',
    contentHash: 'synthetic', agentEvalDataset: { casesJson: '[]' }, cases: [{ id: 'case', publicPayloadJson: JSON.stringify(publicCase) }] }))
  mockMethod(t, prisma.reliabilityClient, 'findFirst', async () => client)
  mockMethod(t, prisma.reliabilityClientConfig, 'findFirst', async () => ({ overrideJson: JSON.stringify({ tasksDir: config }) }))
  let frozen = ''
  mockMethod(t, prisma, '$transaction', async (callback: any) => callback({
    experiment: { create: async ({ data }: any) => { frozen = data.benchmarkBinding.create.runConfigJson; return { id: 'experiment', status: 'draft' } } },
    experimentCase: { create: async () => ({}) }, benchmarkCaseRun: { create: async () => ({}) },
  }))
  await createBenchmarkExperiment({ user: 'owner', name: 'synthetic', datasetId: 'dataset', clientId: 'one', caseSelection: { mode: 'all' },
    runConfig: { platform: 'pi-mcts', agent: 'pi-mcts' } })
  config = '/srv/changed'
  const task = zsoftL1Adapter.buildAgentTask({ publicPayload: publicCase, runConfig: JSON.parse(frozen), context: { runId: 'synthetic', experimentId: 'experiment', caseId: 'case' } })
  assert.deepEqual(task.workspace, { provider: 'zsoft-tasks', taskId: publicCase.taskId, tasksDir: '/srv/original' })
})
