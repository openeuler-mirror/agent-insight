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

import { definitionsForTarget, type RuntimeDefinition } from '../../../../packages/agent-runtime/index.cjs';
import { prisma } from '@/lib/storage/prisma';
import { pickDisplayClientIp } from '@/lib/reliability/client-ip';
import {
  deriveStatus,
  parseCapabilities,
  type ClientCapabilities,
  type ClientPlatformCapability,
} from '@/lib/reliability/client-registry';

export type ClientTraceGenerationTarget = {
  workerId: string;
  host: string;
  hostname: string | null;
  platform: string;
  agent: string;
  agentLabel: string;
  models: Array<{ id: string; label: string }>;
  lastSeenAt: string;
  parameterDefinitions?: RuntimeDefinition[];
  supportsSkillSnapshot?: boolean;
  supportsTriggerRouting?: boolean;
  supportsEnvironmentPreparation?: boolean;
};

export function listTraceGenerationPlatforms(
  capabilities: ClientCapabilities,
): ClientPlatformCapability[] {
  return capabilities.platforms.filter((platform) => {
    const actions = new Set([...(capabilities.actions || []), ...(platform.actions || [])]);
    return actions.has('RUN_EXPERIMENT_CASE')
      && platform.runExperimentCase?.returnsTraceId === true
      && platform.runExperimentCase.ready !== false;
  });
}

export type TraceGenerationDiagnostic = {
  clientId?: string; host?: string; platform?: string; code: string; message: string;
};

export async function listClientTraceGenerationAvailability(
  user: string | null,
): Promise<{ targets: ClientTraceGenerationTarget[]; diagnostics: TraceGenerationDiagnostic[] }> {
  if (!user) return { targets: [], diagnostics: [{ code: 'NO_USER', message: '请登录后查看当前账号的客户端' }] };
  const clients = await prisma.reliabilityClient.findMany({
    where: { user, unboundAt: null },
    orderBy: { lastSeenAt: 'desc' },
    take: 100,
  });
  const targets: ClientTraceGenerationTarget[] = [];
  const diagnostics: TraceGenerationDiagnostic[] = [];
  if (!clients.length) diagnostics.push({ code: 'NO_BOUND_CLIENT', message: '当前账号没有绑定客户端；请使用当前账号的安装命令完成常驻客户端注册，Trace 采集器安装成功不代表注册完成' });
  for (const client of clients) {
    const identity = { clientId: client.clientId, host: client.hostname || client.name || client.clientId };
    const status = deriveStatus(client);
    if (status !== 'online') {
      diagnostics.push({ ...identity, code: 'CLIENT_NOT_ONLINE', message: `客户端当前${status === 'disabled' ? '已禁用' : status === 'degraded' ? '连接异常' : '已离线'}，请检查常驻服务及心跳` });
      continue;
    }
    const capabilities = parseCapabilities(client.capabilitiesJson);
    if (!capabilities.platforms.length) diagnostics.push({ ...identity, code: 'DISCOVERY_PENDING', message: '客户端在线，尚未上报 Agent 探测结果' });
    for (const platform of capabilities.platforms) {
      const run = platform.runExperimentCase;
      const actions = [...(capabilities.actions || []), ...(platform.actions || [])];
      const reason = run?.unavailableReason;
      if (run?.ready === false || !actions.includes('RUN_EXPERIMENT_CASE') || !run?.returnsTraceId) {
        diagnostics.push({ ...identity, platform: platform.id, code: 'RUNTIME_UNAVAILABLE', message: reason || '客户端未确认该平台支持执行任务并回传 Trace ID；请检查运行时版本与能力探测结果，必要时更新客户端' });
      } else if (!platform.agents?.length) {
        diagnostics.push({ ...identity, platform: platform.id, code: 'NO_AGENTS', message: '客户端在线，但该平台的 Agent 列表为空；请检查版本兼容性、配置与插件启动日志' });
      }
    }
    for (const platform of listTraceGenerationPlatforms(capabilities)) {
      const host = pickDisplayClientIp({
        reportedIp: client.reportedIp,
        observedIp: client.observedIp,
      }) || client.hostname || client.clientId;
      const models = [
        { id: '', label: '平台默认' },
        ...(platform.models || []).map((model) => ({ id: model, label: model })),
      ];
      for (const agent of platform.agents || []) {
        targets.push({
          workerId: client.clientId,
          host,
          hostname: client.hostname,
          platform: platform.id,
          agent,
          agentLabel: agent,
          models,
          lastSeenAt: client.lastSeenAt.toISOString(),
          parameterDefinitions: definitionsForTarget(platform.parameterDefinitions || [], platform.id, agent),
          supportsSkillSnapshot: Number(platform.runExperimentCase?.skillSnapshotVersion || 0) >= 1,
          supportsTriggerRouting: Number(platform.runExperimentCase?.skillSnapshotVersion || 0) >= 4,
          supportsEnvironmentPreparation: capabilities.actions?.includes('PREPARE_EXECUTION_ENVIRONMENT') === true,
        });
      }
    }
  }
  return { targets, diagnostics };
}

export async function listClientTraceGenerationTargets(user: string | null): Promise<ClientTraceGenerationTarget[]> {
  return (await listClientTraceGenerationAvailability(user)).targets;
}
