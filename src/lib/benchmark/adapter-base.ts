import { createHash } from 'node:crypto'

import {
  type AgentTaskEnvelope,
  type BenchmarkManifest,
  type BuildAgentTaskInput,
  canonicalJson,
  fingerprintJson,
  type JsonValue,
  type SplitCaseResult,
  validateTaskEnvelope,
} from '../../../packages/benchmark-protocol/src/contracts'
import type {
  BenchmarkAdapter,
  BuildEvaluationRequestInput,
  EvaluationJob,
  ValidateSubmissionInput,
} from '../../../packages/benchmark-protocol/src/evaluation-contracts'
import type {
  NormalizeBenchmarkResultInput,
  NormalizedBenchmarkResult,
} from '../../../packages/benchmark-protocol/src/evaluator-contracts'
import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'
import {
  assertAgentVisibilityBoundary,
  assertJsonSchema,
} from '../../../packages/benchmark-protocol/src/json-schema'

export abstract class AbstractBenchmarkAdapter<
  TRaw,
  TPublic extends JsonValue,
  TPrivate extends JsonValue,
  TEvaluationPayload extends JsonValue,
> implements BenchmarkAdapter<TRaw, TPublic, TPrivate, TEvaluationPayload> {
  abstract readonly manifest: BenchmarkManifest

  protected abstract splitCase(raw: TRaw): Omit<
    SplitCaseResult<TPublic, TPrivate>,
    'publicFingerprint' | 'privateFingerprint'
  >
  protected abstract createAgentTask(input: BuildAgentTaskInput<TPublic>): AgentTaskEnvelope
  protected abstract validateBenchmarkSubmission(input: ValidateSubmissionInput): Promise<void>
  protected abstract createEvaluationRequest(
    input: BuildEvaluationRequestInput<TPublic, TPrivate>,
  ): EvaluationJob<TEvaluationPayload>
  protected abstract createNormalizedResult(
    input: NormalizeBenchmarkResultInput,
  ): NormalizedBenchmarkResult

  validateAndSplitCase(raw: TRaw): SplitCaseResult<TPublic, TPrivate> {
    assertJsonSchema(raw, this.manifest.schemas.case, 'CASE_SCHEMA_INVALID', 'Benchmark Case 不符合 Schema')
    const split = this.splitCase(raw)
    if (!split.externalCaseId.trim()) {
      throw new BenchmarkProtocolError('CASE_ID_INVALID', 'Case 外部标识不能为空')
    }
    if (
      !split.catalogProjection.input.trim()
      || split.catalogProjection.input.length > 64 * 1024
      || canonicalJson(split.catalogProjection.values).length > 64 * 1024
      || (split.catalogProjection.tags?.length || 0) > 32
    ) {
      throw new BenchmarkProtocolError('CASE_CATALOG_PROJECTION_INVALID', 'Case 公共展示投影为空或超限')
    }
    assertAgentVisibilityBoundary(raw, split.publicPayload, this.manifest.schemas.case)
    return {
      ...split,
      publicFingerprint: fingerprintJson(split.publicPayload),
      privateFingerprint: fingerprintJson(split.privatePayload),
    }
  }

  buildAgentTask(input: BuildAgentTaskInput<TPublic>): AgentTaskEnvelope {
    const task = this.createAgentTask(input)
    validateTaskEnvelope(task, input.context, this.manifest)
    return task
  }

  async validateSubmission(input: ValidateSubmissionInput): Promise<void> {
    const contracts = new Map(this.manifest.requiredArtifacts.map((item) => [item.name, item]))
    const seen = new Set<string>()
    for (const artifact of input.artifacts) {
      const descriptor = artifact.descriptor
      if (descriptor.executionRunId !== input.task.context.runId) {
        throw new BenchmarkProtocolError('ARTIFACT_RUN_MISMATCH', 'Artifact 不属于当前 Run')
      }
      if (seen.has(descriptor.name)) {
        throw new BenchmarkProtocolError('ARTIFACT_NAME_DUPLICATE', `Artifact 名称重复：${descriptor.name}`)
      }
      seen.add(descriptor.name)
      const contract = contracts.get(descriptor.name)
      if (!contract || descriptor.mediaType !== contract.mediaType) {
        throw new BenchmarkProtocolError('ARTIFACT_CONTRACT_MISMATCH', `Artifact 不符合提交契约：${descriptor.name}`)
      }
      if (
        !Number.isInteger(descriptor.sizeBytes)
        || descriptor.sizeBytes < 1
        || descriptor.sizeBytes > contract.maxBytes
      ) {
        throw new BenchmarkProtocolError('ARTIFACT_SIZE_INVALID', `Artifact 大小不合法：${descriptor.name}`)
      }
      if (!/^sha256:[0-9a-f]{64}$/i.test(descriptor.sha256)) {
        throw new BenchmarkProtocolError('ARTIFACT_DIGEST_INVALID', `Artifact 摘要不合法：${descriptor.name}`)
      }
      const bytes = await artifact.readBytes()
      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
      if (bytes.byteLength !== descriptor.sizeBytes || digest !== descriptor.sha256) {
        throw new BenchmarkProtocolError('ARTIFACT_CONTENT_MISMATCH', `Artifact 内容与记录不一致：${descriptor.name}`)
      }
    }
    for (const required of contracts.keys()) {
      if (!seen.has(required)) {
        throw new BenchmarkProtocolError('ARTIFACT_REQUIRED_MISSING', `缺少必需 Artifact：${required}`)
      }
    }
    if (seen.size !== contracts.size) {
      throw new BenchmarkProtocolError('ARTIFACT_UNEXPECTED', '提交包含未声明的 Artifact')
    }
    await this.validateBenchmarkSubmission(input)
  }

  buildEvaluationRequest(
    input: BuildEvaluationRequestInput<TPublic, TPrivate>,
  ): EvaluationJob<TEvaluationPayload> {
    const job = this.createEvaluationRequest(input)
    const expectedArtifacts = canonicalJson(input.artifacts as unknown as JsonValue)
    const actualArtifacts = canonicalJson(job.artifacts as unknown as JsonValue)
    if (
      job.protocolVersion !== 'benchmark-evaluation/v1'
      || job.evaluationId !== input.context.evaluationRunId
      || job.executionRunId !== input.context.executionRunId
      || job.context.experimentId !== input.context.experimentId
      || job.context.caseId !== input.context.caseId
      || job.context.datasetContentHash !== input.context.datasetContentHash
      || job.benchmark.key !== this.manifest.adapterKey
      || job.evaluator.key !== input.runConfig.evaluatorKey
      || actualArtifacts !== expectedArtifacts
    ) {
      throw new BenchmarkProtocolError('EVALUATION_JOB_CONTEXT_INVALID', 'Adapter 生成的评测任务上下文不一致')
    }
    if (
      !Number.isInteger(job.limits.timeoutSeconds)
      || job.limits.timeoutSeconds < 1
      || !Number.isFinite(job.limits.cpu)
      || job.limits.cpu <= 0
      || !Number.isInteger(job.limits.memoryMiB)
      || job.limits.memoryMiB < 1
    ) {
      throw new BenchmarkProtocolError('EVALUATION_JOB_LIMITS_INVALID', 'Adapter 生成的评测资源限制不合法')
    }
    return job
  }

  normalizeResult(input: NormalizeBenchmarkResultInput): NormalizedBenchmarkResult {
    if (input.evaluatorKey !== this.manifest.evaluation.evaluatorKey) {
      throw new BenchmarkProtocolError('EVALUATOR_RESULT_MISMATCH', '评测结果 Evaluator key 不一致')
    }
    if (input.completion.status !== 'failed') {
      assertJsonSchema(
        input.completion.rawResult,
        this.manifest.schemas.rawResult,
        'RAW_RESULT_SCHEMA_INVALID',
        'Evaluator 原生结果不符合 Schema',
      )
    }
    const normalized = this.createNormalizedResult(input)
    if (
      !normalized.summary.trim()
      || !['done', 'failed'].includes(normalized.status)
      || (normalized.score !== null
        && (!Number.isFinite(normalized.score) || normalized.score < 0 || normalized.score > 100))
      || (normalized.status === 'failed' && normalized.score !== null)
    ) {
      throw new BenchmarkProtocolError('NORMALIZED_RESULT_INVALID', 'Adapter 归一化结果不合法', 500)
    }
    const primaryMetric = normalized.primaryMetric
    const declaredPrimaryMetric = this.manifest.result.primaryMetric
    if (
      primaryMetric
      && (
        !primaryMetric.key.trim()
        || !['boolean-rate', 'mean'].includes(primaryMetric.aggregation)
        || primaryMetric.key !== declaredPrimaryMetric.key
        || primaryMetric.aggregation !== declaredPrimaryMetric.aggregation
        || (primaryMetric.value !== null
          && typeof primaryMetric.value !== 'boolean'
          && (typeof primaryMetric.value !== 'number' || !Number.isFinite(primaryMetric.value)))
        || (primaryMetric.aggregation === 'boolean-rate'
          && primaryMetric.value !== null
          && typeof primaryMetric.value !== 'boolean')
        || (primaryMetric.aggregation === 'mean'
          && primaryMetric.value !== null
          && typeof primaryMetric.value !== 'number')
      )
    ) {
      throw new BenchmarkProtocolError('NORMALIZED_RESULT_INVALID', 'Adapter 主指标不合法', 500)
    }
    if (
      input.completion.status === 'completed'
      && (normalized.status !== 'done'
        || !['pass', 'warn', 'fail'].includes(String(normalized.verdict || ''))
        || normalized.score === null
        || !primaryMetric
        || primaryMetric.value === null)
    ) {
      throw new BenchmarkProtocolError('NORMALIZED_RESULT_INVALID', '完成态评测结果缺少有效判定或分数', 500)
    }
    if (input.completion.status === 'failed' && normalized.status !== 'failed') {
      throw new BenchmarkProtocolError('NORMALIZED_RESULT_INVALID', '失败态评测结果不能归一化为成功', 500)
    }
    return normalized
  }
}
