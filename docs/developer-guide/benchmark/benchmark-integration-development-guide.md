# Benchmark 接入开发规范

> 面向 AI 编码 Agent 和 Benchmark 接入开发者。当前协议版本：`agent-task/v1`、`benchmark-evaluation/v1`。

## 1. 目标与非目标

本规范定义如何把一个具体 Benchmark 实现为可安装接入包：

```text
自然语言需求
  → 需求发现与确认单
  → benchmarks/<key> 接入包
  → Catalog 校验
  → 数据集安装
  → Agent 执行与 Submission
  → Evaluator 判定与结果归一化
  → 公共前端展示
```

接入采用“公共框架 + Benchmark 实例实现”：

- 公共平台负责任务状态机、执行目标匹配、Artifact 传输、评测调度、结果保存和统一页面；
- Adapter 负责具体 Benchmark 的 Case 拆分、任务构造、提交校验、评测请求和结果归一化；
- Evaluator 负责运行 Benchmark 的权威判定逻辑并产出原生结果和 Evidence；
- Manifest 和 Presentation 声明静态契约及受控展示。

本规范不承诺任意 Benchmark 零代码、纯配置接入。标准能力无法表达新任务时，应扩展可复用的公共协议或执行组件，不能添加 Benchmark 专属公共分支。

## 2. AI 必须遵循的开发流程

### 2.1 需求发现

收到自然语言需求后，先阅读客户提供的数据、仓库、测试、脚本和运行说明。不要立即编码，也不要要求客户一次性填写技术表格。

把信息分成三类：

- **业务事实**：评什么、什么算成功、哪些数据敏感，由客户确认；
- **接入设计**：Submission、Evaluator、环境、指标和展示，由 AI 提议；
- **实现细节**：类型、文件路径、错误码、摘要和测试，由开发者按本规范处理。

只询问无法从材料推导、且答案会改变方案的问题。每轮最多提出 1～3 个问题，并附推荐选项和影响。

### 2.2 形成确认单

编码前生成《Benchmark 接入确认单》，至少包含：

- 目标与一条 Case 的业务含义；
- 原始字段、公开数据、私有数据和目录展示投影；
- Agent 工作区、任务说明、网络策略和 Submission；
- Evaluator 的权威判定依据、运行环境和 Evidence；
- 主指标、聚合方式、评分点及页面展示；
- V1 能力判断和可能的公共扩展。

没有权威成功标准、数据授权或关键私有边界时，不得把假设写成正式实现。

### 2.3 判断接入包还是公共扩展

满足以下条件时，只开发 `benchmarks/<key>`：

- Git Workspace 可以承载任务；
- 仓库是无凭据的 GitHub HTTPS 地址；
- 基线是完整 40 位 commit SHA；
- 已注册的 Agent Runtime 可以执行任务；
- 已注册的 Artifact Collector 可以收集全部必需提交物；
- Evaluator Entrypoint 和现有文件协议可以承载判定逻辑。

任一条件不满足时，先提交公共能力扩展设计，说明协议变化、复用对象、安全边界、兼容性和测试。未经确认不要在实例 Adapter、公共 API 或 React 页面中绕过限制。

### 2.4 实现与验证

确认后按顺序完成：Schema → Manifest → Adapter → Evaluator → Dataset Loader → Presentation → 单元测试 → Smoke → 端到端验收。

## 3. V1 支持边界

`agent-task/v1` 当前硬边界：

- `workspace.provider` 只能为 `git`；
- 仓库必须是 `https://github.com/...`，不得包含账号、密码、查询参数或锚点；
- `workspace.revision` 必须是完整 40 位 commit SHA；
- `workspaceWrite` 为 `allow`，`hiddenDataAccess` 为 `deny`；
- Agent 网络策略为 `deny` 或 `client-default`；
- 每个 Benchmark 至少声明一个 Artifact；
- Artifact 必须由已注册 Collector 产生；
- 执行目标还必须上报 `agent-runtime/<platform>/v1` 和 `RUN_BENCHMARK_CASE`。

