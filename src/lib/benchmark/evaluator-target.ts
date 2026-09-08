import { createHash, timingSafeEqual } from 'node:crypto'

import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'
import {
  defaultEvaluatorRuntimeConfigProvider,
  type EvaluatorRuntimeConfigProvider,
  type EvaluatorRuntimeConfigSnapshot,
} from './evaluator-runtime-config'

export type EvaluatorTarget = {
  targetKey: string
  baseUrl: string
  evaluatorKey: string
  token?: string
  configRevision?: string
}

export interface EvaluatorTargetResolver {
  resolve(evaluatorKey: string): EvaluatorTarget
}

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

export class EnvEvaluatorTargetResolver implements EvaluatorTargetResolver {
  constructor(
    private readonly provider: EvaluatorRuntimeConfigProvider = defaultEvaluatorRuntimeConfigProvider,
  ) {}

  resolve(evaluatorKey: string): EvaluatorTarget {
    let snapshot: EvaluatorRuntimeConfigSnapshot
    try {
      snapshot = this.provider.snapshot()
    } catch {
      throw new BenchmarkProtocolError('EVALUATOR_CONFIGURATION_INVALID', 'Benchmark 评测服务配置不合法', 500)
    }
    const configured = snapshot.evaluatorBaseUrl
    if (!configured) {
      throw new BenchmarkProtocolError(
        'EVALUATOR_NOT_CONFIGURED',
        '未配置 Benchmark 评测服务地址',
        503,
        true,
      )
    }
    let url: URL
    try {
      url = new URL(configured)
    } catch {
      throw new BenchmarkProtocolError('EVALUATOR_URL_INVALID', 'Benchmark 评测服务地址不合法', 500)
    }
    if (
      !['http:', 'https:'].includes(url.protocol)
      || url.username
      || url.password
      || url.search
      || url.hash
    ) {
      throw new BenchmarkProtocolError('EVALUATOR_URL_INVALID', 'Benchmark 评测服务地址必须是无凭证、query 和 fragment 的 HTTP(S) URL', 500)
    }
    if (url.protocol === 'http:' && !isLoopback(url.hostname) && !snapshot.allowInsecureHttp) {
      throw new BenchmarkProtocolError('EVALUATOR_INSECURE_HTTP_FORBIDDEN', '非本机评测服务必须使用 HTTPS', 500)
    }
    if (snapshot.authMode === 'token' && !snapshot.activeToken) {
      throw new BenchmarkProtocolError('EVALUATOR_TOKEN_NOT_CONFIGURED', '未配置 Benchmark 评测服务凭证', 503, true)
    }
    const targetRevision = createHash('sha256').update(JSON.stringify({
      baseUrl: url.toString().replace(/\/$/, ''),
      authMode: snapshot.authMode,
      token: snapshot.activeToken,
      allowInsecureHttp: snapshot.allowInsecureHttp,
    })).digest('hex').slice(0, 24)
    return {
      targetKey: `runtime:${targetRevision}:${evaluatorKey}`,
      baseUrl: url.toString().replace(/\/$/, ''),
      evaluatorKey,
      ...(snapshot.activeToken ? { token: snapshot.activeToken } : {}),
      configRevision: snapshot.revision,
    }
  }
}

export function benchmarkEvaluatorToken(
  snapshot = defaultEvaluatorRuntimeConfigProvider.snapshot(),
): string {
  const token = snapshot.activeToken
  if (!token) {
    throw new BenchmarkProtocolError('EVALUATOR_TOKEN_NOT_CONFIGURED', '未配置 Benchmark 评测服务凭证', 503, true)
  }
  return token
}

export function authenticateBenchmarkEvaluator(
  req: Request,
  provider: EvaluatorRuntimeConfigProvider = defaultEvaluatorRuntimeConfigProvider,
): void {
  let snapshot: EvaluatorRuntimeConfigSnapshot
  try {
    snapshot = provider.snapshot()
  } catch {
    throw new BenchmarkProtocolError('EVALUATOR_CONFIGURATION_INVALID', 'Benchmark 评测服务配置不合法', 500)
  }
  if (snapshot.authMode === 'none') return
  const expectedTokens = [benchmarkEvaluatorToken(snapshot), ...snapshot.previousTokens]
  const authorization = req.headers.get('authorization') || ''
  const actual = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  const actualHash = createHash('sha256').update(actual).digest()
  const authenticated = Boolean(actual) && expectedTokens.some((expected) => (
    timingSafeEqual(createHash('sha256').update(expected).digest(), actualHash)
  ))
  if (!authenticated) {
    throw new BenchmarkProtocolError('EVALUATOR_UNAUTHORIZED', '评测服务凭证无效', 401)
  }
}

export const defaultEvaluatorTargetResolver = new EnvEvaluatorTargetResolver()
