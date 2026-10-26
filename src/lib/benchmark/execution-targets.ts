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

import type { ReliabilityClient } from '@prisma/client'

import type { BenchmarkManifest } from '../../../packages/benchmark-protocol/src/contracts'
import { resolveAgentOptions, type RuntimeDefinition } from '../../../packages/agent-runtime/index.cjs'
import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'
import {
  deriveServiceHealth,
  deriveStatus,
  parseCapabilities,
  type ClientStatus,
  type ServiceHealth,
} from '@/lib/reliability/client-registry'
import { prisma } from '@/lib/storage/prisma'

export type BenchmarkExecutionTarget = {
  clientId: string
  name: string
  hostname: string | null
  os: string | null
  arch: string | null
  platform: string
  agents: string[]
  models: string[]
  parameterDefinitions: RuntimeDefinition[]
  status: ClientStatus
  serviceHealth: ServiceHealth
  ready: boolean
  unavailableReasons: string[]
  missingCapabilities: string[]
  lastSeenAt: Date
}

function componentReady(value: unknown): boolean {
  if (value === true) return true
  if (!value || typeof value !== 'object') return false
  return (value as Record<string, unknown>).ready !== false
}

export function benchmarkAgentRuntimeCapability(platform: string): string {
  return `agent-runtime/${platform}/v1`
}

export function inspectBenchmarkExecutionTargets(
  client: ReliabilityClient,
  manifest: BenchmarkManifest,
): BenchmarkExecutionTarget[] {
  const capabilities = parseCapabilities(client.capabilitiesJson)
  const status = deriveStatus(client)
  const serviceHealth = deriveServiceHealth(client)

  return capabilities.platforms.filter((platform) => {
    const actions = new Set([...(capabilities.actions || []), ...(platform.actions || [])])
    return actions.has('RUN_BENCHMARK_CASE') && (
      platform.runBenchmarkCase?.returnsTraceId === true
      || platform.runExperimentCase?.returnsTraceId === true
    )
  }).flatMap((platform) => {
    const agents = [...new Set(platform.agents || [])]
    if (!agents.length) return []
    const actions = new Set([...(capabilities.actions || []), ...(platform.actions || [])])
    const requiredCapabilities = [
      ...manifest.requiredCapabilities,
      benchmarkAgentRuntimeCapability(platform.id),
    ]
    const missingCapabilities = [...new Set(requiredCapabilities)].filter(
      capability => !componentReady(capabilities.components?.[capability]),
    )
    const unavailableReasons = [
      status !== 'online' ? `客户端状态不可用：${status}` : '',
      serviceHealth !== 'healthy' ? '客户端服务未就绪' : '',
      !actions.has('RUN_BENCHMARK_CASE') ? '客户端版本不支持 Benchmark 控制指令' : '',
      ...missingCapabilities.map(capability => `缺少 ${capability}`),
    ].filter(Boolean)

    return [{
      clientId: client.clientId,
      name: client.name,
      hostname: client.hostname,
      os: client.os,
      arch: client.arch,
      platform: platform.id,
      agents,
      models: [...new Set(platform.models || [])],
      parameterDefinitions: platform.parameterDefinitions || [],
      status,
      serviceHealth,
      ready: unavailableReasons.length === 0,
      unavailableReasons,
      missingCapabilities,
      lastSeenAt: client.lastSeenAt,
    }]
  })
}

export async function listBenchmarkExecutionTargets(
  user: string,
  manifest: BenchmarkManifest,
): Promise<BenchmarkExecutionTarget[]> {
  const clients = await prisma.reliabilityClient.findMany({
    where: { user, unboundAt: null },
    orderBy: { lastSeenAt: 'desc' },
    take: 100,
  }) as ReliabilityClient[]
  return clients.flatMap(client => inspectBenchmarkExecutionTargets(client, manifest))
}

export function assertBenchmarkExecutionTarget(
  client: ReliabilityClient,
  manifest: BenchmarkManifest,
  input: { platform: string; agent: string; agentOptions?: unknown },
): BenchmarkExecutionTarget {
  const target = inspectBenchmarkExecutionTargets(client, manifest).find(item => (
    item.platform === input.platform && item.agents.includes(input.agent)
  ))
  if (!target) {
    throw new BenchmarkProtocolError(
      'EXECUTION_TARGET_UNAVAILABLE',
      '所选客户端未上报可执行的 Benchmark platform 与 agent 组合，或该平台不能安全回传 Trace ID',
      409,
    )
  }
  if (target.missingCapabilities.length) {
    throw new BenchmarkProtocolError(
      'EXECUTOR_CAPABILITY_MISSING',
      `所选执行器缺少能力：${target.missingCapabilities.join(', ')}`,
      409,
      false,
      { missing: target.missingCapabilities.join(', ') },
    )
  }
  if (!target.ready) {
    throw new BenchmarkProtocolError(
      'EXECUTOR_NOT_READY',
      target.unavailableReasons.join('；') || '执行客户端当前不可用',
      409,
    )
  }
  try { resolveAgentOptions(target.parameterDefinitions, input.platform, input.agent, input.agentOptions) }
  catch (error) {
    throw new BenchmarkProtocolError((error as { code?: string }).code || 'AGENT_OPTIONS_INVALID', (error as Error).message, 409)
  }
  return target
}
