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

import { getGeneratedBenchmarkManifest } from '../../../generated/benchmark-catalog/manifests'
import type { AgentTaskEnvelope, BuildAgentTaskInput, JsonValue } from '../../../packages/benchmark-protocol/src/contracts'
import { canonicalJson } from '../../../packages/benchmark-protocol/src/contracts'
import type { BuildEvaluationRequestInput, EvaluationJob, ValidateSubmissionInput } from '../../../packages/benchmark-protocol/src/evaluation-contracts'
import type { NormalizeBenchmarkResultInput, NormalizedBenchmarkResult } from '../../../packages/benchmark-protocol/src/evaluator-contracts'
import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'
import { AbstractBenchmarkAdapter } from '../../../src/lib/benchmark/adapter-base'

export type ZsoftPublicCase = {
  taskId: string; title: string; description: string
  submissionKind: 'python' | 'c' | 'binary'; maxBytes: number; tags: string[]
}
export type ZsoftPrivateCase = { revision?: string; sourceTaskDigest: string }
export type ZsoftCase = { public: ZsoftPublicCase; private: ZsoftPrivateCase }
export type ZsoftEvaluationPayload = ZsoftPrivateCase & { taskId: string; maxBytes: number; submissionKind: string }

type ZsoftResult = { sourceTaskDigest: string; taskId: string; submissionSha256: string; bundleDigest: string; taskDigest: string; status: string; success: boolean }

