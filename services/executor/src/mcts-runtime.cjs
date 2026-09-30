'use strict'

const { createHash } = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { BenchmarkExecutorError, runProcess } = require('./index.cjs')

const RUN_ID = /^erun_[0-9a-f]{32}$/
const INSTANCE_ID = /^[A-Za-z0-9_.-]{1,200}$/
const MAX_PATCH_BYTES = 10 * 1024 * 1024

function mctsPaths(config) {
  const repoDir = String(config.mctsRepoDir || '').trim()
  const traceLauncher = String(config.mctsTraceLauncher || '').trim()
  const python = String(config.mctsPython || '').trim()
  return {
    repoDir,
    traceLauncher,
    python: python || path.join(repoDir, '.venv', 'bin', 'python'),
    entrypoint: path.join(repoDir, 'testcases_union', 'run_union.sh'),
    configEnv: path.join(repoDir, 'testcases_union', 'config.env'),
    main: path.join(repoDir, 'testcases_union', 'core', 'main.py'),
  }
}

function probeMctsBenchmarkRuntime(config) {
  const paths = mctsPaths(config)
  if (!path.isAbsolute(paths.repoDir)) return { ready: false, reason: 'MCTS 仓库路径未配置' }
  if (!path.isAbsolute(paths.traceLauncher)) return { ready: false, reason: 'MCTS Trace 启动器路径未配置' }
  if (!path.isAbsolute(paths.python)) return { ready: false, reason: 'MCTS Python 路径必须是绝对路径' }
  for (const [target, label] of [
    [paths.entrypoint, 'MCTS 启动脚本'],
    [paths.configEnv, 'MCTS config.env'],
    [paths.python, 'MCTS Python 虚拟环境'],
    [paths.main, 'MCTS 主程序'],
    [paths.traceLauncher, 'MCTS Trace 启动器'],
    [path.join(path.dirname(paths.traceLauncher), 'core.cjs'), 'MCTS Trace 核心'],
    [path.join(path.dirname(paths.traceLauncher), 'gateway.cjs'), 'MCTS Trace 网关'],
    [path.join(path.dirname(paths.traceLauncher), '..', 'shared', 'trace-transport.cjs'), 'Trace 上传组件'],
    [path.join(path.dirname(paths.traceLauncher), '..', 'shared', 'collaboration-transport.cjs'), '协作关系上传组件'],
  ]) {
    try {
      if (!fs.statSync(target).isFile()) return { ready: false, reason: `${label} 不存在` }
    } catch { return { ready: false, reason: `${label} 不存在` } }
  }
  try {
    if (!fs.readFileSync(paths.main, 'utf8').includes('--output-dir')) {
      return { ready: false, reason: 'MCTS 未支持 --output-dir' }
    }
  } catch { return { ready: false, reason: 'MCTS 程序不可读' } }
  const python = spawnSync(paths.python, ['-c', 'import sys; import datasets; print(f"{sys.version_info.major}.{sys.version_info.minor}")'], {
    encoding: 'utf8', timeout: 2_000,
  })
  const pythonVersion = /^([0-9]+)\.([0-9]+)$/.exec(String(python.stdout || '').trim())
  if (python.status !== 0 || !pythonVersion || Number(pythonVersion[1]) < 3
    || (Number(pythonVersion[1]) === 3 && Number(pythonVersion[2]) < 11)) {
    return { ready: false, reason: 'MCTS Python 需要 3.11+ 和 datasets' }
  }
  const configPath = path.join(path.dirname(paths.traceLauncher), 'config.json')
  try {
    const traceConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    if (traceConfig.proxyEnabled === false || (!traceConfig.apiKey && !process.env.AGENT_INSIGHT_API_KEY)) {
      return { ready: false, reason: 'MCTS Trace 代理未启用或缺少 API Key' }
    }
  } catch {
    if (!process.env.AGENT_INSIGHT_API_KEY) return { ready: false, reason: 'MCTS Trace 代理配置不可用' }
  }
  return { ready: true }
}

async function mctsTraceId(observerHome) {
  const traceRoot = path.join(observerHome, 'otel_data', 'mcts-xgovernor')
  const entries = await fsp.readdir(traceRoot, { withFileTypes: true })
  const directories = entries.filter(entry => entry.isDirectory())
  if (directories.length !== 1) throw new BenchmarkExecutorError('MCTS_TRACE_UNAVAILABLE', 'MCTS Trace 目录不唯一')
  const ledger = JSON.parse(await fsp.readFile(path.join(traceRoot, directories[0].name, 'runtime-ledger.json'), 'utf8'))
  if (!Array.isArray(ledger.runs) || ledger.runs.length !== 1 || !/^mcts\.run\.[0-9a-f]{32}$/.test(ledger.runs[0]?.sessionId)) {
    throw new BenchmarkExecutorError('MCTS_TRACE_UNAVAILABLE', 'MCTS 未生成唯一的根 Trace')
  }
  return createHash('sha256').update(`mcts-xgovernor\u001f${ledger.runs[0].sessionId}`).digest('hex').slice(0, 32)
}

