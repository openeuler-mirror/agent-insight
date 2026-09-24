import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const { GitWorkspaceProvider, GitPatchCollector, createBenchmarkExecutor, runProcess } = require('../services/executor/src/index.cjs')
const { SweBenchGitSourcePolicy, MIRRORS } = require('../services/executor/src/benchmarks/swe-bench.cjs')
const { readLocalSetting } = require('../services/executor/src/git-source.cjs')
const repository = 'https://github.com/pallets/flask.git'

test('default executor registers only the SWE-bench policy with the explicit client home', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swe-git-composition-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const executor = createBenchmarkExecutor({
    clientId: 'test', deviceCredential: 'test', insightBaseUrl: 'http://localhost',
    baseDir: path.join(root, 'client'), agentInsightHome: root, runAgent: async () => ({}),
  })
  t.after(() => executor.close())
  const policies = executor.runner.workspaceProviders.get('git').sourcePolicies
  assert.deepEqual([...policies.keys()], ['swe-bench'])
  assert.ok(policies.get('swe-bench') instanceof SweBenchGitSourcePolicy)
  assert.equal(policies.get('swe-bench').home, root)
})

async function fixture(t: any, source: string | undefined = undefined) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swe-git-source-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const upstream = path.join(root, 'upstream')
  await fs.mkdir(upstream)
  const git = async (cwd: string, args: string[]) => (await runProcess('git', args, { cwd })).stdout.trim()
  await git(upstream, ['init', '--quiet'])
  await fs.writeFile(path.join(upstream, 'file.txt'), 'before\n')
  await git(upstream, ['add', '.'])
  const commit = () => git(upstream, ['-c', 'user.name=Test', '-c', 'user.email=test@example.test',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture'])
  await commit()
  const first = await git(upstream, ['rev-parse', 'HEAD'])
  await fs.writeFile(path.join(upstream, 'file.txt'), 'after\n')
  await git(upstream, ['add', '.'])
  await commit()
  const second = await git(upstream, ['rev-parse', 'HEAD'])
  const cacheRoot = path.join(root, 'cache')
  const policy = new SweBenchGitSourcePolicy({ home: root, env: { SWE_BENCH_GIT_SOURCE: source ?? cacheRoot } })
  const requests: string[] = []
  let offline = false
  let failGitee = false
  let failLocal = false
  const runner = async (command: string, args: string[], options: any) => {
    const url = args.find((arg) => /^https?:/.test(arg)) || (args.includes('fetch') && args.includes('origin') ? repository : undefined)
    if (args.includes('fetch') && url) {
      requests.push(url)
      if (failLocal) throw Object.assign(new Error('No space left on device'), { code: 'ENOSPC' })
      if (offline || (failGitee && url.includes('gitee.com'))) throw new Error('remote source unavailable')
      args = args.map((arg) => arg === url || arg === 'origin' ? pathToFileURL(upstream).href : arg)
    }
    return runProcess(command, args, options)
  }
  const provider = new GitWorkspaceProvider(path.join(root, 'workspaces'), runner, {
    sourcePolicies: new Map([['swe-bench', policy]]), fetchTimeoutMs: 10_000,
  })
  const prepare = (revision: string, runId: string, benchmarkKey = 'swe-bench') =>
    provider.prepare({ repository, revision }, { runId, benchmarkKey })
  return { root, cacheRoot, git, first, second, provider, prepare, requests,
    offline: () => { offline = true }, failGitee: () => { failGitee = true }, failLocal: () => { failLocal = true } }
}

test('SWE policy maps all 12 repositories and appends HTTP root before Gitee and GitHub', () => {
  const defaults = new SweBenchGitSourcePolicy({ home: '/unused', env: { SWE_BENCH_GIT_SOURCE: '' } })
  assert.equal(Object.keys(MIRRORS).length, 12)
  for (const repo of Object.keys(MIRRORS)) {
    const result = defaults.resolve({ repository: `https://github.com/${repo}.git` })
    assert.equal(result.cachePath, null)
    assert.equal(result.remotes[0].url, `https://gitee.com/${MIRRORS[repo]}.git`)
  }
  const custom = new SweBenchGitSourcePolicy({ home: '/unused', env: { SWE_BENCH_GIT_SOURCE: 'http://mirror.example/git/' } })
  assert.deepEqual(custom.resolve({ repository }).remotes.map((r: any) => r.url), [
    'http://mirror.example/git/pallets/flask.git', 'https://gitee.com/mirrors/flask.git', repository,
  ])
  assert.equal(defaults.resolve({ repository: 'https://github.com/example/unknown.git' }).remotes.length, 1)
  for (const value of ['relative/path', 'ftp://mirror.example/git', 'https://user:secret@mirror.example/git', 'http://mirror.example/?q=x']) {
    assert.throws(() => new SweBenchGitSourcePolicy({ home: '/unused', env: { SWE_BENCH_GIT_SOURCE: value } }).resolve({ repository }))
  }
})

test('client setting preserves explicit empty override and reads only selected dotenv key', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swe-env-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(path.join(root, '.env'), 'DATABASE_URL="ignored"\nexport SWE_BENCH_GIT_SOURCE="/cache with spaces" # note\n')
  assert.equal(readLocalSetting('SWE_BENCH_GIT_SOURCE', root, {}), '/cache with spaces')
  assert.equal(readLocalSetting('SWE_BENCH_GIT_SOURCE', root, { SWE_BENCH_GIT_SOURCE: '' }), '')
  assert.equal(readLocalSetting('SWE_BENCH_GIT_SOURCE', root, { SWE_BENCH_GIT_SOURCE: '/override' }), '/override')
})

