import { createHash } from 'node:crypto'

import { BenchmarkProtocolError } from './errors'

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export type BenchmarkArtifactContract = {
  name: string
  mediaType: string
  collector: string
  maxBytes: number
}

export type BenchmarkDatasetProfile = {
  key: string
  displayName: string
  acceptedExtensions: readonly string[]
  expectedCaseCount?: number
}

export type BenchmarkPresentationColumn = {
  path: string
  label: string
  type: 'text' | 'code' | 'number' | 'boolean'
}

export type BenchmarkPresentation = {
  caseTable: {
    searchPaths: readonly string[]
    searchPlaceholder?: string
    columns: readonly BenchmarkPresentationColumn[]
  }
  referencePanel?: {
    title: string
    description: string
    columns: readonly BenchmarkPresentationColumn[]
  }
  result?: {
    primaryMetric: {
      path: string
      label: string
      type: 'text' | 'code' | 'number' | 'boolean'
    }
  }
}

export interface BenchmarkDatasetLoader {
  loadCases(sourcePath: string): AsyncIterable<JsonValue>
}

export type BenchmarkManifest = {
  adapterKey: string
  displayName: string
  protocols: {
    agentTask: 'agent-task/v1'
    evaluation: 'benchmark-evaluation/v1'
  }
  requiredCapabilities: readonly string[]
  defaultTimeoutSeconds: number
  requiredArtifacts: readonly BenchmarkArtifactContract[]
  schemas: {
    case: JsonValue
    rawResult: JsonValue
  }
  evaluation: {
    evaluatorKey: string
    defaultTimeoutSeconds: number
    defaultResources: { cpu: number; memoryMiB: number }
  }
  result: {
    primaryMetric: {
      key: string
      aggregation: 'boolean-rate' | 'mean'
    }
  }
  dataset?: {
    profiles: readonly BenchmarkDatasetProfile[]
  }
  presentation?: BenchmarkPresentation
}

export type BenchmarkRunConfig = {
  platform: string
  agent: string
  model?: string
  timeoutSeconds: number
}

export type BenchmarkRunContext = {
  runId: string
  experimentId: string
  caseId: string
}

export type AgentTaskEnvelope = {
  schemaVersion: 'agent-task/v1'
  benchmark: { key: string }
  context: BenchmarkRunContext
  task: {
    instruction: string
    benchmarkPayload: JsonValue
  }
  workspace: {
    provider: 'git'
    repository: string
    revision: string
  }
  policy: {
    workspaceWrite: 'allow'
    hiddenDataAccess: 'deny'
    network: 'deny' | 'client-default'
  }
  submission: {
    requiredArtifacts: BenchmarkArtifactContract[]
  }
  agentConfig: BenchmarkRunConfig
}

export type SplitCaseResult<TPublic extends JsonValue, TPrivate extends JsonValue> = {
  externalCaseId: string
  publicPayload: TPublic
  privatePayload: TPrivate
  catalogProjection: {
    input: string
    values: { [key: string]: JsonValue }
    tags?: readonly string[]
  }
  publicFingerprint: string
  privateFingerprint: string
}

export type BuildAgentTaskInput<TPublic extends JsonValue> = {
  publicPayload: TPublic
  runConfig: BenchmarkRunConfig
  context: BenchmarkRunContext
}

export interface BenchmarkPreExecutionAdapter<
  TRaw = unknown,
  TPublic extends JsonValue = JsonValue,
  TPrivate extends JsonValue = JsonValue,
> {
  readonly manifest: BenchmarkManifest
  validateAndSplitCase(raw: TRaw): SplitCaseResult<TPublic, TPrivate>
  buildAgentTask(input: BuildAgentTaskInput<TPublic>): AgentTaskEnvelope
}

const FORBIDDEN_TASK_KEYS = new Set([
  'command',
  'shell',
  'args',
  'executable',
  'token',
  'credential',
  'privatepayload',
])

function normalizeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(normalizeJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeJson(item)]),
    )
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new BenchmarkProtocolError('JSON_VALUE_INVALID', 'JSON 数字必须是有限值')
  }
  return value
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(normalizeJson(value))
}