当前默认本地执行器提供：

- `git-workspace/v1`；
- `agent-runtime/opencode/v1`；
- `git-patch/v1`。

其他 Workspace、Agent Runtime 或 Collector 属于公共能力扩展，不是 Manifest 中写一个新字符串就会自动获得实现。

## 4. 接入包目录

```text
benchmarks/<key>/
├── benchmark.yaml
├── adapter/
│   └── index.ts
├── dataset/                    # 可选：官方数据源 Loader
│   └── index.ts
├── evaluator/
│   ├── evaluator.yaml
│   ├── entrypoint.cjs          # 也可以是 Python 或可执行文件
│   └── ...                     # Harness、脚本、镜像构建文件
├── schemas/
│   ├── case.schema.json
│   └── result.schema.json
├── fixtures/
│   └── smoke-case.json
├── smoke/
│   ├── case.json
│   └── index.cjs
└── tests/
    └── adapter.test.ts
```

接入包通过 Catalog 自动发现，不需要在公共注册表手工 import。生成物位于 `generated/benchmark-catalog/`，不得直接修改。

## 5. `benchmark.yaml`

下面是使用现有 Git Patch 能力的最小参考结构：

```yaml
key: repository-quality
displayName: Repository Quality
protocols:
  agentTask: agent-task/v1
  evaluation: benchmark-evaluation/v1

implementation:
  adapter: ./adapter/index.ts
  adapterExport: repositoryQualityAdapter
  datasetLoader: ./dataset/index.ts
  datasetLoaderExport: repositoryQualityDatasetLoader
  evaluator: ./evaluator/evaluator.yaml

schemas:
  case: ./schemas/case.schema.json
  rawResult: ./schemas/result.schema.json

executor:
  requiredCapabilities:
    - git-workspace/v1
    - git-patch/v1
  defaultTimeoutSeconds: 600

submission:
  artifacts:
    - name: model.patch
      mediaType: text/x-diff
      collector: git-patch/v1
      maxBytes: 10485760

evaluation:
  evaluatorKey: repository-quality
  defaultTimeoutSeconds: 900
  resources:
    cpu: 2
    memoryMiB: 4096

result:
  primaryMetric:
    key: passed
    aggregation: boolean-rate

dataset:
  profiles:
    - key: default
      displayName: Repository Quality Default
      acceptedExtensions: [.jsonl]

presentation:
  evaluator:
    displayName: Repository Quality Harness
    description: 运行隐藏检查并验证修改结果。
    runMode: Isolated Script
    outputDescription: 输出通过状态、检查项和运行证据。
  caseTable:
    searchPaths: [externalCaseId, values.repo]
    searchPlaceholder: 搜索 Case 或仓库
    columns:
      - { path: input, label: 任务, type: text, truncate: 160 }
      - { path: externalCaseId, label: Case, type: code, width: 180 }
      - { path: values.repo, label: 仓库, type: text }
  referencePanel:
    title: 隐藏检查契约
    description: 隐藏检查只交给 Evaluator，不发送给 Agent。
    columns:
      - { path: externalCaseId, label: Case, type: code }
      - { path: values.repo, label: 仓库, type: text }
  result:
    primaryMetric:
      path: primaryMetric.value
      label: Passed
      aggregateLabel: Pass Rate
      type: boolean
      trueLabel: 通过
      falseLabel: 未通过
  artifacts:
    - { source: submission, name: model.patch, label: Agent Patch, order: 10 }
    - { source: evidence, kind: check-report, label: 检查报告, order: 20 }
```

### 5.1 标识

- `key`：Benchmark 稳定标识，格式为小写字母、数字、点、下划线或连字符，最长 64 个字符；Catalog 将它投影为 `adapterKey`。
- `displayName`：用户可见名称。
- `evaluation.evaluatorKey`：Evaluator 稳定标识，可以与 `key` 不同，也可以被多个 Benchmark 复用。

