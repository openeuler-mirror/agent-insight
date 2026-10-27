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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { prepareExecutionWorkspace } = require('../services/executor/src/execution-workspace.cjs')
const { XGovernorExecutionBackend } = require('../services/executor/src/xgovernor/backend.cjs')
const { GitPatchCollector, atomicWriteJson } = require('../services/executor/src/index.cjs')
const contract = { name: 'model.patch', mediaType: 'text/x-diff', collector: 'git-patch/v1', maxBytes: 1024 * 1024 }

function fixture(t: TestContext, platform = 'pi-agent') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xgov-swe-git-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  const commands: string[][] = []
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: {
      ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
      GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    } })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '-q')
  fs.writeFileSync(path.join(repo, 'source.py'), 'value = "original"\n')
  fs.writeFileSync(path.join(repo, 'setup.cfg'), '[setup]\nvalue = original\n')
  git('add', '.')
  git('commit', '-qm', 'Dataset base')
  const revision = git('rev-parse', 'HEAD')
  fs.writeFileSync(path.join(repo, 'setup.cfg'), '[setup]\nvalue = image-installation\n')
  git('commit', '-qam', 'SWE-bench')
  const imageHead = git('rev-parse', 'HEAD')
  const backend = new XGovernorExecutionBackend({
    baseDir: root, config: { profiles: {} }, atomicWriteJson, GitPatchCollector,
    async fetchImpl(url: string, options: { body: string }) {
      assert.ok(url.endsWith('/sessions/exec'))
      const { command, cwd } = JSON.parse(options.body)
      assert.equal(cwd, '/testbed')
      assert.equal(command[0], 'git')
      commands.push(command)
      const result = spawnSync(command[0], command.slice(1), { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull } })
      return Response.json({ exit_code: result.status, stdout: result.stdout, stderr: result.stderr, timed_out: false })
    },
  })
  const directory = path.join(root, 'xgovernor-runs', 'run_fixture')
  fs.mkdirSync(directory)
  fs.writeFileSync(path.join(directory, 'admin.auth'), 'private-test-token')
  const handle = { backendKey: 'xgovernor', runId: 'run_fixture', opaque: { directory, platform, runtimeId: 'runtime_fixture', adminPort: 1, workspaceRoot: '/testbed' } as any }
  const task = { benchmark: { key: 'swe-bench' }, workspace: { revision, repository: 'https://github.com/example/project.git' } }
  const prepare = async () => {
    Object.assign(handle.opaque, await prepareExecutionWorkspace(task, {
      exec: (command: string[], operation: string) => backend.exec(handle, command, undefined, undefined, operation),
    }))
    await atomicWriteJson(path.join(directory, 'lease.json'), handle.opaque)
    return { ...handle, opaque: JSON.parse(fs.readFileSync(path.join(directory, 'lease.json'), 'utf8')) }
  }
  return { root, repo, git, imageHead, revision, task, handle, backend, commands, prepare }
}

