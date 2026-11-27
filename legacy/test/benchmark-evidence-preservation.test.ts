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
import fs from 'node:fs/promises'
import { watch } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { readEvaluationEvidence } from '../src/lib/benchmark/evidence-artifacts'
const require = createRequire(import.meta.url)
const { isEvidencePath, evidenceContentDisposition, matchesEvidenceCollection } = require('../packages/benchmark-protocol/artifact-path.cjs')
const { collectEvidence, describeEvidence } = require('../services/evaluator/src/evidence-collection.cjs')
const { FileEvaluatorEntrypoint } = require('../services/evaluator/src/evaluator-registry.cjs')
const { BenchmarkEvaluatorService } = require('../services/evaluator/src/service.cjs')
const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
async function directory(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'evidence-preserve-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

test('official evidence names support Unicode and spaces without accepting unsafe paths', () => {
  for (const name of ['评测结果.json', 'test results.json', '.report', 'a/report.json', 'b/report.json']) assert.equal(isEvidencePath(name), true, name)
  for (const name of ['', '../report', '/report', 'a//b', 'a/./b', 'a/../b', 'a\\b', 'a:b', 'a\n.json', 'name.', 'name ', 'a\u202eb', '\ud800.json']) assert.equal(isEvidencePath(name), false, name)
  assert.match(evidenceContentDisposition('评测/测试 结果.json'), /filename\*=UTF-8''%E6%B5%8B/)
  assert.equal(evidenceContentDisposition('report.json'), `attachment; filename="report.json"; filename*=UTF-8''report.json`)
})

test('directory collection preserves all actual files, original names, subdirectories and bytes', async t => {
  const root = await directory(t)
  await fs.mkdir(path.join(root, 'official/a'), { recursive: true })
  await fs.mkdir(path.join(root, 'official/b'), { recursive: true })
  const content = Buffer.from('{"largeInteger":9007199254740993}\n')
  for (const name of ['结果 文件.json', 'a/report.json', 'b/report.json']) await fs.writeFile(path.join(root, 'official', name), content)
  await fs.writeFile(path.join(root, 'result.json'), '{}')
  const collection = await collectEvidence(root, [{ name: '结果 文件.json', path: 'official/结果 文件.json', source: 'official-file', kind: 'official-report', mediaType: 'application/json' }], 'official')
  assert.deepEqual(collection.issues, [])
  assert.deepEqual(collection.files.map((file: any) => file.name).sort(), ['a/report.json', 'b/report.json', '结果 文件.json'])
  const manifest = await describeEvidence(collection.files, collection)
  assert.equal(manifest.scope, 'official-directory')
  assert.ok(manifest.files.every((file: any) => file.sha256 === digest(content)))
})

test('renaming official files, missing declarations and escaping symlinks are reported', async t => {
  const root = await directory(t)
  await fs.mkdir(path.join(root, 'official'))
  await fs.writeFile(path.join(root, 'official/原名.json'), '{}')
  await fs.symlink(os.tmpdir(), path.join(root, 'outside'))
  const collected = await collectEvidence(root, [
    { name: 'evaluation.json', path: 'official/原名.json' },
    { name: 'missing.json', path: 'missing.json' },
  ], 'official')
  assert.equal((await describeEvidence(collected.files, collected)).complete, false)
  assert.ok(collected.issues.some((item: any) => item.message.includes('不能改名')))
  assert.ok(collected.issues.some((item: any) => item.message.includes('符号链接')))
  assert.deepEqual(collected.files.map((file: any) => file.name), ['原名.json'])
})

async function evaluatorRun(t: TestContext, code: string, signal = new AbortController().signal) {
  const root = await directory(t)
  const entrypoint = path.join(root, 'fixture.cjs')
  await fs.writeFile(entrypoint, `const fs=require('node:fs'),path=require('node:path'); const output=process.argv[process.argv.indexOf('--output')+1]; ${code}`)
  const evaluator = new FileEvaluatorEntrypoint({ key: 'fixture', runtime: 'script-package', command: 'node', entrypoint, rawResultSchema: { type: 'object', required: ['passed'] } })
  return evaluator.evaluate({ workDir: path.join(root, 'job'), artifacts: new Map(), job: { evaluationId: 'eval-1', limits: { timeoutSeconds: 2, cpu: 1, memoryMiB: 128 }, payload: {} }, signal, async reportProgress() {} })
}

test('real process success automatically delivers undeclared native files and keeps platform logs distinct', async t => {
  const result = await evaluatorRun(t, `fs.writeFileSync(path.join(path.dirname(output),'原名.json'),'{"passed":true}'); fs.writeFileSync(output,JSON.stringify({protocolVersion:'evaluator-output/v1',completion:{status:'completed',rawResult:{passed:true},runtimeFacts:{},cleanup:{}},evidenceFiles:[]}));`)
  assert.ok(result.evidenceFiles.some((file: any) => file.name === '原名.json'))
  assert.equal(result.completion.runtimeFacts.evidenceCollection.complete, true)
  assert.equal(result.evidenceFiles.filter((file: any) => file.source === 'platform').length, 2)
})

test('nonzero process exit retains partial official output and complete stderr beyond error-message limit', async t => {
  const error = await evaluatorRun(t, `fs.writeFileSync(path.join(path.dirname(output),'partial.json'),'{'); process.stderr.write('x'.repeat(12000)); process.exitCode=2;`).then(() => assert.fail('expected process failure'), (failure: any) => failure)
  {
    assert.equal(error.code, 'EVALUATOR_ENTRYPOINT_FAILED')
    const partial = error.evidenceFiles.find((file: any) => file.name === 'partial.json')
    assert.equal(await fs.readFile(partial.path, 'utf8'), '{')
    const log = error.evidenceFiles.find((file: any) => file.name === 'controller/stderr.log')
    assert.equal((await fs.readFile(log.path)).length, 12000)
    const service = new BenchmarkEvaluatorService({ dataDir: path.dirname(log.path), registry: { list: () => [] } })
    await fs.mkdir(service.journal.jobDir('fallback'), { recursive: true })
    const fallback = await service.fallbackResult({ runId: 'fallback' }, error)
    assert.ok(fallback.evidenceFiles.some((file: any) => file.name === 'partial.json'))
    assert.ok(fallback.evidenceFiles.some((file: any) => file.source === 'platform'))
  }
})

test('timeout retains files and logs written before termination', async t => {
  const controller = new AbortController()
  const readyRoot = await directory(t)
  const ready = path.join(readyRoot, 'ready')
  const watcher = watch(readyRoot, (_event, filename) => { if (String(filename) === 'ready') controller.abort() })
  const timeout = setTimeout(() => controller.abort(), 10000)
  try {
    const error = await evaluatorRun(t, `fs.writeFileSync(path.join(path.dirname(output),'before-timeout.log'),'progress'); fs.writeSync(2,'timeout diagnostic'); fs.writeFileSync(${JSON.stringify(ready)},'ready'); setInterval(()=>{},1000);`, controller.signal).then(() => assert.fail('expected timeout'), (failure: any) => failure)
    {
      assert.equal(error.code, 'EVALUATION_TIMEOUT')
      assert.ok(error.evidenceFiles.some((file: any) => file.name === 'before-timeout.log'))
      assert.equal(await fs.readFile(error.evidenceFiles.find((file: any) => file.name === 'controller/stderr.log').path, 'utf8'), 'timeout diagnostic')
    }
  } finally { watcher.close(); clearTimeout(timeout) }
})

test('malformed JSON diagnostics remain readable while structured scoring data and byte integrity stay strict', async t => {
  const root = await directory(t)
  const bytes = Buffer.from('{"truncated":')
  await fs.writeFile(path.join(root, 'artifact'), bytes)
  const artifact = { id: 'a', evaluationId: 'e', name: '原始诊断.json', kind: 'diagnostic', mediaType: 'application/json', storagePath: 'artifact', sha256: digest(bytes), sizeBytes: bytes.length }
  const [result] = await readEvaluationEvidence([artifact], root)
  assert.equal(result.jsonContent, undefined)
  assert.ok(result.jsonParseError)
  assert.equal(await fs.readFile(path.join(root, 'artifact'), 'utf8'), bytes.toString())
  await fs.writeFile(path.join(root, 'artifact'), 'changed')
  await assert.rejects(readEvaluationEvidence([artifact], root), (error: any) => error.code === 'EVALUATION_EVIDENCE_DIGEST_MISMATCH')
})

test('completion cannot claim a different file, omit uploads, duplicate IDs or mark incomplete collection successful', () => {
  const artifact = { id: 'artifact', name: '原名.json', sha256: 'sha256:' + 'a'.repeat(64), sizeBytes: 8 }
  const entry = { artifactId: artifact.id, name: artifact.name, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes, source: 'official-file' }
  const collection = { schemaVersion: 'evidence-collection/v1', scope: 'output-directory', complete: true, issues: [], files: [entry] }
  assert.equal(matchesEvidenceCollection(collection, [artifact], 'completed'), true)
  for (const files of [[], [{ ...entry, name: 'summary.json' }], [{ ...entry, sha256: 'sha256:' + 'b'.repeat(64) }], [entry, entry]]) {
    assert.equal(matchesEvidenceCollection({ ...collection, files }, [artifact], 'completed'), false)
  }
  assert.equal(matchesEvidenceCollection({ ...collection, complete: false }, [artifact], 'completed'), false)
  assert.equal(matchesEvidenceCollection({ ...collection, complete: false }, [artifact], 'failed'), true)
})

test('replacing the output directory with a symlink cannot collect files outside the run', async t => {
  const root = await directory(t)
  const output = path.join(root, 'output')
  await fs.symlink(os.tmpdir(), output)
  await assert.rejects(collectEvidence(output), /符号链接/)
})
