import { createHash } from 'node:crypto'
import fs from 'node:fs'

import { parse } from 'dotenv'

import { resolveAgentInsightDataPath } from '@/lib/env'

const CONFIG_KEYS = new Set([
  'AGENT_INSIGHT_PUBLIC_BASE_URL',
  'AGENT_INSIGHT_BENCHMARK_EXECUTOR_CALLBACK_BASE_URL',
  'AGENT_INSIGHT_BENCHMARK_EVALUATOR_BASE_URL',
  'AGENT_INSIGHT_BENCHMARK_EVALUATOR_AUTH_MODE',
  'AGENT_INSIGHT_BENCHMARK_EVALUATOR_TOKEN',
  'AGENT_INSIGHT_BENCHMARK_EVALUATOR_PREVIOUS_TOKENS',
  'AGENT_INSIGHT_BENCHMARK_EVALUATOR_ALLOW_INSECURE_HTTP',
])

export type EvaluatorAuthMode = 'token' | 'none'

export type EvaluatorRuntimeConfigSnapshot = Readonly<{
  source: 'file' | 'environment'
  revision: string
  authMode: EvaluatorAuthMode
  publicBaseUrl?: string
  executorCallbackBaseUrl?: string
  evaluatorBaseUrl?: string
  activeToken?: string
  previousTokens: readonly string[]
  allowInsecureHttp: boolean
}>

type RuntimeConfigProviderOptions = {
  configPath?: string
  environment?: NodeJS.ProcessEnv
  onInvalidUpdate?: (message: string) => void
}

function normalizeUrl(value: string | undefined, label: string): string | undefined {
  const configured = value?.trim()
  if (!configured) return undefined
  let url: URL
  try {
    url = new URL(configured)
  } catch {
    throw new Error(`${label} 不是合法 URL`)
  }
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

function parseBoolean(value: string | undefined): boolean {
  const normalized = value?.trim() || 'false'
  if (normalized !== 'true' && normalized !== 'false') {
    throw new Error('AGENT_INSIGHT_BENCHMARK_EVALUATOR_ALLOW_INSECURE_HTTP 必须是 true 或 false')
  }
  return normalized === 'true'
}

function parseAuthMode(value: string | undefined): EvaluatorAuthMode {
  const normalized = value?.trim() || 'token'
  if (normalized !== 'token' && normalized !== 'none') {
    throw new Error('AGENT_INSIGHT_BENCHMARK_EVALUATOR_AUTH_MODE 必须是 token 或 none')
  }
  return normalized
}

function normalizeToken(value: string | undefined, label: string): string | undefined {
  const token = value?.trim()
  if (!token) return undefined
  if (!/^[\x21-\x7e]+$/.test(token) || token.includes(',')) {
    throw new Error(`${label} 必须是不含空白、控制字符或逗号的单行值`)
  }
  return token
}

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

function buildSnapshot(
  source: 'file' | 'environment',
  values: NodeJS.ProcessEnv | Record<string, string>,
  requireComplete: boolean,
): EvaluatorRuntimeConfigSnapshot {
  const authMode = parseAuthMode(values.AGENT_INSIGHT_BENCHMARK_EVALUATOR_AUTH_MODE)
  const allowInsecureHttp = parseBoolean(values.AGENT_INSIGHT_BENCHMARK_EVALUATOR_ALLOW_INSECURE_HTTP)
  const publicBaseUrl = normalizeUrl(values.AGENT_INSIGHT_PUBLIC_BASE_URL, 'AGENT_INSIGHT_PUBLIC_BASE_URL')
  const executorCallbackBaseUrl = normalizeUrl(
    values.AGENT_INSIGHT_BENCHMARK_EXECUTOR_CALLBACK_BASE_URL,
    'AGENT_INSIGHT_BENCHMARK_EXECUTOR_CALLBACK_BASE_URL',
  )
  const evaluatorBaseUrl = normalizeUrl(
    values.AGENT_INSIGHT_BENCHMARK_EVALUATOR_BASE_URL,
    'AGENT_INSIGHT_BENCHMARK_EVALUATOR_BASE_URL',
  )
  const configuredToken = normalizeToken(
    values.AGENT_INSIGHT_BENCHMARK_EVALUATOR_TOKEN,
    'AGENT_INSIGHT_BENCHMARK_EVALUATOR_TOKEN',
  )
  const configuredPreviousTokens = [
    ...new Set(String(values.AGENT_INSIGHT_BENCHMARK_EVALUATOR_PREVIOUS_TOKENS || '')
      .split(',')
      .map((token) => normalizeToken(token, 'AGENT_INSIGHT_BENCHMARK_EVALUATOR_PREVIOUS_TOKENS'))
      .filter((token): token is string => Boolean(token) && token !== configuredToken)),
  ]
  const activeToken = authMode === 'token' ? configuredToken : undefined
  const previousTokens = Object.freeze(authMode === 'token' ? configuredPreviousTokens : [])
  if (
    requireComplete
    && (!publicBaseUrl || !evaluatorBaseUrl || (authMode === 'token' && !activeToken))
  ) {
    throw new Error(
      authMode === 'token'
        ? '运行时配置文件必须同时提供 Public Base URL、Evaluator Base URL 和当前 Token'
        : '运行时配置文件必须同时提供 Public Base URL 和 Evaluator Base URL',
    )
  }
  if (evaluatorBaseUrl) {
    const evaluatorUrl = new URL(evaluatorBaseUrl)
    if (evaluatorUrl.protocol === 'http:' && !isLoopback(evaluatorUrl.hostname) && !allowInsecureHttp) {
      throw new Error('非本机 Evaluator Base URL 必须使用 HTTPS，或显式允许受控内网 HTTP')
    }
  }
  const revisionInput = JSON.stringify({
    authMode,
    publicBaseUrl,
    executorCallbackBaseUrl,
    evaluatorBaseUrl,
    activeToken,
    previousTokens,
    allowInsecureHttp,
  })
  const revision = createHash('sha256').update(revisionInput).digest('hex').slice(0, 24)
  return Object.freeze({
    source,
    revision,
    authMode,
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
    ...(executorCallbackBaseUrl ? { executorCallbackBaseUrl } : {}),
    ...(evaluatorBaseUrl ? { evaluatorBaseUrl } : {}),
    ...(activeToken ? { activeToken } : {}),
    previousTokens,
    allowInsecureHttp,
  })
}

function parseConfigFile(source: string): Record<string, string> {
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(trimmed)
    if (!match) throw new Error('运行时配置文件包含无法识别的行')
    if (!CONFIG_KEYS.has(match[1])) throw new Error(`运行时配置文件包含未知变量：${match[1]}`)
  }
  return parse(source)
}

