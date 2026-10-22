import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'

const require = createRequire(import.meta.url)
const { generate } = require('../scripts/benchmark/generate-catalog.cjs') as { generate(root: string): string[] }
type CatalogLock = { packages: { key: string; digest: string; evaluatorDigest: string }[] }

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-catalog-cache-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const source of ['benchmarks', 'packages/project-config', 'config/benchmark/evaluator.yaml', 'services/evaluator/src', 'packages/benchmark-protocol/artifact-path.cjs']) {
    const target = path.join(root, source)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.cpSync(path.resolve(source), target, { recursive: true })
  }
  function snapshot() {
    assert.deepEqual(generate(root), ['swe-bench', 'zsoft-l1'])
    const directory = path.join(root, 'generated/benchmark-catalog')
    return Object.fromEntries(fs.readdirSync(directory).sort().map(name => [name, fs.readFileSync(path.join(directory, name), 'utf8')]))
  }
  function lock(): CatalogLock {
    return JSON.parse(snapshot()['catalog-lock.json'])
  }
  return { root, snapshot, lock }
}

test('Catalog output stays identical across repeated generation and cache creation or modification', t => {
  const f = fixture(t)
  const baseline = f.snapshot()
  assert.deepEqual(f.snapshot(), baseline)
  const cacheFiles: string[] = []
  for (const directory of ['benchmarks/zsoft-l1/evaluator', 'benchmarks/zsoft-l1/dataset', 'benchmarks/swe-bench/evaluator',
    'benchmarks/swe-bench/smoke', 'benchmarks/swe-bench/executor', 'packages/project-config', 'services/evaluator/src']) {
    for (const name of ['__pycache__/nested/module.py', '__pycache__/module.cpython-311.pyc', 'nested/module.pyc', 'module.pyo', '.DS_Store']) {
      const file = path.join(f.root, directory, name)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, Buffer.from([0, 1, 2, 255]))
      cacheFiles.push(file)
    }
  }
  assert.deepEqual(f.snapshot(), baseline)
  for (const file of cacheFiles) fs.writeFileSync(file, 'changed runtime cache')
  assert.deepEqual(f.snapshot(), baseline)
  assert.doesNotMatch(f.snapshot()['executors.cjs'], /__pycache__|\.pyc|\.pyo|\.DS_Store/)
})

test('real evaluator source changes still update the package digest, evaluator digest and Runtime image tag', t => {
  const f = fixture(t)
  const baseline = f.snapshot()
  const before: CatalogLock = JSON.parse(baseline['catalog-lock.json'])
  fs.appendFileSync(path.join(f.root, 'benchmarks/zsoft-l1/evaluator/entrypoint.py'), '\n# changed evaluator source\n')
  const changed = f.snapshot()
  const after: CatalogLock = JSON.parse(changed['catalog-lock.json'])
  assert.deepEqual(after.packages[0], before.packages[0])
  assert.notEqual(after.packages[1].digest, before.packages[1].digest)
  assert.notEqual(after.packages[1].evaluatorDigest, before.packages[1].evaluatorDigest)
  assert.notEqual(changed['evaluators.cjs'], baseline['evaluators.cjs'])
  assert.ok(changed['evaluators.cjs'].includes(`artifact-${after.packages[1].evaluatorDigest.slice('sha256:'.length)}`))
})

test('real dataset source changes update the package digest but not the evaluator digest', t => {
  const f = fixture(t)
  const before = f.lock()
  fs.appendFileSync(path.join(f.root, 'benchmarks/zsoft-l1/dataset/prepare.ts'), '\n// changed dataset source\n')
  const after = f.lock()
  assert.deepEqual(after.packages[0], before.packages[0])
  assert.notEqual(after.packages[1].digest, before.packages[1].digest)
  assert.equal(after.packages[1].evaluatorDigest, before.packages[1].evaluatorDigest)
})

test('real shared configuration loader changes still invalidate both Runtime digests', t => {
  const f = fixture(t)
  const before = f.lock()
  fs.appendFileSync(path.join(f.root, 'packages/project-config/index.cjs'), '\n// changed shared config loader\n')
  const after = f.lock()
  for (let index = 0; index < before.packages.length; index++) {
    assert.notEqual(after.packages[index].digest, before.packages[index].digest)
    assert.notEqual(after.packages[index].evaluatorDigest, before.packages[index].evaluatorDigest)
  }
})

for (const dependency of ['services/evaluator/src/runtime-image.cjs', 'services/evaluator/src/evaluator-assets.cjs', 'packages/benchmark-protocol/artifact-path.cjs']) {
  test(`shared Runtime dependency ${dependency} updates digests and image tags`, t => {
    const f = fixture(t)
    const before = f.lock()
    fs.appendFileSync(path.join(f.root, dependency), '\n// changed Runtime dependency\n')
    const snapshot = f.snapshot()
    const after: CatalogLock = JSON.parse(snapshot['catalog-lock.json'])
    for (let index = 0; index < before.packages.length; index++) {
      assert.notEqual(after.packages[index].digest, before.packages[index].digest)
      assert.notEqual(after.packages[index].evaluatorDigest, before.packages[index].evaluatorDigest)
      assert.ok(snapshot['evaluators.cjs'].includes(`artifact-${after.packages[index].evaluatorDigest.slice('sha256:'.length)}`))
    }
  })
}
