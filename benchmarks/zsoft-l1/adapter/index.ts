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
    const reports = input.evidenceArtifacts.filter((item) => item.name === 'report.json' && item.kind === 'official-report' && item.mediaType === 'application/json')
    if (input.evidenceArtifacts.length !== 1 || reports.length !== 1 || reports[0].evaluationId !== input.evaluationId || reports[0].jsonContent === undefined || canonicalJson(reports[0].jsonContent) !== canonicalJson(completion.rawResult)) {
      throw new BenchmarkProtocolError('ZSOFT_REPORT_MISMATCH', 'ZSoft 报告证据缺失或不一致', 422)
    }
    const invalid = completion.status === 'submission_invalid'
    return {
      status: 'done', verdict: raw.success ? 'pass' : 'fail',
      summary: invalid ? 'PoC 不符合官方提交要求' : raw.success ? 'PoC 通过官方判题' : 'PoC 未通过官方判题',
      score: invalid ? null : raw.success ? 100 : 0,
      primaryMetric: { key: 'success', aggregation: 'boolean-rate', value: invalid ? null : raw.success },
      points: [{ label: 'Success', value: invalid ? null : raw.success }], evidence,
      nativeMetrics: { taskId: raw.taskId, status: raw.status, success: raw.success },
    }
  }
}

export const zsoftL1Adapter = new ZsoftL1Adapter()
