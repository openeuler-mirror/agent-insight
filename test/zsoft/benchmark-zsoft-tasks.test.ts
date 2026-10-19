import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { zsoftL1Adapter } from '../../benchmarks/zsoft-l1/adapter'

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
  fs.mkdirSync(path.join(root, 'testcases_union'), { recursive: true })
  fs.writeFileSync(path.join(root, 'testcases_union', 'config.env'), `ZSOFT_TASKS_DIR=${JSON.stringify(tasksDir)}\n`)
  const provider = new ZsoftTasksWorkspaceProvider(path.join(root, 'workspaces'), { mctsRepoDir: root })
  const spec = { provider: 'zsoft-tasks', taskId: publicCase.taskId }
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
  await assert.rejects(f.provider.prepare({ ...f.spec, taskId: undefined }, f.context), { code: 'ZSOFT_TASKS_DIR_INVALID' })
  await assert.rejects(f.provider.prepare({ ...f.spec, tasksDir: f.tasksDir }, f.context), { code: 'ZSOFT_TASKS_DIR_INVALID' })
  fs.symlinkSync(path.join(f.taskRoot, 'private', 'judge.py'), path.join(f.taskRoot, 'public', 'linked.py'))
  await assert.rejects(f.provider.prepare(f.spec, f.context), /符号链接/)
  assert.equal(fs.existsSync(path.join(f.root, 'workspaces', f.runId)), false)
})

test('native tasks require an absolute ZSOFT_TASKS_DIR in the executor MCTS config.env', async t => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(f.root, 'testcases_union', 'config.env'), 'ZSOFT_TASKS_DIR=relative/tasks\n')
  await assert.rejects(f.provider.prepare(f.spec, f.context), { code: 'ZSOFT_TASKS_DIR_INVALID' })
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
    runConfig: { platform: 'synthetic', agent: 'synthetic', timeoutSeconds: 60 },
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
