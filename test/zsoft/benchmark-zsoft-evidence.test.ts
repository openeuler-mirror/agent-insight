import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { isEvidencePath } from '../../packages/benchmark-protocol/artifact-path.cjs'

const require = createRequire(import.meta.url)

test('ZSoft evidence preserves original bytes, nested results, empty and malformed files, and excludes private inputs', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zsoft-evidence-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  execFileSync('python3', ['-c', `
import json, sys, zipfile
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path.cwd() / 'benchmarks/zsoft-l1/evaluator'))
from evidence import collect_evidence
root = Path(sys.argv[1]).resolve()
work, output = root / 'work', root / 'output'
run = work / 'runs' / 'task' / 'attempt'
(run / 'judge-evidence/nested').mkdir(parents=True)
(run / 'public-feedback').mkdir()
output.mkdir()
originals = {
    'evaluation.json': b'{ "status": "completed", "success": true, "summary": "original", "checks": [], "details": {"full": true} }\\n',
    'record.json': b'{"official":"record"}\\n',
    'evaluator.stdout.log': b'',
    'evaluator.stderr.log': b'original failure\\n',
    'cleanup.stdout.log': b'',
    'cleanup.stderr.log': b'cleanup\\n',
    'judge-evidence/vuln-result.json': b'{"passed":true}',
    'judge-evidence/fix-result.json': b'{"passed":true}',
    'judge-evidence/vuln.stderr': b'',
    'judge-evidence/nested/partial.json': b'{"incomplete":',
    'public-feedback/generator.json': b'{"feedback":"full"}',
}
for name, content in originals.items(): (run / name).write_bytes(content)
for name in ('compose.env', 'context.json', 'private-source.py'): (run / name).write_text('must not export')
(run / 'submission').mkdir()
(run / 'submission/poc').write_text('already stored as submission')
files, facts = collect_evidence(work, 'task', output)
assert facts == {'missingFiles': [], 'errors': []}, facts
assert {item['name'] for item in files} == set(originals) | {'official-output.zip'}
for item in files:
    if item['name'] != 'official-output.zip': assert (output / item['path']).read_bytes() == originals[item['name']]
partial = next(item for item in files if item['name'].endswith('partial.json'))
assert partial['mediaType'] == 'application/octet-stream'
with zipfile.ZipFile(output / 'official-output.zip') as archive:
    assert set(archive.namelist()) == set(originals)
    for name, content in originals.items(): assert archive.read(name) == content
(run / 'judge-evidence/escape.log').symlink_to(run / 'compose.env')
files, facts = collect_evidence(work, 'task', output)
assert facts['errors'] and all(item['name'] != 'judge-evidence/escape.log' for item in files)
with patch('evidence.MAX_FILE_BYTES', 1):
    files, facts = collect_evidence(work, 'task', output)
    assert facts['errors']
    assert not any(item['name'] == 'evaluation.json' for item in files)
with patch('evidence.zipfile.ZipFile', side_effect=OSError('synthetic disk error')):
    files, facts = collect_evidence(work, 'task', output)
    assert facts['errors']
    assert any(item['name'] == 'evaluation.json' for item in files)
    assert not any(item['name'] == 'official-output.zip' for item in files)
`, directory], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
})

test('evidence names accept safe relative directories but reject traversal and absolute paths', () => {
  for (const name of ['evaluation.json', 'judge-evidence/vuln-result.json', 'public-feedback/deep/output.log']) assert.equal(isEvidencePath(name), true, name)
  for (const name of ['', '/', '../escape', 'a/../escape', './a', 'a//b', '/tmp/a', 'a\\b', 'a/./b', 'a/', 'a\nlog', 'a/'.repeat(17) + 'b', 'a'.repeat(129)]) assert.equal(isEvidencePath(name), false, name)
})

test('Controller Docker context includes its shared evidence-path validator', async () => {
  const dockerfile = await fs.readFile('services/evaluator/Dockerfile', 'utf8')
  const ignore = await fs.readFile('.dockerignore', 'utf8')
  assert.match(dockerfile, /COPY packages\/benchmark-protocol\/artifact-path.cjs \.\/packages\/benchmark-protocol\/artifact-path.cjs/)
  for (const entry of ['!packages/', '!packages/benchmark-protocol/', '!packages/benchmark-protocol/artifact-path.cjs']) assert.ok(ignore.split('\n').includes(entry))
})

