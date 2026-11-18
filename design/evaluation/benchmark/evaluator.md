# Benchmark 步骤 09～12：评测服务后端设计

> 范围：评测服务接单、准备并运行 Case 容器、上传证据、回传原生结果，以及 Agent Insight 调用 Adapter 第五个方法归一化结果。
> 不包含前端、服务注册中心、多机调度、Benchmark/数据集/评估器业务版本。独立机器部署见[服务安装指南](../../../docs/zh/how-to/evaluation/benchmarks/deploy-services.md)。当前脚本与配置热加载已经实现。
> 前序：[提交校验与评测下发](evaluation-dispatch.md)。

状态：步骤 09～12 的 Controller、协议、SWE-bench 官方 Harness 包装、平台回调和结果归一化已实现；后续步骤 13 查询也已实现，01～13 已在真实数据库和真实 Verified Case 上完成 API 级串联。一期另提供 Linux/macOS `evaluator.sh start`、容器内外 Doctor、显式 Gold Smoke 和 Agent Insight 专用通信配置热加载。2026-09-04 已在 ARM64 Docker Desktop 上完成双层容器验收：Docker 化 Controller 通过真实 HTTP 接单、下载真实 Artifact、启动官方 `pallets__flask-5014` Case 容器，并将进度、三类证据和原生结果回传 Agent Insight；平台完成归一化和结果查询。该结果只作为 ARM64 单 Case 冒烟，不替代 x86_64 Linux 正式计分验收。

## 1. 最终方案

运行时使用三层容器：

```text
Agent Insight
  └─ POST /api/v1/evaluations
       └─ Evaluator Controller 容器（本项目构建，常驻）
            ├─ 持久化任务、下载 Agent Patch、回调平台
            ├─ 构建生成的 Evaluator Catalog
            └─ 统一 FileEvaluatorEntrypoint
                 └─ Benchmark Runtime 容器（按 Catalog 准备并缓存）
                      └─ evaluator evaluate --request ... --output ...
                           └─ SWE-bench Entrypoint
                                └─ 官方 make_test_spec() + run_instance()
                                     └─ SWE-bench Case 容器（每个 Case 一个，用后即删）
```

- **Controller 容器**：通用 Node.js HTTP/任务编排 + Docker CLI；挂载 Docker Socket 和持久化任务目录，不内置具体 Benchmark Harness。
- **Runtime 镜像**：`benchmarks/<key>/evaluator/Dockerfile` 安装该 Benchmark 的语言、SDK 和 Harness 依赖；由 Catalog 给出内容派生镜像引用，首次任务按需拉取，源码 checkout 无远端制品时回退本地构建，之后复用 Docker 缓存。SWE-bench 的 Python 与官方源码只存在于自己的 Runtime 镜像。
- **Case 容器**：执行真正的 Patch 应用和测试。正式评测使用官方 x86_64 SWE-bench 镜像。
- 不复制官方 Patch 应用、测试执行和判分代码；固定复用本地已下载官方源码 commit `02e7a74ffd0b707aab73d203fe87bdc7c76afc8e` 中的 `make_test_spec()`、`run_instance()` 和 `get_eval_report()`。
- Controller 与 Agent Insight 可以不在一台机器；双方只通过 REST 和 Artifact 内容传输，不共享文件路径或数据库。

## 2. Docker 镜像策略

### 2.1 Controller 镜像

项目提供不含具体 Harness 的通用 Controller 镜像；部署脚本始终只构建这一镜像，不接受 Benchmark 选择参数。有额外依赖的接入包提供自己的 `evaluator/Dockerfile`，Controller 收到任务后按 Catalog 的 `evaluator.key + benchmark.key` 解析、校验并准备 Runtime 镜像：

```text
docker run --restart unless-stopped \
  -p 8080:8080 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v agent-insight-evaluator-data:/data \
  --env-file evaluator.env \
  agent-insight-benchmark-evaluator:<release>
```

Runtime 镜像以接入包内容摘要派生的不可变 tag 和 `agent-insight.evaluator.artifact-digest` label 双重校验。已缓存的相同摘要直接复用；升级接入包会得到新的镜像引用。通用 Controller 不 import 实例实现，也不含任何 SWE-bench 分支。

挂载 Docker Socket 等价于较高宿主权限，因此评测服务必须运行在专用机器或专用 VM，端口只向 Agent Insight 开放。平台凭证不进入 Case 容器。

