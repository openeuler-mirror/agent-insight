import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const startScript = path.resolve('scripts/start.sh')

test('start.sh prepares SWE-bench by default and rejects the removed benchmark argument', () => {
  const help = spawnSync('bash', [startScript, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.doesNotMatch(help.stdout, /--benchmark|AGENT_INSIGHT_BENCHMARK/)
  assert.match(help.stdout, /--port PORT/)
  assert.match(help.stdout, /SWE-bench Verified is prepared automatically/)

  const missing = spawnSync('bash', [startScript, '--benchmark'], { encoding: 'utf8' })
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /不支持的参数：--benchmark/)

  const unsupported = spawnSync('bash', [startScript, '--benchmark', 'unknown'], { encoding: 'utf8' })
  assert.notEqual(unsupported.status, 0)
  assert.match(unsupported.stderr, /不支持的参数：--benchmark/)

  const empty = spawnSync('bash', [startScript, '--benchmark='], { encoding: 'utf8' })
  assert.notEqual(empty.status, 0)
  assert.match(empty.stderr, /不支持的参数：--benchmark=/)

  const missingPort = spawnSync('bash', [startScript, '--port'], { encoding: 'utf8' })
  assert.notEqual(missingPort.status, 0)
  assert.match(missingPort.stderr, /--port 缺少参数值/)
})

test('SWE-bench bootstrap explains how to fix a missing Python venv module', () => {
  const source = fs.readFileSync(path.resolve('scripts/benchmark/ensure-swe-bench-dataset.ts'), 'utf8')
  assert.match(source, /缺少 python3-venv，请安装后重试/)
})

test('start.sh ignores the removed benchmark environment variable', () => {
  const managedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-start-config-'))
  fs.writeFileSync(path.join(managedHome, '.env'), 'AGENT_INSIGHT_BENCHMARK=unknown\n', 'utf8')
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, AGENT_INSIGHT_HOME: managedHome, AGENT_INSIGHT_BENCHMARK: 'also-unknown' }
    delete env.PORT
    delete env.AGENT_INSIGHT_DATA_DIR
    const result = spawnSync('bash', [startScript, '--port', 'invalid'], {
      encoding: 'utf8',
      env,
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /AGENT_INSIGHT_PORT \/ --port 必须是/)
    assert.doesNotMatch(result.stderr, /Benchmark/)
    assert.doesNotMatch(result.stdout, /Syncing database schema/)
  } finally {
    fs.rmSync(managedHome, { recursive: true, force: true })
  }
})

test('startup continues after bootstrap failures with four-line warnings and detailed logs', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-bootstrap-warning-'))
  const managedHome = path.join(testDir, 'managed home')
  const binDir = path.join(testDir, 'bin')
  fs.mkdirSync(binDir)
  fs.writeFileSync(path.join(binDir, 'npx'), `#!${process.execPath}
console.log(process.env.BOOTSTRAP_TEST_OUTPUT)
console.error(process.env.BOOTSTRAP_TEST_ERROR)
process.exit(Number(process.env.BOOTSTRAP_TEST_STATUS))
`, { mode: 0o755 })
  const source = fs.readFileSync(startScript, 'utf8')
  const bootstrapStart = source.indexOf('if ! node scripts/benchmark/bootstrap-swe-bench-dataset.cjs; then')
  const buildStart = source.indexOf('echo "Building project..."', bootstrapStart)
  assert.ok(bootstrapStart > 0 && buildStart > bootstrapStart)
  const startupStep = source.slice(bootstrapStart, buildStart) + 'echo "Building project..."\n'
  const cases = [
    { error: 'curl 执行失败：curl: (28) Operation timed out', reason: '下载超时', advice: 'dataset.source' },
    { error: 'curl 执行失败：curl: (7) Failed to connect', reason: '下载失败', advice: 'dataset.source' },
    { output: '下载SWE-bench 官方源码：https://example.test/archive', error: 'curl 执行失败：curl: (28) Timeout', reason: '下载超时', advice: 'loader.sourceArchive' },
    { error: 'SWE-bench Verified 数据集哈希校验失败：期望 pinned，实际 invalid', reason: '文件哈希校验失败', advice: '官方版本' },
    { error: 'SWE-bench Verified 数据集本机文件不存在或不是普通文件：/missing', reason: '本机来源文件不可用', advice: '指定的文件' },
    { error: '无法创建 Python 虚拟环境，可能缺少 python3-venv，请安装后重试。', reason: 'Python 环境准备或加载失败', advice: 'loader.python' },
    { output: '复用 SWE-bench Python 环境：/home/.venv/bin/python', error: 'PrismaClientKnownRequestError: database is locked', reason: '自动准备或数据库导入失败', advice: '具体错误' },
  ]
  try {
    const env = {
      ...process.env,
      AGENT_INSIGHT_HOME: managedHome,
      AGENT_INSIGHT_CONFIG_DIR: path.join(testDir, 'config'),
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    }
    for (const failure of cases) {
      const result = spawnSync('bash', [], {
        input: startupStep,
        encoding: 'utf8',
        env: { ...env, BOOTSTRAP_TEST_OUTPUT: failure.output || '', BOOTSTRAP_TEST_ERROR: failure.error, BOOTSTRAP_TEST_STATUS: '1' },
      })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /Building project/)
      assert.equal(result.stderr.trim().split('\n').length, 4)
      assert.ok(result.stderr.includes(failure.reason), result.stderr)
      assert.ok(result.stderr.includes(failure.advice), result.stderr)
      assert.match(result.stderr, /下次启动自动重试/)
      const logPath = path.join(managedHome, 'logs', 'swe-bench-bootstrap.log')
      assert.ok(result.stderr.includes(logPath))
      const detail = fs.readFileSync(logPath, 'utf8')
      assert.ok(detail.includes(failure.error))
      if (failure.output) assert.ok(detail.includes(failure.output))
    }
    const success = spawnSync('bash', [], {
      input: startupStep,
      encoding: 'utf8',
      env: { ...env, BOOTSTRAP_TEST_OUTPUT: 'already-installed', BOOTSTRAP_TEST_ERROR: '', BOOTSTRAP_TEST_STATUS: '0' },
    })
    assert.equal(success.status, 0)
    assert.equal(success.stderr, '')
    assert.match(success.stdout, /数据集已就绪/)
    assert.match(success.stdout, /Building project/)
    assert.doesNotMatch(fs.readFileSync(path.join(managedHome, 'logs', 'swe-bench-bootstrap.log'), 'utf8'), /database is locked/)
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true })
  }
})

