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

export type ValidateSubmissionInput = ({
  task: AgentTaskEnvelope
  submission?: never
} | {
  task?: never
  submission: {
    runId: string
    publicPayload: JsonValue
    privatePayload: JsonValue
  }
}) & {
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
  imagePreparationInput?(publicPayload: TPublic, privatePayload: TPrivate): JsonValue | null
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
