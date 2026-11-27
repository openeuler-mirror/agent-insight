/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { createHash } from 'node:crypto'

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
    const targetRevision = createHash('sha256').update(JSON.stringify({
      baseUrl: url.toString().replace(/\/$/, ''),
      allowInsecureHttp: snapshot.allowInsecureHttp,
    })).digest('hex').slice(0, 24)
    return {
      targetKey: `runtime:${targetRevision}:${evaluatorKey}`,
      baseUrl: url.toString().replace(/\/$/, ''),
      evaluatorKey,
      configRevision: snapshot.revision,
    }
  }
}

export const defaultEvaluatorTargetResolver = new EnvEvaluatorTargetResolver()
