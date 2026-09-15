import { z } from 'zod'

import { getGeneratedBenchmarkManifest } from '../../../generated/benchmark-catalog/manifests'
import { canonicalJson, type JsonValue } from '../../../packages/benchmark-protocol/src/contracts'
import type {
  AgentTaskEnvelope,
  BuildAgentTaskInput,
} from '../../../packages/benchmark-protocol/src/contracts'
import type {
  BuildEvaluationRequestInput,
  EvaluationJob,
  ValidateSubmissionInput,
} from '../../../packages/benchmark-protocol/src/evaluation-contracts'
import type {
  NormalizeBenchmarkResultInput,
  NormalizedBenchmarkResult,
} from '../../../packages/benchmark-protocol/src/evaluator-contracts'
import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'
import { AbstractBenchmarkAdapter } from '../../../src/lib/benchmark/adapter-base'

const TestListSchema = z.union([z.string(), z.array(z.string())])
const REQUIRED_COMPLETION_EVIDENCE = [
  { name: 'report.json', kind: 'official-report', mediaType: 'application/json' },
  { name: 'test_output.txt', kind: 'test-output', mediaType: 'text/plain' },
  { name: 'run_instance.log', kind: 'harness-log', mediaType: 'text/plain' },
] as const

const RawSweBenchCaseSchema = z.object({
  instance_id: z.string().trim().min(1),
  repo: z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  base_commit: z.string().trim().regex(/^[0-9a-f]{40}$/i),
  problem_statement: z.string().trim().min(1),
  hints_text: z.string().default(''),
  patch: z.string(),
  test_patch: z.string(),
  FAIL_TO_PASS: TestListSchema,
  PASS_TO_PASS: TestListSchema,
  environment_setup_commit: z.string().trim().optional(),
  version: z.string().trim().optional(),
  image: z.string().default(''),
  eval_script: z.string().default(''),
  eval_type: z.string().default(''),
  log_parser: z.string().default(''),
  created_at: z.string().default(''),
  difficulty: z.string().default(''),
})

export type RawSweBenchCase = z.infer<typeof RawSweBenchCaseSchema>

export type SweBenchPublicCase = {
  instanceId: string
  repo: string
  baseCommit: string
  problemStatement: string
  hintsText: string
  repositoryVersion?: string
}

export type SweBenchPrivateCase = {
  goldPatch: string
  testPatch: string
  failToPass: string[]
  passToPass: string[]
  environmentSetupCommit?: string
  evaluation: {
    image: string
    script: string
    type: string
    logParser: string
  }
  metadata: {
    createdAt: string
    difficulty: string
  }
}

export type SweBenchEvaluationPayload = {
  instance: {
    instance_id: string
    repo: string
    base_commit: string
    version: string
    image: string
    eval_script: string
    eval_type: string
    log_parser: string
    FAIL_TO_PASS: string[]
    PASS_TO_PASS: string[]
  }
  prediction: {
    instance_id: string
    model_name_or_path: string
    model_patch_artifact_id: string
  }
}

function parseTestList(value: string | string[], field: string): string[] {
  if (Array.isArray(value)) return value.map(String)
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed
    }
  } catch {
    // Fall through to the structured protocol error below.
  }
  throw new BenchmarkProtocolError(
    'SWE_CASE_FIELD_INVALID',
    `${field} 必须是字符串数组或其 JSON 字符串`,
  )
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function rawResultError(message: string): never {
  throw new BenchmarkProtocolError('SWE_RAW_RESULT_INVALID', message, 500)
}

function strictMetric(value: unknown, field: string): { passed: number; total: number } {
  const metric = asRecord(value)
  const passed = metric?.passed
  const total = metric?.total
  if (
    typeof passed !== 'number'
    || typeof total !== 'number'
    || !Number.isInteger(passed)
    || !Number.isInteger(total)
    || passed < 0
    || total < 0
    || passed > total
  ) {
    return rawResultError(`SWE-bench 原生结果 ${field} 计数不合法`)
  }
  return { passed, total }
}

