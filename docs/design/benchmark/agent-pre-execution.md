# Benchmark Agent 执行前服务端设计

> 聚焦步骤 01～04：创建实验 → 拆分 Case → 构造任务 → 下发执行器。前端、Agent 本地执行、Artifact 上传和评测服务分别见本目录其他文档。

状态：已实现。浏览器统一实验入口、服务端冻结与串行调度、客户端控制通道及执行器步骤 04～07 已接通；真实 SWE-bench Verified Case 已贯穿步骤 01～07 测试。

## 1. 主流程

```text
POST /api/experiments (scope=benchmark)
  └─ BenchmarkExperimentService.create()
       ├─ datasetId → dataset + adapterKey
       ├─ clientId → capabilities
       └─ 事务创建 Experiment、Binding、Cases、CaseRuns(pending)

POST /api/experiments/{id}/run
  └─ BenchmarkOrchestrator.start()
       └─ prepareNextCaseRun()
            ├─ adapter.validateAndSplitCase(rawCase)
            ├─ adapter.buildAgentTask(publicPayload, runContext)
            ├─ 事务保存 TaskEnvelope + digest + DispatchOutbox
            └─ OutboxWorker → RUN_BENCHMARK_CASE(clientId)
                 └─ COMMAND_STATUS accepted → CaseRun(running_agent)
```

创建实验只冻结任务，不调用 Adapter、不发 HTTP。启动实验后按 Case 顺序推进；同一实验 Agent 并发固定为 1，当前 Run 未结束前不下发下一条。

高保真步骤 01 展示了 `/api/benchmark/v1/experiments`，但当前项目已有统一实验资源。实现采用 `POST /api/experiments`，避免维护两套实验生命周期。

## 2. 模块落点

沿用 phase3 的一期过渡目录，不提前迁移完整 Monorepo：

```text
packages/benchmark-protocol/
  src/contracts.ts            # 三端稳定信封与 Adapter 接口
  src/errors.ts
  schemas/
  tests/contracts.test.ts

src/lib/benchmark/
  adapter-base.ts             # Agent Insight 服务端抽象基类
  adapter-registry.ts         # 只消费构建生成的 Adapter Catalog
  dataset-service.ts
  experiment-service.ts
  orchestrator.ts
  scheduler.ts                # Dispatch Outbox、客户端控制指令下发与恢复

benchmarks/swe-bench/
  benchmark.yaml
  adapter/index.ts
  dataset/
    index.ts                 # 调用官方 loader，导入真实 Verified 数据
  schemas/
  fixtures/smoke-case.json
  tests/adapter.test.ts

scripts/benchmark/
  load_official_swebench_dataset.py  # standalone 会携带的 Python 进程桥
  generate-catalog.cjs               # 扫描接入包并生成三端静态 Catalog

generated/benchmark-catalog/
  adapters.ts                        # Adapter 静态 import；禁止手改

src/app/api/experiments/route.ts
src/app/api/experiments/[id]/run/route.ts

test/
  benchmark-dataset-admin.test.ts
  benchmark-execution-dispatch.test.ts
  benchmark-executor-api.test.ts
  benchmark-real-e2e.test.ts
  swe-bench-official-dataset.test.ts
```

`services/executor/` 由现有 `agent-insight-client` 加载，不是第二个守护进程。API Route 只做鉴权、参数解析和响应映射；SWE-bench Adapter 保持纯函数，数据集模块负责文件与官方 Python loader，二者不混用。执行器实现以 [Benchmark 执行器后端设计](executor.md) 为准。

## 3. Adapter 协议