test('bootstrap logging failures do not stop startup or point to a nonexistent log', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-bootstrap-log-'))
  fs.writeFileSync(path.join(testDir, 'logs'), 'not a directory')
  try {
    const result = spawnSync(process.execPath, ['scripts/benchmark/bootstrap-swe-bench-dataset.cjs'], {
      encoding: 'utf8',
      env: { ...process.env, AGENT_INSIGHT_HOME: testDir },
    })
    assert.equal(result.status, 0)
    assert.equal(result.stderr.trim().split('\n').length, 4)
    assert.match(result.stderr, /将继续启动服务/)
    assert.match(result.stderr, /写入权限/)
    assert.doesNotMatch(result.stderr, /详细错误见/)
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true })
  }
})

test('start.sh accepts a one-shot port override before startup side effects', () => {
  const managedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-start-port-'))
  fs.writeFileSync(path.join(managedHome, '.env'), 'AGENT_INSIGHT_PORT=3100\n', 'utf8')
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, AGENT_INSIGHT_HOME: managedHome, AGENT_INSIGHT_PORT: 'invalid' }
    delete env.PORT
    delete env.AGENT_INSIGHT_DATA_DIR
    const result = spawnSync('bash', [startScript], { encoding: 'utf8', env })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /AGENT_INSIGHT_PORT \/ --port 必须是 1 到 65535 的整数：invalid/)
    assert.doesNotMatch(result.stdout, /Syncing database schema/)

    const cli = spawnSync('bash', [startScript, '--port', 'also-invalid'], {
      encoding: 'utf8',
      env: { ...env, AGENT_INSIGHT_PORT: '3100' },
    })
    assert.notEqual(cli.status, 0)
    assert.match(cli.stderr, /AGENT_INSIGHT_PORT \/ --port 必须是 1 到 65535 的整数：also-invalid/)
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
    const env: NodeJS.ProcessEnv = { ...process.env, AGENT_INSIGHT_HOME: managedHome }
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

test('SWE-bench bootstrap reads project configuration and retains managed cache paths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-bootstrap-config-'))
  const previousHome = process.env.AGENT_INSIGHT_HOME
  const previousConfig = process.env.AGENT_INSIGHT_CONFIG_DIR
  process.env.AGENT_INSIGHT_HOME = root
  process.env.AGENT_INSIGHT_CONFIG_DIR = path.join(root, 'config')
  fs.mkdirSync(process.env.AGENT_INSIGHT_CONFIG_DIR)
  fs.writeFileSync(path.join(process.env.AGENT_INSIGHT_CONFIG_DIR, 'platform.local.yaml'), JSON.stringify({ benchmarks: {
    'swe-bench': { dataset: { source: 'http://mirror.example.test/test.parquet' }, loader: { sourceArchive: 'http://mirror.example.test/source.tar.gz' } },
  } }))
  try {
    const { resolveSweBenchProvisionPaths } = await import('../scripts/benchmark/ensure-swe-bench-dataset')
    const paths = resolveSweBenchProvisionPaths()
    assert.equal(paths.datasetPath, path.join(root, 'data/imports/swe-bench-verified/test.parquet'))
    assert.equal(paths.pythonPath, path.join(root, 'vendor/SWE-bench/.venv/bin/python'))
    assert.equal(paths.datasetSource, 'http://mirror.example.test/test.parquet')
    assert.equal(paths.sourceArchiveSource, 'http://mirror.example.test/source.tar.gz')
    assert.equal(paths.customPythonPath, false)
  } finally {
    if (previousHome === undefined) delete process.env.AGENT_INSIGHT_HOME
    else process.env.AGENT_INSIGHT_HOME = previousHome
    if (previousConfig === undefined) delete process.env.AGENT_INSIGHT_CONFIG_DIR
    else process.env.AGENT_INSIGHT_CONFIG_DIR = previousConfig
    fs.rmSync(root, { recursive: true, force: true })
  }
})