### 2.2 Case 镜像选择

```dotenv
SWE_BENCH_IMAGE_SOURCE=official   # official | epoch
SWE_BENCH_IMAGE_ARCH=auto         # auto | x86_64 | arm64
SWE_BENCH_ALLOW_NON_OFFICIAL=false
```

`ImageResolver` 规则：

1. `auto` 只按 Docker daemon 架构选择 `x86_64/arm64`，不会改变镜像来源。
2. x86_64 正式评测使用 EvaluationJob 中的官方 `swebench/sweb.eval.x86_64...` 镜像。
3. ARM64 本机 smoke 先尝试对应的官方 `swebench/sweb.eval.arm64...`；不存在即返回 `SWE_IMAGE_UNAVAILABLE`。
4. 只有显式配置 `source=epoch` 且 `ALLOW_NON_OFFICIAL=true` 时，才使用 `ghcr.io/epoch-research/swe-bench.eval.arm64.<instance_id>`；结果标记 `formalEligible=false`。
5. 不默认使用 `greynewell/swe-bench-arm64`，也不在缺镜像时静默回退。
6. 拉取后立即解析并保存实际 `repo@sha256:...`；同一 evaluation 重试继续使用该 digest，不再解析移动 tag。

正式成绩口径固定为 **Linux x86_64 + 官方镜像**。官方也将 x86_64 作为推荐环境，ARM64 仍属于实验支持；Epoch 的 ARM64 镜像是未完整验证的 best-effort 资产，只适合本机链路 smoke。

