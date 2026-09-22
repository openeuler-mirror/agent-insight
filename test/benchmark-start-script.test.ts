import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const startScript = path.resolve('scripts/start.sh')

test('start.sh documents and validates benchmark bootstrap arguments before startup', () => {
  const help = spawnSync('bash', [startScript, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /--benchmark KEY/)
  assert.match(help.stdout, /--port PORT/)
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

  const missingPort = spawnSync('bash', [startScript, '--port'], { encoding: 'utf8' })
  assert.notEqual(missingPort.status, 0)
  assert.match(missingPort.stderr, /--port 缺少参数值/)
})

test('SWE-bench bootstrap explains how to fix a missing Python venv module', () => {
  const source = fs.readFileSync(path.resolve('scripts/benchmark/ensure-swe-bench-dataset.ts'), 'utf8')
  assert.match(source, /缺少 python3-venv，请安装后重试/)
})

test('start.sh reads the default benchmark from AGENT_INSIGHT_HOME/.env before startup side effects', () => {
  const managedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-start-config-'))
  fs.writeFileSync(path.join(managedHome, '.env'), 'AGENT_INSIGHT_BENCHMARK=unknown\n', 'utf8')
  try {
    const env = { ...process.env, AGENT_INSIGHT_HOME: managedHome }
    delete env.AGENT_INSIGHT_DATA_DIR
    delete env.AGENT_INSIGHT_BENCHMARK
    const result = spawnSync('bash', [startScript], {
      encoding: 'utf8',
      env,
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /当前支持：swe-bench/)
    assert.doesNotMatch(result.stdout, /Syncing database schema/)
  } finally {
    fs.rmSync(managedHome, { recursive: true, force: true })
  }
})

test('start.sh accepts a one-shot port override before startup side effects', () => {
  const managedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-start-port-'))
  fs.writeFileSync(path.join(managedHome, '.env'), 'PORT=3100\n', 'utf8')
  try {
    const env = { ...process.env, AGENT_INSIGHT_HOME: managedHome, PORT: 'invalid' }
    delete env.AGENT_INSIGHT_DATA_DIR
    const result = spawnSync('bash', [startScript], { encoding: 'utf8', env })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /PORT 必须是 1 到 65535 的整数：invalid/)
    assert.doesNotMatch(result.stdout, /Syncing database schema/)

    const cli = spawnSync('bash', [startScript, '--port', 'also-invalid'], {
      encoding: 'utf8',
      env: { ...env, PORT: '3100' },
    })
    assert.notEqual(cli.status, 0)
    assert.match(cli.stderr, /PORT 必须是 1 到 65535 的整数：also-invalid/)
    assert.doesNotMatch(cli.stdout, /Syncing database schema/)
  } finally {
    fs.rmSync(managedHome, { recursive: true, force: true })
  }
})

test('start.sh explains an inaccessible custom SQLite target before destructive startup work', () => {
  const managedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-start-sqlite-'))
  const missingDir = path.join(managedHome, 'missing', 'nested')
  fs.writeFileSync(path.join(managedHome, '.env'), `DATABASE_URL=file:${missingDir}/test.db\n`, 'utf8')
  try {
    const env = { ...process.env, AGENT_INSIGHT_HOME: managedHome }
    delete env.AGENT_INSIGHT_DATA_DIR
    delete env.DATABASE_URL
    const result = spawnSync('bash', [startScript, '--port', '31999'], { encoding: 'utf8', env })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /SQLite 数据库父目录不存在/)
    assert.match(result.stderr, new RegExp(missingDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(result.stderr, /mkdir -p/)
    assert.doesNotMatch(result.stdout, /Clearing Next\.js build cache/)
    assert.doesNotMatch(result.stdout, /Syncing database schema/)
  } finally {
    fs.rmSync(managedHome, { recursive: true, force: true })
  }
})

test('SWE-bench bootstrap uses managed paths unless advanced overrides are set', async () => {
  const previousHome = process.env.AGENT_INSIGHT_HOME
  const previousLegacyHome = process.env.AGENT_INSIGHT_DATA_DIR
  const previousDataset = process.env.SWE_BENCH_DATASET_PATH
  const previousDatasetUrl = process.env.SWE_BENCH_DATASET_URL
  const previousSourceUrl = process.env.SWE_BENCH_SOURCE_ARCHIVE_URL
  const previousDatasetSource = process.env.SWE_BENCH_DATASET_SOURCE
  const previousArchiveSource = process.env.SWE_BENCH_SOURCE_ARCHIVE_SOURCE
  const previousPython = process.env.SWE_BENCH_PYTHON
  const managedHome = path.resolve('/tmp/agent-insight-benchmark-bootstrap-test')
  process.env.AGENT_INSIGHT_HOME = managedHome
  delete process.env.AGENT_INSIGHT_DATA_DIR
  delete process.env.SWE_BENCH_DATASET_PATH
  delete process.env.SWE_BENCH_DATASET_SOURCE
  delete process.env.SWE_BENCH_SOURCE_ARCHIVE_SOURCE
  process.env.SWE_BENCH_DATASET_URL = 'http://mirror.example.test/swe-bench/test.parquet'
  process.env.SWE_BENCH_SOURCE_ARCHIVE_URL = 'http://mirror.example.test/swe-bench/source.tar.gz'
  delete process.env.SWE_BENCH_PYTHON
  try {
    const provisioner = await import('../scripts/benchmark/ensure-swe-bench-dataset')
    const paths = provisioner.resolveSweBenchProvisionPaths()
    assert.equal(paths.datasetPath, path.join(managedHome, 'data', 'imports', 'swe-bench-verified', 'test.parquet'))
    assert.equal(paths.pythonPath, path.join(managedHome, 'vendor', 'SWE-bench', '.venv', 'bin', 'python'))
    assert.match(paths.sourceArchivePath, new RegExp(provisioner.SWE_BENCH_SOURCE_COMMIT))
    assert.equal(paths.customPythonPath, false)
    assert.equal(paths.datasetSource, process.env.SWE_BENCH_DATASET_URL)
    assert.equal(paths.sourceArchiveSource, process.env.SWE_BENCH_SOURCE_ARCHIVE_URL)
  } finally {
    if (previousHome == null) delete process.env.AGENT_INSIGHT_HOME
    else process.env.AGENT_INSIGHT_HOME = previousHome
    if (previousLegacyHome == null) delete process.env.AGENT_INSIGHT_DATA_DIR
    else process.env.AGENT_INSIGHT_DATA_DIR = previousLegacyHome
    if (previousDataset == null) delete process.env.SWE_BENCH_DATASET_PATH
    else process.env.SWE_BENCH_DATASET_PATH = previousDataset
    if (previousDatasetUrl == null) delete process.env.SWE_BENCH_DATASET_URL
    else process.env.SWE_BENCH_DATASET_URL = previousDatasetUrl
    if (previousSourceUrl == null) delete process.env.SWE_BENCH_SOURCE_ARCHIVE_URL
    else process.env.SWE_BENCH_SOURCE_ARCHIVE_URL = previousSourceUrl
    if (previousDatasetSource == null) delete process.env.SWE_BENCH_DATASET_SOURCE
    else process.env.SWE_BENCH_DATASET_SOURCE = previousDatasetSource
    if (previousArchiveSource == null) delete process.env.SWE_BENCH_SOURCE_ARCHIVE_SOURCE
    else process.env.SWE_BENCH_SOURCE_ARCHIVE_SOURCE = previousArchiveSource
    if (previousPython == null) delete process.env.SWE_BENCH_PYTHON
    else process.env.SWE_BENCH_PYTHON = previousPython
  }
})
