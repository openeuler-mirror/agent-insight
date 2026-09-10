# Benchmark 剩余步骤：结果接收与实验结果处理

> 范围：高保真业务步骤 09～10，对应调用级步骤 11～13：接收证据和评测终态、保存原生结果、调用 Adapter 归一化、收敛 Case/实验状态、查询实验结果。
> 不包含前端、重跑入口、批量 500 调度、评测服务注册，以及 Benchmark/数据集/评估器业务版本。
> 前序：[评测服务后端设计](benchmark-evaluator.md)；溯源：[高保真源码](../../评测服务文档/Benchmark统一接口设计-SWE-bench示例.html)。

状态：已实现。证据上传、终态回调、稳定结果契约、异常收敛、`normalizeResult()`、`ExperimentEvalResult` 投影、固定分母聚合、实验结果查询和用户证据下载均已通过 API 验收。

## 1. 后端主链路

```text
评测服务
  ├─ POST /api/benchmark/v1/evaluations/{evaluationId}/artifacts
  │    └─ 校验身份、evaluation 归属、SHA-256 → 保存证据
  └─ POST /api/benchmark/v1/evaluations/{evaluationId}/complete
       ├─ 校验 completion 与证据引用
       ├─ CAS 冻结 completionDigest
       ├─ 先保存 rawResult/runtimeFacts/cleanup
       ├─ AdapterRegistry.get(adapterKey).normalizeResult()
       ├─ 同一事务写入：
            BenchmarkEvaluation.normalizedResultJson
            BenchmarkCaseRun 终态
            ExperimentEvalResult 统一投影
            continuationStatus=pending
       └─ 持久化续跑任务异步执行：
            补充评估器（仅未完成项）
            Experiment / BenchmarkExperimentBinding 收敛状态
            下一 Case 调度

实验用户
  └─ GET /api/benchmark/v1/experiments/{experimentId}
       └─ BenchmarkExperimentResultQueryService 读取统一投影并聚合
```

原生结果以 `BenchmarkEvaluation` 为事实源；`ExperimentEvalResult` 只是跨 Benchmark 的查询投影。任何聚合都不能反向覆盖原生结果。

## 2. 协议与抽象

继续使用现有 `BenchmarkAdapter` 五方法，结果阶段只调用第五个方法：

```ts
interface BenchmarkAdapter {
  readonly manifest: BenchmarkManifest
  validateAndSplitCase(rawCase: unknown): SplitCaseResult
  buildAgentTask(input: BuildAgentTaskInput): AgentTaskEnvelope
  validateSubmission(input: ValidateSubmissionInput): Promise<void>
  buildEvaluationRequest(input: BuildEvaluationRequestInput): EvaluationJob
  normalizeResult(input: NormalizeBenchmarkResultInput): NormalizedBenchmarkResult
}
```

`AbstractBenchmarkAdapter.normalizeResult()` 负责通用不变量校验，具体 Adapter 只负责原生语义映射。统一输出补充主指标，供通用查询服务聚合，不增加第六个 Adapter 方法：

`NormalizeBenchmarkResultInput` 同时带入本次冻结的 `EvaluationJob` 和已核验的证据描述；JSON 证据可携带解析后的 `jsonContent`。Adapter 必须把回传事实与冻结任务、证据内容交叉校验，不能只检查 Raw Result 自身是否自洽。

```ts
type NormalizedBenchmarkResult = {
  status: 'done' | 'failed'
  verdict?: 'pass' | 'warn' | 'fail'
  summary: string
  score: number | null                 // 0～100
  primaryMetric?: {
    key: string
    value: boolean | number | null
    aggregation: 'boolean-rate' | 'mean'
  }
  points: NormalizedBenchmarkPoint[]
  nativeMetrics: JsonValue             // 可安全返回的原生指标摘要
  evidence: JsonValue                  // 只保存 Artifact ID，不保存文件路径
  errorMessage?: string
}
```

通用约束：

- `completion.status=completed` 必须得到 `status=done`、非空 verdict、score 和 primaryMetric；
- `completion.status=failed` 只能得到 `status=failed`、`score=null`；
- `submission_invalid` 是有效判分终态，Case 标记提交无效，不伪装成基础设施错误；
- `nativeMetrics` 只放展示安全的摘要；完整 `rawResult` 单独保存在 `BenchmarkEvaluation.rawResultJson`。