公共代码不得假设 `evaluatorKey === adapterKey`。平台评估器 ID 为 `benchmark:<evaluatorKey>`。

### 5.2 能力与提交物

- `executor.requiredCapabilities` 必须非空、不能重复；
- 每个 Artifact 的 `collector` 必须同时出现在能力列表中；
- Artifact 名称必须唯一且使用安全文件名；
- `mediaType` 描述真实内容；
- `maxBytes` 是正整数并应按业务需要收紧；
- 当前所有声明的 Submission Artifact 都是必需项，不存在 Manifest 级可选提交物。

### 5.3 Evaluator 和资源

`evaluation.defaultTimeoutSeconds/resources` 必须与 `evaluator/evaluator.yaml` 完全一致。资源值是 Evaluator 可接受的上限和默认运行配置，不要复制不合理的大值。

### 5.4 主指标

- `boolean-rate`：Case 值必须是布尔值，实验趋势聚合通过率；
- `mean`：Case 值必须是有限数字，实验趋势聚合均值。

主指标 key 必须与 Adapter 归一化结果中的 key 一致。

## 6. Case Schema 与数据边界

`schemas/case.schema.json` 是原始 Case 的真值。每个业务字段应使用 `x-agent-visibility` 标记：

- `public`：允许进入 `publicPayload`，可发送给 Agent；
- `private`：只能进入 `privatePayload`，仅供评测使用。

示例：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["case_id", "repo", "base_commit", "instruction", "hidden_checks"],
  "properties": {
    "case_id": { "type": "string", "x-agent-visibility": "public" },
    "repo": { "type": "string", "x-agent-visibility": "public" },
    "base_commit": { "type": "string", "x-agent-visibility": "public" },
    "instruction": { "type": "string", "x-agent-visibility": "public" },
    "hidden_checks": { "type": "array", "items": { "type": "string" }, "x-agent-visibility": "private" }
  },
  "additionalProperties": false
}
```

Adapter 基类会校验 Schema 和 Agent 可见性边界。不要通过任务说明、Catalog 投影、日志或错误信息重新泄露私有字段。

### 6.1 Catalog 投影

`splitCase` 还要产生：

```ts
{
  externalCaseId: 'case-001',
  catalogProjection: {
    input: '修复仓库中的目标问题',
    values: {
      repo: 'owner/repository',
      metadata: { language: 'TypeScript' },
    },
    tags: ['repository-quality'],
  },
}
```

规则：

- `externalCaseId` 必须稳定且非空；
- `input` 是数据集和实验页面使用的公开任务文本；
- 其他公开展示值放入 `values`，支持嵌套对象；
- Presentation 只能引用 `input`、`externalCaseId` 和 `values.*`；
- Catalog 投影不得包含隐藏测试、Gold 答案、凭据或私有路径；
- 公共输入和 `values` 各自受到大小与数量限制，避免把原始 Case 整体复制到页面。

## 7. Dataset Loader

当接入包提供标准数据源读取方式时，实现：

```ts
export interface BenchmarkDatasetLoader {
  loadCases(sourcePath: string): AsyncIterable<JsonValue>
}
```

Loader 只负责把文件逐条解析为原始 Case，不负责公开/私有拆分或业务校验；这些仍由 Adapter 完成。

`dataset.profiles` 声明可安装的数据集变体、显示名称、文件扩展名和可选预期数量。声明 Loader 时必须同时声明至少一个 Profile。

安装命令：

```bash
npx tsx scripts/benchmark/install-dataset.ts \
  --benchmark <key> \
  --profile <profile> \
  --source <dataset-file> \
  --name <display-name>
