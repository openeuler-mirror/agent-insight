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

export type ExecutionProfile = {
  key: string; backendKey: string; sandbox: string; sourceRevision: string; implementationDigest: string; network: 'deny'
  artifactDigest?: string
  resources: { cpu: number; memoryMiB: number; pids: number }
  timeouts: { prepareSeconds: number; cleanupSeconds: number }
  targets: Array<{ platform: string; agents: string[] }>; models: string[]; definitionDigest: string
}
export type ExecutionSpec = { profile: ExecutionProfile; environment: { kind: 'oci-image'; image: string; arch: 'amd64' | 'arm64'; workspaceRoot: string } }
export type ExecutionProfileCapability = { profile: ExecutionProfile; benchmarks: string[]; ready: boolean; note?: string; targetReadiness?: Record<string, { ready: boolean; note?: string }> }
export function validateProfile(value: unknown): ExecutionProfile
export function validateExecution(value: unknown): ExecutionSpec
export function digest(value: unknown): string
export const DEFAULT_BINDINGS: Array<{ benchmarks: string[]; platforms: string[]; profile: string }>
export function bindingFor(bindings: typeof DEFAULT_BINDINGS, benchmark: string, platform: string): typeof DEFAULT_BINDINGS[number] | undefined
