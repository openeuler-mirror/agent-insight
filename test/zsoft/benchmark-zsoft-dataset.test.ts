import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { loadZsoftCases } from '../../benchmarks/zsoft-l1/dataset'
import { prepareZsoftSource } from '../../benchmarks/zsoft-l1/dataset/prepare'
import { zsoftL1Adapter } from '../../benchmarks/zsoft-l1/adapter'
import { main } from '../../scripts/benchmark/ensure-dataset'

async function temporary(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zsoft-dataset-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

async function fixture(root: string) {
  for (const [id, tags] of [
    ['c-case', ['c']], ['service-case', ['python', 'service']], ['binary-case', []],
    ['sample-example', []], ['kernel-case', ['kernel']], ['linux-rxrpc-case', []],
  ] as const) {
    const directory = path.join(root, 'tasks', id)
    await fs.mkdir(path.join(directory, 'public'), { recursive: true })
    await fs.writeFile(path.join(directory, 'task.json'), JSON.stringify({
      task_id: id, title: '官方格式合成题', description: 'Synthetic metadata; never executed',
      tags, submission: { max_bytes: 128 },
    }))
    await fs.writeFile(path.join(directory, 'public/README.md'), 'Synthetic instructions')
    await fs.writeFile(path.join(directory, 'verify.py'), 'private judge content; never executed')
  }
}

test('offline official package and repository directories yield formal userspace and kernel cases without build state', async (t) => {
  const repository = await temporary(t)
  const root = path.join(repository, 'benchmarks/vulnerability/zsoft-l1')
  await fixture(root)
  assert.equal(await prepareZsoftSource({ source: repository }), repository)
  assert.equal(await prepareZsoftSource({ source: root }), root)
  const cases = await loadZsoftCases(root)
  assert.deepEqual(await loadZsoftCases(repository), cases)
  assert.deepEqual(cases.map(item => item.public.taskId), ['binary-case', 'c-case', 'kernel-case', 'linux-rxrpc-case', 'service-case'])
  assert.deepEqual(cases.map(item => item.public.submissionKind), ['binary', 'c', 'c', 'c', 'python'])
  for (const item of cases) {
    assert.equal(item.private.revision, undefined)
    assert.match(item.private.sourceTaskDigest, /^sha256:[a-f0-9]{64}$/)
    assert.notEqual(item.public.tags.includes('userspace'), item.public.tags.includes('kernel'))
    assert.equal(JSON.stringify(item).includes('private judge content'), false)
    zsoftL1Adapter.validateAndSplitCase(item)
  }
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'tasks/service-case/task.json'), 'utf8'))
  assert.equal(manifest.tags.includes('userspace'), false)
  await fs.writeFile(path.join(root, 'tasks/service-case/verify.py'), 'changed private judge')
  assert.deepEqual(await loadZsoftCases(root), cases)
  await fs.writeFile(path.join(root, 'tasks/service-case/public/README.md'), 'changed public instructions')
  assert.notEqual((await loadZsoftCases(root))[4].private.sourceTaskDigest, cases[4].private.sourceTaskDigest)
})

test('online Git preparation pins a commit, validates cached content, and cleans up failed fetches', async (t) => {
  const root = await temporary(t)
  const repository = path.join(root, 'official')
  await fixture(repository)
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' }
  const git = (args: string[]) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', env })
  git(['init', '--quiet'])
  git(['add', '.'])
  git(['commit', '--quiet', '-m', 'fixture'])
  const revision = git(['rev-parse', 'HEAD']).trim()
  const source = 'https://datasets.example.test/official.git'
  const configEnv = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${repository}.insteadOf`, GIT_CONFIG_VALUE_0: source, GIT_ALLOW_PROTOCOL: 'file' }
  for (const [key, value] of Object.entries(configEnv)) {
    const previous = process.env[key]
    process.env[key] = value
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })
  }
  const cacheRoot = path.join(root, 'cache')
  const cache = await prepareZsoftSource({ source, revision, cacheRoot })
  assert.equal((await loadZsoftCases(cache))[0].private.revision, revision)
  git(['commit', '--allow-empty', '--quiet', '-m', 'new upstream version'])
  assert.equal(await prepareZsoftSource({ source, revision, cacheRoot }), cache)
  assert.equal(execFileSync('git', ['-C', cache, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), revision)
  await fs.rename(repository, `${repository}-unavailable`)
  assert.equal(await prepareZsoftSource({ source, revision, cacheRoot }), cache)
  await assert.rejects(prepareZsoftSource({ source, revision: 'f'.repeat(40), cacheRoot }))
  assert.deepEqual(await fs.readdir(cacheRoot), [path.basename(cache)])
  await fs.writeFile(path.join(cache, 'tasks/c-case/public/README.md'), 'changed cached source')
  await assert.rejects(prepareZsoftSource({ source, revision, cacheRoot }), /缓存与冻结来源不一致/)
  await assert.rejects(prepareZsoftSource({ source, revision: 'moving-branch', cacheRoot }), /40位/)
})

test('official sources reject empty directories and inconsistent metadata; shared CLI rejects invalid arguments', async (t) => {
  const root = await temporary(t)
  await assert.rejects(loadZsoftCases(root), /官方/)
  await fixture(root)
  const manifestPath = path.join(root, 'tasks/c-case/task.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, task_id: 'different-case' }))
  await assert.rejects(loadZsoftCases(root), /元数据不一致/)
  for (const args of [[], ['--benchmark'], ['--benchmark', 'zsoft-l1', '--name'], ['--unknown']]) {
    await assert.rejects(main(args), /用法|缺少参数值|未知参数/)
  }
})
