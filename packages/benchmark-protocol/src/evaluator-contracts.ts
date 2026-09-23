import { fingerprintJson, type JsonValue } from './contracts'
import type { EvaluationJob } from './evaluation-contracts'

export type BenchmarkEvaluationProgress = {
  kind: 'evaluation'
  stage:
    | 'downloading_artifacts'
    | 'preparing_runtime'
    | 'resolving_image'
    | 'running_harness'
    | 'collecting_evidence'
    | 'uploading_evidence'
    | 'cleaning'
  progress?: { message?: string; elapsedSeconds?: number }
  occurredAt: string
}

export type BenchmarkEvaluationArtifactDescriptor = {
  artifactId: string
  evaluationId: string
  name: string
  kind: string
  mediaType: string
  sha256: `sha256:${string}`
  sizeBytes: number
  jsonContent?: JsonValue
}

export type BenchmarkEvaluationCompletion = {
  status: 'completed' | 'submission_invalid' | 'failed'
  rawResult: JsonValue
  evidenceArtifactIds: string[]
  runtimeFacts: JsonValue
  cleanup: JsonValue
  error?: {
    code: string
    message: string
    retryable: boolean
  }
}

export type NormalizedBenchmarkPoint = {
  label: string
  value: string | number | boolean | null
  total?: number
  format?: 'plain' | 'percentage' | 'ratio'
  score?: number | null
  evidence?: JsonValue
}

export type NormalizedBenchmarkPrimaryMetric = {
  key: string
  value: boolean | number | null
  aggregation: 'boolean-rate' | 'mean'
}

export type NormalizedBenchmarkResult = {
  status: 'done' | 'failed'
  verdict?: 'pass' | 'warn' | 'fail'
  summary: string
  score: number | null
  primaryMetric?: NormalizedBenchmarkPrimaryMetric
  points: NormalizedBenchmarkPoint[]
  evidence: JsonValue
  nativeMetrics: JsonValue
  errorMessage?: string
}

export type NormalizeBenchmarkResultInput = {
  evaluationId: string
  evaluatorKey: string
  evaluationJob: EvaluationJob
  completion: BenchmarkEvaluationCompletion
  evidenceArtifacts: readonly BenchmarkEvaluationArtifactDescriptor[]
}

export type LocalEvaluationArtifact = {
  descriptor: BenchmarkEvaluationArtifactDescriptor
  path: string
}

export type EvaluatorRuntime = {
  dataDir: string
  hostArch: string
}

export type EvaluatorReadyResult = {
  ready: boolean
  formalEligible?: boolean
  reason?: string
  runtimeFacts?: JsonValue
}

export type EvaluationOutput<TRawResult extends JsonValue = JsonValue> = {
  completion: Omit<BenchmarkEvaluationCompletion, 'rawResult' | 'evidenceArtifactIds'> & {
    rawResult: TRawResult
  }
  evidenceFiles: Array<{
    name: string
    kind: string
    mediaType: string
    path: string
  }>
}

export interface BenchmarkEvaluator<
  TPayload extends JsonValue = JsonValue,
  TRawResult extends JsonValue = JsonValue,
> {
  readonly key: string
  checkReady(runtime: EvaluatorRuntime): Promise<EvaluatorReadyResult>
  validateJob(job: EvaluationJob<TPayload>): void
  evaluate(input: {
    job: EvaluationJob<TPayload>
    artifacts: ReadonlyMap<string, LocalEvaluationArtifact>
    workDir: string
    signal: AbortSignal
    reportProgress: (event: BenchmarkEvaluationProgress) => Promise<void>
  }): Promise<EvaluationOutput<TRawResult>>
}

export function benchmarkEvaluationCompletionDigest(
  completion: BenchmarkEvaluationCompletion,
): `sha256:${string}` {
  return fingerprintJson(completion as unknown as JsonValue)
}
