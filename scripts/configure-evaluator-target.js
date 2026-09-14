#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function usage() {
  return [
    'Usage:',
    '  node scripts/configure-evaluator-target.js \\',
    '    --public-base-url URL --evaluator-base-url URL \\',
    '    [--executor-callback-base-url URL] \\',
    '    [--auth-mode token|none] \\',
    '    [--token-file FILE] [--previous-token-file FILE] \\',
    '    [--allow-insecure-http true|false]',
    '',
    'token 模式省略 --token-file 时，仅在交互式终端中无回显读取当前共享 Token。',
  ].join('\n')
}

function parseArgs(args) {
  const options = { authMode: 'token', previousTokenFiles: [], allowInsecureHttp: 'false' }
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]
    if (name === '--help' || name === '-h') return { help: true }
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数值`)
    if (name === '--public-base-url') options.publicBaseUrl = value
    else if (name === '--executor-callback-base-url') options.executorCallbackBaseUrl = value
    else if (name === '--evaluator-base-url') options.evaluatorBaseUrl = value
    else if (name === '--auth-mode') options.authMode = value
    else if (name === '--token-file') options.tokenFile = value
    else if (name === '--previous-token-file') options.previousTokenFiles.push(value)
    else if (name === '--allow-insecure-http') options.allowInsecureHttp = value
    else if (name === '--config-file') options.configFile = value
    else throw new Error(`不支持的参数：${name}`)
    index += 1
  }
  if (!options.publicBaseUrl || !options.evaluatorBaseUrl) {
    throw new Error('必须同时提供 --public-base-url 和 --evaluator-base-url')
  }
  if (!['true', 'false'].includes(options.allowInsecureHttp)) {
    throw new Error('--allow-insecure-http 必须是 true 或 false')
  }
  if (!['token', 'none'].includes(options.authMode)) {
    throw new Error('--auth-mode 必须是 token 或 none')
  }
  if (options.authMode === 'none' && (options.tokenFile || options.previousTokenFiles.length)) {
    throw new Error('none 模式不接受 --token-file 或 --previous-token-file')
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

function validateToken(value, label) {
  const token = String(value || '').trim()
  if (!token) throw new Error(`${label} 为空`)
  if (!/^[\x21-\x7e]+$/.test(token) || token.includes(',')) {
    throw new Error(`${label} 必须是不含空白、控制字符或逗号的单行值`)
  }
  return token
}

function readTokenFile(filePath, label) {
  const resolved = path.resolve(filePath)
  const stat = fs.statSync(resolved)
  if (!stat.isFile()) throw new Error(`${label} 不是普通文件`)
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) {
    throw new Error(`${label} 权限必须为 0600`)
  }
  return validateToken(fs.readFileSync(resolved, 'utf8'), label)
}

function promptSecret(label) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error('非交互模式必须使用 --token-file')
  }
  return new Promise((resolve, reject) => {
    let value = ''
    process.stdout.write(label)
    process.stdin.setEncoding('utf8')
    process.stdin.setRawMode(true)
    process.stdin.resume()
    const finish = (error) => {
      process.stdin.off('data', onData)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write('\n')
      if (error) reject(error)
      else {
        try { resolve(validateToken(value, '当前共享 Token')) } catch (validationError) { reject(validationError) }
      }
    }
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') return finish(new Error('操作已取消'))
        if (character === '\r' || character === '\n') return finish()
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1)
        else value += character
      }
    }
    process.stdin.on('data', onData)
  })
}

function defaultConfigPath() {
  const agentInsightHome = process.env.AGENT_INSIGHT_DATA_DIR || path.join(os.homedir(), '.agent-insight')
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
  const publicBaseUrl = normalizeUrl(options.publicBaseUrl, 'Public Base URL')
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
  const token = options.authMode === 'token'
    ? options.tokenFile
      ? readTokenFile(options.tokenFile, '当前 Token 文件')
      : await promptSecret('当前共享 Token（输入不回显）：')
    : ''
  const previousTokens = options.authMode === 'token'
    ? [...new Set(options.previousTokenFiles.map((filePath) => (
        readTokenFile(filePath, '旧 Token 文件')
      )).filter((previous) => previous !== token))]
    : []
  const configPath = path.resolve(options.configFile || defaultConfigPath())
  const content = [
    '# Agent Insight Benchmark Evaluator runtime configuration.',
    `AGENT_INSIGHT_PUBLIC_BASE_URL=${JSON.stringify(publicBaseUrl)}`,
    ...(executorCallbackBaseUrl
      ? [`AGENT_INSIGHT_BENCHMARK_EXECUTOR_CALLBACK_BASE_URL=${JSON.stringify(executorCallbackBaseUrl)}`]
      : []),
    `AGENT_INSIGHT_BENCHMARK_EVALUATOR_BASE_URL=${JSON.stringify(evaluatorBaseUrl)}`,
    `AGENT_INSIGHT_BENCHMARK_EVALUATOR_AUTH_MODE=${options.authMode}`,
    `AGENT_INSIGHT_BENCHMARK_EVALUATOR_TOKEN=${JSON.stringify(token)}`,
    `AGENT_INSIGHT_BENCHMARK_EVALUATOR_PREVIOUS_TOKENS=${JSON.stringify(previousTokens.join(','))}`,
    `AGENT_INSIGHT_BENCHMARK_EVALUATOR_ALLOW_INSECURE_HTTP=${options.allowInsecureHttp}`,
    '',
  ].join('\n')
  atomicWrite(configPath, content)
  process.stdout.write(`Evaluator 运行时配置已原子更新：${configPath}\n`)
  if (options.authMode === 'none') {
    process.stdout.write('警告：Evaluator 双向鉴权已关闭，必须由安全组或防火墙限制服务互访。\n')
  }
  process.stdout.write('Agent Insight 将在下一次相关请求中热加载，无需重启。\n')
  return { configPath, previousTokenCount: previousTokens.length }
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
  readTokenFile,
  validateToken,
}