function officialMetric(
  report: Record<string, unknown>,
  field: 'FAIL_TO_PASS' | 'PASS_TO_PASS',
  expectedTests: readonly string[],
): { passed: number; total: number } {
  const status = asRecord(asRecord(report.tests_status)?.[field])
  const success = status?.success
  const failure = status?.failure
  if (
    !Array.isArray(success)
    || !Array.isArray(failure)
    || success.some((item) => typeof item !== 'string')
    || failure.some((item) => typeof item !== 'string')
  ) {
    return rawResultError(`SWE-bench 官方报告 tests_status.${field} 不完整`)
  }
  const reportedTests = [...success, ...failure]
  if (
    new Set(expectedTests).size !== expectedTests.length
    || new Set(reportedTests).size !== reportedTests.length
    || reportedTests.length !== expectedTests.length
    || reportedTests.some((test) => !expectedTests.includes(test))
  ) {
    return rawResultError(`SWE-bench 官方报告 tests_status.${field} 与冻结测试名单不一致`)
  }
  return { passed: success.length, total: success.length + failure.length }
}

function frozenExpectation(input: NormalizeBenchmarkResultInput): {
  instanceId: string
  failToPass: string[]
  passToPass: string[]
} {
  const payload = asRecord(input.evaluationJob.payload)
  const instance = asRecord(payload?.instance)
  const instanceId = instance?.instance_id
  const failToPass = instance?.FAIL_TO_PASS
  const passToPass = instance?.PASS_TO_PASS
  if (
    typeof instanceId !== 'string'
    || !instanceId.trim()
    || !Array.isArray(failToPass)
    || failToPass.length < 1
    || failToPass.some((test) => typeof test !== 'string')
    || !Array.isArray(passToPass)
    || passToPass.some((test) => typeof test !== 'string')
    || new Set([...failToPass, ...passToPass]).size !== failToPass.length + passToPass.length
  ) {
    throw new BenchmarkProtocolError(
      'EVALUATION_REQUEST_INVALID',
      '冻结的 SWE-bench 评测任务缺少实例或测试名单',
      500,
    )
  }
  return {
    instanceId,
    failToPass: failToPass as string[],
    passToPass: passToPass as string[],
  }
}

function sameMetric(
  first: { passed: number; total: number },
  second: { passed: number; total: number },
): boolean {
  return first.passed === second.passed && first.total === second.total
}

export class SweBenchAdapter extends AbstractBenchmarkAdapter<
  RawSweBenchCase,
  SweBenchPublicCase,
  SweBenchPrivateCase,
  SweBenchEvaluationPayload
