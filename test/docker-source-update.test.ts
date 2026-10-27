import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import AdmZip from 'adm-zip'

const script = path.resolve('scripts/update-source.sh')

function fixture(t: test.TestContext, prefix = '') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'source update-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const bin = path.join(directory, 'bin')
  fs.mkdirSync(bin)
  const log = path.join(directory, 'docker.jsonl')
  fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_DOCKER_LOG, JSON.stringify({args, source: process.env.SOURCE_RELEASE}) + '\\n');
if (args.includes('up') && process.env.MOCK_UP_FAIL) process.exit(1);
`, { mode: 0o755 })
  const compose = path.join(directory, 'compose.yml')
  fs.writeFileSync(compose, 'services: {}\n')
  const zipFile = path.join(directory, 'source.zip')
  const archive = new AdmZip()
  archive.addFile(`${prefix}package.json`, Buffer.from('{"name":"agent-insight"}'))
  archive.addFile(`${prefix}prisma/schema.prisma`, Buffer.from('schema'))
  archive.addFile(`${prefix}src/index.ts`, Buffer.from('export {}'))
  archive.writeZip(zipFile)
  const releases = path.join(directory, 'releases')
  const run = (extraEnv: Partial<NodeJS.ProcessEnv> = {}) => spawnSync('bash', [script, '--zip', zipFile, '--compose', compose], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RELEASES_DIR: releases, MOCK_DOCKER_LOG: log, ...extraEnv },
  })
  const calls = () => fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) as {args: string[], source?: string}[]
    : []
  return { directory, zipFile, releases, archive, run, calls }
}

for (const prefix of ['', 'agent-insight-feature/']) {
  test(`ZIP update finds source root for ${prefix || 'flat archive'} and uses the existing image`, t => {
    const f = fixture(t, prefix)
    const result = f.run()
    assert.equal(result.status, 0, result.stderr)
    const up = f.calls().find(call => call.args.includes('up'))!
    assert.ok(up)
    assert.ok(up.source!.startsWith(`${fs.realpathSync(f.releases)}${path.sep}`))
    if (prefix) assert.equal(path.basename(up.source!), 'agent-insight-feature')
    assert.equal(fs.readFileSync(path.join(up.source!, 'src/index.ts'), 'utf8'), 'export {}')
    assert.equal(fs.statSync(path.dirname(path.join(up.source!, 'src/index.ts'))).mode & 0o777, 0o755)
    assert.equal(fs.statSync(path.join(up.source!, 'src/index.ts')).mode & 0o777, 0o644)
    assert.ok(up.args.includes('--force-recreate'))
    assert.ok(up.args.includes('--no-build'))
    assert.ok(!up.args.includes('--wait'))
    assert.equal(up.args[up.args.indexOf('--pull') + 1], 'never')
    assert.deepEqual(up.args, ['compose', '-f', path.join(f.directory, 'compose.yml'), 'up', '-d', '--force-recreate', '--pull', 'never', '--no-build'])
    assert.ok(!f.calls().some(call => call.args.includes('config')))
    assert.ok(!f.calls().some(call => call.args.includes('rm') || call.args.includes('down')))
    assert.match(result.stdout, /export SOURCE_RELEASE=/)
    const second = f.run()
    assert.equal(second.status, 0, second.stderr)
    const updates = f.calls().filter(call => call.args.includes('up'))
    assert.notEqual(updates[0].source, updates[1].source)
    assert.ok(fs.existsSync(updates[0].source!))
  })
}

test('missing ZIP stops before any Docker command', t => {
  const f = fixture(t)
  fs.renameSync(f.zipFile, `${f.zipFile}.saved`)
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /ZIP file not found/)
  assert.deepEqual(f.calls(), [])
})

test('unsafe archive paths are rejected before extraction and recreation', t => {
  const f = fixture(t)
  const archive = spawnSync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("../escaped.txt","escape"); z.close()', f.zipFile], { encoding: 'utf8' })
  assert.equal(archive.status, 0, archive.stderr)
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /unsafe path/)
  assert.ok(!fs.existsSync(f.releases))
  assert.ok(!fs.existsSync(path.join(f.directory, 'escaped.txt')))
  assert.ok(!f.calls().some(call => call.args.includes('up')))
})

test('ambiguous project roots stop before recreation', t => {
  const f = fixture(t)
  f.archive.addFile('second/package.json', Buffer.from('{"name":"agent-insight"}'))
  f.archive.addFile('second/prisma/schema.prisma', Buffer.from('schema'))
  f.archive.addFile('second/src/index.ts', Buffer.from('export {}'))
  f.archive.writeZip(f.zipFile)
  const ambiguous = f.run()
  assert.notEqual(ambiguous.status, 0)
  assert.match(ambiguous.stderr, /found 2/)
  assert.ok(!f.calls().some(call => call.args.includes('up')))
})

test('Compose failures report failure and retain the extracted source without rollback', t => {
  const f = fixture(t)
  const result = f.run({ MOCK_UP_FAIL: '1' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Database rollback is not automatic/)
  const up = f.calls().find(call => call.args.includes('up'))!
  assert.ok(fs.existsSync(path.join(up.source!, 'package.json')))
  assert.equal(f.calls().filter(call => call.args.includes('up')).length, 1)
  assert.doesNotMatch(result.stdout, /Compose command completed/)
})
