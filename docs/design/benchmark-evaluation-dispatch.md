# Benchmark 步骤 08～09：提交校验与评测下发后端设计

> 范围：高保真步骤 08、09——Agent Insight 校验执行器提交、构造评测任务、持久化并通过 REST 下发评测服务。  
> 不包含前端、评测服务内部 Harness 执行、结果回传和 `normalizeResult()`。  
> 前序：[Agent 执行前服务端设计](benchmark-agent-pre-execution.md)、[执行器后端设计](benchmark-executor.md)；溯源：[高保真源码](../../评测服务文档/Benchmark统一接口设计-SWE-bench示例.html)。

状态：Agent Insight 侧步骤 08～09 已实现；后续评测服务接单、回调、原生结果落库、`normalizeResult()` 和结果查询也已实现。01～13 已使用真实数据库和真实 SWE-bench Verified Case 完成 API 级串联；步骤 09～13 另已由 Docker 化 Controller 使用真实 Artifact 和官方 ARM64 `pallets__flask-5014` Case 镜像完成双层容器 API 验收。

## 1. 主流程

```text
步骤 07 POST /api/benchmark/v1/runs/{executionRunId}/complete
  └─ 保存执行终态和 Artifact 引用，executionRun.status = submitted
       └─ prepareBenchmarkEvaluation(executionRunId)                 # 步骤 08
            ├─ 重读 Artifact 并核对 size + sha256
            ├─ adapter.validateSubmission(task, artifacts)
            ├─ adapter.buildEvaluationRequest(public, private, artifacts)
            └─ 同一事务创建 Evaluation(queued) + EvaluationDispatchOutbox
                 └─ dispatchBenchmarkEvaluation(evaluationRunId)    # 步骤 09
                      ├─ EvaluatorTargetResolver.resolve()
                      ├─ 必要时 GET {evaluatorBaseUrl}/health
                      └─ POST {evaluatorBaseUrl}/api/v1/evaluations
                           └─ 202 accepted → Evaluation(running_evaluator)
```

步骤 08 不访问外部网络；步骤 09 的 HTTP 必须在数据库事务提交后执行。步骤 07 的相同终态重放必须返回同一个 `evaluationRunId`，不得重复创建评测。

## 2. Adapter 第 3、4 个方法

在现有 `BenchmarkPreExecutionAdapter` 上扩成完整协议，本阶段只实现新增的两个方法：

```ts
type ArtifactDescriptor = {
  artifactId: string
  executionRunId: string
  name: string
  mediaType: string
  sha256: `sha256:${string}`
  sizeBytes: number
}

type ReadonlySubmissionArtifact = {
  descriptor: ArtifactDescriptor
  readBytes(): Promise<Uint8Array> // 只能读取本次 Run 已绑定的 Artifact
}

type ValidateSubmissionInput = {
  task: AgentTaskEnvelope
  artifacts: readonly ReadonlySubmissionArtifact[]
}

type BuildEvaluationRequestInput<
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

type EvaluationJob<TPayload extends JsonValue = JsonValue> = {
  protocolVersion: 'benchmark-evaluation/v1'
  evaluationId: string
  executionRunId: string
  context: { experimentId: string; caseId: string; datasetContentHash: string }
  benchmark: { key: string }
  evaluator: { key: string }
  artifacts: ArtifactDescriptor[]
  payload: TPayload
  limits: { timeoutSeconds: number; cpu: number; memoryMiB: number }
}

interface BenchmarkAdapter<TRaw, TPublic, TPrivate, TEvaluationPayload> {
  readonly manifest: BenchmarkManifest
  validateAndSplitCase(raw: TRaw): SplitCaseResult<TPublic, TPrivate>
  buildAgentTask(input: BuildAgentTaskInput<TPublic>): AgentTaskEnvelope
  validateSubmission(input: ValidateSubmissionInput): Promise<void>
  buildEvaluationRequest(
    input: BuildEvaluationRequestInput<TPublic, TPrivate>,
  ): EvaluationJob<TEvaluationPayload>
}
```

`AbstractBenchmarkAdapter` 固定处理通用规则：

1. Artifact 必须属于当前 `executionRunId`，名称不重复；
2. 必需 Artifact 齐全，名称、媒体类型、大小符合 Manifest；
3. 服务端重新读取文件，实际字节数和 SHA-256 必须与数据库一致；
4. 子类 `validateBenchmarkSubmission()` 只补 Benchmark 特有格式检查；
5. 子类 `createEvaluationRequest()` 构造请求后，基类校验上下文 ID、Adapter key、Artifact 引用和大小上限；
6. Adapter 不接收评测服务 URL、凭证、HTTP 客户端或服务器文件路径。