export function fingerprintJson(value: JsonValue): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function taskValue(value: AgentTaskEnvelope): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function scanForbiddenKeys(value: JsonValue, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbiddenKeys(item, `${path}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_TASK_KEYS.has(key.toLowerCase())) {
      throw new BenchmarkProtocolError(
        'TASK_FORBIDDEN_FIELD',
        `任务包含禁止字段 ${path}.${key}`,
      )
    }
    scanForbiddenKeys(item, `${path}.${key}`)
  }
}

export function validateTaskEnvelope(
  task: AgentTaskEnvelope,
  context: BenchmarkRunContext,
  manifest: BenchmarkManifest,
): void {
  if (task.schemaVersion !== 'agent-task/v1') {
    throw new BenchmarkProtocolError('TASK_SCHEMA_INVALID', '任务协议标识不受支持')
  }
  if (
    task.context.runId !== context.runId
    || task.context.experimentId !== context.experimentId
    || task.context.caseId !== context.caseId
  ) {
    throw new BenchmarkProtocolError('TASK_CONTEXT_MISMATCH', '任务上下文与运行记录不一致')
  }
  if (task.benchmark.key !== manifest.adapterKey) {
    throw new BenchmarkProtocolError('TASK_ADAPTER_MISMATCH', '任务 Adapter key 不一致')
  }
  if (!task.task.instruction.trim() || task.task.instruction.length > 64 * 1024) {
    throw new BenchmarkProtocolError('TASK_INSTRUCTION_INVALID', '任务说明为空或超限')
  }
  if (canonicalJson(task.task.benchmarkPayload).length > 256 * 1024) {
    throw new BenchmarkProtocolError('TASK_PAYLOAD_TOO_LARGE', '任务公开数据超过 256 KiB')
  }
  let repository: URL
  try {
    repository = new URL(task.workspace.repository)
  } catch {
    throw new BenchmarkProtocolError('TASK_REPOSITORY_INVALID', '仓库地址不合法')
  }
  if (
    repository.protocol !== 'https:'
    || repository.hostname !== 'github.com'
    || repository.username
    || repository.password
    || repository.search
    || repository.hash
  ) {
    throw new BenchmarkProtocolError('TASK_REPOSITORY_INVALID', '仓库地址必须是 GitHub HTTPS 地址')
  }
  if (!/^[0-9a-f]{40}$/i.test(task.workspace.revision)) {
    throw new BenchmarkProtocolError('TASK_REVISION_INVALID', '仓库 revision 必须是 40 位 commit SHA')
  }
  const expectedArtifacts = canonicalJson(manifest.requiredArtifacts as unknown as JsonValue)
  const actualArtifacts = canonicalJson(task.submission.requiredArtifacts as unknown as JsonValue)
  if (expectedArtifacts !== actualArtifacts) {
    throw new BenchmarkProtocolError('TASK_ARTIFACT_CONTRACT_MISMATCH', '提交物契约与 Manifest 不一致')
  }
  if (
    manifest.protocols.agentTask !== task.schemaVersion
    || !task.submission.requiredArtifacts.every((artifact) => (
      /^[a-z0-9][a-z0-9._/-]{0,127}$/.test(artifact.collector)
      && Number.isInteger(artifact.maxBytes)
      && artifact.maxBytes > 0
    ))
    ||
    !task.agentConfig.platform.trim()
    || !task.agentConfig.agent.trim()
    || !Number.isInteger(task.agentConfig.timeoutSeconds)
    || task.agentConfig.timeoutSeconds < 1
  ) {
    throw new BenchmarkProtocolError('TASK_AGENT_CONFIG_INVALID', 'Agent 配置不合法')
  }
  scanForbiddenKeys(taskValue(task))
}

export function benchmarkDispatchDigest(input: {
  runId: string
  task: AgentTaskEnvelope
  callbackBaseUrl: string
  timeoutSeconds: number
}): `sha256:${string}` {
  return fingerprintJson(input as unknown as JsonValue)
}