### SWE-bench 实例

| 评测输入 | 统一结果 |
|-|-|
| `completed + resolved=true` | `done / pass / score=100 / primaryMetric={key:"resolved",value:true,aggregation:"boolean-rate"}` |
| `completed + resolved=false` | `done / fail / score=0 / primaryMetric={key:"resolved",value:false,aggregation:"boolean-rate"}` |
| `submission_invalid` | `done / fail / score=null`，Case 状态为 `submission_invalid` |
| `failed` | `failed / score=null`，outcome 在查询层显示为 `unknown` |

SWE-bench 的 `nativeMetrics` 只返回：

```json
{
  "resolved": false,
  "patchSuccessfullyApplied": true,
  "failToPass": { "passed": 0, "total": 1 },
  "passToPass": { "passed": 42, "total": 42 }
}
```

完整 `officialReport` 仍保存在 Raw Result 和证据文件中，不复制到统一投影。

SWE-bench 的 `completed` 结果还必须满足以下正式计分门槛，否则闭合失败而不是产生分数：

- `runtimeFacts.formalEligible` 必须严格等于 `true`，实例 ID 必须与冻结任务一致；
- `resolved` 与每个测试结果必须是 JSON boolean，不接受 `"false"` 等 truthy 字符串；
- 官方报告中的 `FAIL_TO_PASS` / `PASS_TO_PASS` 必须与冻结测试名单精确分区，禁止缺项、未知项、重复项和跨组项；
- Raw Result 的计数、布尔值和 `officialReport` 必须一致，`resolved=true` 还要求 Patch 应用成功且全部冻结测试通过；
- 必须且只能引用当前评测的 `report.json`、`test_output.txt`、`run_instance.log` 三类证据；平台重读 `report.json`，复核 size、SHA-256 和 JSON 内容后再交给 Adapter。

## 3. complete 接口处理规则

`POST /api/benchmark/v1/evaluations/{evaluationId}/complete` 保持同步完成单 Case 归一化，处理顺序固定：

1. 使用评测服务 Bearer Token 鉴权，确认 evaluation 存在且尚可接收终态；
2. 校验 `status/rawResult/runtimeFacts/cleanup/evidenceArtifactIds` 基本结构；
3. 确认证据全部属于当前 evaluation，重读证据并复核 size、SHA-256，拒绝跨任务引用或落盘内容漂移；
4. 计算 `completionDigest`，用 `completionDigest IS NULL` 做 CAS；
5. 先写 Raw Result、运行事实、清理结果和 digest，状态进入 `normalizing`；
6. 从冻结的 `requestJson` 恢复 `EvaluationJob`，按 evaluation 冻结的 `adapterKey` 调用 `normalizeResult()`；
7. 事务写统一结果、Case 终态和 `continuationStatus=pending`；
8. 调度持久化 continuation；它用递增 attempt 作为租约 owner，跳过已完成的补充评估器并结算实验/下一 Case；
9. 返回严格终态 ACK，评测 Controller 校验 ACK 后结束任务。

幂等规则：相同 evaluationId 和相同 digest 返回已保存结果；若停在 `normalizing`，相同 completion 会继续归一化而不重跑 Harness；同一 evaluationId 的不同 digest 返回 `409 EVALUATION_COMPLETION_CONFLICT`，绝不覆盖第一次终态。

错误分三类：

- completion 基本结构或证据引用不合法：在 CAS 前返回 `4xx`，不接受终态；
- Raw Result 已冻结，但 Schema、正式资格、证据契约或 Adapter 映射失败：保留 Raw Result，evaluation 进入 `normalization_failed`，写 `ExperimentEvalResult(status=failed, score=null)` 并将 Case 收敛为 `evaluation_failed`；分别返回非重试 `422 RAW_RESULT_SCHEMA_INVALID`、`SWE_FORMAL_RESULT_INELIGIBLE`、`SWE_EVIDENCE_CONTRACT_INVALID` 或 `RESULT_MAPPING_FAILED`，同时返回 `acceptedRawResult=true`；
- 数据库暂时不可写等持久化错误：返回可重试的 `5xx`。相同 completion 可从已保存 Raw Result 继续归一化，不重跑 Harness。

