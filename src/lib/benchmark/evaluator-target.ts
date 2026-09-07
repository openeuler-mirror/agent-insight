import { createHash, timingSafeEqual } from 'node:crypto'

import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'

export type EvaluatorTarget = {
  targetKey: string
  baseUrl: string
  evaluatorKey: string
}

export interface EvaluatorTargetResolver {
  resolve(evaluatorKey: string): EvaluatorTarget
}

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

export class EnvEvaluatorTargetResolver implements EvaluatorTargetResolver {
  resolve(evaluatorKey: string): EvaluatorTarget {
    const configured = process.env.AGENT_INSIGHT_BENCHMARK_EVALUATOR_BASE_URL?.trim()
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
    const allowInsecure = process.env.AGENT_INSIGHT_BENCHMARK_EVALUATOR_ALLOW_INSECURE_HTTP === 'true'
    if (url.protocol === 'http:' && !isLoopback(url.hostname) && !allowInsecure) {
      throw new BenchmarkProtocolError('EVALUATOR_INSECURE_HTTP_FORBIDDEN', '非本机评测服务必须使用 HTTPS', 500)
    }
    return {
      targetKey: `env:${evaluatorKey}`,
      baseUrl: url.toString().replace(/\/$/, ''),
      evaluatorKey,
    }
  }
}

export function benchmarkEvaluatorToken(): string {
  const token = process.env.AGENT_INSIGHT_BENCHMARK_EVALUATOR_TOKEN?.trim()
  if (!token) {
    throw new BenchmarkProtocolError('EVALUATOR_TOKEN_NOT_CONFIGURED', '未配置 Benchmark 评测服务凭证', 503, true)
  }
  return token
}

export function authenticateBenchmarkEvaluator(req: Request): void {
  const expected = benchmarkEvaluatorToken()
  const authorization = req.headers.get('authorization') || ''
  const actual = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  const expectedHash = createHash('sha256').update(expected).digest()
  const actualHash = createHash('sha256').update(actual).digest()
  if (!actual || !timingSafeEqual(expectedHash, actualHash)) {
    throw new BenchmarkProtocolError('EVALUATOR_UNAUTHORIZED', '评测服务凭证无效', 401)
  }
}

export const defaultEvaluatorTargetResolver = new EnvEvaluatorTargetResolver()
