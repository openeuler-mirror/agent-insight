# Benchmark 步骤 09～12：评测服务后端设计

> 范围：评测服务接单、准备并运行 Case 容器、上传证据、回传原生结果，以及 Agent Insight 调用 Adapter 第五个方法归一化结果。
> 不包含前端、服务注册中心、多机调度、Benchmark/数据集/评估器业务版本。固定源码的独立机器一键部署见[修改方案](../../评测服务文档/evaluator-source-one-command-deployment-plan.md)，一期脚本与配置热加载已经实现。
> 前序：[提交校验与评测下发](benchmark-evaluation-dispatch.md)；溯源：[高保真源码](../../评测服务文档/Benchmark统一接口设计-SWE-bench示例.html)。

状态：步骤 09～12 的 Controller、协议、SWE-bench 官方 Harness 包装、平台回调和结果归一化已实现；后续步骤 13 查询也已实现，01～13 已在真实数据库和真实 Verified Case 上完成 API 级串联。一期另提供 Linux/macOS `start-evaluator.sh`、容器内外 Doctor、显式 Gold Smoke 和 Agent Insight 专用通信配置热加载。2026-09-04 已在 ARM64 Docker Desktop 上完成双层容器验收：Docker 化 Controller 通过真实 HTTP 接单、下载真实 Artifact、启动官方 `pallets__flask-5014` Case 容器，并将进度、三类证据和原生结果回传 Agent Insight；平台完成归一化和结果查询。该结果只作为 ARM64 单 Case 冒烟，不替代 x86_64 Linux 正式计分验收。

## 1. 最终方案

运行时使用两层容器：

```text
Agent Insight
  └─ POST /api/v1/evaluations
       └─ Evaluator Controller 容器（本项目构建，常驻）
            ├─ 持久化任务、下载 Agent Patch、回调平台
            ├─ 构建生成的 Evaluator Catalog
            └─ 统一 FileEvaluatorEntrypoint
                 └─ evaluator evaluate --request ... --output ...
                      └─ SWE-bench Entrypoint
                           └─ 官方 make_test_spec() + run_instance()
                                └─ SWE-bench Case 容器（每个 Case 一个，用后即删）
```

- **Controller 容器**：Node.js HTTP/任务编排 + Python/SWE-bench + Docker CLI；挂载 Docker Socket 和持久化任务目录。
- **Case 容器**：执行真正的 Patch 应用和测试。正式评测使用官方 x86_64 SWE-bench 镜像。
- 不复制官方 Patch 应用、测试执行和判分代码；固定复用本地已下载官方源码 commit `02e7a74ffd0b707aab73d203fe87bdc7c76afc8e` 中的 `make_test_spec()`、`run_instance()` 和 `get_eval_report()`。
- Controller 与 Agent Insight 可以不在一台机器；双方只通过 REST 和 Artifact 内容传输，不共享文件路径或数据库。

## 2. Docker 镜像策略

### 2.1 Controller 镜像

项目提供一个可构建的多架构 Controller 镜像，包含 Node.js、Python、Docker CLI 和锁定 commit 的官方 SWE-bench 源码。运行方式：

```text
docker run --restart unless-stopped \
  -p 8080:8080 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v agent-insight-evaluator-data:/data \
  --env-file evaluator.env \
  agent-insight-benchmark-evaluator:<release>
```

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

Controller 不 import 具体 Evaluator，也不写 `if (benchmark === 'swe-bench')`。构建期 Catalog 从每个接入包的 `benchmark.yaml`、`evaluator/evaluator.yaml` 和 Raw Result Schema 生成 Evaluator descriptor；运行时 `FileEvaluatorEntrypoint` 根据 `evaluator.key` 选择 descriptor，并只调用两个稳定命令：

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

### 步骤 11：上传证据并回传原生结果

Agent Insight 新增三个只供评测服务调用的 API：

```http
POST {callbackBaseUrl}/progress
POST {callbackBaseUrl}/artifacts
POST {callbackBaseUrl}/complete
Authorization: Bearer <evaluator-token>
```

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
    "passToPass": { "passed": 59, "total": 59 }
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

