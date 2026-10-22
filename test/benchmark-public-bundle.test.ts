import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { writeSyntheticZsoftPlugin } from './fixtures/mcts-zsoft-fixture'

const require = createRequire(import.meta.url)
const { PublicBundleWorkspaceProvider, SingleFileCollector, canonical, digest } = require('../services/executor/src/public-bundle.cjs')
const { BenchmarkExecutionRunner, WorkspaceProviderRegistry, AgentRuntimeRegistry, ArtifactCollectorRegistry, FileRunStore, LocalPolicyEnforcer, WorkspaceCleanupManager, BenchmarkExecutorError } = require('../services/executor/src/index.cjs')

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-public-bundle-'))
  const taskId = 'synthetic-only'
  const files = { [`tasks/${taskId}/task.json`]: Buffer.from('{}'), [`tasks/${taskId}/public/README.md`]: Buffer.from('Synthetic fixture; no runnable content') }
  const lock = { schemaVersion: 'public-bundle/v1', taskId, files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, { sha256: digest(bytes), sizeBytes: bytes.length, executable: false }])) }
  const hash = digest(canonical(lock))
  const bundleDir = path.join(root, 'bundles')
  const bundle = path.join(bundleDir, hash.slice(7))
  fs.mkdirSync(bundle, { recursive: true })
  for (const [name, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(bundle, name)), { recursive: true })
    fs.writeFileSync(path.join(bundle, name), bytes)
  }
  fs.writeFileSync(path.join(bundle, 'bundle.json'), canonical(lock))
  const runId = `erun_${'d'.repeat(32)}`
  return { root, bundle, files, runId, spec: { provider: 'public-bundle', taskId, digest: hash }, provider: new PublicBundleWorkspaceProvider(path.join(root, 'workspaces'), bundleDir), close: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test('public bundles reject missing, changed, extra and symlinked assets and clean failed workspaces', async () => {
  for (const failure of ['missing', 'changed', 'extra', 'symlink']) {
    const f = fixture()
    try {
      const target = path.join(f.bundle, Object.keys(f.files)[1])
      if (failure === 'changed') fs.writeFileSync(target, 'Changed')
      if (failure === 'extra') fs.writeFileSync(path.join(f.bundle, 'private.json'), '{}')
      if (failure === 'symlink') { fs.renameSync(target, `${target}.original`); fs.symlinkSync(`${target}.original`, target) }
      if (failure === 'missing') f.spec.digest = `sha256:${'e'.repeat(64)}`
      await assert.rejects(f.provider.prepare(f.spec, { runId: f.runId }), /任务包|指纹|符号链接/)
      assert.equal(fs.existsSync(path.join(f.root, 'workspaces', f.runId)), false)
    } finally { f.close() }
  }
})

test('single-file collector rejects missing, oversized and symlinked submissions without executing bytes', async () => {
  const f = fixture()
  try {
    const workspace = await f.provider.prepare(f.spec, { runId: f.runId })
    const collector = new SingleFileCollector()
    const contract = { name: 'poc', mediaType: 'application/octet-stream', maxBytes: 4 }
    await assert.rejects(collector.collect(contract, { workspace }), /未生成/)
    fs.writeFileSync(path.join(workspace.path, 'submission/poc'), Buffer.alloc(5))
    await assert.rejects(collector.collect(contract, { workspace }), /大小/)
    fs.renameSync(path.join(workspace.path, 'submission/poc'), path.join(workspace.path, 'submission/original'))
    fs.symlinkSync(path.join(workspace.path, 'submission/original'), path.join(workspace.path, 'submission/poc'))
    await assert.rejects(collector.collect(contract, { workspace }), /符号链接/)
  } finally { f.close() }
})

test('public-bundle execution saves synthetic bytes before cleanup and retries upload without rerunning Agent', async () => {
  const f = fixture()
  const bytes = Buffer.from([0, 255, 13, 10, 128])
  const completions: Array<{ status: string; runFacts: { traceId: string } }> = []
  let calls = 0
  let uploads = 0
  try {
    const store = new FileRunStore(path.join(f.root, 'runs'))
    const runner = new BenchmarkExecutionRunner({ store,
      workspaceProviders: new WorkspaceProviderRegistry([['public-bundle', f.provider]]),
      agentRuntimes: new AgentRuntimeRegistry([['synthetic', { run: async ({ cwd }: { cwd: string }) => {
        calls++
        fs.writeFileSync(path.join(cwd, 'submission/poc'), bytes)
        return { traceId: 'synthetic-trace', exitCode: 0 }
      } }]]),
      collectors: new ArtifactCollectorRegistry([['single-file/v1', new SingleFileCollector()]]),
      policyEnforcer: new LocalPolicyEnforcer(), cleanupManager: new WorkspaceCleanupManager(),
      callback: { progress: async () => {}, uploadArtifact: async (_request: unknown, artifact: { bytes: Buffer }) => {
        assert.deepEqual(artifact.bytes, bytes)
        if (++uploads === 1) throw new BenchmarkExecutorError('CALLBACK_UNAVAILABLE', 'synthetic retry', 503, true)
        return { artifactId: 'synthetic-artifact' }
      }, complete: async (_request: unknown, completion: unknown) => { completions.push(completion as { status: string; runFacts: { traceId: string } }) } },
    })
    const request = { runId: f.runId, timeoutSeconds: 60, task: { workspace: f.spec, benchmark: { key: 'zsoft-l1' },
      context: { runId: f.runId, experimentId: 'synthetic', caseId: 'synthetic' }, policy: { workspaceWrite: 'allow', hiddenDataAccess: 'deny', network: 'client-default' },
      agentConfig: { platform: 'synthetic', agent: 'synthetic', timeoutSeconds: 60 }, task: { instruction: 'Synthetic only', benchmarkPayload: {} },
      submission: { requiredArtifacts: [{ name: 'poc', mediaType: 'application/octet-stream', collector: 'single-file/v1', maxBytes: 128 }] } } }
    await runner.execute(request)
    const state = await store.state(f.runId)
    assert.equal(state.stage, 'upload_pending')
    assert.equal(fs.existsSync(path.join(f.root, 'workspaces', f.runId)), false)
    await runner.resume(request, state)
    assert.equal(calls, 1)
    assert.equal(uploads, 2)
    assert.equal(completions[0].status, 'succeeded')
    assert.equal(completions[0].runFacts.traceId, 'synthetic-trace')
    assert.equal((await store.state(f.runId)).stage, 'terminal')
  } finally { f.close() }
})

test('MCTS Python bridge adapts each submission kind and exports raw bytes without native judging', () => {
  for (const kind of ['python', 'c', 'binary']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-mcts-bridge-'))
    try {
      writeSyntheticZsoftPlugin(root, `
import os
from pathlib import Path
from types import SimpleNamespace
from testcases_union.res.task_plugins.zsoft import bundle, official, plugin
from testcases_union.res.mode import OFFICIALS, ARTIFACT_READERS
_setup_task('zsoft', {})
kind = os.environ['AGENT_INSIGHT_ZSOFT_SUBMISSION_KIND']
expected = {'python':'poc.py', 'c':'poc.c', 'binary':'poc'}[kind]
assert bundle.poc_filename_for({}) == expected
assert _task.poc_filename == expected
for message in [_task.init_solver(), _task.step_solver({}), _task.init_author(), _task.step_author({})]:
    assert 'submission_kind=' + kind in message
    if kind != 'python': assert 'Run python3 /input/poc' not in message
assert _task.issue_text() in _task.init_solver()
for role in _spec.prompts():
    prompt = Path(os.environ['XIAOO_PROMPT_' + role.upper()]).read_text()
    assert 'submission_kind=' + kind in prompt
    if kind != 'python': assert 'python3 /input/poc' not in prompt
assert plugin.evaluate is official.evaluate is OFFICIALS['zsoft_official']
for hook in [official._local, official._post]:
    try: hook()
    except RuntimeError as e: assert str(e) == 'official judging is owned by Agent Insight'
    else: raise AssertionError('judge not blocked')
_task.tasks_dir = Path(os.environ['AGENT_INSIGHT_ZSOFT_WORKSPACE']) / 'tasks'
_task.task_id = 'synthetic'
node = SimpleNamespace(session=object())
if kind == 'binary':
    name, review = ARTIFACT_READERS['poc_file'](node, _task, session=node.session)
    assert name == 'poc' and 'sha256=' in review and 'raw' not in review
result, target = official.evaluate(node, _task, os.environ['SYNTHETIC_OUTPUT'])
assert result is False
`.trim())
      fs.mkdirSync(path.join(root, 'tasks/synthetic'), { recursive: true })
      fs.writeFileSync(path.join(root, 'tasks/synthetic/task.json'), JSON.stringify({ task_id: 'synthetic', max_bytes: 128, submission_kind: kind }))
      const output = path.join(root, 'output')
      const probe = spawnSync('python3', [path.resolve('services/executor/src/mcts-zsoft-contract.py'), root], { encoding: 'utf8' })
      assert.equal(probe.status, 0, probe.stderr)
      const contract = JSON.parse(probe.stdout)
      const result = spawnSync('python3', [path.resolve('services/executor/src/mcts-zsoft-export.py')], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', AGENT_INSIGHT_MCTS_REPO_DIR: root, AGENT_INSIGHT_ZSOFT_WORKSPACE: root, AGENT_INSIGHT_ZSOFT_SUBMISSION_KIND: kind, AGENT_INSIGHT_ZSOFT_CONTRACT_DIGEST: contract.sourceDigest, SYNTHETIC_OUTPUT: output } })
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(fs.readFileSync(path.join(output, 'poc')), Buffer.from([0, 255, 13, 10, 128]))
      const metadata = JSON.parse(fs.readFileSync(path.join(output, 'platform-export.json'), 'utf8'))
      assert.equal(metadata.submissionKind, kind)
      assert.deepEqual(metadata.mctsContract, contract)
      assert.equal(fs.existsSync(path.join(output, 'official_result.json')), false)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }
})

test('MCTS bridge rejects source changes before imports and rejects mismatched task contracts before export', () => {
  for (const mutation of ['source', 'task-id', 'submission-kind']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-mcts-contract-'))
    try {
      writeSyntheticZsoftPlugin(root, `
import os
from pathlib import Path
from types import SimpleNamespace
from testcases_union.res.task_plugins.zsoft import official
_setup_task('zsoft', {})
_task.tasks_dir = Path(os.environ['AGENT_INSIGHT_ZSOFT_WORKSPACE']) / 'tasks'
_task.task_id = 'synthetic'
official.evaluate(SimpleNamespace(session=object()), _task, os.environ['SYNTHETIC_OUTPUT'])
`.trim())
      fs.mkdirSync(path.join(root, 'tasks/synthetic'), { recursive: true })
      fs.writeFileSync(path.join(root, 'tasks/synthetic/task.json'), JSON.stringify({ task_id: mutation === 'task-id' ? 'other' : 'synthetic', submission_kind: mutation === 'submission-kind' ? 'c' : 'python', max_bytes: 128 }))
      const probe = spawnSync('python3', [path.resolve('services/executor/src/mcts-zsoft-contract.py'), root], { encoding: 'utf8' })
      assert.equal(probe.status, 0, probe.stderr)
      if (mutation === 'source') fs.appendFileSync(path.join(root, 'testcases_union/res/task_plugins/zsoft/plugin.py'), '\nraise RuntimeError("unexpected upstream import")\n')
      const output = path.join(root, 'output')
      const result = spawnSync('python3', [path.resolve('services/executor/src/mcts-zsoft-export.py')], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', AGENT_INSIGHT_MCTS_REPO_DIR: root, AGENT_INSIGHT_ZSOFT_WORKSPACE: root, AGENT_INSIGHT_ZSOFT_SUBMISSION_KIND: 'python', AGENT_INSIGHT_ZSOFT_CONTRACT_DIGEST: JSON.parse(probe.stdout).sourceDigest, SYNTHETIC_OUTPUT: output } })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, mutation === 'source' ? /MCTS source changed/ : /selected task differs/)
      assert.doesNotMatch(result.stderr, /unexpected upstream import/)
      assert.equal(fs.existsSync(output), false)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }
})