```

数据集安装后只读；字段定义按当时的 Presentation 冻结。只刷新展示字段而不重写 Case：

```bash
npx tsx scripts/benchmark/refresh-dataset-presentation.ts --dataset <dataset-id>
```

## 8. Adapter 开发规范

Adapter 必须继承 `AbstractBenchmarkAdapter`，只实现五个受保护的业务 Hook。不要覆盖公共生命周期方法。

| 需要实现的 Hook | 基类公开调用 | 业务职责 |
|---|---|---|
| `splitCase` | `validateAndSplitCase` | 解析 Case，拆分公开/私有数据，生成目录投影 |
| `createAgentTask` | `buildAgentTask` | 构造 Agent 指令、工作区、策略和提交契约 |
| `validateBenchmarkSubmission` | `validateSubmission` | 在通用摘要、大小和名称校验后做业务内容校验 |
| `createEvaluationRequest` | `buildEvaluationRequest` | 将冻结 Case、Artifact 和资源组装为 EvaluationJob |
| `createNormalizedResult` | `normalizeResult` | 校验原生结果和 Evidence，生成平台统一结果 |

基类负责：Schema、可见性、上下文、防篡改、Artifact 摘要、大小、资源范围、原生结果 Schema 和归一化结构校验。

### 8.1 `splitCase`

必须：

- 对业务字段做语义校验，不只依赖 JSON 类型；
- 生成稳定 `externalCaseId`；
- 明确构造 `publicPayload` 和 `privatePayload`；
- 只把公开值投影到 `catalogProjection`；
- 不保留无法解释的隐式字段回退。

### 8.2 `createAgentTask`

必须完整构造 `AgentTaskEnvelope`，尤其是：

- 指令应告诉 Agent 任务目标，但不得包含隐藏测试和 Gold 数据；
- `benchmarkPayload` 只能使用 `publicPayload`；
- `context` 必须原样使用平台传入值；
- `submission.requiredArtifacts` 必须与 Manifest 完全一致；
- 不要把 shell 命令、凭据或私有 Payload 塞入任务信封。

### 8.3 `validateBenchmarkSubmission`

基类已经校验 Artifact 归属、名称、MIME、大小、SHA-256、真实字节和必需集合。实例只校验业务内容，例如：

- UTF-8 和结构是否有效；
- Patch 或 JSON 是否为空；
- 路径是否越界；
- 内容是否满足本 Benchmark 的最小语义。

业务错误码使用 `<BENCHMARK>_<REASON>` 形式。不要依赖公共流程识别某个前缀；公共流程依据阶段和异常类型分类。

### 8.4 `createEvaluationRequest`

`EvaluationJob.payload` 是 Evaluator 的业务输入，可以包含公开和私有 Case 数据。必须使用平台传入的冻结上下文、Artifact 描述和资源配置，不得重新读取可变数据源。

不得在这里执行 Harness；这里只构造可重放、可摘要的评测请求。

### 8.5 `createNormalizedResult`

归一化输出：

```ts
type NormalizedBenchmarkResult = {
  status: 'done' | 'failed'
  verdict?: 'pass' | 'warn' | 'fail'
  summary: string
  score: number | null
  primaryMetric?: {
    key: string
    value: boolean | number | null
    aggregation: 'boolean-rate' | 'mean'
  }
  points: Array<{
    label: string
    value: string | number | boolean | null
    total?: number
    format?: 'plain' | 'percentage' | 'ratio'
    score?: number | null
    evidence?: JsonValue
  }>
  evidence: JsonValue
  nativeMetrics: JsonValue
  errorMessage?: string
}
```

要求：

- `summary` 必须是面向用户的明确结论；
- `score` 若存在必须在 0～100；
- 正常完成必须返回 `done`、verdict、score 和非空主指标；
- 基础设施失败必须返回 `failed` 且 score 为 `null`；
- `submission_invalid` 可以归一化为业务失败，不要伪装成基础设施故障；
- `points` 必须直接提供可展示的 `label/value/total/format`；
- 不让前端从 Evidence 猜测业务计数；
- `nativeMetrics` 保留 Benchmark 原生指标，`evidence` 保存审计引用和简要事实。

## 9. Evaluator 开发规范

部署入口 `scripts/start-evaluator.sh` 只启动通用 Controller，不接受 Benchmark 选择、Runtime 预热或应用层鉴权参数。Controller 收到任务后，才根据 `benchmark.key + evaluator.key` 从 Catalog 解析并准备对应 Runtime；相同内容摘要的镜像直接复用。Agent Insight 与 Controller 之间不发送或校验 Bearer Token，部署者必须使用白名单、安全组或防火墙限制双向访问。这里的服务互访边界与 `evaluator.yaml` 的 `network` 不同：后者只约束实例 Runtime 执行评测时的容器网络策略。

### 9.1 `evaluator.yaml`

```yaml
key: repository-quality
runtime: oci-container
imageRepository: your-registry.example.com/benchmark/repository-quality-runtime
dockerfile: ./Dockerfile
entrypoint: ./entrypoint.cjs
containerEntrypoint: /app/benchmarks/repository-quality/evaluator/entrypoint.cjs
smokeEntrypoint: ../smoke/index.cjs
containerSmokeEntrypoint: /app/benchmarks/repository-quality/smoke/index.cjs
command: node
network: deny
resources:
  cpu: 2
  memoryMiB: 4096
  timeoutSeconds: 900