```ts
type JsonValue =
  | null | boolean | number | string
  | JsonValue[]
  | { [key: string]: JsonValue }

type BenchmarkManifest = {
  adapterKey: string
  displayName: string
  protocols: {
    agentTask: 'agent-task/v1'
    evaluation: 'benchmark-evaluation/v1'
  }
  requiredCapabilities: readonly string[]
  defaultTimeoutSeconds: number
  requiredArtifacts: readonly {
    name: string
    mediaType: string
    collector: string
    maxBytes: number
  }[]
  schemas: { case: JsonValue; rawResult: JsonValue }
  evaluation: {
    evaluatorKey: string
    defaultTimeoutSeconds: number
    defaultResources: { cpu: number; memoryMiB: number }
  }
  result: {
    primaryMetric: { key: string; aggregation: 'boolean-rate' | 'mean' }
  }
}

type BenchmarkRunConfig = {
  platform: string
  agent: string
  model?: string
  timeoutSeconds: number
}

type RunContext = {
  runId: string
  experimentId: string
  caseId: string
}

type SplitCaseResult<TPublic extends JsonValue, TPrivate extends JsonValue> = {
  externalCaseId: string
  publicPayload: TPublic
  privatePayload: TPrivate
  catalogProjection: {
    input: string
    values: Record<string, JsonValue>
    tags?: readonly string[]
  }
  publicFingerprint: string
  privateFingerprint: string
}

type BuildAgentTaskInput<TPublic extends JsonValue> = {
  publicPayload: TPublic
  runConfig: BenchmarkRunConfig
  context: RunContext
}

interface BenchmarkAdapter<
  TRaw = unknown,
  TPublic extends JsonValue = JsonValue,
  TPrivate extends JsonValue = JsonValue,
  TEvaluationPayload extends JsonValue = JsonValue,
> {
  readonly manifest: BenchmarkManifest
  validateAndSplitCase(raw: TRaw): SplitCaseResult<TPublic, TPrivate>
  buildAgentTask(input: BuildAgentTaskInput<TPublic>): AgentTaskEnvelope
  validateSubmission(input: ValidateSubmissionInput): Promise<void>
  buildEvaluationRequest(
    input: BuildEvaluationRequestInput<TPublic, TPrivate>,
  ): EvaluationJob<TEvaluationPayload>
  normalizeResult(input: NormalizeBenchmarkResultInput): NormalizedBenchmarkResult
}

abstract class AbstractBenchmarkAdapter<
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
}
```

抽象基类统一执行 Case/Raw Result Schema、公开/私有边界、指纹、上下文、Artifact 和归一化结果校验；开发者只实现上面一一对应的五个 `protected` hook。当前文档的步骤 01～03 只调用前两个，后三个由步骤 08～12 调用。`BenchmarkRunConfig` 使用结构化 `platform + agent + model + timeoutSeconds`，执行器不解析展示字符串。

注册表从构建生成的 Catalog 注册，不直接 import SWE-bench：

```ts
for (const adapter of generatedBenchmarkAdapters) registerBenchmarkAdapter(adapter)
getBenchmarkAdapter('swe-bench')
```

不建立 Benchmark、数据集或评估器业务版本。`schemaVersion` 和能力名中的 `/v1` 仅是跨进程协议兼容标识。

## 4. 通用任务信封

```ts
type AgentTaskEnvelope = {
  schemaVersion: 'agent-task/v1'
  benchmark: { key: string }
  context: RunContext
  task: { instruction: string; benchmarkPayload: JsonValue }
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
    requiredArtifacts: Array<{
      name: string
      mediaType: string
      collector: string
      maxBytes: number
    }>
  }
  agentConfig: BenchmarkRunConfig
}
```

通用校验负责：上下文 ID 一致、JSON 大小、仓库 URL、commit、Artifact 契约和执行器能力；递归拒绝 `command/shell/args/executable/token/credential/privatePayload`。

## 5. SWE-bench 实现

数据集入口不自行解析 Parquet，而是调用官方 `swebench.harness.utils.load_swebench_dataset()`；官方 Python 输出回到服务端后再由 Zod 做平台边界校验。开发与验收时可使用以下约定位置，但导入契约只要求 `--source` 指向进程可读文件，运行期不再依赖原始 Parquet：

```text
数据：~/.agent-insight/data/imports/swe-bench-verified/test.parquet
源码：~/.agent-insight/vendor/SWE-bench
Python：~/.agent-insight/vendor/SWE-bench/.venv/bin/python
```

loader 强制离线、只接受本地 Parquet，并要求恰好得到 500 个唯一 `instance_id`。原始行拆成：

```ts
type SweBenchPublicCase = {
  instanceId: string
  repo: string
  baseCommit: string
  problemStatement: string
  hintsText: string
  repositoryVersion?: string
}

type SweBenchPrivateCase = {
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
  metadata: { createdAt: string; difficulty: string }
}
```

| 原始字段 | 去向 |
|-|-|
| `instance_id/repo/base_commit/problem_statement/hints_text` | Public |
| `patch/test_patch/FAIL_TO_PASS/PASS_TO_PASS/environment_setup_commit` | Private |
| `image/eval_script/eval_type/log_parser` | Private，供后续官方 Harness 使用 |
| `created_at/difficulty` | Private 元数据，不下发 Agent |
| `version` | `repositoryVersion`，表示项目事实，不是数据集版本 |

