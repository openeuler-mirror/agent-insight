import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const startScript = path.resolve('scripts/start.sh')

test('start.sh documents and validates benchmark bootstrap arguments before startup', () => {
  const help = spawnSync('bash', [startScript, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /--benchmark KEY/)
  assert.match(help.stdout, /swe-bench/)

  const missing = spawnSync('bash', [startScript, '--benchmark'], { encoding: 'utf8' })
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /缺少参数值/)

  const unsupported = spawnSync('bash', [startScript, '--benchmark', 'unknown'], { encoding: 'utf8' })
  assert.notEqual(unsupported.status, 0)
  assert.match(unsupported.stderr, /当前支持：swe-bench/)

  const empty = spawnSync('bash', [startScript, '--benchmark='], { encoding: 'utf8' })
  assert.notEqual(empty.status, 0)
  assert.match(empty.stderr, /缺少参数值/)
})

test('SWE-bench bootstrap explains how to fix a missing Python venv module', () => {
  const source = fs.readFileSync(path.resolve('scripts/benchmark/ensure-swe-bench-dataset.ts'), 'utf8')
  assert.match(source, /缺少 python3-venv，请安装后重试/)
})

test('SWE-bench bootstrap uses managed paths unless advanced overrides are set', async () => {
  const previousHome = process.env.AGENT_INSIGHT_DATA_DIR
  const previousDataset = process.env.SWE_BENCH_DATASET_PATH
  const previousPython = process.env.SWE_BENCH_PYTHON
  const managedHome = path.resolve('/tmp/agent-insight-benchmark-bootstrap-test')
  process.env.AGENT_INSIGHT_DATA_DIR = managedHome
  delete process.env.SWE_BENCH_DATASET_PATH
  delete process.env.SWE_BENCH_PYTHON
  try {
    const provisioner = await import('../scripts/benchmark/ensure-swe-bench-dataset')
    const paths = provisioner.resolveSweBenchProvisionPaths()
    assert.equal(paths.datasetPath, path.join(managedHome, 'data', 'imports', 'swe-bench-verified', 'test.parquet'))
    assert.equal(paths.pythonPath, path.join(managedHome, 'vendor', 'SWE-bench', '.venv', 'bin', 'python'))
    assert.match(paths.sourceArchivePath, new RegExp(provisioner.SWE_BENCH_SOURCE_COMMIT))
    assert.equal(paths.customDatasetPath, false)
    assert.equal(paths.customPythonPath, false)
  } finally {
    if (previousHome == null) delete process.env.AGENT_INSIGHT_DATA_DIR
    else process.env.AGENT_INSIGHT_DATA_DIR = previousHome
    if (previousDataset == null) delete process.env.SWE_BENCH_DATASET_PATH
    else process.env.SWE_BENCH_DATASET_PATH = previousDataset
    if (previousPython == null) delete process.env.SWE_BENCH_PYTHON
    else process.env.SWE_BENCH_PYTHON = previousPython
  }
})