依据：[SWE-bench 官方 Harness 说明](https://github.com/SWE-bench/SWE-bench/blob/main/docs/reference/harness.md)、[Epoch Research ARM64 镜像仓](https://github.com/epoch-research/SWE-bench)、[greynewell ARM64 镜像标签](https://hub.docker.com/r/greynewell/swe-bench-arm64/tags)。

这里的源码 commit、镜像引用和 digest 是运行事实与完整性证据，不是 Benchmark、数据集或评估器业务版本。

## 3. 统一文件协议与 SWE-bench 实例

Controller 不 import 具体 Evaluator，也不写 `if (benchmark === 'swe-bench')`。构建期 Catalog 从每个接入包的 `benchmark.yaml`、`evaluator/evaluator.yaml` 和 Raw Result Schema 生成 Evaluator descriptor；运行时按 `evaluator.key + benchmark.key` 选择 descriptor，允许多个 Benchmark 绑定相同 Evaluator key。descriptor 的 runtime、network、CPU、内存和超时上限参与任务校验并注入 Entrypoint 环境。Controller 只调用两个稳定命令：

```text
evaluator doctor
evaluator evaluate --request <input/request.json> --output <output/result.json>
```

每个任务使用隔离目录，对应容器内的统一文件边界：

```text
/benchmark/input/                 # Controller 准备，只读
  request.json                    # EvaluationJob + Artifact 相对引用
  case.json                       # Benchmark 私有评测 Payload
  artifacts/*
/benchmark/output/                # Evaluator 唯一可写目录
  result.json                     # evaluator-output/v1
  evidence/*
  logs/*
```

Controller 负责通用 EvaluationJob、Artifact 数量/媒体类型/摘要和路径边界校验；Evaluator 返回后，Controller 再按接入包的 `result.schema.json` 校验 `rawResult`，并验证 Evidence 只能引用输出目录内的真实文件。`AbstractBenchmarkEvaluator`/`EvaluatorRegistry` 仍可作为 Node 实现的内部 SDK 和测试辅助，但不再是 Controller 与接入包之间的跨语言契约。

SWE-bench 的 `entrypoint.cjs` 在文件协议内部复用现有 `SweBenchEvaluator`，具体只做五件事：

1. 校验 `instance/prediction` 字段以及镜像仓库白名单；
2. 通过 `ImageResolver` 得到已固定 digest 的 Case 镜像；
3. 把已下载的 `model.patch` 读成官方 prediction 的 `model_patch`；
4. Python Entrypoint 调用官方 `make_test_spec(instance)` 和 `run_instance(testSpec, prediction, dockerClient, runId, timeout)`；
5. 从官方 `report.json` 映射原生结果，并返回日志证据。

为保留官方 `run_instance()`，不 fork 官方源码。传入一个受控 Docker Client 包装器，仅给官方 `containers.create()` 补充当前 evaluation 标签、CPU 和内存限制，其他调用原样委托给官方 Docker SDK。官方当前要求的 `SYS_ADMIN` 保持不变，因此仍只能在隔离评测机运行。其他 Benchmark 可以用 Node、Python 或独立可执行文件实现同一 Entrypoint，不需要修改 Controller。

## 4. 09～12 调用逻辑

### 步骤 09：评测服务接单

```http
GET  {evaluatorBaseUrl}/health
POST {evaluatorBaseUrl}/api/v1/evaluations
```

接收逻辑：鉴权 → 校验 Schema 和回调地址 → 重算 `requestDigest` → 处理幂等/忙状态 → 原子持久化 `runId + digest + request.json` → 返回 `202` → 后台执行。必须先落盘再返回 202。

Agent Insight 只要 `/health` 的目标 Evaluator 满足 `ready=true` 就下发评测；`formalEligible` 仅保留为运行事实，不参与调度或结果准入。每次 outbox claim 递增 `attemptCount`；接单、未知和失败响应都只能由仍持有该 `sending + attemptCount` 的发送者 CAS 写回，watchdog 已回收后到达的旧响应不得复活任务。

- 相同 `runId + digest`：返回当前状态，不重复启动 Harness。
- 相同 `runId`、不同 digest：`409 RUN_ID_CONFLICT`。
- 一期 `maxConcurrency=1`；已有活动任务时，新 `runId` 返回 `409 SERVICE_BUSY`，由 Agent Insight 保留队列并延迟重发；相同 `runId` 的幂等重放仍可查询已接收状态。
- `callbackBaseUrl` 必须与 `platformBaseUrl` 同源且 ID 与 `runId` 一致，禁止重定向，防止任务制造 SSRF。

任务 journal 使用 `/data/jobs/<runId>/request.json` 和原子更新的 `state.json`；服务重启扫描 `accepted/preparing/running/callback_pending`。若发现遗留 Case 容器，按 evaluation 标签清理后重新执行未产出原生结果的任务；已有 `result.json` 的任务只重试上传/回调，不重跑 Harness。

### 步骤 10：准备并运行 Case 容器

顺序固定为：

```text
accepted
  → 下载 model.patch
  → 校验 size + sha256
  → FileEvaluatorEntrypoint 校验 Manifest/Job/Artifact
  → evaluator evaluate
  → 解析 Case 镜像；本地不存在时才拉取，并固定本地镜像 digest
  → make_test_spec()
  → run_instance() 创建 Case 容器、应用 Patch、运行 eval_script、生成 report.json
  → 收集官方报告和日志
  → cleanup Case 容器
```

EvaluationJob 已带单 Case 所需的 `eval_script`、`FAIL_TO_PASS`、`PASS_TO_PASS`、`log_parser` 和 `eval_type`，评测服务不需要加载整份 Parquet。`goldPatch` 不在 Job 中；正式评测只判断 Agent Patch 是否让 F2P 全过且 P2P 不回归。

只有官方报告结构完整且未标记 `infra_failure` 才产生 `status=completed`：

- `resolved=true`：有效完成，业务通过；
- `resolved=false`：有效完成，业务不通过，不是系统错误；
- Patch 无法应用：`submission_invalid`；
- 镜像、Docker、Harness、超时或报告缺失：`failed`，并给出是否可重试。

Controller 和 SWE-bench 子进程 Runner 都把 abort 视为不可逆超时：超时后先向独立进程组发送 `SIGTERM`，宽限期后再 `SIGKILL`；即使进程在 `SIGTERM` 后以退出码 0 结束，也必须回传 `EVALUATION_TIMEOUT`，不能读取迟到输出并判为成功。

官方报告解析严格保留 JSON 类型，不再对任意值调用宽松 truthy 转换。报告结构、实例键或 `resolved` 类型不合法时生成 `SWE_HARNESS_RESULT_INVALID` 基础设施失败；官方 `resolved=false` 仍是正常完成的业务失败。官方 Harness 的 `get_eval_report()` 判定本身保持不变。

### 步骤 11：上传证据并回传原生结果

Agent Insight 提供三个只供评测服务调用的 API：

```http
POST {callbackBaseUrl}/progress
POST {callbackBaseUrl}/artifacts
POST {callbackBaseUrl}/complete
```

这些入口不校验应用层凭证，只允许从受控网络访问。

其中 `callbackBaseUrl=/api/benchmark/v1/evaluations/{evaluationId}`，不复用执行器的 `/runs/{runId}` 路由，避免两类身份、状态和 DTO 混在一起。

上传证据采用 multipart，至少包含官方 `report.json`、`test_output.txt` 和 `run_instance.log`；平台重算摘要并以 `(evaluationId, name)` 幂等保存。终态只引用已上传 Artifact ID：

```json
{
  "status": "completed",
  "rawResult": {
    "instanceId": "pallets__flask-5014",
    "resolved": true,
    "patchSuccessfullyApplied": true,
    "failToPass": { "passed": 1, "total": 1 },
    "passToPass": { "passed": 59, "total": 59 },
    "officialReport": {
      "pallets__flask-5014": {
        "resolved": true,
        "patch_successfully_applied": true,
        "FAIL_TO_PASS": { "success": ["test_a"], "failure": [] },
        "PASS_TO_PASS": { "success": ["test_b"], "failure": [] }
      }
    }
  },
  "evidenceArtifactIds": ["beart_report", "beart_test", "beart_log"],
  "runtimeFacts": {
    "harnessSourceCommit": "02e7a74ffd0b707aab73d203fe87bdc7c76afc8e",
    "caseImage": "swebench/...@sha256:...",
    "hostArch": "arm64",
    "formalEligible": false,
    "durationMs": 341000
  },
  "cleanup": {
    "evaluator": { "status": "succeeded" },
    "controller": { "status": "succeeded", "removedContainerIds": [] }
  }
}
```

Controller 在官方 Harness 清理后再次按 evaluation 标签兜底清理，再把终态和 digest 写入 journal 并调用平台；断网时进入 `callback_pending`，只重传相同内容。平台对相同 digest 返回同一结果，对冲突终态返回 409。清理失败保存在 `cleanup` 和统一结果证据中，但不覆盖已经生成的官方判分。

2xx 不是充分 ACK。进度接口必须返回 `accepted=true` 与 `desiredState=continue`；终态接口必须返回 `accepted=true`、`normalizationStatus=completed`、与提交终态匹配的平台 evaluation 状态，以及合法的 `normalizedResult`。空响应、非 JSON 或字段不一致的 2xx 按可重试协议错误处理，journal 保持 `callback_pending`。

### 步骤 12：Agent Insight 归一化

`BenchmarkAdapter` 补齐第五个方法：

```ts
normalizeResult(input: NormalizeBenchmarkResultInput): NormalizedBenchmarkResult
```

平台先持久化 Raw Result，再调用 Adapter；归一化失败保留原始证据并标记 `normalization_failed`，可单独重试，不要求重新运行 Harness。相同 completion 在 `normalizing` 崩溃窗口内可恢复；最终写入使用 `status + completionDigest` CAS，不能覆盖 watchdog 已写入的失败终态。

`SweBenchAdapter.normalizeResult()` 映射：

| 原生结果 | 统一结果 |
|-|-|
| `completed + resolved=true` | `verdict=pass, score=100` |
| `completed + resolved=false` | `verdict=fail, score=0` |
| `submission_invalid` | `verdict=fail, score=null` |
| `failed` | 评测失败，不生成机器分 |

完整官方测试明细保留在 `nativeMetrics`，证据引用保留在 `evidenceJson`；归一化后 upsert 当前 Case 的 `ExperimentEvalResult`。每次评测的原始历史继续保存在 `BenchmarkEvaluation`，不会被只重评覆盖。

`completed` 结果按冻结任务做闭合校验：实例 ID、`FAIL_TO_PASS/PASS_TO_PASS` 完整名单、严格 boolean、Raw Result 计数与官方报告必须一致；`report.json` 会从 Artifact Store 重读并复核 size/SHA-256/JSON，且证据集合必须精确包含 official report、test output 和 run log。运行架构不参与结果准入；其余契约未满足时分别以 `RAW_RESULT_SCHEMA_INVALID`、`SWE_EVIDENCE_CONTRACT_INVALID` 或 `RESULT_MAPPING_FAILED` 非重试失败，不能产生成绩。

Raw Result、统一投影、Case 终态与 `continuationStatus=pending` 在同一事务提交后才返回 ACK。后续 continuation 使用递增 attempt 作为 owner lease，服务重启和 30 秒 watchdog 都可恢复；它跳过已经 `done/failed` 的补充评估器，阻止旧 Run 覆盖重跑后的新投影，再结算实验和调度下一 Case。

## 5. 平台持久化改动

`BenchmarkEvaluation` 增加：

```text
rawResultJson / rawResultDigest
runtimeFactsJson / cleanupJson
normalizedResultJson / completionDigest
lastProgressAt / finishedAt
continuationStatus / continuationAttempts / continuationTriedAt / continuationError
```

证据由 `BenchmarkEvaluationArtifact` 保存：

```text
id / evaluationId / name / kind / mediaType / sha256 / sizeBytes / storagePath / createdAt
UNIQUE(evaluationId, name)
```

这些字段记录一次运行及其内容，不增加 Benchmark、数据集或评估器版本表/版本字段。

## 6. 配置与跨机器网络

Agent Insight 侧优先从 `~/.agent-insight/data/config/benchmark-evaluator.env` 热加载以下配置，进程环境变量作为文件不存在时的兼容兜底：

```dotenv
AGENT_INSIGHT_BENCHMARK_EVALUATOR_BASE_URL=http://127.0.0.1:3001
# 可选；仅在平台与执行器同机、Evaluator 远端的开发拓扑中设置
AGENT_INSIGHT_BENCHMARK_EXECUTOR_CALLBACK_BASE_URL=http://127.0.0.1:3000
```

`scripts/configure-evaluator-target.js` 以临时文件、`fsync`、`rename` 原子替换配置。每次 Benchmark 操作读取一份不可变快照；非法或半写入更新保留上一份有效快照。Agent Insight 与 Evaluator 不发送或校验 Authorization，双向访问必须由白名单、安全组或防火墙限制。Agent Insight 公开回调地址从实验启动请求的 `Host` / `X-Forwarded-*` 自动推导并冻结到实验绑定；Evaluator 的实际访问地址由评测机 `--platform-base-url` 覆盖。可选执行器回调地址只冻结到新建执行 Outbox，未配置时使用自动推导的地址。已冻结旧目标的任务不会因配置更新而改写目标地址。

评测服务侧：

```dotenv
EVALUATOR_LISTEN_HOST=0.0.0.0
EVALUATOR_PORT=8080
EVALUATOR_DATA_DIR=/data
EVALUATOR_MAX_CONCURRENCY=1
# 可选；Evaluator 容器实际访问 Agent Insight 的地址
EVALUATOR_AGENT_INSIGHT_BASE_URL=https://agent-insight.example.com
# 具体 Benchmark 环境变量由接入包声明并通过 --evaluator-env 传入
```

Linux 或 macOS 评测机在固定 Git revision 中执行 `scripts/evaluator.sh start`。脚本接受可选 `--platform-base-url`，并可重复使用 `--evaluator-env NAME=VALUE` 注入实例配置；Evaluator 下载 Artifact、上传证据及进度/完成回调优先使用实际可达地址。脚本构建通用 Controller、以 `--restart unless-stopped` 运行固定名称容器、挂载当前 Docker context 的 Unix Socket和独立数据卷，并自动执行 `scripts/evaluator-doctor.sh`。默认 Doctor 不准备 Runtime 或 Case 镜像；真实任务首次进入 `preparing_runtime` 时自动准备，后续复用缓存。显式 `--smoke <evaluator-key>` 同样会按需准备该 Runtime。Controller 的 `status` 只表示 HTTP、journal、Docker Socket 和 Catalog 状态，每个 `evaluators[]` 独立报告运行时事实。

本机 Docker 内访问宿主用 `host.docker.internal`；独立评测机使用 Agent Insight 的实际 HTTPS 地址。生产环境应由反向代理终止 TLS，并通过防火墙只允许两台服务互访。

Agent Insight 还每 30 秒扫描一次评测阶段：queued/dispatch 不确定、收集/上传/清理、normalizing 连续 5 分钟无进度即失败；运行 Harness 超过冻结 `timeoutSeconds + 90 秒` 即失败。回收使用 CAS 同时收敛 Evaluation、Outbox、Case 和统一投影，再落持久化 continuation，避免实验永久运行。

## 7. 实现落点

```text
packages/benchmark-protocol/src/evaluator-contracts.ts
packages/benchmark-protocol/src/evaluation-contracts.ts
services/evaluator/src/index.cjs
services/evaluator/src/service.cjs
services/evaluator/src/job-journal.cjs
services/evaluator/src/platform-client.cjs
services/evaluator/src/evaluator-registry.cjs
services/evaluator/src/cli.cjs
services/evaluator/Dockerfile
scripts/benchmark/generate-catalog.cjs
scripts/benchmark/build-evaluator-runtime.cjs
scripts/evaluator.sh
scripts/evaluator-doctor.sh
scripts/configure-evaluator-target.js
benchmarks/swe-bench/benchmark.yaml
benchmarks/swe-bench/evaluator/evaluator.yaml
benchmarks/swe-bench/evaluator/entrypoint.cjs
benchmarks/swe-bench/evaluator/index.cjs
benchmarks/swe-bench/evaluator/run.py
benchmarks/swe-bench/smoke/*
benchmarks/swe-bench/schemas/result.schema.json
generated/benchmark-catalog/evaluators.cjs
src/lib/benchmark/evaluation-callback-service.ts
src/lib/benchmark/evaluation-continuation-service.ts
src/lib/benchmark/evaluation-scheduler.ts
src/lib/benchmark/evaluator-runtime-config.ts
src/app/api/benchmark/v1/evaluations/[evaluationId]/{progress,artifacts,complete}/route.ts
prisma/schema.prisma
test/benchmark-evaluator-api.test.ts
```

当前实现按以下依赖关系组织：协议与表结构 → 平台回调 API 和 Adapter 第五方法 → Controller 接单/journal → 统一 File Entrypoint → SWE-bench 官方 Harness 包装 → Catalog → Docker/真实 API 串联。

## 8. API 级验收

不使用临时或合成数据集，使用当前真实数据库、本地 Verified Parquet 和官方源码：

1. **09～11**：真实 HTTP 下发 → 评测服务下载真实 Artifact → 官方 Case 容器运行 → 上传真实报告 → complete 回调；覆盖幂等、冲突、断网重传和重启恢复。
2. **01～13**：创建真实 Benchmark 实验 → OpenCode 生成 Patch → 执行器上传 → Agent Insight 下发评测 → 官方 Harness → `normalizeResult()` → 调用实验结果 GET。
3. 本机 smoke 首选已有真实 Case `pallets__flask-5014` 和已生成 Patch；ARM64 镜像必须实际存在且 digest 匹配。该结果标记非正式。
4. 正式验收在 x86_64 Linux 上先跑独立 Gold Control，再跑真实 Agent Patch。Gold Control 仅验证 Harness 环境，Gold Patch 作为该控制任务的 prediction，绝不进入真实 Agent 任务或其 EvaluationJob。
5. `resolved=false` 也算链路成功；只有官方报告缺失、基础设施失败或伪造结果才算链路失败。
6. 负向专项必须覆盖字符串 `"false"`、错误 instance、空/重复/未知测试名单、报告证据漂移、超时后退出 0、畸形 2xx ACK、迟到 dispatch/completion、normalizing 恢复、continuation 租约和 Case 重跑聚合。
7. 最后运行 `npm run test`；Docker daemon 未启动时，容器集成测试必须明确 skip，不能伪造通过。当前 ARM64 冒烟已执行 1 个 Case，镜像为 `swebench/sweb.eval.arm64.pallets_1776_flask-5014@sha256:c6b6e75970bae4403dccdf152a838c7ff4125ec9a08b6febb0894701887d6483`；Docker 化 Controller 的 09～13 和全真实 01～13 测试均为 1/1 通过，测试数据库记录、Controller/Case 容器和证据已清理。

双层容器测试通过 `RUN_SWE_BENCH_CONTROLLER_DOCKER_TEST=true` 显式启用，并可用 `SWE_BENCH_CONTROLLER_IMAGE` 指定已构建的 Controller 镜像；默认测试不启动容器，也不拉取 Case 镜像。

当前不需要再次下载数据集。Case 镜像由评测服务按任务逐个拉取，不会预拉完整 SWE-bench 镜像集；本轮只拉取了 `pallets__flask-5014` 对应镜像。

## 9. 明确不做

- 不做前端和评测服务注册管理页面；
- 不做多评测服务、多并发槽位和自动迁移；
- 不把 Docker Socket、平台 Token 或宿主路径传进 Case 容器；
- 不执行来自请求拼接出的 Shell 命令；
- 不用第三方 ARM64 结果冒充正式 SWE-bench 成绩；
- 不建立 Benchmark、数据集或评估器业务版本概念。

## 10. ZSoft 实例开发与对照验证

本节供维护 ZSoft Evaluator、资产格式和验收工具时使用。常规安装与发布分别见 [ZSoft 部署指南](../../../docs/zh/how-to/evaluation/benchmarks/deploy-zsoft.md)和[资产发布指南](../../../docs/zh/how-to/evaluation/benchmarks/release-zsoft-assets.md)。

### 题目身份与冻结资产

ZSoft 的 `sourceTaskDigest` 专门对原始 `task.json` 对象与 `public/` 文件字节摘要清单计算 SHA-256，键按固定 Unicode 字符顺序序列化；平台导入与 Node Provider 共用 `source-identity.cjs`，与 Python 冻结端保持一致，不复用通用协议中基于 `localeCompare` 的 JSON 排序。跨语言测试须包含多文件、大小写、标点和数字字符串键。只在实际资产及公开元数据全部验证通过后识别旧排序摘要，并以 `ZSOFT_TASK_DIGEST_LEGACY` 拒绝，不接受任意历史哈希；管理员显式导入新名称的数据集并新建实验，不静默改写冻结身份。通用请求摘要规则不变。

平台题目内容身份与评测机私有资产构建摘要分别管理。接入包的 Image Provider 根据题目身份和可选官方 revision 校验冻结清单，再交由公共镜像池准备固定引用；不得接受任务指定任意镜像。`registryImages` 使用固定仓库摘要，`images` 记录本地 Docker config Image ID，两者角色一致并参与资产校验。内核的 `bzImage`、metadata 和模块属于逐文件校验的冻结资产，不作为 Docker 镜像引用；合并快照须匹配官方 revision 与框架摘要。具体格式以 `benchmarks/zsoft-l1/evaluator/images.cjs`、`assets.py`、`source-identity.cjs` 和资产构建脚本为准。

Controller 通过已校验的内部配置快照向 Runtime 交付配置，Evaluator 不连接平台数据库。平台 Judge 容器与实际 runner 的设备权限分开；仅实际 runner 在 KVM 模式获得所需设备并验证可用性。提交编译失败归为 `submission_invalid`，基础设施、超时和清理故障按各自状态保留，不能混作业务未通过。

### 官方结果与证据

正式评分来自官方执行记录；Adapter 核对题目、提交摘要及大小、阶段、最终判定与清理/超时事实，不能用平台自行生成的摘要替代官方报告。成功时必须有官方报告和执行记录；失败时保留已经产生的官方输出，不伪造缺失报告或清空证据。原始输出按字节保留，异常 JSON 不得阻止整个失败回调。

证据收集仅允许白名单文件与目录，拒绝符号链接、特殊文件和越界路径，不导出隐藏判题源码、工作配置或提交副本。文件、总量和归档限制及采集失败事实以 `benchmarks/zsoft-l1/evaluator/evidence.py`、`entrypoint.py` 和对应测试为准，避免在文档维护另一份易漂移的数值清单。

### 原生对照工具

维护者使用 [`zsoft-preflight.py`](../../../scripts/benchmark/zsoft-preflight.py) 检查环境，使用 [`zsoft-validate.py`](../../../scripts/benchmark/zsoft-validate.py) 对照官方判题；这些工具不注册平台接入，也不运行 Agent、MCTS、模型或 E2B。源码、Python 环境和输出目录独立准备，固定官方 revision；内核构建依赖和实际加速能力按所选任务验证。参数以脚本帮助和实现为准。

P0 冻结正式题目、来源锁与控制提交，逐题核对公开导出内容，不执行 Judge；指定任务后的 P1 运行正确和错误控制提交，准备动作可能构建镜像与内核。正确提交须成功、错误提交须正常完成且业务失败，基础设施错误不算负例通过。保留原生报告、日志、资产身份及清理证据；输出目录不得覆盖旧证据，同题避免并发准备，私有控制材料不交给执行 Agent。原生对照通过仍不代替平台完整链路验收。
