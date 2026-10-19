'use strict'
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { BenchmarkExecutorError, runProcess } = require('./index.cjs')
const { MCTS_SEARCH_OPTIONS_CAPABILITY, MCTS_RUNTIMES, normalizeAgentOptions, mctsOptionArgs } = require('./mcts-options.cjs')
const { mctsPaths, checkMctsRepository, mctsUpstream, proxyPythonScript, readMctsEnvFile } = require('./mcts-config.cjs')

const { readBoundedFile } = require('./public-bundle.cjs')
const { validateZsoftTasksSpec } = require('./zsoft-tasks.cjs')
const ZSOFT_CAPABILITY = 'mcts-zsoft-export/v1'
const SWE_CAPABILITY = 'mcts-swe-bench/v1'

const RUN_ID = /^erun_[0-9a-f]{32}$/
const INSTANCE_ID = /^[A-Za-z0-9_.-]{1,200}$/
const MAX_PATCH_BYTES = 10 * 1024 * 1024

function probeMctsBenchmarkRuntime(config, benchmarkKey = 'swe-bench') {
  const paths = mctsPaths(config)
  if (!path.isAbsolute(paths.repoDir)) return { ready: false, reason: 'MCTS 仓库路径未配置' }
  if (!path.isAbsolute(paths.traceLauncher)) return { ready: false, reason: 'MCTS Trace 启动器路径未配置' }
  if (!path.isAbsolute(paths.python)) return { ready: false, reason: 'MCTS Python 路径必须是绝对路径' }
  const collectorDir = path.dirname(paths.traceLauncher)
  const transportDir = fs.existsSync(path.join(collectorDir, 'shared', 'trace-transport.cjs'))
    ? path.join(collectorDir, 'shared') : path.join(collectorDir, '..', 'shared')
  for (const [target, label] of [
    ...(benchmarkKey === 'swe-bench' ? [[paths.entrypoint, 'MCTS 启动脚本']] : []),
    [paths.configEnv, 'MCTS config.env'],
    [paths.python, 'MCTS Python 虚拟环境'],
    [paths.main, 'MCTS 主程序'],
    [paths.traceLauncher, 'MCTS Trace 启动器'],
    [path.join(path.dirname(paths.traceLauncher), 'core.cjs'), 'MCTS Trace 核心'],
    [path.join(path.dirname(paths.traceLauncher), 'gateway.cjs'), 'MCTS Trace 网关'],
    [path.join(transportDir, 'trace-transport.cjs'), 'Trace 上传组件'],
    [path.join(transportDir, 'collaboration-transport.cjs'), '协作关系上传组件'],
  ]) {
    try {
      if (!fs.statSync(target).isFile()) return { ready: false, reason: `${label} 不存在` }
    } catch { return { ready: false, reason: `${label} 不存在` } }
  }
  try { checkMctsRepository(config, benchmarkKey) }
  catch (error) { return { ready: false, reason: error.message } }
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

function probeMctsZsoftRuntime(config) {
  const readiness = probeMctsBenchmarkRuntime(config, 'zsoft-l1')
  if (!readiness.ready) return readiness
  const paths = mctsPaths(config)
  const result = spawnSync(paths.python, [path.join(__dirname, 'mcts-zsoft-contract.py'), paths.repoDir], {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 65536,
  })
  if (result.error?.code === 'ETIMEDOUT') return { ready: false, reason: 'MCTS ZSoft 接口检查超过 5 秒' }
  try {
    const contract = JSON.parse(result.stdout)
    if (result.error || result.status !== 0 || contract.schemaVersion !== 'mcts-zsoft-contract/v1' || !/^sha256:[a-f0-9]{64}$/.test(contract.sourceDigest)) throw new Error()
    return { ready: true, contract }
  } catch {
    return { ready: false, reason: 'MCTS ZSoft 插件缺失或不兼容平台 PoC 导出接口' }
  }
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
  return ledger.runs[0].sessionId
}

function validateMctsTask(payload) {
  const runId = String(payload.correlation?.caseRunId || '')
  const publicCase = payload.benchmarkPayload
  const instanceId = String(publicCase?.instanceId || '')
  const repo = String(publicCase?.repo || '')
  const baseCommit = String(publicCase?.baseCommit || '')
  const expectedRepository = `https://github.com/${repo}.git`
  const runtime = Object.hasOwn(MCTS_RUNTIMES, payload.platform) ? MCTS_RUNTIMES[payload.platform] : null
  if (!['swe-bench', 'zsoft-l1'].includes(payload.benchmarkKey) || !runtime || payload.agent !== payload.platform) {
    throw new BenchmarkExecutorError('MCTS_TASK_UNSUPPORTED', 'MCTS 仅支持 SWE-bench / ZSoft 的 MCTS 执行目标')
  }
  if (!RUN_ID.test(runId) || (payload.benchmarkKey === 'swe-bench' && !INSTANCE_ID.test(instanceId))) {
    throw new BenchmarkExecutorError('MCTS_TASK_INVALID', 'MCTS 运行 ID 或 SWE-bench Case ID 不合法')
  }
  if (payload.model) {
    throw new BenchmarkExecutorError('MCTS_MODEL_UNSUPPORTED', 'MCTS 模型由 xGovernor 服务端配置，请选择平台默认模型')
  }
  if (payload.benchmarkKey === 'zsoft-l1') {
    validateZsoftTasksSpec(payload.workspace)
    if (publicCase?.taskId !== payload.workspace.taskId
      || !Array.isArray(publicCase.tags)
      || publicCase.tags.includes('kernel') === publicCase.tags.includes('userspace')
      || (publicCase.tags.includes('kernel') && publicCase.submissionKind !== 'c')
      || !['python', 'c', 'binary'].includes(publicCase.submissionKind)
      || !Number.isSafeInteger(publicCase.maxBytes) || publicCase.maxBytes < 1 || publicCase.maxBytes > 1048576) {
      throw new BenchmarkExecutorError('MCTS_TASK_MISMATCH', 'ZSoft Case 与任务目录或提交契约不一致')
    }
    let agentOptions
    try { agentOptions = normalizeAgentOptions(payload.agentOptions) }
    catch (error) { throw new BenchmarkExecutorError('AGENT_OPTIONS_INVALID', error.message) }
    return { runId, instanceId: publicCase.taskId, runtime, agentOptions, zsoft: true }
  }
  if (payload.workspace?.repository !== expectedRepository || payload.workspace?.revision !== baseCommit) {
    throw new BenchmarkExecutorError('MCTS_TASK_MISMATCH', 'SWE-bench Case 与 Git 工作区版本不一致')
  }
  let agentOptions
  try { agentOptions = normalizeAgentOptions(payload.agentOptions) }
  catch (error) { throw new BenchmarkExecutorError('AGENT_OPTIONS_INVALID', error.message) }
  return { runId, instanceId, runtime, agentOptions }
}

async function runMctsBenchmarkCase(config, payload, processRunner = runProcess) {
  const { runId, instanceId, runtime, agentOptions, zsoft } = validateMctsTask(payload)
  const readiness = zsoft ? probeMctsZsoftRuntime(config) : probeMctsBenchmarkRuntime(config)
  if (!readiness.ready) throw new BenchmarkExecutorError('MCTS_RUNTIME_UNAVAILABLE', readiness.reason, 503)
  const paths = mctsPaths(config)
  if (zsoft) {
    const metadata = JSON.parse((await readBoundedFile(payload.cwd, `tasks/${instanceId}/task.json`, 65536)).toString('utf8'))
    if (metadata.task_id !== instanceId || metadata.submission_kind !== payload.benchmarkPayload.submissionKind
      || metadata.max_bytes !== payload.benchmarkPayload.maxBytes) {
      throw new BenchmarkExecutorError('MCTS_TASK_MISMATCH', '公开任务包元数据与冻结 Case 不一致')
    }
  }
  let upstream
  try { upstream = mctsUpstream(paths) }
  catch (error) { throw new BenchmarkExecutorError('MCTS_CONFIG_INVALID', error.message) }
  const outputDir = path.join(paths.repoDir, 'testcases_union', 'output', zsoft ? 'zsoft' : 'sweverified', runId)
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
  await fsp.writeFile(path.join(interpreterBin, 'python'), proxyPythonScript(paths.python), { mode: 0o700 })
  const env = {
    ...process.env,
    PATH: `${interpreterBin}${path.delimiter}${process.env.PATH || ''}`,
    AGENT_INSIGHT_HOME: observerHome,
    AGENT_INSIGHT_MCTS_REPO_DIR: paths.repoDir,
    AGENT_INSIGHT_MCTS_PYTHON: paths.python,
    ...(zsoft ? { AGENT_INSIGHT_ZSOFT_WORKSPACE: payload.cwd, AGENT_INSIGHT_ZSOFT_SUBMISSION_KIND: payload.benchmarkPayload.submissionKind,
      AGENT_INSIGHT_ZSOFT_CONTRACT_DIGEST: readiness.contract.sourceDigest } : {}),
  }
  try {
    await processRunner(process.execPath, [
      paths.traceLauncher, '--strict', '--config', path.join(path.dirname(paths.traceLauncher), 'config.json'),
      '--upstream', upstream,
      '--', 'bash', zsoft ? path.join(__dirname, 'mcts-zsoft-launch.sh') : paths.entrypoint,
      ...(zsoft ? ['--mode', 'zsoft', '--runtime', runtime, '--task-id', instanceId]
        : ['--mode', 'sweverified', '--runtime', runtime, '--testbench', 'sweverified', '--instance-id', instanceId, '--split', 'test']),
      '--output-dir', runId,
      ...mctsOptionArgs(agentOptions),
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
    if (zsoft) {
      const metadata = JSON.parse((await readBoundedFile(outputDir, 'platform-export.json', 4096)).toString('utf8'))
      if (metadata.schemaVersion !== 'mcts-poc-export/v1' || metadata.taskId !== instanceId
        || metadata.evaluation !== 'deferred' || metadata.submissionKind !== payload.benchmarkPayload.submissionKind
        || metadata.mctsContract?.schemaVersion !== readiness.contract.schemaVersion
        || metadata.mctsContract?.sourceDigest !== readiness.contract.sourceDigest) {
        throw new BenchmarkExecutorError('MCTS_EXPORT_MISMATCH', 'MCTS 导出的 PoC 题目、类型或源码契约不一致')
      }
      const bytes = await readBoundedFile(outputDir, 'poc', payload.benchmarkPayload.maxBytes)
      if (!bytes.length) throw new BenchmarkExecutorError('AGENT_NO_OUTPUT', 'MCTS 未导出最终 PoC')
      const traceId = await mctsTraceId(observerHome)
      const submission = await fsp.lstat(path.join(payload.cwd, 'submission'))
      if (!submission.isDirectory() || submission.isSymbolicLink()) throw new BenchmarkExecutorError('MCTS_EXPORT_MISMATCH', '提交目录不合法')
      await fsp.writeFile(path.join(payload.cwd, 'submission', 'poc'), bytes, { flag: 'wx', mode: 0o600 })
      return { traceId, exitCode: 0, timedOut: false, mctsRuntime: runtime, mctsZsoftContract: readiness.contract, ...(agentOptions ? { agentOptions } : {}) }
    }
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
    return { traceId: await mctsTraceId(observerHome), exitCode: 0, timedOut: false,
      mctsRuntime: runtime, ...(agentOptions ? { agentOptions } : {}) }
  } catch (error) {
    if (error && typeof error === 'object') {
      const traceId = await mctsTraceId(observerHome).catch(() => null)
      error.runFacts = { ...(traceId ? { traceId } : {}), mctsRuntime: runtime,
        ...(agentOptions ? { agentOptions } : {}) }
    }
    throw error
  }
}

module.exports = { ZSOFT_CAPABILITY, SWE_CAPABILITY, probeMctsZsoftRuntime, mctsTraceId, probeMctsBenchmarkRuntime, runMctsBenchmarkCase, validateMctsTask, readMctsEnvFile,
  agentOptionCapabilities: [MCTS_SEARCH_OPTIONS_CAPABILITY] }