Artifact 读取器由平台按本次 Run 创建，Adapter 不能用任意 ID 或路径读取其他运行的数据。

`BenchmarkManifest` 在本阶段增加评测默认值，作为后端冻结配置的来源，不依赖前端：

```ts
evaluation: {
  evaluatorKey: 'swe-bench'
  defaultTimeoutSeconds: 1800
  defaultResources: { cpu: 4; memoryMiB: 16384 }
}
```

## 3. SWE-bench 实例

### 3.1 `validateSubmission()`

`SweBenchAdapter` 在通用校验之后检查：

- 必须且只能有一个 `model.patch`；
- 使用严格 UTF-8 解码，拒绝空内容和 NUL；
- 至少包含一个合法的 `diff --git a/... b/...` 文件段；
- 路径必须是仓库相对路径，拒绝绝对路径、`..` 和 `.git/`；
- 允许官方 Git binary patch 语法，不在平台层重新解释 Patch；
- 不判断 Patch 是否能应用、不运行测试、不读取或比较 `goldPatch`，这些属于官方 Harness。

### 3.2 `buildEvaluationRequest()`

输出直接贴近官方 SWE-bench `make_test_spec()` 和 `run_instance()` 所需字段，后续评测服务只做文件落盘和官方函数调用：

```json
{
  "protocolVersion": "benchmark-evaluation/v1",
  "evaluationId": "veval_001",
  "executionRunId": "erun_001",
  "context": {
    "experimentId": "exp_001",
    "caseId": "case_001",
    "datasetContentHash": "sha256:..."
  },
  "benchmark": { "key": "swe-bench" },
  "evaluator": { "key": "swe-bench" },
  "artifacts": [{
    "artifactId": "bart_001",
    "executionRunId": "erun_001",
    "name": "model.patch",
    "mediaType": "text/x-diff",
    "sha256": "sha256:...",
    "sizeBytes": 1553
  }],
  "payload": {
    "instance": {
      "instance_id": "pallets__flask-5014",
      "repo": "pallets/flask",
      "base_commit": "7ee9ceb71e868944a46e1ff00b506772a53a4f1d",
      "version": "2.3",
      "image": "swebench/sweb.eval.x86_64.pallets_1776_flask-5014:latest",
      "eval_script": "<official loader 生成的脚本>",
      "eval_type": "pass_and_fail",
      "log_parser": "parse_log_flask",
      "FAIL_TO_PASS": ["tests/test_blueprints.py::test_empty_name_not_allowed"],
      "PASS_TO_PASS": ["..."]
    },
    "prediction": {
      "instance_id": "pallets__flask-5014",
      "model_name_or_path": "deepseek/deepseek-v4-flash",
      "model_patch_artifact_id": "bart_001"
    }
  },
  "limits": { "timeoutSeconds": 1800, "cpu": 4, "memoryMiB": 16384 }
}
```

映射规则：

- `publicPayload` 提供 `instance_id/repo/base_commit/version`；这里的 `version` 是被测项目事实，不是 Benchmark 或数据集版本；
- `privatePayload.evaluation` 提供 `image/eval_script/eval_type/log_parser`；
- `privatePayload.failToPass/passToPass` 映射为官方同名字段；
- `prediction.model_name_or_path` 来自已冻结的 `task.agentConfig.model`，为空时使用 `platform/agent`，不是评测服务临时选择；
- `model.patch` 只传 Artifact ID 和摘要，不把文件内容塞进 JSON；
- `goldPatch` 不进入 `EvaluationJob`。官方 Harness 判 Agent Patch 不需要参考答案，继续只保留在 Agent Insight 私有数据中；
- 评测服务下载 Patch 后补成官方 prediction 的 `model_patch`，调用官方 `make_test_spec()` 与 `run_instance()`，不重写判分逻辑。

