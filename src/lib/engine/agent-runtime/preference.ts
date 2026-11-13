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

import { getUserSettings, saveAgentRuntimePreference } from '@/lib/storage/server-config';
import { detectAgentRuntimes } from './detect';
import type {
  AgentRuntimeDetection,
  AgentRuntimeDescriptor,
  AgentRuntimeId,
  AgentRuntimeOverview,
  AgentRuntimeSelection,
  AgentRuntimeUnavailableReason,
} from './types';

export type AgentRuntimeSelectionErrorCode = 'INVALID_RUNTIME' | 'RUNTIME_UNAVAILABLE';

export class AgentRuntimeSelectionError extends Error {
  readonly code: AgentRuntimeSelectionErrorCode;
  readonly status: 400 | 409;
  readonly reason?: AgentRuntimeUnavailableReason;

  constructor(
    code: AgentRuntimeSelectionErrorCode,
    message: string,
    status: 400 | 409,
    reason?: AgentRuntimeUnavailableReason,
  ) {
    super(message);
    this.name = 'AgentRuntimeSelectionError';
    this.code = code;
    this.status = status;
    this.reason = reason;
  }
}

function normalizeRuntimeId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function findRuntime(
  runtimes: readonly AgentRuntimeDescriptor[],
  runtimeId: string | null,
): AgentRuntimeDescriptor | null {
  if (!runtimeId) return null;
  return runtimes.find((runtime) => runtime.id === runtimeId) ?? null;
}

/**
 * 计算用户偏好当前是否可用。不做任何回退：偏好指向的运行时不满足条件时，
 * 明确返回原因，由调用方决定如何提示。
 */
export function resolveRuntimeSelection(
  runtimes: readonly AgentRuntimeDescriptor[],
  storedRuntimeId: unknown,
): AgentRuntimeSelection {
  const runtimeId = normalizeRuntimeId(storedRuntimeId);
  if (!runtimeId) return { runtimeId: null, usable: false, reason: null };

  const runtime = findRuntime(runtimes, runtimeId);
  if (!runtime) {
    return {
      runtimeId: runtimeId as AgentRuntimeId,
      usable: false,
      reason: { code: 'UNKNOWN_RUNTIME', detail: runtimeId },
    };
  }

  return {
    runtimeId: runtime.id,
    usable: runtime.usable,
    reason: runtime.usable ? null : runtime.unavailableReason,
  };
}

export function buildAgentRuntimeOverview(
  detection: AgentRuntimeDetection,
  storedRuntimeId: unknown,
): AgentRuntimeOverview {
  const defaultRuntimeId = detection.runtimes.find((runtime) => runtime.usable)?.id ?? null;
  return {
    ...detection,
    selection: resolveRuntimeSelection(detection.runtimes, storedRuntimeId),
    defaultRuntimeId,
  };
}

export async function getAgentRuntimeOverview(
  user: string,
  options: { force?: boolean } = {},
): Promise<AgentRuntimeOverview> {
  const [detection, settings] = await Promise.all([
    detectAgentRuntimes({ force: options.force }),
    getUserSettings(user),
  ]);
  return buildAgentRuntimeOverview(detection, settings.agentRuntime?.defaultRuntimeId ?? null);
}

export async function saveAgentRuntimeSelection(
  user: string,
  runtimeId: unknown,
  options: { force?: boolean } = {},
): Promise<AgentRuntimeOverview> {
  const detection = await detectAgentRuntimes({ force: options.force });
  const normalized = normalizeRuntimeId(runtimeId);

  if (normalized) {
    const runtime = findRuntime(detection.runtimes, normalized);
    if (!runtime) {
      throw new AgentRuntimeSelectionError(
        'INVALID_RUNTIME',
        `未知的运行时：${normalized}`,
        400,
        { code: 'UNKNOWN_RUNTIME', detail: normalized },
      );
    }
    if (!runtime.usable) {
      throw new AgentRuntimeSelectionError(
        'RUNTIME_UNAVAILABLE',
        `运行时 ${runtime.displayName} 当前不可用`,
        409,
        runtime.unavailableReason ?? undefined,
      );
    }
  }

  await saveAgentRuntimePreference(user, { defaultRuntimeId: normalized });
  return buildAgentRuntimeOverview(detection, normalized);
}
