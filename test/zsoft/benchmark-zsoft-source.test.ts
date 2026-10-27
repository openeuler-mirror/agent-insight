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
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { writeSyntheticZsoftPlugin } from '../fixtures/mcts-zsoft-fixture'

const helper = path.resolve('services/executor/src/mcts-zsoft-source.py')
const bridge = path.resolve('services/executor/src/mcts-zsoft-export.py')
const contract = path.resolve('services/executor/src/mcts-zsoft-contract.py')

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zsoft-source-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const task = path.join(root, 'tasks/synthetic')
  fs.mkdirSync(path.join(task, 'public'), { recursive: true })
  fs.mkdirSync(path.join(task, 'private'))
  fs.mkdirSync(path.join(root, 'source-locks'))
  fs.writeFileSync(path.join(task, 'task.json'), '{"task_id":"synthetic"}')
  fs.writeFileSync(path.join(task, 'public/README.md'), 'Public instructions')
  fs.writeFileSync(path.join(task, 'private/source-manifest.json'), '{"source_id":"synthetic"}')
  fs.writeFileSync(path.join(task, 'private/judge.py'), 'JUDGE_SECRET')
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', AGENT_INSIGHT_ZSOFT_WORKSPACE: root }
  const python = (code: string) => spawnSync('python3', ['-c', `import importlib.util, sys
from pathlib import Path
from types import SimpleNamespace
root = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('source_helper', sys.argv[2])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
${code}`, root, helper], { env, encoding: 'utf8', timeout: 10_000 })
  return { root, task, env, python }
}

test('sandbox bundles contain exactly prepared public bytes and never include host-only controls or judge files', t => {
  const f = fixture(t)
  const result = f.python(`
import io, tarfile
task = SimpleNamespace(tasks_dir=root / 'tasks', task_id='synthetic')
allowed = {'task.json': (root / 'tasks/synthetic/task.json').read_bytes(),
           'TASK.md': b'Public instructions', 'task/README.md': b'Public instructions'}
def bundle(files, extra=None):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as archive:
        for name, data in files:
            item = tarfile.TarInfo(name)
            item.size = len(data)
            archive.addfile(item, io.BytesIO(data))
        if extra is not None:
            archive.addfile(extra)
    return output.getvalue()
safe = list(allowed.items())
module.validate_agent_bundle(bundle(safe), task)
for forbidden in ['task/private/judge.py', 'task/private/source-manifest.json', 'private/source-manifest.json',
                  'source-locks/synthetic.json', 'task/unknown.txt', '../private/judge.py', '/task/judge.py']:
    try:
        module.validate_agent_bundle(bundle(safe + [(forbidden, b'JUDGE_SECRET')]), task)
    except RuntimeError as error:
        assert str(error) == 'ZSOFT_AGENT_BUNDLE_INVALID'
    else:
        raise AssertionError('private or unexpected archive entry accepted')
for entries in [safe + [safe[0]], safe[:-1], [(name, b'Private information' if name == 'task/README.md' else data) for name, data in safe]]:
    try:
        module.validate_agent_bundle(bundle(entries), task)
    except RuntimeError:
        pass
    else:
        raise AssertionError('duplicate, missing or substituted file accepted')
for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE]:
    item = tarfile.TarInfo('task/README.md')
    item.type, item.linkname = kind, '../private/judge.py'
    try:
        module.validate_agent_bundle(bundle(safe[:-1], item), task)
    except RuntimeError:
        pass
    else:
        raise AssertionError('unsafe file type accepted')
`)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.includes('JUDGE_SECRET'), false)
  assert.equal(result.stderr.includes('JUDGE_SECRET'), false)
})

test('archive downloads verify an available checksum before extracting and reject checksum mismatches', t => {
  const f = fixture(t)
  const archive = path.join(f.root, 'source.tar.gz')
  const create = f.python(`
import io, tarfile
with tarfile.open(root / 'source.tar.gz', 'w:gz') as output:
    item = tarfile.TarInfo('source/code.c')
    content = b'public vulnerable source only'
    item.size = len(content)
    output.addfile(item, io.BytesIO(content))
`)
  assert.equal(create.status, 0, create.stderr)
  const bin = path.join(f.root, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'curl'), `#!${process.execPath}
require('node:fs').copyFileSync(process.env.SOURCE_ARCHIVE_FIXTURE, process.argv[process.argv.indexOf('-o') + 1]);
`, { mode: 0o755 })
  const expected = createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
  for (const checksum of [expected, '0'.repeat(64)]) {
    const metadata = { source_id: 'synthetic', kind: 'archive', url: 'https://downloads.example.test/source.tar.gz', sha256: checksum }
    fs.writeFileSync(path.join(f.root, 'source-locks/synthetic.json'), JSON.stringify(metadata))
    const script = f.python(`print(module.download_script(SimpleNamespace(source_id='synthetic', kind='archive', url='${metadata.url}', commit=None)))`)
    assert.equal(script.status, 0, script.stderr)
    assert.ok(script.stdout.indexOf('sha256sum -c -') < script.stdout.indexOf('tar --'))
    const sandbox = path.join(f.root, `sandbox-${checksum}`)
    fs.mkdirSync(sandbox)
    const run = spawnSync('bash', ['-euo', 'pipefail', '-c', script.stdout], { cwd: sandbox, encoding: 'utf8', timeout: 10_000,
      env: { ...f.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, SOURCE_ARCHIVE_FIXTURE: archive } })
    if (checksum === expected) {
      assert.equal(run.status, 0, run.stderr)
      assert.equal(fs.readFileSync(path.join(sandbox, 'repo/code.c'), 'utf8'), 'public vulnerable source only')
      assert.equal(fs.existsSync(path.join(sandbox, 'repo.dl')), false)
    } else {
      assert.notEqual(run.status, 0)
      assert.equal(fs.existsSync(path.join(sandbox, 'repo')), false)
    }
  }
})

