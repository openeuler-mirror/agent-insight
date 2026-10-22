import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const state = createRequire(import.meta.url)('../scripts/start-build-state.cjs')

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-build-state-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const env = { AGENT_INSIGHT_HOME: path.join(root, 'home') }
  const write = (file: string, content = '') => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), content)
  }
  const seedArtifacts = () => {
    write('.next/BUILD_ID', 'build-1')
    for (const [file, content] of Object.entries({
      'server.js': 'server', '.next/BUILD_ID': 'build-1',
      '.next/required-server-files.json': '{}', '.next/server/app-paths-manifest.json': '{}',
      '.next/server/pages-manifest.json': '{}', '.next/static/chunk.js': 'asset',
      'public/logo.svg': 'logo', 'node_modules/next/index.js': 'runtime',
    })) write(`.next/standalone/${file}`, content)
    write('.next/static/chunk.js', 'asset')
  }
  write('src/app/page.tsx', 'original')
  write('package.json', '{}')
  write('package-lock.json', '{}')
  write('node_modules/example/index.js', 'installed')
  write('home/.env', 'SECRET=never-log-me\n')
  seedArtifacts()
  const record = () => {
    state.checkBuild(root, false, env)
    state.recordBuild(root, env)
  }
  return { root, env, write, seedArtifacts, record, check: () => state.checkBuild(root, false, env) }
}

test('unchanged inputs reuse artifacts; first startup, force and corrupt state rebuild', t => {
  const f = fixture(t)
  assert.equal(f.check().reusable, false)
  f.record()
  assert.equal(f.check().reusable, true)
  assert.equal(state.checkBuild(f.root, true, f.env).reusable, false)
  assert.doesNotMatch(fs.readFileSync(state.statePaths(f.root).build, 'utf8'), /never-log-me/)
  f.write('.next/start-build-state.json', '{broken')
  assert.equal(f.check().reusable, false)
})

for (const [file, content] of Object.entries({
  'src/app/page.tsx': 'modified', 'src/untracked.ts': 'added', 'public/new.svg': 'new',
  'package-lock.json': '{"changed":true}', 'node_modules/example/index.js': 'tampered',
  'next.config.ts': 'config', 'tsconfig.next.json': '{}', 'postcss.config.mjs': 'postcss',
  '.env.production.local': 'NEXT_PUBLIC_TEST=changed', 'home/.env': 'SECRET=changed',
  'prisma/schema.prisma': 'schema', 'scripts/benchmark/generate-catalog.cjs': 'generator',
  'services/executor/runtimes/mcts/runtime.yaml': 'key: mcts', 'config/benchmark/executor.yaml': 'runtimes: {}',
})) {
  test(`changed ${file} invalidates successful build`, t => {
    const f = fixture(t)
    f.record()
    f.write(file, content)
    assert.equal(f.check().reusable, false)
  })
}

test('content, additions, deletions and symlink targets count; timestamps alone do not', t => {
  const f = fixture(t)
  f.record()
  const file = path.join(f.root, 'src/app/page.tsx')
  const before = fs.statSync(file)
  fs.utimesSync(file, new Date(), new Date())
  assert.equal(f.check().reusable, true)
  f.write('src/app/page.tsx', 'modified')
  fs.utimesSync(file, before.atime, before.mtime)
  assert.equal(f.check().reusable, false)
  f.record()
  fs.renameSync(file, path.join(f.root, 'src/app/new-page.tsx'))
  assert.equal(f.check().reusable, false)
  f.record()
  fs.unlinkSync(path.join(f.root, 'src/app/new-page.tsx'))
  assert.equal(f.check().reusable, false)
  f.write('linked/dep.js', 'v1')
  fs.symlinkSync('../linked', path.join(f.root, 'node_modules/link'))
  f.record()
  f.write('linked/dep.js', 'v2')
  assert.equal(f.check().reusable, false)
})

test('dependency checksum cache detects edits even when mtime and size are restored', t => {
  const f = fixture(t)
  f.record()
  const file = path.join(f.root, 'node_modules/example/index.js')
  const stat = fs.statSync(file)
  f.write('node_modules/example/index.js', 'tampered!')
  fs.utimesSync(file, stat.atime, stat.mtime)
  assert.equal(f.check().reusable, false)
  f.record()
  fs.writeFileSync(path.join(f.root, 'node_modules/.cache/agent-insight/dependency-hashes.json'), '{invalid')
  assert.equal(f.check().reusable, true)
})