评测 Controller 必须按响应的 `retryable` 处理：只有网络错误和 `5xx` 重传；确定性 `4xx` 记录终态后停止重传。

Controller 不再把任意 HTTP 2xx 当作成功。进度回调必须收到 `accepted=true + desiredState=continue`；终态回调必须收到 `accepted=true + normalizationStatus=completed`、匹配的 evaluation 状态和合法 `normalizedResult`。空响应、非 JSON 或字段不匹配的 2xx 都保留为可重试 `callback_pending`。

返回结构：

```json
{
  "accepted": true,
  "evaluationStatus": "completed",
  "normalizationStatus": "completed",
  "normalizedResult": { "status": "done", "verdict": "pass", "score": 100 }
}
```

## 4. 状态收敛与聚合

Case 终态只有以下几类参与完成判断：

| CaseRun 状态 | 含义 | outcome |
|-|-|-|
| `evaluated` | 有有效官方判定 | `pass` 或 `fail` |
| `submission_invalid` | Patch 无法评测 | `fail` |
| `execution_failed` | Agent/执行器失败 | `unknown` |
| `evaluation_failed` | Harness、回调或归一化失败 | `unknown` |
| `dispatch_failed` | 下发最终失败 | `unknown` |
| `blocked` | 平台明确阻断该 Case | `unknown` |

实验只有在 `terminalCaseCount === BenchmarkExperimentBinding.expectedCaseCount` 时才进入 `done`；不能只因为当前数据库里暂时没有 running Case 就提前结束。

通用聚合固定返回：

- `total/pending/pass/warn/fail/unknown`；
- `completed` 按 Case Run 终态数计算，等于 `pass + warn + fail + unknown`；
- `coverageRate = completed / total`；
- `averageScore` 只对非空 score 求平均，同时返回参与计算的数量；
- boolean primaryMetric 使用 `trueCount / expectedCaseCount`，失败和未知不能缩小分母。

SWE-bench 将 boolean `resolved` 聚合为 `resolvedRate`。Verified 500 的分母始终是冻结的 `expectedCaseCount`，不能因为提交无效或基础设施失败变成更小的数据集。

同一 Case 重跑后，查询和收敛只使用重试图中的叶子 Run；`createdAt` 与 `id` 共同提供稳定排序。旧 Run 的迟到 continuation 会检测到后继 Run 并停止，不能覆盖新 Run 的 Case 投影，也不能让历史分数被重复计入。

平台另有 30 秒周期的 Evaluation watchdog：queued/dispatch 不确定、收集/上传/清理、以及 normalizing 连续 5 分钟无进度时回收；Harness 按冻结 `timeoutSeconds + 90 秒` 回收。watchdog、迟到 completion 和迟到 dispatch 都用状态、活性时间与 outbox attempt 的 CAS 竞争，只有胜者能写终态；失败终态同样落 `continuationStatus=pending`，不会停在页面上。

## 5. 实验结果查询 API

新增：

```text
GET /api/benchmark/v1/experiments/{experimentId}
    ?page=1&pageSize=20&status=&verdict=
```

只允许实验所有者读取；`pageSize` 最大 100。查询不触发重新评测或重新归一化。

```json
{
  "experimentId": "exp_01",
  "status": "completed",
  "benchmark": { "key": "swe-bench" },
  "progress": { "total": 500, "completed": 500, "pending": 0 },
  "outcomes": { "pass": 312, "fail": 176, "unknown": 12 },
  "metrics": {
    "primary": { "key": "resolvedRate", "value": 62.4, "numerator": 312, "denominator": 500 },
    "averageScore": { "value": 63.93, "count": 488 }
  },
  "cases": [{
    "caseId": "case_01",
    "externalCaseId": "pallets__flask-5014",
    "runStatus": "evaluated",
    "outcome": "pass",
    "score": 100,
    "summary": "Agent Patch 通过全部 SWE-bench 目标测试且没有回归",
    "primaryMetric": { "key": "resolved", "value": true },
    "nativeMetrics": {
      "resolved": true,
      "failToPass": { "passed": 1, "total": 1 },
      "passToPass": { "passed": 59, "total": 59 }
    },
    "execution": { "runId": "erun_01", "traceId": "...", "patchArtifactId": "bart_01" },
    "evaluation": { "evaluationId": "veval_01", "status": "completed" },
    "evidence": [{ "artifactId": "beart_01", "name": "report.json", "kind": "official-report" }]
  }],
  "pagination": { "page": 1, "pageSize": 20, "total": 500 }
}
```