for (const platform of ['pi-agent', 'xiaoo']) {
  test(`${platform}: retain image setup without origin and collect committed, unstaged, new and deleted files from the persisted image baseline`, async t => {
    const f = fixture(t, platform)
    assert.equal(f.git('remote'), '')
    const handle = await f.prepare()
    assert.equal(handle.opaque.baseCommit, f.imageHead)
    assert.equal(handle.opaque.datasetRevision, f.revision)
    assert.equal(f.task.workspace.revision, f.revision)
    assert.equal(f.git('rev-parse', 'HEAD'), f.imageHead)
    assert.ok(fs.readFileSync(path.join(f.repo, 'setup.cfg'), 'utf8').includes('image-installation'))
    assert.ok(f.commands.every(command => !['remote', 'reset', 'clean'].includes(command[1])))

    fs.writeFileSync(path.join(f.repo, 'source.py'), 'value = "committed-fix"\n')
    f.git('commit', '-qam', 'Agent commit')
    fs.writeFileSync(path.join(f.repo, 'new.py'), 'added = True\n')
    fs.writeFileSync(path.join(f.repo, 'source.py'), 'value = "final-fix"\n')
    fs.unlinkSync(path.join(f.repo, 'setup.cfg'))
    fs.writeFileSync(path.join(f.repo, 'model.patch'), 'must not include the patch itself')
    f.git('add', 'model.patch')

    const artifact = await f.backend.collect(handle, contract, {})
    const patch = artifact.bytes.toString()
    assert.ok(patch.includes('+value = "final-fix"'))
    assert.ok(patch.includes('new file mode'))
    assert.ok(patch.includes('+added = True'))
    assert.ok(patch.includes('deleted file mode'))
    assert.ok(patch.includes('-value = image-installation'))
    assert.equal(patch.includes('committed-fix'), false)
    assert.equal(patch.includes('a/model.patch'), false)
    assert.equal(patch.includes('+value = image-installation'), false)

    const cleanRepo = path.join(f.root, 'evaluator-repo')
    const cloned = spawnSync('git', ['clone', '-q', '--no-hardlinks', f.repo, cleanRepo], { encoding: 'utf8' })
    assert.equal(cloned.status, 0, cloned.stderr)
    assert.equal(spawnSync('git', ['checkout', '-q', f.imageHead], { cwd: cleanRepo }).status, 0)
    const applied = spawnSync('git', ['apply', '--check', '-'], { cwd: cleanRepo, input: artifact.bytes, encoding: 'utf8' })
    assert.equal(applied.status, 0, applied.stderr)
    assert.equal(spawnSync('git', ['apply', '-'], { cwd: cleanRepo, input: artifact.bytes }).status, 0)
    assert.equal(fs.readFileSync(path.join(cleanRepo, 'source.py'), 'utf8'), 'value = "final-fix"\n')
    assert.equal(fs.readFileSync(path.join(cleanRepo, 'new.py'), 'utf8'), 'added = True\n')
    assert.equal(fs.existsSync(path.join(cleanRepo, 'setup.cfg')), false)
  })
}

test('image installation changes alone are not a submission', async t => {
  const f = fixture(t)
  const handle = await f.prepare()
  fs.writeFileSync(path.join(f.repo, 'model.patch'), 'artifact must be excluded')
  await assert.rejects(f.backend.collect(handle, contract, {}), (cause: any) => cause.code === 'AGENT_NO_OUTPUT')
  assert.ok(fs.readFileSync(path.join(f.repo, 'setup.cfg'), 'utf8').includes('image-installation'))
})

test('missing dataset commit and unrelated history fail before the Agent without resetting the repository', async t => {
  const f = fixture(t)
  f.task.workspace.revision = 'f'.repeat(40)
  await assert.rejects(f.prepare(), (cause: any) => cause.runFacts.sandboxDiagnostic.reason === 'GIT_REVISION_MISSING')
  f.git('checkout', '--orphan', 'unrelated')
  f.git('add', '.')
  f.git('commit', '-qm', 'Unrelated image')
  const unrelated = f.git('rev-parse', 'HEAD')
  f.task.workspace.revision = f.revision
  await assert.rejects(f.prepare(), (cause: any) => cause.runFacts.sandboxDiagnostic.reason === 'GIT_BASELINE_UNRELATED')
  assert.equal(f.git('rev-parse', 'HEAD'), unrelated)
  assert.ok(f.commands.every(command => !['reset', 'clean', 'remote'].includes(command[1])))
})

test('dirty initial image is rejected without deleting its files or reporting their contents', async t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.repo, 'private-token.txt'), 'private-value')
  await assert.rejects(f.prepare(), (cause: any) => cause.code === 'WORKSPACE_REVISION_MISMATCH' && !cause.message.includes('private-token'))
  assert.equal(fs.readFileSync(path.join(f.repo, 'private-token.txt'), 'utf8'), 'private-value')
})

test('collect refuses a missing persisted baseline instead of substituting the Agent HEAD', async t => {
  const f = fixture(t)
  await assert.rejects(f.backend.collect(f.handle, contract, {}), (cause: any) => cause.code === 'WORKSPACE_REVISION_MISMATCH')
  assert.equal(f.commands.length, 0)
})