Public 必须严格按字段白名单构造。不能用字符串是否重复判断泄漏：真实数据里公开 issue 可能直接提到测试名，`environment_setup_commit` 也可能等于公开的 `base_commit`；安全边界由结构白名单保证。

```ts
class SweBenchAdapter extends AbstractBenchmarkAdapter<
  RawSweBenchCase,
  SweBenchPublicCase,
  SweBenchPrivateCase
> {
  readonly manifest = getGeneratedBenchmarkManifest('swe-bench')
}
```

Manifest 的唯一声明源是 `benchmarks/swe-bench/benchmark.yaml`：Agent 执行默认超时为 600 秒，评测默认超时为 1800 秒；`model.patch` 使用 `git-patch/v1` Collector，大小上限为 10 MiB。Catalog 构建后由 Adapter 读取生成结果，避免 TypeScript 与 YAML 各自维护一份配置。

Agent Runtime 不属于 SWE-bench 固定能力。服务端复用普通实验的客户端平台清单，
以普通 Trace 生成能力筛选候选平台，再要求客户端支持 `RUN_BENCHMARK_CASE`、安全回传 Trace ID，并在创建时动态校验
`agent-runtime/{platform}/v1` 与精确的 `clientId + platform + agent` 组合。

任务映射：`repo → https://github.com/{repo}.git`，`baseCommit → workspace.revision`，公开题面进入 `benchmarkPayload`，提交物固定为 `model.patch`。Private 字段不参与任务构造。当前固定产生并只接受 `network=client-default`；未来只有在 sandbox capability 落地后才接受 `deny`。

## 6. 创建实验 API

```http
POST /api/experiments
```

```json
{
  "name": "SWE-bench Verified · OpenCode",
  "type": "single",
  "agentName": "opencode",
  "datasetId": "<AgentEvalDataset.id>",
  "datasetCaseIds": ["<AgentEvalDataset Case.id>"],
  "traceSource": "generate",
  "watchMode": false,
  "evaluatorIds": ["benchmark:swe-bench"],
  "executionTarget": {
    "workerId": "client_mac_01",
    "platform": "opencode",
    "model": "provider/model"
  },
  "agentTimeoutSeconds": 600
}
```

这是当前前端使用的统一请求形态。路由通过 `datasetKind=benchmark` 识别 Benchmark 数据集，再解析内部 `BenchmarkDataset` 绑定。显式 `scope=benchmark` 的旧请求形态仍保留给兼容调用与协议测试，但不是浏览器主路径。

处理顺序：

1. 数据集必须 ready，由数据集记录决定 `adapterKey`；
2. 冻结选中 Case 的 ID、公开快照、fingerprint 和顺序；
3. 按当前用户和 `clientId` 查询 `ReliabilityClient`；
4. 校验在线、健康、`RUN_BENCHMARK_CASE`、Adapter 所需能力和动态 Agent Runtime；
5. 单事务创建 Experiment、Binding、ExperimentCase 和带唯一 `runId` 的 CaseRun；
6. 返回 `201`，不调用 Adapter、不发送任务。

请求只接受 `clientId + platform + agent` 目标，不存在客户端执行地址字段；实际投递复用已鉴权的客户端控制通道。

`experiments/route.ts` 在普通实验逻辑之前识别共享 Benchmark 数据集，强制 `single + generate + watchMode=false`，并自动补齐不可取消的 `benchmark:<adapterKey>` 评估器。内部创建服务仍接受已经解析好的数据集、Case、客户端和结构化 RunConfig。

## 7. 启动与下发

`POST /api/experiments/{id}/run` 对 `scope=benchmark` 调用 `BenchmarkOrchestrator.start()`，持久化调度后立即返回 `202`。

单个 Case 的处理顺序固定为：

1. CAS：`pending → preparing`；
2. 读取冻结的 raw Case、RunConfig 和预创建的 `runId`；
3. `validateAndSplitCase(rawCase)`，保存 Public/Private 快照；
4. `buildAgentTask(publicPayload, runContext)`；
5. 对 `{runId, task, callbackBaseUrl, timeoutSeconds}` 做 canonical JSON 和 SHA-256；
6. 单事务保存 TaskEnvelope、摘要、`CaseRun(dispatching)` 和 Outbox；
7. 事务外由 Outbox Worker 创建白名单 `RUN_BENCHMARK_CASE` 指令并按 `clientId` 投递；
8. 客户端持久化同一 `runId + requestDigest` 后回执 accepted，CaseRun 进入 `running_agent`。

指令 payload 只包含一个冻结的 `request` 字段，沿用普通实验的 WSS 投递与 HTTPS 长轮询兜底；客户端不开放入站端口。

