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

import { isIP } from 'node:net'
import { normalizePublicIp } from './client-ip'

export type TraceClientMetadata = {
  clientId: string | null
  hostIp: string | null
  hostName: string | null
  observedIp: string | null
}

export function resolveTraceClientSnapshot(
  existing: Partial<TraceClientMetadata> | null | undefined,
  incoming: Partial<TraceClientMetadata> | null | undefined,
): TraceClientMetadata {
  return {
    clientId: existing?.clientId || incoming?.clientId || null,
    hostIp: existing?.hostIp || incoming?.hostIp || null,
    hostName: existing?.hostName || incoming?.hostName || null,
    observedIp: existing?.observedIp || incoming?.observedIp || null,
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    return null
  }
  return normalized
}

export function normalizeReliabilityClientId(value: unknown): string | null {
  const clientId = text(value, 128)
  if (!clientId || !/^cli_[A-Za-z0-9][A-Za-z0-9._-]{7,123}$/.test(clientId)) return null
  return clientId
}

export function normalizeHostIp(value: unknown): string | null {
  const ip = text(value, 64)
  return ip && isIP(ip) ? ip : null
}

export function normalizeHostName(value: unknown): string | null {
  return text(value, 255)
}

export function normalizeTraceClientMetadata(
  payload: unknown,
  observedIp?: unknown,
): TraceClientMetadata {
  const root = asRecord(payload) || {}
  const host = asRecord(root.host) || {}
  return {
    clientId: normalizeReliabilityClientId(root.client_id ?? root.clientId),
    hostIp: normalizeHostIp(
      host.reported_ip ?? host.reportedIp ?? root.host_ip ?? root.hostIp,
    ),
    hostName: normalizeHostName(
      host.hostname ?? host.host_name ?? root.host_name ?? root.hostName,
    ),
    observedIp: normalizePublicIp(observedIp),
  }
}
