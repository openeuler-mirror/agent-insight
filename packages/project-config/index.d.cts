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
    'zsoft-l1': { dataset: { source: string | null; revision: string | null } }
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
export type ExecutorConfig = { benchmarks: { 'swe-bench': { gitSource: string | null } }; runtimes: Record<string, { defaults?: Record<string, string | number | boolean | null> }> }
type Options = { root?: string; configDir?: string; env?: NodeJS.ProcessEnv; warn?: (message: string) => void }
export function loadProjectConfig(scope: 'platform', options?: Options): PlatformConfig
export function loadProjectConfig(scope: 'evaluator', options?: Options): EvaluatorConfig
export function loadProjectConfig(scope: 'executor', options?: Options): ExecutorConfig
export function warnLegacy(scope: 'platform' | 'evaluator' | 'executor', env?: NodeJS.ProcessEnv, warn?: (message: string) => void): void
