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
  fs.mkdirSync(path.join(taskRoot, 'public', 'repo-vul'))
  fs.writeFileSync(path.join(taskRoot, 'public', 'repo-vul', 'source.c'), 'Synthetic vulnerable source; never executed')
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

function sourceFixture() {
  const f = fixture()
  fs.rmSync(path.join(f.taskRoot, 'public/repo-vul'), { recursive: true })
  const sourceId = `civetweb-${'a'.repeat(40)}`
  const manifestPath = path.join(f.taskRoot, 'private/source-manifest.json')
  const locksDir = path.join(f.root, 'source-locks')
  const lockPath = path.join(locksDir, `${sourceId}.json`)
  const lock = { source_id: sourceId, kind: 'archive', url: `https://github.com/civetweb/civetweb/archive/${'a'.repeat(40)}.tar.gz` }
  fs.mkdirSync(locksDir)
  fs.writeFileSync(manifestPath, JSON.stringify({ source_id: sourceId, judge_secret: 'never-copy-this-secret', target_image_tag: 'private-tag' }))
  fs.writeFileSync(lockPath, JSON.stringify({ ...lock, reference_poc: 'never-copy-this-secret', unknown: { private: true } }))
  return { ...f, sourceId, manifestPath, lockPath, lock }
}

test('source handoff reconstructs host-only allowlisted metadata without copying private files or changing the source', async t => {
  const f = sourceFixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const original = fs.readFileSync(f.manifestPath, 'utf8')
  const prepared = await f.provider.prepare(f.spec, f.context)
  const task = path.join(prepared.path, 'tasks', publicCase.taskId)
  const privateDir = path.join(task, 'private')
  assert.deepEqual(fs.readdirSync(privateDir), ['source-manifest.json'])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(privateDir, 'source-manifest.json'), 'utf8')), { source_id: f.sourceId })
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(prepared.path, 'source-locks', `${f.sourceId}.json`), 'utf8')), f.lock)
  assert.equal(fs.statSync(privateDir).mode & 0o777, 0o700)
  assert.equal(fs.statSync(path.join(privateDir, 'source-manifest.json')).mode & 0o777, 0o600)
  assert.equal(fs.readFileSync(path.join(task, 'task.json'), 'utf8').includes('private-marker'), false)
  assert.equal(fs.readFileSync(f.manifestPath, 'utf8'), original)
  assert.deepEqual(fs.readdirSync(path.join(task, 'public')).sort(), ['README.md', 'helper.sh'])
})

test('source handoff accepts a fixed Git commit or archive checksum and drops mutable refs', async t => {
  const f = sourceFixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  for (const [index, input, expected] of [
    [1, { ...f.lock, kind: 'git_snapshot', url: 'https://github.com/example/project.git', commit: 'b'.repeat(40), ref: 'main' },
      { ...f.lock, kind: 'git_snapshot', url: 'https://github.com/example/project.git', commit: 'b'.repeat(40) }],
    [2, { ...f.lock, url: 'https://downloads.example.test/release.tar.gz', sha256: `sha256:${'c'.repeat(64)}` },
      { ...f.lock, url: 'https://downloads.example.test/release.tar.gz', sha256: 'c'.repeat(64) }],
  ] as const) {
    fs.writeFileSync(f.lockPath, JSON.stringify(input))
    const prepared = await f.provider.prepare(f.spec, { ...f.context, runId: `erun_${String(index).repeat(32)}` })
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(prepared.path, 'source-locks', `${f.sourceId}.json`), 'utf8')), expected)
  }
})

test('missing or unsafe source metadata fails before creating workspaces and never echoes private values', async t => {
  const f = sourceFixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const badLocks = [
    { ...f.lock, source_id: 'different' },
    { ...f.lock, url: 'file:///private-marker' },
    { ...f.lock, url: 'https://user:private-marker@example.test/source.tar.gz' },
    { ...f.lock, url: 'https://example.test/$(touch-private-marker).tar.gz' },
    { ...f.lock, url: 'https://example.test/source.tar.gz?token=private-marker' },
    { ...f.lock, url: 'https://example.test/source.tar.gz#private-marker' },
    { ...f.lock, url: 'http://127.0.0.1/private-marker' },
    { ...f.lock, url: 'http://metadata.internal/private-marker' },
    { ...f.lock, url: 'http://metadata.internal./private-marker' },
    { ...f.lock, url: 'https://example.test/main.tar.gz' },
    { ...f.lock, kind: 'git_snapshot', ref: 'main' },
    { ...f.lock, commit: 'main' },
    { ...f.lock, sha256: 'private-marker' },
    { ...f.lock, kind: 'private-marker' },
    null,
  ]
  for (const input of badLocks) {
    fs.writeFileSync(f.lockPath, JSON.stringify(input))
    await assert.rejects(f.provider.prepare(f.spec, f.context), (error: { code: string; message: string }) => {
      assert.equal(error.code, 'ZSOFT_SOURCE_INVALID')
      assert.equal(error.message.includes('private-marker'), false)
      return true
    })
    assert.equal(fs.existsSync(path.join(f.root, 'workspaces', f.runId)), false)
  }
  for (const sourceId of ['../private-marker', '$(private-marker)', null]) {
    fs.writeFileSync(f.manifestPath, JSON.stringify({ source_id: sourceId }))
    await assert.rejects(f.provider.prepare(f.spec, f.context), { code: 'ZSOFT_SOURCE_INVALID' })
  }
  fs.rmSync(f.manifestPath)
  await assert.rejects(f.provider.prepare(f.spec, f.context), { code: 'ZSOFT_SOURCE_MISSING' })
  assert.equal(fs.existsSync(path.join(f.root, 'workspaces', f.runId)), false)
})

test('source handoff rejects linked manifests and locks instead of reading arbitrary private files', async t => {
  const f = sourceFixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  fs.renameSync(f.lockPath, `${f.lockPath}.original`)
  fs.symlinkSync(`${f.lockPath}.original`, f.lockPath)
  await assert.rejects(f.provider.prepare(f.spec, f.context), { code: 'ZSOFT_SOURCE_INVALID' })
  fs.rmSync(f.lockPath)
  fs.renameSync(`${f.lockPath}.original`, f.lockPath)
  fs.renameSync(f.manifestPath, `${f.manifestPath}.original`)
  fs.symlinkSync(`${f.manifestPath}.original`, f.manifestPath)
  await assert.rejects(f.provider.prepare(f.spec, f.context), { code: 'ZSOFT_SOURCE_INVALID' })
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
  const completions: { status: string; runFacts: { traceId: string } }[] = []
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
    }, complete: async (_: unknown, completion: typeof completions[number]) => completions.push(completion) },
  })
  await runner.execute({ runId: f.runId, timeoutSeconds: 60, task })
  assert.equal(uploaded[0].toString(), 'Synthetic bytes; never executed')
  assert.equal(completions[0].status, 'succeeded')
  assert.equal(completions[0].runFacts.traceId, 'synthetic-trace')
  assert.equal(fs.existsSync(path.join(f.root, 'workspaces', f.runId)), false)
  assert.equal(fs.existsSync(f.taskRoot), true)
})