> {
  readonly manifest = getGeneratedBenchmarkManifest('swe-bench')

  protected splitCase(rawInput: RawSweBenchCase) {
    const parsed = RawSweBenchCaseSchema.safeParse(rawInput)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new BenchmarkProtocolError(
        'SWE_CASE_FIELD_INVALID',
        `SWE-bench Case 字段不合法：${issue.path.join('.') || '$'} ${issue.message}`,
      )
    }
    const raw = parsed.data
    const publicPayload: SweBenchPublicCase = {
      instanceId: raw.instance_id,
      repo: raw.repo,
      baseCommit: raw.base_commit,
      problemStatement: raw.problem_statement,
      hintsText: raw.hints_text,
      ...(raw.version ? { repositoryVersion: raw.version } : {}),
    }
    const privatePayload: SweBenchPrivateCase = {
      goldPatch: raw.patch,
      testPatch: raw.test_patch,
      failToPass: parseTestList(raw.FAIL_TO_PASS, 'FAIL_TO_PASS'),
      passToPass: parseTestList(raw.PASS_TO_PASS, 'PASS_TO_PASS'),
      evaluation: {
        image: raw.image,
        script: raw.eval_script,
        type: raw.eval_type,
        logParser: raw.log_parser,
      },
      metadata: {
        createdAt: raw.created_at,
        difficulty: raw.difficulty,
      },
      ...(raw.environment_setup_commit
        ? { environmentSetupCommit: raw.environment_setup_commit }
        : {}),
    }
    return {
      externalCaseId: raw.instance_id,
      publicPayload,
      privatePayload,
      catalogProjection: {
        input: raw.problem_statement,
        values: {
          instance_id: raw.instance_id,
          repo: raw.repo,
          base_commit: raw.base_commit,
          version: raw.version || '',
          hints_text: raw.hints_text,
        },
        tags: ['SWE-bench', 'Verified'],
      },
    }
  }

  protected createAgentTask(input: BuildAgentTaskInput<SweBenchPublicCase>): AgentTaskEnvelope {
    const payload = input.publicPayload
    return {
      schemaVersion: 'agent-task/v1',
      benchmark: { key: this.manifest.adapterKey },
      context: input.context,
      task: {
        instruction: [
          'Fix the issue described below in the checked-out repository.',
          `Repository: ${payload.repo}`,
          `Issue:\n${payload.problemStatement}`,
          payload.hintsText ? `Hints:\n${payload.hintsText}` : '',
          'Do not access hidden evaluation data. Modify the working tree only; the executor will collect model.patch.',
        ].filter(Boolean).join('\n\n'),
        benchmarkPayload: payload,
      },
      workspace: {
        provider: 'git',
        repository: `https://github.com/${payload.repo}.git`,
        revision: payload.baseCommit,
      },
      policy: {
        workspaceWrite: 'allow',
        hiddenDataAccess: 'deny',
        network: 'client-default',
      },
      submission: {
        requiredArtifacts: this.manifest.requiredArtifacts.map((item) => ({ ...item })),
      },
      agentConfig: input.runConfig,
    }
  }

  protected async validateBenchmarkSubmission(input: ValidateSubmissionInput): Promise<void> {
    if (input.artifacts.length !== 1 || input.artifacts[0].descriptor.name !== 'model.patch') {
      throw new BenchmarkProtocolError('SWE_PATCH_MISSING', 'SWE-bench 必须且只能提交 model.patch')
    }
    const bytes = await input.artifacts[0].readBytes()
    let patch: string
    try {
      patch = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new BenchmarkProtocolError('SWE_PATCH_ENCODING_INVALID', 'model.patch 必须是 UTF-8 文本')
    }
    if (!patch.trim() || patch.includes('\0')) {
      throw new BenchmarkProtocolError('SWE_PATCH_INVALID', 'model.patch 为空或包含 NUL')
    }
    const headers = [...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)]
    if (!headers.length) {
      throw new BenchmarkProtocolError('SWE_PATCH_INVALID', 'model.patch 不是有效 Git Patch')
    }
    for (const header of headers) {
      for (const relativePath of [header[1], header[2]]) {
        const segments = relativePath.split('/')
        if (
          relativePath.startsWith('/')
          || relativePath.includes('\\')
          || segments.some((segment) => !segment || segment === '.' || segment === '..')
          || segments.includes('.git')
        ) {
          throw new BenchmarkProtocolError('SWE_PATCH_PATH_INVALID', 'model.patch 包含越界或 Git 元数据路径')
        }
      }
    }
  }

  protected createEvaluationRequest(
    input: BuildEvaluationRequestInput<SweBenchPublicCase, SweBenchPrivateCase>,
  ): EvaluationJob<SweBenchEvaluationPayload> {
    const artifact = input.artifacts.find((item) => item.name === 'model.patch')
    const evaluation = input.privatePayload.evaluation
    if (!artifact) {
      throw new BenchmarkProtocolError('SWE_PATCH_MISSING', 'SWE-bench 缺少 model.patch')
    }
    if (!evaluation.image || !evaluation.script || !evaluation.type || !evaluation.logParser) {
      throw new BenchmarkProtocolError('SWE_EVALUATION_CONFIG_MISSING', 'SWE-bench 官方评测配置不完整', 500)
    }
    return {
      protocolVersion: 'benchmark-evaluation/v1',
      evaluationId: input.context.evaluationRunId,
      executionRunId: input.context.executionRunId,
      context: {
        experimentId: input.context.experimentId,
        caseId: input.context.caseId,
        datasetContentHash: input.context.datasetContentHash,
      },
      benchmark: { key: this.manifest.adapterKey },
      evaluator: { key: input.runConfig.evaluatorKey },
      artifacts: input.artifacts.map((item) => ({ ...item })),
      payload: {
        instance: {
          instance_id: input.publicPayload.instanceId,
          repo: input.publicPayload.repo,
          base_commit: input.publicPayload.baseCommit,
          version: input.publicPayload.repositoryVersion || '',
          image: evaluation.image,
          eval_script: evaluation.script,
          eval_type: evaluation.type,
          log_parser: evaluation.logParser,
          FAIL_TO_PASS: [...input.privatePayload.failToPass],
          PASS_TO_PASS: [...input.privatePayload.passToPass],
        },
        prediction: {
          instance_id: input.publicPayload.instanceId,
          model_name_or_path: input.runConfig.agentModel || 'platform/agent',
          model_patch_artifact_id: artifact.artifactId,
        },
      },
      limits: {
        timeoutSeconds: input.runConfig.timeoutSeconds,
        cpu: input.runConfig.cpu,
        memoryMiB: input.runConfig.memoryMiB,
      },
    }
  }

  protected createNormalizedResult(
    input: NormalizeBenchmarkResultInput,
  ): NormalizedBenchmarkResult {
    const completion = input.completion
    const raw = asRecord(completion.rawResult) || {}
    const evidence = {
      artifactIds: input.evidenceArtifacts.map((artifact) => artifact.artifactId),
      cleanup: completion.cleanup,
    }
    const testMetric = (value: unknown, field: string) => strictMetric(value, field)
    const nativeMetrics = {
      ...(typeof raw.instanceId === 'string' ? { instanceId: raw.instanceId } : {}),
      ...(typeof raw.resolved === 'boolean' ? { resolved: raw.resolved } : {}),
      ...(typeof raw.patchSuccessfullyApplied === 'boolean'
        ? { patchSuccessfullyApplied: raw.patchSuccessfullyApplied }
        : {}),
      ...(completion.status === 'failed'
        ? {}
        : {
            failToPass: testMetric(raw.failToPass, 'failToPass'),
            passToPass: testMetric(raw.passToPass, 'passToPass'),
          }),
    }

    if (completion.status === 'failed') {
      return {
        status: 'failed',
        summary: completion.error?.message || 'SWE-bench 评测基础设施执行失败',
        score: null,
        points: [],
        evidence,
        nativeMetrics,
        errorMessage: completion.error?.message || 'SWE-bench 评测失败',
      }
    }
    const expected = frozenExpectation(input)
    if (completion.status === 'submission_invalid') {
      if (raw.instanceId !== expected.instanceId) {
        return rawResultError('SWE-bench 原生结果 instanceId 与冻结评测任务不一致')
      }
      return {
        status: 'done',
        verdict: 'fail',
        summary: completion.error?.message || 'Agent Patch 无法应用',
        score: null,
        points: [],
        evidence,
        nativeMetrics,
      }
    }
    if (typeof raw.resolved !== 'boolean') {
      return rawResultError('SWE-bench 原生结果缺少 resolved')
    }
    if (raw.instanceId !== expected.instanceId) {
      return rawResultError('SWE-bench 原生结果 instanceId 与冻结评测任务不一致')
    }
    if (input.evidenceArtifacts.length !== REQUIRED_COMPLETION_EVIDENCE.length) {
      throw new BenchmarkProtocolError(
        'SWE_EVIDENCE_CONTRACT_INVALID',
        'SWE-bench 正式结果的证据集合不完整或包含未声明项',
        422,
      )
    }
    let officialEvidence: NormalizeBenchmarkResultInput['evidenceArtifacts'][number] | undefined
    for (const required of REQUIRED_COMPLETION_EVIDENCE) {
      const matches = input.evidenceArtifacts.filter((artifact) => (
        artifact.name === required.name
        && artifact.kind === required.kind
        && artifact.mediaType === required.mediaType
      ))
      if (matches.length !== 1) {
        throw new BenchmarkProtocolError(
          'SWE_EVIDENCE_CONTRACT_INVALID',
          `SWE-bench 正式结果缺少有效证据：${required.name}`,
          422,
        )
      }
      if (required.kind === 'official-report') officialEvidence = matches[0]
    }
    const officialReport = asRecord(raw.officialReport)
    const officialKeys = officialReport ? Object.keys(officialReport) : []
    const caseReport = officialReport ? asRecord(officialReport[expected.instanceId]) : null
    if (officialKeys.length !== 1 || !caseReport) {
      return rawResultError('SWE-bench 官方报告与冻结评测任务不一致')
    }
    if (
      officialEvidence?.jsonContent === undefined
      || canonicalJson(officialEvidence.jsonContent) !== canonicalJson(officialReport as JsonValue)
    ) {
      throw new BenchmarkProtocolError(
        'SWE_EVIDENCE_CONTRACT_INVALID',
        'SWE-bench report.json 与回调中的官方报告不一致',
        422,
      )
    }
    if (
      caseReport.infra_failure === true
      || typeof caseReport.resolved !== 'boolean'
      || typeof caseReport.patch_successfully_applied !== 'boolean'
      || caseReport.resolved !== raw.resolved
      || caseReport.patch_successfully_applied !== raw.patchSuccessfullyApplied
    ) {
      return rawResultError('SWE-bench 原生结果与官方报告判定不一致')
    }
    const failToPass = strictMetric(raw.failToPass, 'failToPass')
    const passToPass = strictMetric(raw.passToPass, 'passToPass')
    if (
      !sameMetric(failToPass, officialMetric(caseReport, 'FAIL_TO_PASS', expected.failToPass))
      || !sameMetric(passToPass, officialMetric(caseReport, 'PASS_TO_PASS', expected.passToPass))
    ) {
      return rawResultError('SWE-bench 原生测试计数与官方报告不一致')
    }
    if (
      raw.resolved
      && (
        raw.patchSuccessfullyApplied !== true
        || failToPass.passed !== failToPass.total
        || passToPass.passed !== passToPass.total
      )
    ) {
      return rawResultError('SWE-bench resolved=true 与官方测试结果不一致')
    }
    const metricPoint = (label: string, value: unknown) => {
      const { passed, total } = strictMetric(value, label)
      const score = total > 0
        ? Math.round((passed / total) * 10_000) / 100
        : null
      return {
        label,
        value: passed,
        total,
        format: 'ratio' as const,
        score,
        evidence: { passed, total },
      }
    }
    return {
      status: 'done',
      verdict: raw.resolved ? 'pass' : 'fail',
      summary: raw.resolved
        ? 'Agent Patch 通过全部 SWE-bench 目标测试且没有回归'
        : 'Agent Patch 未通过 SWE-bench 官方判定',
      score: raw.resolved ? 100 : 0,
      primaryMetric: {
        key: 'resolved',
        value: raw.resolved,
        aggregation: 'boolean-rate',
      },
      points: [
        metricPoint('FAIL_TO_PASS', raw.failToPass),
        metricPoint('PASS_TO_PASS', raw.passToPass),
      ],
      evidence,
      nativeMetrics,
    }
  }
}

export const sweBenchAdapter = new SweBenchAdapter()
