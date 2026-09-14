import { fingerprintJson, type AgentTaskEnvelope, type BenchmarkPreExecutionAdapter, type JsonValue } from './contracts'
import type {
  NormalizeBenchmarkResultInput,
  NormalizedBenchmarkResult,
} from './evaluator-contracts'

export type ArtifactDescriptor = {
  artifactId: string
  executionRunId: string
  name: string
  mediaType: string
  sha256: `sha256:${string}`
  sizeBytes: number
}

export type ReadonlySubmissionArtifact = {
  descriptor: ArtifactDescriptor
  readBytes(): Promise<Uint8Array>
}

export type ValidateSubmissionInput = {
  task: AgentTaskEnvelope
  artifacts: readonly ReadonlySubmissionArtifact[]
}

export type BuildEvaluationRequestInput<
  TPublic extends JsonValue,
  TPrivate extends JsonValue,
> = {
  context: {
    evaluationRunId: string
    executionRunId: string
    experimentId: string
    caseId: string
    datasetContentHash: string
  }
  publicPayload: TPublic
  privatePayload: TPrivate
  artifacts: readonly ArtifactDescriptor[]
  runConfig: {
    evaluatorKey: string
    timeoutSeconds: number
    cpu: number
    memoryMiB: number
    agentModel?: string
  }
}

export type EvaluationJob<TPayload extends JsonValue = JsonValue> = {
  protocolVersion: 'benchmark-evaluation/v1'
  evaluationId: string
  executionRunId: string
  context: {
    experimentId: string
    caseId: string
    datasetContentHash: string
  }
  benchmark: { key: string }
  evaluator: { key: string }
  artifacts: ArtifactDescriptor[]
  payload: TPayload
  limits: { timeoutSeconds: number; cpu: number; memoryMiB: number }
}

export type BenchmarkEvaluationDispatchRequest = {
  runId: string
  requestDigest: `sha256:${string}`
  evaluationJob: EvaluationJob
  platformBaseUrl: string
  callbackBaseUrl: string
  timeoutSeconds: number
}

export interface BenchmarkAdapter<
  TRaw = unknown,
  TPublic extends JsonValue = JsonValue,
  TPrivate extends JsonValue = JsonValue,
  TEvaluationPayload extends JsonValue = JsonValue,
> extends BenchmarkPreExecutionAdapter<TRaw, TPublic, TPrivate> {
  validateSubmission(input: ValidateSubmissionInput): Promise<void>
  buildEvaluationRequest(
    input: BuildEvaluationRequestInput<TPublic, TPrivate>,
  ): EvaluationJob<TEvaluationPayload>
  normalizeResult(input: NormalizeBenchmarkResultInput): NormalizedBenchmarkResult
}

export function benchmarkEvaluationDispatchDigest(input: Omit<
  BenchmarkEvaluationDispatchRequest,
  'requestDigest'
>): `sha256:${string}` {
  return fingerprintJson(input as unknown as JsonValue)
}