export class EvaluatorRuntimeConfigProvider {
  private readonly configuredPath?: string
  private readonly environment: NodeJS.ProcessEnv
  private readonly onInvalidUpdate: (message: string) => void
  private activeFileSnapshot?: EvaluatorRuntimeConfigSnapshot
  private lastFileIdentity?: string
  private lastInvalidIdentity?: string

  constructor(options: RuntimeConfigProviderOptions = {}) {
    this.configuredPath = options.configPath
    this.environment = options.environment || process.env
    this.onInvalidUpdate = options.onInvalidUpdate || ((message) => {
      console.error(`[benchmark/evaluator-runtime-config] ${message}`)
    })
  }

  configPath(): string {
    return this.configuredPath || resolveAgentInsightDataPath('config', 'benchmark-evaluator.env')
  }

  snapshot(): EvaluatorRuntimeConfigSnapshot {
    const configPath = this.configPath()
    let stat: fs.Stats
    try {
      stat = fs.statSync(configPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.reportInvalid(`无法读取运行时配置文件状态；继续使用上一份有效配置`, `stat:${String(error)}`)
        if (this.activeFileSnapshot) return this.activeFileSnapshot
      }
      this.activeFileSnapshot = undefined
      this.lastFileIdentity = undefined
      return buildSnapshot('environment', this.environment, false)
    }
    const identity = `${configPath}:${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}`
    if (identity === this.lastFileIdentity && this.activeFileSnapshot) return this.activeFileSnapshot
    try {
      if (!stat.isFile()) throw new Error('运行时配置路径不是普通文件')
      if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) {
        throw new Error('运行时配置文件权限必须为 0600')
      }
      const values = parseConfigFile(fs.readFileSync(configPath, 'utf8'))
      const snapshot = buildSnapshot('file', values, true)
      this.activeFileSnapshot = snapshot
      this.lastFileIdentity = identity
      this.lastInvalidIdentity = undefined
      return snapshot
    } catch (error) {
      this.reportInvalid(
        `运行时配置更新无效，继续使用上一份有效配置：${error instanceof Error ? error.message : '未知错误'}`,
        identity,
      )
      return this.activeFileSnapshot || buildSnapshot('environment', this.environment, false)
    }
  }

  private reportInvalid(message: string, identity: string): void {
    if (this.lastInvalidIdentity === identity) return
    this.lastInvalidIdentity = identity
    this.onInvalidUpdate(message)
  }
}

export const defaultEvaluatorRuntimeConfigProvider = new EvaluatorRuntimeConfigProvider()
