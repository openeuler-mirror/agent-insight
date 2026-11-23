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

test('SWE-bench configuration accepts files and URLs; null restores official sources', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-sources-config-'))
  const previous = process.env.AGENT_INSIGHT_CONFIG_DIR
  process.env.AGENT_INSIGHT_CONFIG_DIR = root
  const update = (source: string | null, sourceArchive: string | null) => fs.writeFileSync(path.join(root, 'platform.local.yaml'), JSON.stringify({
    benchmarks: { 'swe-bench': { dataset: { source }, loader: { sourceArchive } } },
  }))
  try {
    update('~/datasets/test.parquet', '$HOME/datasets/source.tar.gz')
    let paths = resolveSweBenchProvisionPaths()
    assert.equal(paths.datasetPath, path.join(os.homedir(), 'datasets/test.parquet'))
    assert.equal(paths.sourceArchivePath, path.join(os.homedir(), 'datasets/source.tar.gz'))
    update('http://mirror.example/test.parquet', 'https://mirror.example/source.tar.gz')
    paths = resolveSweBenchProvisionPaths()
    assert.equal(paths.datasetSource, 'http://mirror.example/test.parquet')
    assert.notEqual(paths.datasetPath, paths.datasetSource)
    update(null, null)
    paths = resolveSweBenchProvisionPaths()
    assert.match(paths.datasetSource, /^https:\/\/huggingface\.co\//)
    assert.match(paths.sourceArchiveSource, /^https:\/\/codeload\.github\.com\//)
    update('ftp://mirror.example/test.parquet', null)
    assert.throws(resolveSweBenchProvisionPaths, /HTTP\(S\).*文件路径/)
  } finally {
    if (previous === undefined) delete process.env.AGENT_INSIGHT_CONFIG_DIR
    else process.env.AGENT_INSIGHT_CONFIG_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
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