test('Controller accepts nested empty evidence and refuses paths or symlinks outside its output directory', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evidence-controller-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const root = path.join(directory, 'output')
  await fs.mkdir(path.join(root, 'official', 'judge-evidence'), { recursive: true })
  const filename = path.join(root, 'official', 'judge-evidence', 'vuln.stderr')
  await fs.writeFile(filename, '')
  const { AbstractBenchmarkEvaluator } = require('../../services/evaluator/src/evaluator-registry.cjs')
  class Evaluator extends AbstractBenchmarkEvaluator {
    constructor(key: string) { super(key) }
  }
  const evaluator = new Evaluator('synthetic')
  const evidence = { name: 'judge-evidence/vuln.stderr', kind: 'test-output', mediaType: 'text/plain', path: filename }
  const result = { completion: { status: 'failed', rawResult: {} }, evidenceFiles: [evidence] }
  assert.equal(evaluator.assertEvaluationOutput(result, root), result)
  assert.throws(() => evaluator.assertEvaluationOutput({ ...result, evidenceFiles: [{ ...evidence, name: '../outside' }] }, root), /证据文件/)
  const outside = path.join(directory, 'secret')
  await fs.writeFile(outside, 'secret')
  const link = path.join(root, 'link.log')
  await fs.symlink(outside, link)
  assert.throws(() => evaluator.assertEvaluationOutput({ ...result, evidenceFiles: [{ ...evidence, name: 'link.log', path: link }] }, root), /证据文件/)
})

test('platform stores nested empty evidence without touching the real user database or retaining paths in storage filenames', async t => {
  const { prisma } = await import('../../src/lib/storage/prisma')
  const { storeBenchmarkEvaluationArtifact } = await import('../../src/lib/benchmark/evaluation-callback-service')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evidence-upload-'))
  const previous = process.env.AGENT_INSIGHT_HOME
  process.env.AGENT_INSIGHT_HOME = directory
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENT_INSIGHT_HOME
    else process.env.AGENT_INSIGHT_HOME = previous
    await fs.rm(directory, { recursive: true, force: true })
  })
  function override(target: object, method: string, implementation: unknown) {
    const original = Reflect.get(target, method)
    Reflect.set(target, method, implementation)
    t.after(() => { Reflect.set(target, method, original) })
  }
  override(prisma.benchmarkEvaluation, 'findUnique', async () => ({ id: 'eval-one', status: 'running_evaluator', artifacts: [], caseRun: { experimentId: 'synthetic', experimentCaseId: 'case' } }))
  override(prisma.experiment, 'findUnique', async () => ({ status: 'running' }))
  override(prisma.experimentCase, 'findUnique', async () => ({ status: 'running' }))
  override(prisma.experimentCancellation, 'findFirst', async () => null)
  let stored: { storagePath: string; name: string; sizeBytes: number } | undefined
  override(prisma.benchmarkEvaluationArtifact, 'create', async ({ data }: { data: typeof stored }) => { stored = data; return data })
  const input = { evaluationId: 'eval-one', name: 'judge-evidence/vuln.stderr', kind: 'test-output', mediaType: 'text/plain', expectedSha256: `sha256:${createHash('sha256').update('').digest('hex')}`, bytes: new Uint8Array() }
  const response = await storeBenchmarkEvaluationArtifact(input)
  assert.equal(response.size, 0)
  assert.equal(stored!.name, input.name)
  assert.equal(stored!.sizeBytes, 0)
  assert.equal(path.basename(stored!.storagePath), response.artifactId)
  assert.equal((await fs.readFile(path.join(directory, 'data', stored!.storagePath))).length, 0)
  await assert.rejects(storeBenchmarkEvaluationArtifact({ ...input, name: '../escape' }), /名称不合法/)
  await assert.rejects(storeBenchmarkEvaluationArtifact({ ...input, expectedSha256: 'wrong' }), /SHA-256/)
})