```

允许值：

- `runtime`：有独立依赖的公开接入使用 `oci-container`；`script-package`、`builtin` 只适用于与 Controller 共享依赖的内置实现；
- `command`：`node`、`python3`、`direct`；
- `network`：`deny` 或 `allow`。`deny` 使用 Docker `network_mode=none` 隔离外部网络，同时保留容器内部 `localhost` 解析与回环套接字；`allow` 使用 bridge 网络。SWE-bench 官方 Case 容器与其 Evaluator Runtime 遵循同一策略，测试插件需要的本地通信不会被误禁用。

Entrypoint、Smoke 和 Dockerfile 必须位于接入包内。Catalog 按接入包内容摘要生成 Runtime 镜像 tag，并在运行时校验镜像 label；发布方可用 `node scripts/benchmark/build-evaluator-runtime.cjs <key>` 构建并推送该制品。未命中远端制品的源码 checkout 会在首次任务中回退本地构建，之后复用缓存。运行依赖归接入包制品所有，不要加入通用 Controller 基础依赖，也不要在 Controller 公共代码中加入 Benchmark 分支。

### 9.2 Entrypoint 命令

必须支持：

```bash
evaluator doctor
evaluator evaluate --request <request.json> --output <result.json>
```

`doctor` 向 stdout 输出 JSON：

```json
{
  "ready": true,
  "formalEligible": true,
  "runtimeFacts": { "harnessVersion": "1.0.0" }
}
```

`evaluate` 接收的工作目录：

```text
entrypoint/
├── input/
│   ├── request.json
│   ├── case.json
│   └── artifacts/<submission files>
└── output/
    ├── result.json
    └── <evidence files>