### 步骤 12：Agent Insight 归一化

`BenchmarkAdapter` 补齐第五个方法：

```ts
normalizeResult(input: NormalizeBenchmarkResultInput): NormalizedBenchmarkResult
```

平台先持久化 Raw Result，再调用 Adapter；归一化失败保留原始证据并标记 `normalization_failed`，可单独重试，不要求重新运行 Harness。

`SweBenchAdapter.normalizeResult()` 映射：

| 原生结果 | 统一结果 |
|-|-|
| `completed + resolved=true` | `verdict=pass, score=100` |
| `completed + resolved=false` | `verdict=fail, score=0` |
| `submission_invalid` | `verdict=fail, score=null` |
| `failed` | 评测失败，不生成机器分 |

完整官方测试明细保留在 `nativeMetrics`，证据引用保留在 `evidenceJson`；归一化后 upsert 当前 Case 的 `ExperimentEvalResult`。每次评测的原始历史继续保存在 `BenchmarkEvaluation`，不会被只重评覆盖。

## 5. 平台持久化改动

`BenchmarkEvaluation` 增加：

```text
rawResultJson / rawResultDigest
runtimeFactsJson / cleanupJson
normalizedResultJson / completionDigest
lastProgressAt / finishedAt
```

新增 `BenchmarkEvaluationArtifact`：

```text
id / evaluationId / name / kind / mediaType / sha256 / sizeBytes / storagePath / createdAt
UNIQUE(evaluationId, name)
```

这些字段记录一次运行及其内容，不增加 Benchmark、数据集或评估器版本表/版本字段。

## 6. 配置与跨机器网络

Agent Insight 侧优先从 `~/.agent-insight/data/config/benchmark-evaluator.env` 热加载以下配置，进程环境变量作为文件不存在时的兼容兜底：

```dotenv
AGENT_INSIGHT_BENCHMARK_EVALUATOR_BASE_URL=http://127.0.0.1:8080
AGENT_INSIGHT_BENCHMARK_EVALUATOR_AUTH_MODE=token
AGENT_INSIGHT_BENCHMARK_EVALUATOR_TOKEN=<shared-secret>
AGENT_INSIGHT_BENCHMARK_EVALUATOR_PREVIOUS_TOKENS=
AGENT_INSIGHT_PUBLIC_BASE_URL=http://host.docker.internal:3000
# 可选；仅在平台与执行器同机、Evaluator 远端的开发拓扑中设置
AGENT_INSIGHT_BENCHMARK_EXECUTOR_CALLBACK_BASE_URL=http://127.0.0.1:3000
```

`scripts/configure-evaluator-target.js` 默认在 `token` 模式从权限为 `0600` 的 Token 文件读取密钥，也支持显式 `--auth-mode none` 在受安全组或防火墙隔离的网络中关闭双向 Bearer 鉴权。脚本以临时文件、`fsync`、`rename` 原子替换配置。每次 Benchmark 操作读取一份不可变快照；非法或半写入更新保留上一份有效快照。认证模式、当前 Token、旧 Token 与地址共同进入配置修订；当前 Token 用于新任务下发，当前与旧 Token 都可通过回调鉴权。`none` 模式不要求 Token，任务下发、Artifact 下载、进度、证据和完成回调均省略 Authorization，但不替代网络访问控制。公开地址冻结到实验绑定并供 Evaluator 使用；可选执行器回调地址只冻结到新建执行 Outbox，未配置时回退公开地址。已冻结旧目标的任务不会自动拿新认证配置或新回调地址请求旧地址。

评测服务侧：

```dotenv
EVALUATOR_LISTEN_HOST=0.0.0.0
EVALUATOR_PORT=8080
EVALUATOR_DATA_DIR=/data
EVALUATOR_MAX_CONCURRENCY=1
EVALUATOR_AUTH_MODE=token
EVALUATOR_PLATFORM_TOKEN=<same-shared-secret>
SWE_BENCH_IMAGE_SOURCE=official
SWE_BENCH_IMAGE_ARCH=auto
SWE_BENCH_ALLOW_NON_OFFICIAL=false
```

