#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { getAgentInsightHome } = require('./agent-insight-home.cjs')

function usage() {
  return [
    'Usage:',
    '  node scripts/configure-evaluator-target.js \\',
    '    --evaluator-base-url URL \\',
    '    [--executor-callback-base-url URL] \\',
    '    [--allow-insecure-http true|false]',
    '',
    '服务通信依赖网络白名单；默认允许受控网络中的 HTTP。',
  ].join('\n')
}

function parseArgs(args) {
  const options = { allowInsecureHttp: 'true' }
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]
    if (name === '--help' || name === '-h') return { help: true }
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数值`)
    if (name === '--executor-callback-base-url') options.executorCallbackBaseUrl = value
    else if (name === '--evaluator-base-url') options.evaluatorBaseUrl = value
    else if (name === '--allow-insecure-http') options.allowInsecureHttp = value
    else if (name === '--config-file') options.configFile = value
    else throw new Error(`不支持的参数：${name}`)
    index += 1
  }
  if (!options.evaluatorBaseUrl) throw new Error('必须提供 --evaluator-base-url')
  if (!['true', 'false'].includes(options.allowInsecureHttp)) {
    throw new Error('--allow-insecure-http 必须是 true 或 false')
  }
  return options
}

function normalizeUrl(value, label) {
  let url
  try { url = new URL(String(value).trim()) } catch { throw new Error(`${label} 不是合法 URL`) }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error(`${label} 必须是无凭证、query 和 fragment 的 HTTP(S) URL`)
  }
  return url.toString().replace(/\/$/, '')
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function defaultConfigPath() {
  const agentInsightHome = getAgentInsightHome()
  return path.join(agentInsightHome, 'data', 'config', 'benchmark-evaluator.env')
}

function atomicWrite(filePath, content) {
  const directory = path.dirname(filePath)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700)
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  const handle = fs.openSync(temporary, 'w', 0o600)
  try {
    fs.writeFileSync(handle, content, 'utf8')
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
  fs.renameSync(temporary, filePath)
  if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600)
  try {
    const directoryHandle = fs.openSync(directory, 'r')
    try { fs.fsyncSync(directoryHandle) } finally { fs.closeSync(directoryHandle) }
  } catch {}
}

async function configure(args = process.argv.slice(2)) {
  const options = parseArgs(args)
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
    return { help: true }
  }
  const executorCallbackBaseUrl = options.executorCallbackBaseUrl
    ? normalizeUrl(options.executorCallbackBaseUrl, 'Executor Callback Base URL')
    : undefined
  const evaluatorBaseUrl = normalizeUrl(options.evaluatorBaseUrl, 'Evaluator Base URL')
  if (
    new URL(evaluatorBaseUrl).protocol === 'http:'
    && !isLoopback(new URL(evaluatorBaseUrl).hostname)
    && options.allowInsecureHttp !== 'true'
  ) {
    throw new Error('非本机 Evaluator Base URL 必须使用 HTTPS，或显式允许受控内网 HTTP')
  }
  const configPath = path.resolve(options.configFile || defaultConfigPath())
  const content = [
    '# Agent Insight Benchmark Evaluator runtime configuration.',
    ...(executorCallbackBaseUrl
      ? [`AGENT_INSIGHT_BENCHMARK_EXECUTOR_CALLBACK_BASE_URL=${JSON.stringify(executorCallbackBaseUrl)}`]
      : []),
    `AGENT_INSIGHT_BENCHMARK_EVALUATOR_BASE_URL=${JSON.stringify(evaluatorBaseUrl)}`,
    `AGENT_INSIGHT_BENCHMARK_EVALUATOR_ALLOW_INSECURE_HTTP=${options.allowInsecureHttp}`,
    '',
  ].join('\n')
  atomicWrite(configPath, content)
  process.stdout.write(`Evaluator 运行时配置已原子更新：${configPath}\n`)
  process.stdout.write('提示：服务通信不校验应用层 Token，必须由白名单、安全组或防火墙限制互访。\n')
  process.stdout.write('Agent Insight 将在下一次相关请求中热加载，无需重启。\n')
  return { configPath }
}

if (require.main === module) {
  configure().catch((error) => {
    process.stderr.write(`配置失败：${error.message}\n${usage()}\n`)
    process.exitCode = 1
  })
}

module.exports = {
  atomicWrite,
  configure,
  normalizeUrl,
  parseArgs,
}