```

`request.json` 包含 `schemaVersion: evaluator-entrypoint/v1`、完整 `evaluationJob` 和只读 Artifact 相对路径。Evaluator 只能从输入目录读取提交物，把 Evidence 写入输出目录。

可选的 `preparedImages` 数组由公共 Controller 写入输入契约，包含 `imageId`、不可变 `pinnedImage`、实际来源及接入包提供的上下文；不得直接信任客户端提交的同名字段。启用池的实例使用这些引用，不再自行拉取缺失镜像；缺失时失败并通过 Controller 重试。未接入镜像池的 Evaluator 保持原有输入和运行方式。

### 9.3 `result.json`

```json
{
  "protocolVersion": "evaluator-output/v1",
  "completion": {
    "status": "completed",
    "rawResult": { "passed": true },
    "runtimeFacts": {},
    "cleanup": { "status": "succeeded" }
  },
  "evidenceFiles": [
    {
      "name": "report.json",
      "kind": "check-report",
      "mediaType": "application/json",
      "path": "evidence/report.json"
    }
  ]
}
```

`completion.status`：

- `completed`：Harness 正常结束并给出业务结果；
- `submission_invalid`：提交物在业务上不可评，例如 Patch 无法应用；
- `failed`：Evaluator、容器、下载、超时或其他基础设施失败。

`rawResult` 必须符合 `schemas/result.schema.json`。Evidence 文件名必须安全、唯一，路径必须位于输出目录。每个实际产生的 Evidence 都应返回，不能因 Presentation 未配置而丢弃。

### 9.4 运行要求

- 响应 SIGTERM/SIGINT，超时时尽快终止子进程和容器；
- 使用每次运行独立的工作目录和容器名；
- 验证镜像、脚本和 Artifact 与冻结 Job 一致；
- 把业务未通过与运行故障分开；
- `finally` 中清理进程、容器、临时目录和策略；
- 错误中不得输出 Token、隐藏测试正文或私有 Payload；
- 相同 EvaluationJob 和 Artifact 应得到可解释、可重放的结果。

### 9.5 可选：公共镜像池接入

镜像池位于 `services/evaluator/src/image-pool.cjs`，按 Docker daemon 共享，不属于某个 Benchmark。接入包只声明需求，不另建空间预算或回收器，也不需要增加公共 API 路由。

1. 在 `evaluator.yaml` 增加 `imageProvider: ./images.cjs`。该 Node 模块随 Catalog 加载，在 Controller 内导出 `describeImages(payload, daemonArch)`，返回数组；可无镜像或一个 Case 多镜像。这里只解析/校验元数据，不执行拉取、Shell 或 Harness，也不引入 Runtime 专属依赖。
2. 每项包含 `{ key, arch, references, estimatedBytes?, context? }`。`references` 是经接入包校验的来源和回退顺序；`estimatedBytes` 是新增占用的保守估值，省略使用主机默认值；`context` 是 Runtime 所需安全元数据。命中本地镜像也须校验允许范围和架构。公共层按架构和来源列表合并在途请求，解析后按实际 image ID 合并归属和使用者，不按 Benchmark/case 名称合并。
3. 若需提前准备，Adapter 可增加 `imagePreparationInput(publicPayload, privatePayload)`，返回准备所需 JSON 或 `null`，不发送答案、测试补丁或完整私有载荷。平台在 Agent 下发前异步发送当前/下一个 Case 的元数据，Controller 使用同一个 `describeImages` 校验。此优化 hook 不替代五个必需业务 hook。
4. Controller 获取镜像后持久化使用者，把 `preparedImages` 交给 Runtime；任务目录的 `pool-images.json` 冻结身份。重试重新检查本地镜像，仅按冻结 digest 重拉；仅本地 image ID 消失时明确失败，不回退到新 `latest`。
5. 所有评测容器必须带 `agent-insight.evaluation-id` 标签，最终容器清理成功后 Controller 才释放使用者。OCI Runtime 同样带此标签及 `agent-insight.role=evaluator-runtime`；Runtime 内部清理不能删除自己，退出后由 Controller 兜底清理。清理或操作结果不确定时保留保护，不能用超时推断 Docker 操作已停止。

准备消息复用 `POST /api/v1/evaluations`：`{ operation: 'prepare-images', benchmarkKey, evaluatorKey, experimentId, revision, cases, requestDigest }`，`cases` 最多两个 Case；摘要覆盖其余完整消息。请求携带 `x-agent-insight-image-pool-token` 和 `x-agent-insight-request-digest`，双端密钥匹配后才接受。按 Benchmark/实验保存递增窗口版本，旧消息不能恢复旧窗口；空数组撤销该实验的准备。第一版信任单个平台服务身份，不增加用户配额或多平台协调。

后台准备不占评测执行槽，发送失败降级到按需准备；无镜像依赖的包不需要实现以上 hook。主机配置、空间口径、异常恢复及性能指标见[部署指南](./service-deployment-guide.md#53-可选跨-benchmark-共享镜像池)。

## 10. Presentation

Presentation 只控制公共前端的名称、顺序和有限格式，不能改变数据、校验或评测。

### 10.1 Case 表格和参考面板

- `caseTable.columns` 必须为 1～8 列；
- 路径只能是 `input`、`externalCaseId` 或嵌套 `values.*`；
- 类型支持 `text`、`code`、`number`、`boolean`；
- 格式支持 `plain`、`percentage`、`bytes`、`duration-ms`、`date-time`；
- 可选 `width` 范围 60～1200；
- 可选 `truncate` 范围 1～10000；
- `searchPaths` 使用同一组安全路径；
- 数据集详情、创建实验和实验详情使用同一公共取值逻辑。

私有字段不能进入 Presentation。数据集导入时会冻结字段快照，Manifest 后续变化不会静默修改已发布数据集。

### 10.2 Evaluator

`presentation.evaluator` 提供 `displayName/description/runMode/outputDescription`。这些是实例业务文案，公共 React 组件不应根据 Benchmark key 推断名称。

### 10.3 主指标

`presentation.result.primaryMetric.path` 当前固定为 `primaryMetric.value`。可以声明：

- `label`：Case 指标名称；
- `aggregateLabel`：趋势聚合名称；
- `trueLabel/falseLabel`：布尔文案；
- `format/precision/unit`：受控数字格式。

### 10.4 Artifact

`presentation.artifacts` 每项必须且只能按以下一种方式匹配：

- 精确 `source + name`；
- `source + kind`。

`source` 为 `submission` 或 `evidence`。规则只设置 `label/order`；前端匹配顺序是精确名称、类型、原始名称兜底。API 始终返回完整 `submissions[]` 和 `evidenceArtifacts[]`。

文本、JSON、Diff、图片和 PDF 使用公共预览器，其他媒体类型保留下载入口。不要把 HTML、JavaScript 或 React 代码放入 Presentation。

## 11. 错误与安全

错误要区分：

| 类别 | 示例 | 结果处理 |
|---|---|---|
| Case 不合法 | Schema、唯一标识、字段语义错误 | 拒绝导入 |
| Submission 不合法 | 缺文件、摘要错误、业务格式错误 | Case 业务失败或拒绝评测 |
| Evaluator 输出不合法 | Raw Result Schema、Evidence 不一致 | 评测失败，不发布伪结果 |
| 基础设施故障 | 超时、镜像、进程、网络、磁盘 | `failed`，不记 0 分 |
| 清理故障 | 主判定已产生但资源清理失败 | 保留主事实并记录 cleanup |

安全要求：

- 原始私有 Case 不发送给 Agent 或浏览器；
- 所有 Artifact 校验 Run 归属、大小、SHA-256 和真实字节；
- 文件名和相对路径必须防止目录穿越；
- 不接受 Manifest 或 Presentation 注入命令和前端代码；
- 不把凭据写进 Case、任务信封、日志、Evidence 或 `.env.example`；
- 网络开放必须来自明确业务需求和部署授权。

## 12. 测试与验收

### 12.1 Catalog

```bash
npm run benchmark:catalog
```

必须验证：路径不越界、key 唯一、Evaluator 匹配、资源一致、Artifact/能力一致、Schema 可读取、Presentation 合法，以及生成结果可重复。

### 12.2 Adapter 单元测试

```bash
node --import tsx --test benchmarks/<key>/tests/*.test.ts
```

至少覆盖：

- 合法和非法 Case；
- 公共/私有拆分及不可见性；
- Agent Task 不含隐藏数据；
- 缺失、篡改、超限和业务无效 Submission；
- EvaluationJob 上下文和资源；
- `completed/submission_invalid/failed` 三类归一化；
- 主指标类型、分数、评分点和 Evidence 一致性。

### 12.3 Evaluator Doctor 和 Smoke

Doctor 验证依赖可用性，Smoke 必须使用已知结果的最小样例穿过真实 Harness。Smoke 输出至少包含：

```json
{
  "purpose": "deployment_smoke",
  "evaluatorKey": "repository-quality",
  "succeeded": true
}
```

不要用仅返回固定成功的假脚本替代正式 Smoke。

### 12.4 公共一致性与回归

```bash
node --import tsx --test \
  test/benchmark-extension-conformance.test.ts \
  test/benchmark-presentation.test.ts \
  test/benchmark-experiment-wizard-ui.test.ts

npm run test
```

最后使用真实或脱敏 Case 完成：数据集安装、实验创建、Agent 执行、全部 Submission 上传、Evaluator 判定、Evidence 查看、重评和趋势展示。

### 12.5 验收矩阵

| 场景 | 必须观察到的结果 |
|---|---|
| 成功 Case | 正确 verdict、score、主指标、评分点和 Evidence |
| 业务未通过 | `done` + fail，不误报基础设施故障 |
| 无有效提交 | 明确“未生成有效提交物”或对应 Artifact 名称 |
| Artifact 被篡改 | 摘要或真实字节校验失败 |
| Evaluator 超时 | `failed`、可重试信息和清理事实 |
| 新增未配置 Evidence | 仍以原始名称显示和下载 |
| `evaluatorKey != adapterKey` | 自动绑定、重评和趋势均使用正确 Evaluator |
| 数字主指标 | `mean` 聚合和 Presentation 格式正确 |

## 13. 禁止事项

- 不在公共服务中判断 `adapterKey === '<benchmark>'`；
- 不在公共 React 组件中写死 Case 字段、提交物名称或指标；
- 不把 Gold 答案、隐藏测试或 Evaluator 命令发送给 Agent；
- 不用 Presentation 过滤、生成或校验 Artifact；
- 不让前端从 Evidence 猜测评分点；
- 不手工编辑 `generated/benchmark-catalog/`；
- 不把未注册能力写入 Manifest 后假设运行时会自动支持；
- 不以业务未通过代替基础设施故障，也不把基础设施故障记为 0 分。

## 14. 交付清单

- [ ] 客户确认《Benchmark 接入确认单》；
- [ ] `benchmark.yaml`、Case Schema、Raw Result Schema；
- [ ] Adapter 五个 Hook；
- [ ] Dataset Loader 和 Profile（如需要）；
- [ ] Evaluator Entrypoint、依赖或镜像构建文件；
- [ ] Doctor 和真实 Smoke；
- [ ] Presentation；
- [ ] Adapter、Evaluator 和公共一致性测试；
- [ ] 成功、业务失败、无提交和基础设施失败验收；
- [ ] 私有数据、路径、摘要、资源和日志安全检查；
- [ ] 用户指南、部署说明和版本要求；
- [ ] 浏览器验证数据集、实验、Case、Artifact 和趋势页面。

## 15. 参考实现

SWE-bench 是当前完整参考实例：

- [Manifest](../../../benchmarks/swe-bench/benchmark.yaml)
- [Adapter](../../../benchmarks/swe-bench/adapter/index.ts)
- [Evaluator 配置](../../../benchmarks/swe-bench/evaluator/evaluator.yaml)
- [Evaluator Entrypoint](../../../benchmarks/swe-bench/evaluator/entrypoint.cjs)
- [Case Schema](../../../benchmarks/swe-bench/schemas/case.schema.json)
- [Raw Result Schema](../../../benchmarks/swe-bench/schemas/result.schema.json)
- [Adapter 测试](../../../benchmarks/swe-bench/tests/adapter.test.ts)
- [部署 Smoke](../../../benchmarks/swe-bench/smoke/index.cjs)

参考它的目录和生命周期，不要复制它的 `model.patch`、Resolved、FAIL_TO_PASS、镜像或 Evidence 业务语义。新的 Benchmark 必须使用自己的实例代码表达这些差异。

客户侧的自然语言协作方式见[《自定义 Benchmark 接入指南》](./custom-benchmark-onboarding-guide.md)，三份文档的使用顺序见[《Benchmark 文档关系与开发指南》](./README.md)。
