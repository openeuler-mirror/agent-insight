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

export type SchedulingConfig = {
  maxPendingEvaluations: number
  maxPendingEvaluationsPerUser: number
  maxEvaluationConcurrencyPerUser: number | null
}
export type PlatformConfig = {
  benchmarks: {
    'swe-bench': {
      dataset: { autoImport: boolean; source: string | null }
      loader: { sourceArchive: string | null; python: string | null }
    }
    'zsoft-l1': { dataset: { autoImport: boolean; source: string | null; revision: string | null } }
    scheduling: SchedulingConfig
  }
}
export type EvaluatorConfig = {
  maxConcurrency: number
  benchmarks: {
    'swe-bench': {
      python: string
      images: { source: 'official' | 'epoch'; arch: 'auto' | 'x86_64' | 'arm64'; allowNonOfficial: boolean; proxyPrefix: string | null; verifiedMirrorRepositories: string[] | null }
      docker: { requestTimeoutSeconds: number; connectionPoolSize: number }
    }
    'zsoft-l1': { assetsDir: string | null; kernelAccel: 'tcg' | 'kvm' }
  }
  imagePool: { enabled: boolean; prefetchEnabled: boolean; reserveRatio: number; highWatermark: number; maxPulls: number; waitSeconds: number; macDiskPath: string | null }
}
export type ExecutorConfig = { retention: { days: number }; benchmarks: { 'swe-bench': { gitSource: string | null; images: { source: 'official' | 'epoch'; arch: 'auto' | 'x86_64' | 'arm64'; allowNonOfficial: boolean; proxyPrefix: string | null; verifiedMirrorRepositories: string[] | null } } }; runtimes: Record<string, { defaults?: import('../agent-runtime/index.cjs').JsonObject }>; execution: { profiles: Record<string, unknown>; bindings: Array<{ benchmarks: string[]; platforms: string[]; profile: string }> } }
type Environment = Readonly<Record<string, string | undefined>>
type Options = { root?: string; configDir?: string; env?: Environment; warn?: (message: string) => void }
export function loadProjectConfig(scope: 'platform', options?: Options): PlatformConfig
export function loadProjectConfig(scope: 'evaluator', options?: Options): EvaluatorConfig
export function loadProjectConfig(scope: 'executor', options?: Options): ExecutorConfig
export function warnLegacy(scope: 'platform' | 'evaluator' | 'executor', env?: Environment, warn?: (message: string) => void): void