function validateMctsTask(payload) {
  const runId = String(payload.correlation?.caseRunId || '')
  const publicCase = payload.benchmarkPayload
  const instanceId = String(publicCase?.instanceId || '')
  const repo = String(publicCase?.repo || '')
  const baseCommit = String(publicCase?.baseCommit || '')
  const expectedRepository = `https://github.com/${repo}.git`
  if (payload.benchmarkKey !== 'swe-bench' || payload.platform !== 'pi-mcts' || payload.agent !== 'pi-mcts') {
    throw new BenchmarkExecutorError('MCTS_TASK_UNSUPPORTED', 'MCTS 仅支持 SWE-bench 的 pi-mcts Agent')
  }
  if (!RUN_ID.test(runId) || !INSTANCE_ID.test(instanceId)) {
    throw new BenchmarkExecutorError('MCTS_TASK_INVALID', 'MCTS 运行 ID 或 SWE-bench Case ID 不合法')
  }
  if (payload.model) {
    throw new BenchmarkExecutorError('MCTS_MODEL_UNSUPPORTED', 'MCTS 模型由 xGovernor 服务端配置，请选择平台默认模型')
  }
  if (payload.workspace?.repository !== expectedRepository || payload.workspace?.revision !== baseCommit) {
    throw new BenchmarkExecutorError('MCTS_TASK_MISMATCH', 'SWE-bench Case 与 Git 工作区版本不一致')
  }
  return { runId, instanceId }
}

async function runMctsBenchmarkCase(config, payload, processRunner = runProcess) {
  const { runId, instanceId } = validateMctsTask(payload)
  const readiness = probeMctsBenchmarkRuntime(config)
  if (!readiness.ready) throw new BenchmarkExecutorError('MCTS_RUNTIME_UNAVAILABLE', readiness.reason, 503)
  const paths = mctsPaths(config)
  const outputDir = path.join(paths.repoDir, 'testcases_union', 'output', 'sweverified', runId)
  const observerHome = path.join(outputDir, '.agent-insight')
  const patchPath = path.join(outputDir, 'artifact.patch')
  try {
    await fsp.lstat(outputDir)
    throw new BenchmarkExecutorError('MCTS_OUTPUT_CONFLICT', '本次运行的 MCTS 输出目录已存在')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await fsp.mkdir(outputDir, { recursive: true })
  const interpreterBin = path.join(observerHome, 'bin')
  await fsp.mkdir(interpreterBin, { recursive: true })
  await fsp.symlink(paths.python, path.join(interpreterBin, 'python'))
  const env = {
    ...process.env,
    PATH: `${interpreterBin}${path.delimiter}${process.env.PATH || ''}`,
    AGENT_INSIGHT_HOME: observerHome,
  }
  try {
    await processRunner(process.execPath, [
      paths.traceLauncher, '--strict', '--config', path.join(path.dirname(paths.traceLauncher), 'config.json'),
      '--', 'bash', paths.entrypoint,
      '--mode', 'sweverified', '--runtime', 'pi', '--testbench', 'sweverified', '--instance-id', instanceId,
      '--split', 'test', '--output-dir', runId,
    ], {
      cwd: paths.repoDir,
      env,
      signal: payload.signal,
      timeoutMs: Math.max(1, Number(payload.timeoutSeconds) || 600) * 1_000,
      killProcessGroup: true,
      abortSignal: 'SIGINT',
      timeoutSignal: 'SIGINT',
      terminateGraceMs: 30_000,
      maxOutputBytes: 1024 * 1024,
      errorCode: 'MCTS_RUN_FAILED',
      timeoutErrorCode: 'AGENT_TIMEOUT',
    })
    payload.signal?.throwIfAborted()
    let stat
    try { stat = await fsp.lstat(patchPath) } catch {
      throw new BenchmarkExecutorError('AGENT_NO_OUTPUT', 'MCTS 未生成最终 artifact.patch')
    }
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_PATCH_BYTES) {
      throw new BenchmarkExecutorError('ARTIFACT_SIZE_INVALID', 'MCTS 最终 Patch 为空、过大或不是普通文件')
    }
    await processRunner('git', ['apply', '--check', '--binary', patchPath], {
      cwd: payload.cwd, signal: payload.signal, errorCode: 'MCTS_PATCH_INVALID',
    })
    await processRunner('git', ['apply', '--binary', patchPath], {
      cwd: payload.cwd, signal: payload.signal, errorCode: 'MCTS_PATCH_INVALID',
    })
    return { traceId: await mctsTraceId(observerHome), exitCode: 0, timedOut: false }
  } catch (error) {
    if (error && typeof error === 'object') {
      const traceId = await mctsTraceId(observerHome).catch(() => null)
      if (traceId) error.runFacts = { traceId }
    }
    throw error
  }
}

module.exports = { mctsTraceId, probeMctsBenchmarkRuntime, runMctsBenchmarkCase, validateMctsTask }