test('public build environment changes rebuild; runtime port and logs do not', t => {
  const f = fixture(t)
  f.record()
  assert.equal(state.checkBuild(f.root, false, { ...f.env, NEXT_PUBLIC_URL_PREFIX: '/insight' }).reusable, false)
  assert.equal(state.checkBuild(f.root, false, { ...f.env, AGENT_INSIGHT_PORT: '3317' }).reusable, true)
  f.write('server.log', 'new log')
  f.write('.next/cache/webpack/cache.pack', 'new cache')
  assert.equal(f.check().reusable, true)
})

for (const file of ['.next/BUILD_ID', '.next/standalone/server.js', '.next/standalone/.next/static/chunk.js', '.next/standalone/node_modules/next/index.js']) {
  test(`missing or damaged ${file} causes rebuild`, t => {
    const f = fixture(t)
    f.record()
    f.write(file, 'damaged')
    assert.equal(f.check().reusable, false)
    fs.unlinkSync(path.join(f.root, file))
    assert.equal(f.check().reusable, false)
  })
}

test('failed builds lose success marker, retain cache, and cannot certify changing inputs', t => {
  const f = fixture(t)
  f.record()
  f.write('.next/cache/webpack/cache.pack', 'reusable')
  f.write('.next/cache/.tsbuildinfo', 'obsolete type graph')
  state.prepareBuild(f.root)
  assert.equal(fs.existsSync(state.statePaths(f.root).build), false)
  assert.equal(fs.existsSync(path.join(f.root, '.next/cache/.tsbuildinfo')), false)
  assert.equal(fs.readFileSync(path.join(f.root, '.next/cache/webpack/cache.pack'), 'utf8'), 'reusable')
  assert.equal(f.check().reusable, false)
  assert.throws(() => state.recordBuild(f.root, f.env))
  f.seedArtifacts()
  f.write('src/new.ts', 'changed during build')
  assert.throws(() => state.recordBuild(f.root, f.env), /inputs changed during compilation/)
  assert.equal(fs.existsSync(state.statePaths(f.root).build), false)
})

test('Prisma generation reused only with matching schema, generator and complete client', t => {
  const f = fixture(t)
  f.write('prisma/schema.prisma', 'schema')
  f.write('node_modules/.prisma/client/schema.prisma', 'schema')
  for (const name of ['index.js', 'index.d.ts', 'default.js', 'libquery_engine-linux.so.node']) f.write(`node_modules/.prisma/client/${name}`, name)
  f.write('node_modules/prisma/package.json', '{"version":"5"}')
  assert.equal(state.checkPrisma(f.root), false)
  state.recordPrisma(f.root)
  assert.equal(state.checkPrisma(f.root), true)
  f.write('node_modules/prisma/package.json', '{"version":"6"}')
  assert.equal(state.checkPrisma(f.root), false)
  state.recordPrisma(f.root)
  fs.unlinkSync(path.join(f.root, 'node_modules/.prisma/client/index.js'))
  assert.equal(state.checkPrisma(f.root), false)
  f.write('node_modules/.prisma/client/index.js', 'restored')
  state.recordPrisma(f.root)
  f.write('prisma/schema.prisma', 'new-schema')
  assert.equal(state.checkPrisma(f.root), false)
})

test('start documents force rebuild; db push wrapper rejects arbitrary destructive flags', () => {
  const help = spawnSync('bash', ['scripts/start.sh', '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /--force-rebuild/)
  const rejected = spawnSync('sh', ['scripts/db_push.sh', '--accept-data-loss'], { encoding: 'utf8' })
  assert.equal(rejected.status, 1)
  assert.match(rejected.stderr, /Usage:/)
})

test('db push forwards skip-generate on normal and allowed retry paths, preserving the default', t => {
  const f = fixture(t)
  f.write('scripts/db_push.sh', fs.readFileSync('scripts/db_push.sh', 'utf8'))
  f.write('scripts/trace-datasets/remove-legacy-summary.cjs', '')
  const bin = path.join(f.root, 'bin')
  f.write('bin/npx', `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS"
if [ "$RETRY" = 1 ] && [ ! -e "$CALLS.once" ]; then
  touch "$CALLS.once"
  echo '  • column will be cast from \`Int\` to \`BigInt\`'
  exit 1
fi
`)
  fs.chmodSync(path.join(bin, 'npx'), 0o755)
  const calls = path.join(f.root, 'calls')
  const run = (args: string[], retry = '0') => spawnSync('sh', ['scripts/db_push.sh', ...args], {
    cwd: f.root, encoding: 'utf8', env: { ...process.env, ...f.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, RETRY: retry },
  })
  assert.equal(run([]).status, 0)
  assert.equal(run(['--skip-generate']).status, 0)
  assert.equal(run(['--skip-generate'], '1').status, 0)
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), [
    'prisma db push', 'prisma db push --skip-generate', 'prisma db push --skip-generate',
    'prisma db push --skip-generate --accept-data-loss',
  ])
})

