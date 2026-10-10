import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  ensurePinnedFile,
  resolveSweBenchProvisionPaths,
} from '../scripts/benchmark/ensure-swe-bench-dataset'

test('unified SWE-bench sources accept paths and URLs, with explicit empty overriding legacy settings', () => {
  const variables = [
    'SWE_BENCH_DATASET_SOURCE', 'SWE_BENCH_SOURCE_ARCHIVE_SOURCE',
    'SWE_BENCH_DATASET_PATH', 'SWE_BENCH_DATASET_URL', 'SWE_BENCH_SOURCE_ARCHIVE_URL',
  ]
  const previous = variables.map(name => process.env[name])
  try {
    for (const name of variables) delete process.env[name]
    process.env.SWE_BENCH_DATASET_PATH = '/legacy/test.parquet'
    process.env.SWE_BENCH_DATASET_URL = 'https://legacy.example/test.parquet'
    process.env.SWE_BENCH_SOURCE_ARCHIVE_URL = 'https://legacy.example/source.tar.gz'
    let paths = resolveSweBenchProvisionPaths()
    assert.equal(paths.datasetPath, '/legacy/test.parquet')
    assert.equal(paths.sourceArchiveSource, 'https://legacy.example/source.tar.gz')

    process.env.SWE_BENCH_DATASET_SOURCE = '~/datasets/test.parquet'
    process.env.SWE_BENCH_SOURCE_ARCHIVE_SOURCE = '$HOME/datasets/source.tar.gz'
    paths = resolveSweBenchProvisionPaths()
    assert.equal(paths.datasetSource, path.join(os.homedir(), 'datasets/test.parquet'))
    assert.equal(paths.datasetPath, paths.datasetSource)
    assert.equal(paths.sourceArchivePath, path.join(os.homedir(), 'datasets/source.tar.gz'))
    assert.equal(paths.sourceArchivePath, paths.sourceArchiveSource)

    process.env.SWE_BENCH_DATASET_SOURCE = 'http://mirror.example/test.parquet'
    process.env.SWE_BENCH_SOURCE_ARCHIVE_SOURCE = 'https://mirror.example/source.tar.gz'
    paths = resolveSweBenchProvisionPaths()
    assert.equal(paths.datasetSource, process.env.SWE_BENCH_DATASET_SOURCE)
    assert.equal(paths.sourceArchiveSource, process.env.SWE_BENCH_SOURCE_ARCHIVE_SOURCE)
    assert.notEqual(paths.datasetPath, paths.datasetSource)
    assert.notEqual(paths.sourceArchivePath, paths.sourceArchiveSource)

    process.env.SWE_BENCH_DATASET_SOURCE = ''
    process.env.SWE_BENCH_SOURCE_ARCHIVE_SOURCE = ''
    paths = resolveSweBenchProvisionPaths()
    assert.match(paths.datasetSource, /^https:\/\/huggingface\.co\//)
    assert.match(paths.sourceArchiveSource, /^https:\/\/codeload\.github\.com\//)

    process.env.SWE_BENCH_DATASET_SOURCE = 'ftp://mirror.example/test.parquet'
    assert.throws(resolveSweBenchProvisionPaths, /HTTP\(S\).*本机文件路径/)
  } finally {
    variables.forEach((name, i) => {
      if (previous[i] === undefined) delete process.env[name]
      else process.env[name] = previous[i]
    })
  }
})

test('local dataset and archive files are verified without overwriting or downloading on failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-local-source-'))
  const content = 'pinned fixture bytes'
  const sha256 = createHash('sha256').update(content).digest('hex')
  try {
    for (const name of ['test.parquet', 'source.tar.gz']) {
      const source = path.join(root, name)
      const input = { label: name, source, targetPath: source, sha256 }
      await assert.rejects(ensurePinnedFile(input), /本机文件不存在/)
      assert.equal(fs.existsSync(source), false)
      fs.writeFileSync(source, content)
      await ensurePinnedFile(input)
      fs.writeFileSync(source, 'wrong version')
      await assert.rejects(ensurePinnedFile(input), /哈希不匹配/)
      assert.equal(fs.readFileSync(source, 'utf8'), 'wrong version')
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('HTTP source downloads are pinned, cached, and preserve the prior cache on checksum failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-http-source-'))
  const content = 'pinned HTTP fixture'
  const sha256 = createHash('sha256').update(content).digest('hex')
  let requests = 0
  const server = createServer((req, res) => {
    requests += 1
    res.end(req.url === '/good' ? content : 'wrong version')
  })
  const previousNoProxy = process.env.no_proxy
  process.env.no_proxy = '127.0.0.1'
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const source = `http://127.0.0.1:${address.port}/good`
    const targetPath = path.join(root, 'test.parquet')
    const input = { label: 'fixture', source, targetPath, sha256 }
    await ensurePinnedFile(input)
    assert.equal(fs.readFileSync(targetPath, 'utf8'), content)
    await ensurePinnedFile(input)
    assert.equal(requests, 1)
    fs.writeFileSync(targetPath, 'prior invalid cache')
    await assert.rejects(ensurePinnedFile({ ...input, source: source.replace('/good', '/bad') }), /哈希校验失败/)
    assert.equal(fs.readFileSync(targetPath, 'utf8'), 'prior invalid cache')
    assert.deepEqual(fs.readdirSync(root), ['test.parquet'])
  } finally {
    if (previousNoProxy === undefined) delete process.env.no_proxy
    else process.env.no_proxy = previousNoProxy
    await new Promise<void>(resolve => server.close(() => resolve()))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