test('empty source fetches Gitee and falls back to GitHub without creating cache', async (t) => {
  const f = await fixture(t, '')
  f.failGitee()
  const workspace = await f.prepare(f.first, 'empty')
  assert.deepEqual(f.requests, ['https://gitee.com/mirrors/flask.git', repository])
  assert.equal(await fs.readFile(path.join(workspace.path, 'file.txt'), 'utf8'), 'before\n')
  await assert.rejects(fs.stat(f.cacheRoot), { code: 'ENOENT' })
})

test('HTTP source is tried first and does not create persistent cache', async (t) => {
  const f = await fixture(t, 'https://mirror.example/git')
  await f.prepare(f.first, 'http')
  assert.deepEqual(f.requests, ['https://mirror.example/git/pallets/flask.git'])
  await assert.rejects(fs.stat(f.cacheRoot), { code: 'ENOENT' })
})

test('cache retains multiple shallow commits, works offline, and isolates other case objects', async (t) => {
  const f = await fixture(t)
  await f.prepare(f.first, 'first')
  await f.prepare(f.second, 'second')
  f.offline()
  const previousRequests = f.requests.length
  const workspace = await f.prepare(f.first, 'offline-first')
  await f.prepare(f.second, 'offline-second')
  assert.equal(f.requests.length, previousRequests)
  assert.equal(await f.git(workspace.path, ['rev-parse', 'HEAD']), f.first)
  await assert.rejects(f.git(workspace.path, ['cat-file', '-e', f.second]))
  await assert.rejects(fs.stat(path.join(workspace.path, '.git/objects/info/alternates')), { code: 'ENOENT' })
  await fs.writeFile(path.join(workspace.path, 'file.txt'), 'agent edit\n')
  const artifact = await new GitPatchCollector().collect({ name: 'model.patch', mediaType: 'text/x-diff', maxBytes: 100000 }, { workspace })
  const diff = artifact.bytes.toString('utf8')
  assert.match(diff, /\+agent edit/)
  assert.match(diff, /-before/)
})

test('concurrent runs share a cache fill and use distinct workspaces', async (t) => {
  const f = await fixture(t)
  const [a, b] = await Promise.all([f.prepare(f.first, 'parallel-a'), f.prepare(f.first, 'parallel-b')])
  assert.notEqual(a.path, b.path)
  assert.equal(f.requests.length, 1)
  await assert.rejects(fs.stat(path.join(f.cacheRoot, 'pallets/flask.git.lock')), { code: 'ENOENT' })
})

test('other benchmarks keep original GitHub behavior even with SWE policy installed', async (t) => {
  const f = await fixture(t)
  await f.prepare(f.first, 'other', 'another-benchmark')
  assert.deepEqual(f.requests, [repository])
  await assert.rejects(fs.stat(f.cacheRoot), { code: 'ENOENT' })
})

test('local failures do not fall back; missing sources release locks and remove workspaces', async (t) => {
  const f = await fixture(t)
  f.failLocal()
  await assert.rejects(f.prepare(f.first, 'disk-full'), /No space left/)
  assert.equal(f.requests.length, 1)
  await assert.rejects(fs.stat(path.join(f.cacheRoot, 'pallets/flask.git.lock')), { code: 'ENOENT' })
  await assert.rejects(fs.stat(path.join(f.root, 'workspaces/disk-full')), { code: 'ENOENT' })
  const g = await fixture(t)
  g.offline()
  await assert.rejects(g.prepare(g.first, 'unavailable'), /gitee:.*github:/)
  assert.equal(g.requests.length, 2)
})

test('cancelled source preparation does not attempt a remote or leave a lock', async (t) => {
  const f = await fixture(t)
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  await assert.rejects(f.provider.prepare({ repository, revision: f.first }, {
    runId: 'cancelled', benchmarkKey: 'swe-bench', signal: controller.signal,
  }), /cancelled/)
  assert.equal(f.requests.length, 0)
})

test('a cached repository still falls back for an uncached commit and preserves earlier commits', async (t) => {
  const f = await fixture(t)
  await f.prepare(f.first, 'cached')
  f.failGitee()
  await f.prepare(f.second, 'cache-miss')
  assert.deepEqual(f.requests, ['https://gitee.com/mirrors/flask.git', 'https://gitee.com/mirrors/flask.git', repository])
  f.offline()
  await f.prepare(f.first, 'offline-again')
  await f.prepare(f.second, 'offline-new')
  assert.equal(f.requests.length, 3)
})

test('invalid local cache is not overwritten or silently ignored', async (t) => {
  const f = await fixture(t)
  const cache = path.join(f.cacheRoot, 'pallets/flask.git')
  await fs.mkdir(cache, { recursive: true })
  await fs.writeFile(path.join(cache, 'keep.txt'), 'user content')
  await assert.rejects(f.prepare(f.first, 'invalid-cache'))
  assert.equal(await fs.readFile(path.join(cache, 'keep.txt'), 'utf8'), 'user content')
  assert.equal(f.requests.length, 0)
  await assert.rejects(fs.stat(`${cache}.lock`), { code: 'ENOENT' })
})

test('process runner abort terminates an active child', async () => {
  const controller = new AbortController()
  const pending = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    signal: controller.signal, killProcessGroup: true, timeoutMs: 5000,
  })
  const timer = setTimeout(() => controller.abort(new Error('test cancellation')), 100)
  try {
    await assert.rejects(pending, /test cancellation/)
  } finally {
    clearTimeout(timer)
  }
})