实现第一依据是 SWE-bench 官方 [`make_test_spec()`](https://github.com/SWE-bench/SWE-bench/blob/main/swebench/harness/utils.py) 和 [`run_instance()`](https://github.com/SWE-bench/SWE-bench/blob/main/swebench/harness/run_evaluation.py)；Adapter 只负责把平台字段映射到官方输入，不复制 Harness 的应用 Patch、运行测试和判分实现。

## 4. 评测服务地址配置

不让实验请求携带 URL，也暂不实现评测服务注册中心。增加目标解析协议：

```ts
type EvaluatorTarget = {
  targetKey: string
  baseUrl: string
  evaluatorKey: string
}

interface EvaluatorTargetResolver {
  resolve(evaluatorKey: string): EvaluatorTarget
}

class EnvEvaluatorTargetResolver implements EvaluatorTargetResolver {}
```

第一版配置：

```dotenv
# Agent Insight → 评测服务；本机开发先这样配置
AGENT_INSIGHT_BENCHMARK_EVALUATOR_BASE_URL=http://127.0.0.1:8080

# 两个服务共同配置的随机凭证；不写数据库、不进入任务 JSON
AGENT_INSIGHT_BENCHMARK_EVALUATOR_TOKEN=<random-secret>

# 已有变量；评测服务跨机器时必须是对方可访问的 Agent Insight 地址
AGENT_INSIGHT_PUBLIC_BASE_URL=http://127.0.0.1:3000

# 仅限内网开发联调；默认 false
AGENT_INSIGHT_BENCHMARK_EVALUATOR_ALLOW_INSECURE_HTTP=false
```

规则：

- 未配置评测地址时，合法提交仍可形成 `Evaluation(queued)`，调度停在 `EVALUATOR_NOT_CONFIGURED`；
- URL 必须是绝对 `http/https`，拒绝用户名、密码、query 和 fragment；禁止重定向；
- HTTP 只默认允许 loopback；跨机器部署应使用 HTTPS。内网临时联调若要 HTTP，必须显式设置 `AGENT_INSIGHT_BENCHMARK_EVALUATOR_ALLOW_INSECURE_HTTP=true`；
- 首次实际下发时把解析出的 `targetKey + baseUrl` 冻结到 Evaluation，之后重发继续使用原地址；配置变化只影响尚未绑定目标的新评测；
- 将来需要多个评测服务时增加 `RegisteredEvaluatorTargetResolver`，步骤 08、09 和 Adapter 不变。

这比直接在业务代码读取一个 IP 更稳：当前仍然只有一个环境变量目标，但地址来源被隔离在 resolver 中，也避免用户输入 URL 带来的 SSRF。

## 5. 持久化与状态

新增两个模型，不复用执行器的一对一 Outbox：

```text
BenchmarkEvaluation
  id                         # evaluationRunId
  caseRunId
  attemptNo                  # 首次为 1；只重评时递增
  retryOfEvaluationId?
  status                     # queued/dispatching/dispatch_unknown/
                             # running_evaluator/dispatch_failed
  adapterKey
  evaluatorKey
  evaluatorTargetKey?
  evaluatorBaseUrl?
  requestJson                # 冻结 EvaluationJob，含隐藏测试，严禁日志输出
  requestDigest
  callbackBaseUrl
  timeoutSeconds
  progressJson?
  failureCode/failureMessage?
  timestamps
  UNIQUE(caseRunId, attemptNo)

BenchmarkEvaluationDispatchOutbox
  evaluationId UNIQUE
  destinationBaseUrl?
  requestJson
  requestDigest
  status                     # pending/sending/unknown/accepted/failed
  attemptCount/nextAttemptAt/leasedUntil
  httpStatus/responseJson/errorCode/errorMessage
```

执行 Run 与评测 Run 分开：`BenchmarkCaseRun` 到 `submitted` 后不再因评测重试而重跑 Agent；提交非法时改为 `submission_invalid`。有效提交创建独立 `BenchmarkEvaluation(queued)`。

崩溃恢复扫描两种缺口：

- `BenchmarkCaseRun.status=submitted` 且没有首次 Evaluation：重做步骤 08；
- Evaluation 已存在但 Outbox 未终态：恢复步骤 09，不再调用 Adapter、不重建任务。

## 6. 步骤 08 的服务逻辑

`completeBenchmarkRun()` 在接受执行终态后调用 `prepareBenchmarkEvaluation()`：

1. 按 `executionRunId` 读取冻结 Task、Public/Private Payload 和 Artifact；
2. 核对数据库关联并重算 Artifact SHA-256；
3. 调用 `adapter.validateSubmission()`；
4. 创建 `evaluationRunId`，调用 `adapter.buildEvaluationRequest()`；
5. 对 `{evaluationRunId, evaluationJob, callbackBaseUrl, timeoutSeconds}` 做 canonical JSON + SHA-256；
6. 一个短事务创建 Evaluation 与 Outbox；
7. 提交事务后触发异步下发，步骤 07 HTTP 不等待远程评测服务完成。

成功响应：

```json
{
  "accepted": true,
  "status": "submitted",
  "evaluationRunId": "veval_001"
}
```

提交物非法时，执行完成事实仍然被接受，返回 `200` 和稳定错误，不要求执行器重传或重跑 Agent：

```json
{
  "accepted": true,
  "status": "submission_invalid",
  "error": { "code": "SWE_PATCH_INVALID", "message": "model.patch 不是有效 Git Patch" }
}
```

## 7. 步骤 09 的 REST 协议

```http
GET {evaluatorBaseUrl}/health
Authorization: Bearer <configured-token>
```

健康响应只校验服务状态、busy 和 `swe-bench` 是否 ready，不检查评估器业务版本。最近 30 秒已有健康结果时可跳过重复检查。

```json
{
  "status": "healthy",
  "busy": false,
  "evaluators": [{ "key": "swe-bench", "ready": true }]
}
```

```http
POST {evaluatorBaseUrl}/api/v1/evaluations
Authorization: Bearer <configured-token>
Idempotency-Key: <evaluationRunId>
X-Agent-Insight-Request-Digest: sha256:...
Content-Type: application/json
```

```json
{
  "runId": "veval_001",
  "requestDigest": "sha256:...",
  "evaluationJob": {},
  "platformBaseUrl": "http://127.0.0.1:3000",
  "callbackBaseUrl": "http://127.0.0.1:3000/api/benchmark/v1/runs/veval_001",
  "timeoutSeconds": 1800
}
```

评测服务必须在校验、计算 digest 并持久化 `runId + requestDigest` 后返回：

```json
{
  "runId": "veval_001",
  "requestDigest": "sha256:...",
  "status": "accepted"
}
```

只有匹配的 `202` 才进入 `running_evaluator`。错误分类：

- `409 SERVICE_BUSY`、`503`、连接失败：保持 queued/retry，使用相同 Run 和 digest；
- 请求已发出但响应不明确：`dispatch_unknown`，最多再发送一次相同请求；
- `409 RUN_ID_CONFLICT`：永久 `dispatch_failed`；
- `422 EVALUATION_JOB_INVALID/EVALUATOR_NOT_READY`：结构错误永久失败，未就绪可按服务响应的 `retryable` 标记延迟重试；
- 用户显式只重评时创建新的 `evaluationRunId`，绝不修改旧运行。

评测服务随后使用同一服务凭证和 `evaluationRunId` 调用 Artifact 下载、progress、complete API。两端使用恒定时间比较验证配置凭证；凭证只出现在 HTTP Header，不进入 Outbox、日志或 Harness 输入。平台必须验证目标 Evaluation 的 `requestJson` 确实引用了该 Artifact；服务凭证不能传入 Harness 容器。

## 8. 代码落点与验收

```text
packages/benchmark-protocol/src/evaluation-contracts.ts
src/lib/benchmark/adapter-base.ts
src/lib/benchmark/evaluation-preparation-service.ts
src/lib/benchmark/evaluator-target.ts
src/lib/benchmark/evaluation-scheduler.ts
src/lib/benchmark/run-callback-service.ts
src/app/api/benchmark/v1/artifacts/[artifactId]/content/route.ts
benchmarks/swe-bench/adapter/index.ts
prisma/schema.prisma
test/benchmark-executor-api.test.ts
```

接口级验收必须覆盖：

1. 步骤 07～09：执行器 complete 后产生唯一 Evaluation/Outbox，桩评测服务收到真实 HTTP POST 并返回 202；
2. 步骤 01～13：使用本地真实 Verified Case 和真实数据库，从创建实验一直到评测回传、归一化和实验结果查询；
3. 桩评测服务不得访问 Agent Insight 文件路径，只能凭 Artifact API 下载 Patch，以验证跨机器边界；
4. SWE-bench Job 含官方 `eval_script/FAIL_TO_PASS/PASS_TO_PASS`，但不含 `goldPatch`；
5. 空 Patch、错误 SHA、越界路径、重复 complete、busy、断连、202 响应不匹配、Run 冲突和进程重启；
6. 普通实验及现有步骤 01～07 回归全部通过。

当前数据与官方源码已经足够完成步骤 08～12，不需要再下载数据。Docker 镜像由评测服务按 Case 拉取；官方 Harness 真跑需要本机或独立评测机的 Docker daemon。

已完成的接口验收同时覆盖 04～09 和 01～13：评测端收到真实 HTTP 请求后，只使用服务凭证、`evaluationRunId` 和 Artifact API 反向下载 `model.patch`，再通过独立的 progress、evidence、complete API 回传；01～13 使用本地官方 Verified Parquet 中的真实 Case，并在已备份的真实数据库上复跑通过，最终由实验结果 GET 校验固定分母聚合和安全字段。测试结束后唯一标识的测试记录已清理，原有 Benchmark 数据量未变化。显式 Docker 测试另将 Controller 与官方 ARM64 Case 分别运行在容器中，以真实 Artifact 完成步骤 09～13，1/1 通过。ARM64 结果仅作开发冒烟，正式分数仍以 x86_64 Linux 为准。

本阶段不建立 Benchmark、数据集或评估器业务版本；`protocolVersion` 只表示跨进程消息格式，SHA-256 只用于内容完整性。