test('start.sh integration: reuse, source change, forced and failed rebuilds', { timeout: 90000 }, async t => {
  const f = fixture(t)
  const net = await import('node:net')
  const probe = net.createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as import('node:net').AddressInfo).port
  await new Promise<void>(resolve => probe.close(() => resolve()))
  const pids = new Set<number>()
  t.after(() => { for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch {} } })
  for (const file of ['start.sh', 'start-build-state.cjs', 'verify-standalone.cjs', 'db_push.sh']) {
    f.write(`scripts/${file}`, fs.readFileSync(`scripts/${file}`, 'utf8'))
  }
  for (const file of ['prepare-ras-sqlite-schema.js', 'stop-orphan-trace-consumer.cjs', 'benchmark/generate-catalog.cjs', 'trace-datasets/remove-legacy-summary.cjs']) f.write(`scripts/${file}`, '')
  f.write('home/.env', '')
  f.write('public/logo.svg', 'logo')
  f.write('prisma/schema.prisma', 'schema')
  f.write('fixture-build.cjs', `
const fs = require('node:fs'); const path = require('node:path');
function write(file, content = '') { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, content); }
fs.appendFileSync(process.env.CALLS, 'build\\n');
if (process.env.FAIL_BUILD) process.exit(1);
write('.next/BUILD_ID', 'build-1');
write('.next/standalone/server.js', "require('node:http').createServer((req,res)=>res.end(String(process.pid))).listen(Number(process.env.PORT), '0.0.0.0')");
write('.next/standalone/.next/BUILD_ID', 'build-1');
for (const file of ['required-server-files.json', 'server/app-paths-manifest.json', 'server/pages-manifest.json']) write('.next/standalone/.next/' + file, '{}');
write('.next/static/chunk.js', 'asset');
`)
  f.write('fixture-prisma.cjs', `
const fs=require('node:fs'); const path=require('node:path');
fs.appendFileSync(process.env.CALLS, process.argv.slice(2).join(' ')+'\\n');
if (process.argv[3] === 'generate') {
  fs.mkdirSync('node_modules/.prisma/client', {recursive:true});
  for (const file of ['index.js','index.d.ts','default.js','libquery_engine-linux.so.node']) fs.writeFileSync('node_modules/.prisma/client/'+file, file);
  fs.copyFileSync('prisma/schema.prisma','node_modules/.prisma/client/schema.prisma');
}
`)
  for (const [name, body] of Object.entries({ npm: 'node fixture-build.cjs', npx: 'node fixture-prisma.cjs "$@"' })) {
    f.write(`bin/${name}`, `#!/bin/sh\n${body}\n`)
    fs.chmodSync(path.join(f.root, 'bin', name), 0o755)
  }
  const calls = path.join(f.root, 'commands.log')
  const run = (args: string[] = [], fail = false) => {
    const env = { ...process.env, ...f.env, PATH: `${path.join(f.root, 'bin')}:${process.env.PATH}`, DATABASE_URL: `file:${f.root}/home/test.db`, CALLS: calls } as NodeJS.ProcessEnv
    for (const key of ['PORT', 'DB_HOST', 'AGENT_INSIGHT_DATA_DIR', 'AGENT_INSIGHT_BENCHMARK']) delete env[key]
    if (fail) env.FAIL_BUILD = '1'
    const result = spawnSync('bash', [path.join(f.root, 'scripts/start.sh'), '--port', String(port), ...args], { env, encoding: 'utf8', timeout: 15000 })
    for (const match of result.stdout.matchAll(/^PID: (\d+)/gm)) pids.add(Number(match[1]))
    return result
  }
  const first = run()
  assert.equal(first.status, 0, first.stdout + first.stderr)
  const second = run()
  assert.equal(second.status, 0, second.stdout + second.stderr)
  assert.match(second.stdout, /skipping Next.js build/)
  assert.match(second.stdout, /skipping generation/)
  f.write('src/app/page.tsx', 'change')
  assert.equal(run().status, 0)
  assert.equal(run(['--force-rebuild']).status, 0)
  const failed = run(['--force-rebuild'], true)
  assert.equal(failed.status, 1)
  assert.match(failed.stdout, /total: .*exit=1/)
  assert.equal(fs.existsSync(state.statePaths(f.root).build), false)
  const recovered = run()
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr)
  const commands = fs.readFileSync(calls, 'utf8').trim().split('\n')
  assert.equal(commands.filter(s => s === 'build').length, 5)
  assert.equal(commands.filter(s => s === 'prisma generate').length, 1)
  assert.equal(commands.filter(s => s === 'prisma db push --skip-generate').length, 6)
})