响应禁止包含 `privatePayloadJson`、`requestJson`、gold patch、test patch、评测脚本、数据库 `storagePath` 和服务凭证。Raw Result 默认不在列表返回；用户查看证据时走独立鉴权下载：

```text
GET /api/benchmark/v1/evaluations/{evaluationId}/artifacts/{artifactId}/content
```

下载接口同时校验用户、实验归属、evaluationId 与 artifactId 的关系，并使用安全文件名响应。

## 6. 代码落点

```text
packages/benchmark-protocol/src/evaluator-contracts.ts
src/lib/benchmark/adapter-base.ts
benchmarks/swe-bench/adapter/index.ts
src/lib/benchmark/evaluation-callback-service.ts
services/evaluator/src/service.cjs                                     # 只重传可重试回调
src/lib/benchmark/evaluation-continuation-service.ts                   # 持久化终态续跑与租约
src/lib/benchmark/evaluation-scheduler.ts                              # 下发 owner CAS 与 Evaluation watchdog
src/lib/benchmark/experiment-result-service.ts                         # 新增
src/app/api/benchmark/v1/experiments/[experimentId]/route.ts           # 新增
src/app/api/benchmark/v1/evaluations/[evaluationId]/artifacts/
  [artifactId]/content/route.ts                                        # 新增
test/benchmark-result-processing-api.test.ts                            # 新增
test/benchmark-real-e2e.test.ts                                         # 单 Case 显式真实测试
```

不新增 Prisma 表；复用 `BenchmarkEvaluation`、`BenchmarkEvaluationArtifact`、`BenchmarkCaseRun`、`BenchmarkExperimentBinding` 和 `ExperimentEvalResult`。`BenchmarkEvaluation` 新增 `continuationStatus/continuationAttempts/continuationTriedAt/continuationError`，并为状态扫描和 continuation 扫描建立组合索引；旧记录默认 `continuationStatus=completed`，不会在升级时重放历史副作用。

## 7. 开发与验收顺序

1. 补 `primaryMetric` 契约及 SWE-bench 映射，限制 `nativeMetrics` 为安全摘要；
2. 调整 complete 的幂等、异常收敛和返回结构；
3. 实现通用 `BenchmarkExperimentResultQueryService`、实验 GET 和证据下载；
4. API 测试覆盖 complete 相同重放/冲突、证据越权、归一化失败保留 Raw Result、冻结测试名单与报告绑定、严格 ACK、超时胜出、watchdog/迟到响应竞态、持久化续跑、最新重试叶子、固定分母、分页和隐藏字段隔离；
5. 把现有 01～12 受控 API 测试延伸到步骤 13，断言查询结果；
6. 显式运行一个真实 Case：创建实验 → OpenCode → 执行器 → Docker Controller → 官方 Case 容器 → complete → normalize → GET 实验结果。只拉取该 Case 镜像，不预拉完整 SWE-bench。

退出条件：步骤 11～13 API 专项通过；01～13 受控串联通过；单 Case 01～13 全真实端到端通过；测试产生的数据库记录、工作区、Controller/Case 容器和证据均被精确清理。

上述退出条件已完成：真实数据库专项 11～13、真实 Case 的受控 01～13、Docker Controller 到官方 ARM64 Case 容器的 09～13，以及 `deepseek/deepseek-v4-flash` + `pallets__flask-5014` 的单 Case 全真实 01～13 均通过。全真实开发冒烟的官方 Harness 判定为 pass；ARM64 结果仍只用于开发验收，不替代 x86_64 Linux 正式计分。