function jsonObject(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function officialChecks(value: JsonValue | undefined): JsonValue {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const checks = value.map(jsonObject)
  if (checks.some(check => !check || typeof check.id !== 'string' || !check.id || typeof check.passed !== 'boolean' || (check.message != null && typeof check.message !== 'string'))) return null
  return checks.map(check => ({ ...check!, message: check!.message ?? null }))
}

function officialSummary(input: NormalizeBenchmarkResultInput, raw: ZsoftResult): string | undefined {
  const artifacts = input.evidenceArtifacts
  const legacy = artifacts.filter(item => item.name === 'report.json' && item.kind === 'official-report' && item.mediaType === 'application/json')
  if (artifacts.length === 1 && legacy.length === 1 && legacy[0].evaluationId === input.evaluationId && legacy[0].jsonContent !== undefined && canonicalJson(legacy[0].jsonContent) === canonicalJson(input.completion.rawResult)) return undefined
  const reports = artifacts.filter(item => item.name === 'evaluation.json' && item.kind === 'official-report' && item.mediaType === 'application/json')
  const records = artifacts.filter(item => item.name === 'record.json' && item.kind === 'official-record' && item.mediaType === 'application/json')
  const report = jsonObject(reports[0]?.jsonContent)
  const record = jsonObject(records[0]?.jsonContent)
  const result = jsonObject(record?.result)
  const submission = input.evaluationJob.artifacts.find(item => item.name === 'poc')
  if (reports.length !== 1 || records.length !== 1 || artifacts.some(item => item.evaluationId !== input.evaluationId)
    || new Set(artifacts.map(item => item.name)).size !== artifacts.length
    || !report || !record || !result || !submission
    || record.task_id !== raw.taskId || record.submission_sha256 !== submission.sha256.slice(7)
    || record.submission_bytes !== submission.sizeBytes || record.phase !== 'final' || record.submission_kind !== 'final'
    || record.evaluator_timed_out !== false || record.cleanup_timed_out !== false || record.cleanup_exit_code !== 0
    || result.status !== raw.status || result.success !== raw.success
    || report.status !== result.status || report.success !== result.success
    || typeof result.summary !== 'string' || !result.summary.trim() || report.summary !== result.summary
    || !Array.isArray(result.checks) || !jsonObject(result.details)
    || officialChecks(report.checks) === null || officialChecks(result.checks) === null
    || canonicalJson(officialChecks(report.checks)) !== canonicalJson(officialChecks(result.checks))
    || canonicalJson(report.details ?? {}) !== canonicalJson(result.details)) {
    throw new BenchmarkProtocolError('ZSOFT_REPORT_MISMATCH', 'ZSoft 官方报告证据缺失或与执行记录不一致', 422)
  }
  return result.summary
}

export class ZsoftL1Adapter extends AbstractBenchmarkAdapter<ZsoftCase, ZsoftPublicCase, ZsoftPrivateCase, ZsoftEvaluationPayload> {
  readonly manifest = getGeneratedBenchmarkManifest('zsoft-l1')

  imagePreparationInput(publicPayload: ZsoftPublicCase, privatePayload: ZsoftPrivateCase): ZsoftEvaluationPayload {
    return { ...privatePayload, taskId: publicPayload.taskId, maxBytes: publicPayload.maxBytes, submissionKind: publicPayload.submissionKind }
  }

  protected splitCase(raw: ZsoftCase) {
    return {
      externalCaseId: raw.public.taskId,
      publicPayload: { ...raw.public, tags: [...raw.public.tags] },
      privatePayload: { ...raw.private },
      catalogProjection: {
        input: raw.public.description,
        values: { title: raw.public.title, submissionKind: raw.public.submissionKind },
        tags: [...raw.public.tags],
      },
    }
  }

  protected createAgentTask(input: BuildAgentTaskInput<ZsoftPublicCase>): AgentTaskEnvelope {
    const payload = input.publicPayload
    const kernel = payload.tags.includes('kernel')
    if (kernel === payload.tags.includes('userspace') || (kernel && payload.submissionKind !== 'c')) throw new BenchmarkProtocolError('ZSOFT_TASK_TRACK_INVALID', 'ZSoft 题目轨道或提交类型不一致，内核题需提交 C 源码', 409)
    return {
      schemaVersion: 'agent-task/v1', benchmark: { key: this.manifest.adapterKey }, context: input.context,
      task: {
        instruction: `${payload.title}\n\n${payload.description}\n\n公开任务资料：tasks/${payload.taskId}/public/README.md 及同目录文件。\n生成独立的单文件 ${payload.submissionKind} PoC，将最终文件写入 submission/poc（不要提交目录、Patch 或 verify.py）。\n提交大小上限 ${payload.maxBytes} 字节。遵守公开 README 中的运行路径、依赖和退出码契约。只有 submission/poc 会送至平台评测；本地执行反馈不代表正式评测结果。`,
        benchmarkPayload: payload,
      },
      workspace: { provider: 'zsoft-tasks', taskId: payload.taskId },
      policy: { workspaceWrite: 'allow', hiddenDataAccess: 'deny', network: 'client-default' },
      submission: { requiredArtifacts: this.manifest.requiredArtifacts.map(item => ({ ...item })) },
      agentConfig: input.runConfig,
    }
  }

  protected async validateBenchmarkSubmission(input: ValidateSubmissionInput): Promise<void> {
    const payload = (input.submission?.publicPayload ?? input.task?.task.benchmarkPayload) as ZsoftPublicCase
    const artifact = input.artifacts[0]
    if (!payload || artifact.descriptor.sizeBytes > payload.maxBytes) {
      throw new BenchmarkProtocolError('ZSOFT_SUBMISSION_TOO_LARGE', 'PoC 超出该题的提交限制')
    }
    if (payload.submissionKind !== 'binary') {
      let text: string
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(await artifact.readBytes()) }
      catch { throw new BenchmarkProtocolError('ZSOFT_SUBMISSION_ENCODING_INVALID', 'Python/C PoC 必须为 UTF-8 文本') }
      if (!text.trim() || text.includes('\0')) throw new BenchmarkProtocolError('ZSOFT_SUBMISSION_INVALID', 'PoC 为空或包含 NUL')
    }
  }

  protected createEvaluationRequest(input: BuildEvaluationRequestInput<ZsoftPublicCase, ZsoftPrivateCase>): EvaluationJob<ZsoftEvaluationPayload> {
    return {
      protocolVersion: 'benchmark-evaluation/v1',
      evaluationId: input.context.evaluationRunId,
      executionRunId: input.context.executionRunId,
      context: { experimentId: input.context.experimentId, caseId: input.context.caseId, datasetContentHash: input.context.datasetContentHash },
      benchmark: { key: this.manifest.adapterKey },
      evaluator: { key: input.runConfig.evaluatorKey },
      artifacts: input.artifacts.map((item) => ({ ...item })),
      payload: { ...input.privatePayload, taskId: input.publicPayload.taskId, maxBytes: input.publicPayload.maxBytes, submissionKind: input.publicPayload.submissionKind },
      limits: { timeoutSeconds: input.runConfig.timeoutSeconds, cpu: input.runConfig.cpu, memoryMiB: input.runConfig.memoryMiB },
    }
  }

  protected createNormalizedResult(input: NormalizeBenchmarkResultInput): NormalizedBenchmarkResult {
    const { completion } = input
    const evidence: JsonValue = { artifactIds: input.evidenceArtifacts.map((item) => item.artifactId), cleanup: completion.cleanup }
    if (completion.status === 'failed') {
      return { status: 'failed', summary: completion.error?.message || 'ZSoft 基础设施评测失败', score: null, points: [], evidence, nativeMetrics: {}, errorMessage: completion.error?.message || 'ZSoft 基础设施评测失败' }
    }
    const raw = completion.rawResult as ZsoftResult
    const expected = input.evaluationJob.payload as ZsoftEvaluationPayload
    const artifact = input.evaluationJob.artifacts.find((item) => item.name === 'poc')
    if (raw.taskId !== expected.taskId || raw.sourceTaskDigest !== expected.sourceTaskDigest || raw.submissionSha256 !== artifact?.sha256) {
      throw new BenchmarkProtocolError('ZSOFT_RESULT_IDENTITY_MISMATCH', 'ZSoft 结果与冻结题目或 PoC 不一致', 422)
    }
    if (raw.status === 'infrastructure_error' || (completion.status === 'completed' && raw.status !== 'completed') || (completion.status === 'submission_invalid' && (raw.status !== 'invalid_submission' || raw.success))) {
      throw new BenchmarkProtocolError('ZSOFT_RESULT_STATUS_INVALID', 'ZSoft 原生结果状态不一致', 422)
    }
    const summary = officialSummary(input, raw)
    const invalid = completion.status === 'submission_invalid'
    return {
      status: 'done', verdict: raw.success ? 'pass' : 'fail',
      summary: summary || (invalid ? 'PoC 不符合官方提交要求' : raw.success ? 'PoC 通过官方判题' : 'PoC 未通过官方判题'),
      score: invalid ? null : raw.success ? 100 : 0,
      primaryMetric: { key: 'success', aggregation: 'boolean-rate', value: invalid ? null : raw.success },
      points: [{ label: 'Success', value: invalid ? null : raw.success }], evidence,
      nativeMetrics: { taskId: raw.taskId, status: raw.status, success: raw.success },
    }
  }
}

export const zsoftL1Adapter = new ZsoftL1Adapter()