test('Git snapshots fetch only the pinned commit without using a host source cache', t => {
  const f = fixture(t)
  const repository = path.join(f.root, 'upstream')
  fs.mkdirSync(repository)
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '--quiet')
  fs.writeFileSync(path.join(repository, 'source.c'), 'vulnerable version')
  git('add', '.')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'pinned')
  const commit = git('rev-parse', 'HEAD')
  fs.writeFileSync(path.join(repository, 'source.c'), 'newer version')
  git('add', '.')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'later')
  const url = 'https://sources.example.test/project.git'
  fs.writeFileSync(path.join(f.root, 'source-locks/synthetic.json'), JSON.stringify({ source_id: 'synthetic', kind: 'git_snapshot', url, commit }))
  const script = f.python(`print(module.download_script(SimpleNamespace(source_id='synthetic', kind='git_snapshot', url='${url}', commit='${commit}')))`)
  assert.equal(script.status, 0, script.stderr)
  const sandbox = path.join(f.root, 'sandbox')
  fs.mkdirSync(sandbox)
  const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script.stdout], { cwd: sandbox, encoding: 'utf8', timeout: 10_000,
    env: { ...f.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${repository}.insteadOf`, GIT_CONFIG_VALUE_0: url, GIT_ALLOW_PROTOCOL: 'file' } })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.readFileSync(path.join(sandbox, 'repo/source.c'), 'utf8'), 'vulnerable version')
})

test('the actual MCTS bridge guards bundle bytes before upload and installs the locked source downloader', t => {
  const f = fixture(t)
  const repository = path.join(f.root, 'MCTS')
  writeSyntheticZsoftPlugin(repository, `from types import SimpleNamespace
from pathlib import Path
import os
from testcases_union.res.task_plugins.zsoft import materializer
task = ZSoftTask()
task.tasks_dir = Path(os.environ['AGENT_INSIGHT_ZSOFT_WORKSPACE']) / 'tasks'
task.task_id = 'synthetic'
task.bundle = SimpleNamespace(tar_path=Path(os.environ['TEST_BUNDLE']))
task.bundle_bytes()
lock = SimpleNamespace(source_id='synthetic', kind='archive', url='https://sources.example.test/${'a'.repeat(40)}.tar.gz', commit=None)
assert 'sha256sum -c -' in materializer._download_script(lock)
Path(os.environ['TEST_UPLOAD_MARKER']).write_text('safe to upload')`)
  fs.writeFileSync(path.join(f.root, 'source-locks/synthetic.json'), JSON.stringify({ source_id: 'synthetic', kind: 'archive',
    url: `https://sources.example.test/${'a'.repeat(40)}.tar.gz`, sha256: 'b'.repeat(64) }))
  const check = spawnSync('python3', [contract, repository], { encoding: 'utf8', env: f.env, timeout: 10_000 })
  assert.equal(check.status, 0, check.stderr)
  const fingerprint = JSON.parse(check.stdout).sourceDigest
  for (const unsafe of [false, true]) {
    const created = f.python(`
import io, tarfile
with tarfile.open(root / 'bundle.tar.gz', 'w:gz') as archive:
    entries = {'task.json': (root / 'tasks/synthetic/task.json').read_bytes(), 'TASK.md': b'Public instructions', 'task/README.md': b'Public instructions'}
    if ${unsafe ? 'True' : 'False'}:
        entries['task/private/source-manifest.json'] = b'JUDGE_SECRET'
    for name, content in entries.items():
        item = tarfile.TarInfo(name)
        item.size = len(content)
        archive.addfile(item, io.BytesIO(content))
`)
    assert.equal(created.status, 0, created.stderr)
    const marker = path.join(f.root, `uploaded-${unsafe}`)
    const run = spawnSync('python3', [bridge], { encoding: 'utf8', timeout: 10_000, env: { ...f.env,
      AGENT_INSIGHT_MCTS_REPO_DIR: repository, AGENT_INSIGHT_ZSOFT_CONTRACT_DIGEST: fingerprint,
      AGENT_INSIGHT_ZSOFT_SUBMISSION_KIND: 'python', TEST_BUNDLE: path.join(f.root, 'bundle.tar.gz'), TEST_UPLOAD_MARKER: marker } })
    if (unsafe) {
      assert.notEqual(run.status, 0)
      assert.match(run.stderr, /ZSOFT_AGENT_BUNDLE_INVALID/)
      assert.equal(fs.existsSync(marker), false)
    } else {
      assert.equal(run.status, 0, run.stderr)
      assert.equal(fs.existsSync(marker), true)
    }
    assert.equal(run.stderr.includes('JUDGE_SECRET'), false)
  }
})