Linux 或 macOS 评测机在固定 Git revision 中执行 `scripts/start-evaluator.sh`。脚本构建 revision 镜像、以 `--restart unless-stopped` 运行固定名称 Controller、挂载当前 Docker context 的 Unix Socket 和独立数据卷，并自动执行 `scripts/evaluator-doctor.sh`。默认 Doctor 不拉取 Case 镜像；显式 `--smoke swe-bench` 才使用内置 Gold Case 按需拉取一个镜像。Controller 的 `status` 只表示 HTTP、journal 和 Docker Socket 状态，每个 `evaluators[]` 独立报告 `ready/reason/formalEligible`，单个不兼容 Evaluator 不再拖累 Controller 整体健康。

本机 Docker 内访问宿主用 `host.docker.internal`；独立评测机使用 Agent Insight 的实际 HTTPS 地址。生产环境应由反向代理终止 TLS，并通过防火墙只允许两台服务互访。

## 7. 开发落点

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
scripts/start-evaluator.sh
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
src/lib/benchmark/evaluator-runtime-config.ts
src/app/api/benchmark/v1/evaluations/[evaluationId]/{progress,artifacts,complete}/route.ts
prisma/schema.prisma
test/benchmark-evaluator-api.test.ts
```

开发顺序按依赖执行即可：协议与表结构 → 平台回调 API 和 Adapter 第五方法 → Controller 接单/journal → 统一 File Entrypoint → SWE-bench 官方 Harness 包装 → Catalog → Docker/真实 API 串联。

## 8. API 级验收

不使用临时或合成数据集，使用当前真实数据库、本地 Verified Parquet 和官方源码：

1. **09～11**：真实 HTTP 下发 → 评测服务下载真实 Artifact → 官方 Case 容器运行 → 上传真实报告 → complete 回调；覆盖鉴权、幂等、冲突、断网重传和重启恢复。
2. **01～13**：创建真实 Benchmark 实验 → OpenCode 生成 Patch → 执行器上传 → Agent Insight 下发评测 → 官方 Harness → `normalizeResult()` → 调用实验结果 GET。
3. 本机 smoke 首选已有真实 Case `pallets__flask-5014` 和已生成 Patch；ARM64 镜像必须实际存在且 digest 匹配。该结果标记非正式。
4. 正式验收在 x86_64 Linux 上先跑独立 Gold Control，再跑真实 Agent Patch。Gold Control 仅验证 Harness 环境，Gold Patch 作为该控制任务的 prediction，绝不进入真实 Agent 任务或其 EvaluationJob。
5. `resolved=false` 也算链路成功；只有官方报告缺失、基础设施失败或伪造结果才算链路失败。
6. 最后运行 `npm run test`；Docker daemon 未启动时，容器集成测试必须明确 skip，不能伪造通过。当前 ARM64 冒烟已执行 1 个 Case，镜像为 `swebench/sweb.eval.arm64.pallets_1776_flask-5014@sha256:c6b6e75970bae4403dccdf152a838c7ff4125ec9a08b6febb0894701887d6483`；Docker 化 Controller 的 09～13 和全真实 01～13 测试均为 1/1 通过，测试数据库记录、Controller/Case 容器和证据已清理。

双层容器测试通过 `RUN_SWE_BENCH_CONTROLLER_DOCKER_TEST=true` 显式启用，并可用 `SWE_BENCH_CONTROLLER_IMAGE` 指定已构建的 Controller 镜像；默认测试不启动容器，也不拉取 Case 镜像。

当前不需要再次下载数据集。Case 镜像由评测服务按任务逐个拉取，不会预拉完整 SWE-bench 镜像集；本轮只拉取了 `pallets__flask-5014` 对应镜像。

## 9. 明确不做

- 不做前端和评测服务注册管理页面；
- 不做多评测服务、多并发槽位和自动迁移；
- 不把 Docker Socket、平台 Token 或宿主路径传进 Case 容器；
- 不执行来自请求拼接出的 Shell 命令；
- 不用第三方 ARM64 结果冒充正式 SWE-bench 成绩；
- 不建立 Benchmark、数据集或评估器业务版本概念。