```json
{
  "runId": "erun_swe_001",
  "requestDigest": "sha256:...",
  "task": {},
  "callbackBaseUrl": "https://agent-insight.example.com/api/benchmark/v1/runs/erun_swe_001",
  "timeoutSeconds": 600
}
```

只有目标客户端回 `RUNNING/SUCCEEDED` 且本地 Runner 已接受请求才算接收成功。Scheduler 按回执区分永久的 `RUN_ID_CONFLICT` 与延迟重试的 `CLIENT_BUSY`，未在确认窗口送达时只用相同 `runId + requestDigest` 重试。

## 8. 数据模型与状态

| 模型 | 关键字段 |
|-|-|
| `BenchmarkDataset` | `id,agentEvalDatasetId,user,name,adapterKey,contentHash,status,caseCount,sourceJson,timestamps` |
| `BenchmarkDatasetCase` | `id,datasetId,externalCaseId,rawCaseJson,publicPayloadJson,privatePayloadJson,sourceFingerprint,publicFingerprint,privateFingerprint,ordinal` |
| `BenchmarkExperimentBinding` | `experimentId,datasetId,datasetContentHash,adapterKey,selectionJson,runConfigJson,schedulerStatus,expectedCaseCount,callbackOrigin` |
| `BenchmarkCaseRun` | `id(runId),experimentId,experimentCaseId,datasetCaseId,ordinal,status,adapterKey,clientId,public/private/task 快照与摘要,progress/runFacts/cleanup/completion,retryOfRunId,失败信息与时间戳` |
| `BenchmarkDispatchOutbox` | `id,runId(unique),kind,commandId,requestJson,requestDigest,status,attemptCount,nextAttemptAt,leasedUntil,responseJson,errorCode,errorMessage,timestamps` |

`dataset-service.ts` 导入时先调用同一 Adapter，保存可查询的 Public 和隔离的 Private；创建实验复制 Public 快照；运行前再按高保真步骤 02 校验冻结的 raw Case，并核对两次 fingerprint 一致。

`ReliabilityClient` 不保存 Benchmark 执行地址；在线度、服务健康和能力清单仍由现有客户端心跳与能力上报维护。

```text
pending → preparing → dispatching → running_agent → collecting → uploading → cleaning → submitted → evaluated
   └─ blocked          ├─ dispatch_failed       └─ execution_failed                 └─ evaluation_failed
                      └─ dispatch_unknown → 使用相同 runId + requestDigest 重试
```

- Outbox 必须先落库，Worker 用 `leasedUntil + updateMany` 做 CAS；
- 客户端明确拒绝为 `dispatch_failed`；
- 发送后超时/断连为 `dispatch_unknown`，只允许相同 `runId + requestDigest` 重发一次；
- `409 RUN_ID_CONFLICT` 永久失败；
- Worker 重启只重放 Outbox，不重新调用 Adapter；
- 用户后续重试 Agent 时创建新 `runId`。

## 9. 实现与验证

1. `packages/benchmark-protocol` 的 contracts、errors、schemas 和契约测试；
2. Prisma 模型、`dataset-service.ts` 和脱敏单测 Fixture；
3. `adapter-base.ts`、`adapter-registry.ts` 和 `benchmarks/swe-bench/adapter/index.ts`；
4. `experiment-service.ts` 与创建实验分支；
5. `orchestrator.ts`、`scheduler.ts` 与启动实验分支；
6. Scheduler 内的 Outbox、短时签名和客户端控制通道下发；
7. `test/benchmark-execution-dispatch.test.ts` 控制通道与幂等测试；
8. 官方 loader 导入真实 Verified 500 Case，逐条验证隔离并构造任务；
9. 用真实 Case 调用 `POST /api/experiments` 和 `POST /api/experiments/{id}/run`，验证 `RUN_BENCHMARK_CASE` 指令、客户端回执及 Artifact/终态回调。

必须覆盖：普通实验回归、公开/私有隔离、Adapter 确定性、事务原子性、`202/409/422/超时/断连/重启`、重复 `runId`、伪造 URL 和跨用户 clientId。

合成 Fixture 只用于确定性单测、非法输入、断连和幂等故障测试，不能作为 SWE-bench 接入验收。真实数据与官方源码均放在 `~/.agent-insight/`，不提交 Git；当前已用真实 500 Case 完成数据导入、Private 隔离和任务构造，并以真实 OpenCode 单 Case 贯穿 01～13 开发 Smoke。正式计分验收仍使用 x86_64 Linux。
