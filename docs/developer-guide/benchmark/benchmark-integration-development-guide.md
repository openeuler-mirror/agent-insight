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

Loader 负责将 Profile 接受的文件或目录解析为原始 Case，不负责公开/私有拆分或业务校验；这些仍由 Adapter 完成。

`dataset.profiles` 声明变体、显示名称、`acceptedExtensions` 和可选预期数量。`acceptedSourceKinds` 可为 `file`、`directory` 或两者，省略时保持文件模式；仅接受目录时 `acceptedExtensions` 可为空。可选 `version` 标识来源契约版本，通用已安装检查会严格匹配，避免复用不同契约的数据。声明 Loader 时必须同时声明至少一个 Profile。

手动安装命令：

```bash
npx tsx scripts/benchmark/install-dataset.ts \
  --benchmark <key> \
  --profile <profile> \
  --source <dataset-file-or-directory> \
  --name <display-name>
```

目录来源按解析后的 Case 规范化内容计算指纹，文件来源保留文件字节摘要。目录不得使用导入后删除来源选项。

ZSoft 的 `sourceTaskDigest` 专门对原始 `task.json` 对象与 `public/` 文件字节摘要清单计算 SHA-256，键按固定 Unicode 字符顺序序列化；平台导入与 Node Provider 共用 `source-identity.cjs`，与 Python 冻结端保持一致，不复用通用协议中基于 `localeCompare` 的 JSON 排序。跨语言测试须包含多文件、大小写、标点和数字字符串键。只在实际资产及公开元数据全部验证通过后识别旧排序摘要，并以 `ZSOFT_TASK_DIGEST_LEGACY` 拒绝，不接受任意历史哈希；管理员显式导入新名称的数据集并新建实验，不静默改写冻结身份。通用请求摘要规则不变。

### 7.1 Dataset Preparer

需要在线自动获取或离线复用来源时，在接入包实现：

```ts
export interface BenchmarkDatasetPreparer {
  profileKey: string
  prepareSource(): Promise<{ sourcePath: string; name?: string }>
}
```

在 `implementation` 中注册（以下字段为可选扩展）：

```yaml
datasetPreparer: ./dataset/prepare.ts
datasetPreparerExport: repositoryQualityDatasetPreparer
```

Catalog 自动生成 `dataset-preparers.ts` 和 `dataset-preparer-keys.cjs`；Loader 与 Preparer 源文件均参与接入包内容摘要。包内准备器负责官方来源、固定版本、缓存和依赖准备，返回文件或目录路径；公共服务 `ensureBenchmarkDataset` 负责查询数据库、调用准备器和统一安装，不包含 Benchmark 专属下载逻辑。

统一准备入口为 `npx tsx scripts/benchmark/ensure-dataset.ts --benchmark <key>`。`scripts/start.sh` 按项目 YAML 配置自动准备 SWE-bench，不再接受 `--benchmark`；其他接入包通过统一准备入口独立安装。数据库已存在当前 Profile 版本且未指定 `--refresh` 时，跳过全部来源访问与本机准备依赖。显式刷新仍遵守实验数据冻结：已引用的数据集不能覆盖，可指定新 `--name` 安装另一版本。

数据准备运行在平台机器；执行客户端只读取本机任务环境；Evaluator 按评测请求携带的身份/版本匹配自己部署的资产，不访问平台数据库或平台本机路径。镜像准备与数据导入可以独立进行。

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

部署入口 `scripts/evaluator.sh start` 只启动通用 Controller，不接受 Benchmark 选择、Runtime 预热或应用层鉴权参数。Controller 收到任务后，才根据 `benchmark.key + evaluator.key` 从 Catalog 解析并准备对应 Runtime；相同内容摘要的镜像直接复用。Agent Insight 与 Controller 之间不发送或校验 Bearer Token，部署者必须使用白名单、安全组或防火墙限制双向访问。这里的服务互访边界与 `evaluator.yaml` 的 `network` 不同：后者只约束实例 Runtime 执行评测时的容器网络策略。

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

Entrypoint、Smoke 和 Dockerfile 必须位于接入包内。Catalog 按接入包内容摘要生成 Runtime 镜像 tag，并在运行时校验镜像 label；发布方可用 `node scripts/benchmark/build-evaluator-runtime.cjs <key>` 构建该制品，增加 `--image-prefix registry/namespace --push` 可上传到指定仓库。SWE-bench 和 ZSoft 均在本地镜像缺失时先拉取，拉取失败后按接入包 Dockerfile 自动构建；后续调用复用摘要匹配的镜像。声明 `requiresPrebuiltRuntime: true` 的接入包禁止该回退，本地引用必须预装，远程引用允许按需拉取。运行依赖归接入包制品所有，不要加入通用 Controller 基础依赖，也不要在 Controller 公共代码中加入 Benchmark 分支。

接入包可选声明 `assets`：`image` 必须为固定 `repository@sha256`，同时声明镜像内 `sourcePath`、`releaseId`、`bundleDigest`、可选部署目录变量名 `directoryEnv`、`verifyCommand`（`python3` 或 `node`）及包内 `verifyEntrypoint`。Controller 在启动后台准备资产，调用校验器时依次传入目录、release ID、bundleDigest。校验器只读取文件与元数据，不执行 Judge 或构建任务。

通用安装器按镜像摘要创建版本目录，拉取后从未启动容器复制、校验，再原子发布；并发请求共享准备状态，重启重新校验缓存。默认存储根为 `<EVALUATOR_DATA_DIR>/benchmark-assets/<benchmarkKey>`；配置 Schema 注册了 `benchmarks.<key>.assetsDir` 的接入包使用该 YAML 字段，`null` 使用默认根目录，不再回退旧目录变量。未注册此字段的其他接入包仍可使用 `directoryEnv`。实际目录仍追加摘要。OCI 资产必须在 Controller 与 Runtime 共享卷内。Provider 的第三个参数 `assetsDir` 和 Runtime 环境 `EVALUATOR_ASSETS_DIR` 均为该接入实际解析出的版本目录，不从任务 payload 获取，也不修改全局环境变量。

准备期间 admission 返回可重试的 `EVALUATOR_ASSETS_PREPARING`、`EVALUATOR_ASSETS_DOWNLOADING` 或 `EVALUATOR_ASSETS_VERIFYING`；安装失败返回不可重试的具体错误。健康检查通过 binding 的 `runtimeFacts.assetStage/assetErrorCode` 暴露状态，平台在健康检查和下发响应两条路径均保留错误及详细原因。没有声明资产的接入包不增加准备流程，公共 Controller 不含 ZSoft 分支。

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

`rawResult` 必须符合 `schemas/result.schema.json`。Evidence 的 `name` 可以是安全、唯一的相对路径（如 `judge-evidence/vuln-result.json`），总长不超过 512、最多 16 段，每段匹配 `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`；禁止绝对路径、空段、反斜线和 `.`/`..`。`path` 及其真实文件路径必须位于输出目录。证据支持零字节日志，单文件仍限制 64 MiB；提交物的非空要求不变。平台按 Artifact ID 存储文件，保留原相对路径用于前端可展开目录与证据包，不直接将其作为落盘文件名。每个实际产生的 Evidence 都应返回，不能因 Presentation 未配置而丢弃。

### ZSoft 官方评测证据

ZSoft 不再把平台的任务哈希摘要作为官方报告。独立工作目录内的官方 `evaluation.json`、`record.json`、`evaluator.{stdout,stderr}.log`、`cleanup.{stdout,stderr}.log` 原字节复制；`judge-evidence/` 和 `public-feedback/` 递归保留全部普通文件及相对目录，并提供 `official-output.zip`。不导出 `context.json`、`compose.env`、提交物副本、隐藏判题源码或其他工作文件。拒绝符号链接、特殊文件及越界路径。

成功结果必须有官方报告和执行记录；Adapter 核对任务、提交物摘要/大小、final 阶段、清理/超时状态以及报告和执行记录的最终判定、summary、checks、details。最终评分仍来自官方执行记录，原始报告不会被平台改写。旧版单个摘要 `report.json` 仍按原契约校验，历史实验需重评才能获得新证据。

失败、超时和清理失败均收集已产生的官方输出，不清空证据。缺失文件和采集错误记录在 `runtimeFacts.evidenceCollection`；不存在的文件不生成占位报告。异常或未写完的 JSON 以二进制类型上传原字节，仍可查看原文，避免 JSON 解析错误阻止整个失败回调。单次收集最多 1024 个文件、总大小 256 MiB，单文件及 ZIP 不超过 64 MiB；不安全文件或超限时明确标记采集失败、不静默截断，已安全收集的文件仍保留。

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

1. 在 `evaluator.yaml` 增加 `imageProvider: ./images.cjs`。该 Node 模块随 Catalog 加载，在 Controller 内导出 `describeImages(payload, daemonArch, { assetsDir })`，返回数组；可无镜像或一个 Case 多镜像。这里只解析/校验元数据，不执行拉取、Shell 或 Harness，也不引入 Runtime 专属依赖。
2. 每项包含 `{ key, arch, references, estimatedBytes?, context? }`。`references` 是经接入包校验的来源和回退顺序；`estimatedBytes` 是新增占用的保守估值，省略使用主机默认值；`context` 是 Runtime 所需安全元数据。命中本地镜像也须校验允许范围和架构。公共层按架构和来源列表合并在途请求，解析后按实际 image ID 合并归属和使用者，不按 Benchmark/case 名称合并。
3. 若需提前准备，Adapter 可增加 `imagePreparationInput(publicPayload, privatePayload)`，返回准备所需 JSON 或 `null`，不发送答案、测试补丁或完整私有载荷。平台在 Agent 下发前异步发送当前/下一个 Case 的元数据，Controller 使用同一个 `describeImages` 校验。此优化 hook 不替代五个必需业务 hook。
4. Controller 获取镜像后持久化使用者，把 `preparedImages` 交给 Runtime；任务目录的 `pool-images.json` 冻结身份。重试重新检查本地镜像，仅按冻结 digest 重拉；仅本地 image ID 消失时明确失败，不回退到新 `latest`。
5. 所有评测容器必须带 `agent-insight.evaluation-id` 标签，最终容器清理成功后 Controller 才释放使用者。OCI Runtime 同样带此标签及 `agent-insight.role=evaluator-runtime`；Runtime 内部清理不能删除自己，退出后由 Controller 兜底清理。清理或操作结果不确定时保留保护，不能用超时推断 Docker 操作已停止。

准备消息复用 `POST /api/v1/evaluations`：`operation=prepare-images` 可下发 `revision + windows[]` 全服务窗口快照，兼容原有单实验窗口消息；总 Case 数不超过服务评测并发加 1。摘要覆盖完整消息，请求携带 `x-agent-insight-request-digest`，不再配置专用准备令牌。Controller 校验摘要与递增窗口版本，旧消息不能恢复旧窗口；空数组撤销准备。Evaluator 端口仅向平台开放，不增加用户配额或多平台协调。

Image Provider 可抛出带 `code/status=422/retryable=false` 的确定性元数据错误，由通用 Entrypoint 转为协议错误。完整预取快照仅排除出错 Case，其余 Case 的镜像与窗口继续发布；入场检查在窗口选择之前再次验证元数据并返回 HTTP 422，使平台结束该 Case 的等待。暂态和未知错误不被吞掉，资产未就绪等可重试状态仍按原协议处理。

后台准备不占评测执行槽。重评创建新 Evaluation 后先尝试刷新窗口再下发评测；收到 `IMAGE_POOL_PREPARING` 时也刷新窗口，避免只重试评测而未触发准备。准备请求失败保留评测队列，后续重试及评测 watchdog 定期补偿。执行 watchdog 在启动恢复前注册，历史实验恢复逐条隔离异常，避免单条已取消任务阻断后续恢复或后台调度。无镜像依赖的包不需要实现以上 hook。主机配置、空间口径、异常恢复及性能指标见[部署指南](./service-deployment-guide.md#53-可选跨-benchmark-共享镜像池)。

首次评测与重评共用 `evaluation-scheduler` 的服务容量与单用户配额；重评不设全平台单独并发上限。服务容量读取 `/health.maxConcurrency`，单用户配额通过 `config/benchmark/platform.local.yaml` 的 `benchmarks.scheduling.maxEvaluationConcurrencyPerUser` 限制。相同 Case 的重评使用进程内锁及数据库 Run 状态、`updatedAt` 条件更新认领，防止并发请求重复创建 attempt；不同 Case 可独立入队。

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

MCTS 的本地采集器从失败 HTTP 响应、`turn_failed`/带错误的终态与失败工具结果提取固定诊断码，写入本次 `runtime-ledger.json`。输出截断的失败工具事件不受普通观察队列背压丢弃；未恢复的诊断可将表面成功的 turn 标为错误。同轮后续成功写入不保留已恢复的截断状态，空补救轮次不会擦除先前证据。执行器仅在 `MCTS_RUN_FAILED` / `AGENT_NO_OUTPUT` 时读取本次有界 ledger，并结合进程错误，将 `MCTS_LLM_INSUFFICIENT_BALANCE` / `MCTS_LLM_OUTPUT_TRUNCATED` 的固定中文说明透传至现有失败回调；同时保留根 Trace、原异常 cause 和诊断码，不覆盖取消、超时或提交物校验错误。无需新增路由或修改外部 MCTS/xGovernor；上游完全未暴露的余额错误不能靠文件 404 推断。部署需同步更新客户端运行时、采集器自包含安装包与 standalone 文件追踪清单。

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

Catalog 目录扫描排除 `__pycache__/`、`*.pyc`、`*.pyo` 和 `.DS_Store`，这些运行缓存不参与包摘要、Runtime 摘要或执行器文件清单。真实源码、依赖配置与评测资产仍参与原有摘要计算；新增或修改缓存不应改变生成物，修改真实输入必须更新对应摘要。

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

### ZSoft 接入前的本机验证

`scripts/benchmark/zsoft-preflight.py` 与 `scripts/benchmark/zsoft-validate.py` 用于接入前的环境和原生判题验证；它们尚未注册平台 Benchmark，也不运行 MCTS、模型或 E2B。ZSoft 源码和 Python 依赖应使用独立目录与虚拟环境。需要 Docker Compose；内核题还需宿主编译工具、libelf/OpenSSL 开发文件及锁定源码。没有 `/dev/kvm` 时使用 TCG，实际能否满足判题超时必须由对照验证确认。

在 Linux 评测机设置自己的源码、虚拟环境与输出路径后执行：

```bash
python3 scripts/benchmark/zsoft-preflight.py \
  --mcts-root "$MCTS_ROOT" --work-root "$VALIDATION_ROOT" \
  --bench-root "$ZSOFT_ROOT" --zsoft-bin "$ZSOFT_BIN" \
  --run-container-smoke --output "$VALIDATION_ROOT/preflight.json"

python3 scripts/benchmark/zsoft-validate.py \
  --bench-root "$ZSOFT_ROOT" --binary "$ZSOFT_BIN" \
  --framework-revision "$ZSOFT_REVISION" \
  --output-dir "$VALIDATION_ROOT/p0"

python3 scripts/benchmark/zsoft-validate.py \
  --bench-root "$ZSOFT_ROOT" --binary "$ZSOFT_BIN" \
  --framework-revision "$ZSOFT_REVISION" \
  --output-dir "$VALIDATION_ROOT/p1" --prepare \
  --task libxml2-002-relaxng-pushcdata-oob \
  --task linux-rxrpc-024-add-key-roundup-oob
```

`ZSOFT_REVISION` 必须为所部署框架的完整提交哈希；脚本记录此值，部署者仍需核对源码来源。正式源码先由上游 `zsoft-poc fetch-sources --task-id TASK_ID` 缓存。若 Compose 安装在独立目录，需要将相应 `DOCKER_CONFIG` 传给上述命令，并将 ZSoft 虚拟环境的 `bin` 加入 `PATH`，供题目子进程导入框架。

不带 `--task` 时只做 P0：冻结 30 道正式题的 manifest、source lock 和控制提交摘要，调用上游导出器逐题检查公开文件清单与内容，不执行判题。`inventory.json` 不代表全部源码缓存已通过上游 `validate --strict`。带 `--task` 后运行 P1；`--prepare` 会按上游逻辑构建镜像及内核资产，需预留磁盘和编译时间。输出目录必须不存在，避免覆盖先前证据；同一题不要并发 prepare。

P1 通过要求 reference 为 `completed/success=true`、negative 为 `completed/success=false`，两者均保留 `submission_kind=final` 的完整私有记录，并检查本次新增 Compose 容器和网络是否清理。基础设施故障不能当作 negative 通过。结果、命令日志、镜像 ID 和内核资产摘要写入输出目录；这些私有验证记录不能交给执行 Agent。验证期间应避免其他任务并发创建 Compose 资源，以免剩余资源检查受到干扰。

独立 `zsoft-validate.py` 同样通过 Node.js 配置加载器读取 `evaluator.local.yaml` 的 `benchmarks.zsoft-l1.kernelAccel`，并在调用官方 CLI 时内部转换为框架环境；不再读取旧用户加速变量。需提供 Node.js，配置错误在创建验证输出目录前报错。


### ZSoft 自动生成 PoC 的执行契约

`zsoft-l1` 从官方目录导入 userspace 与 kernel Case，私有身份字段为 `sourceTaskDigest` 和可选 revision。旧 P2 JSON/JSONL 不再接受，也不需要 `agentBundle.digest`。实验向导只选择数据集和执行目标；平台不持久化任务目录，也不扩展 `/api/benchmark/v1/execution-targets` 配置接口。平台按所选 Case 将 `taskId` 放进 `zsoft-tasks` workspace 契约。执行客户端从其 MCTS 仓库 `testcases_union/config.env` 读取 `ZSOFT_TASKS_DIR`，并通过 `zsoft-tasks-workspace/v3` 从 `<ZSOFT_TASKS_DIR>/<taskId>` 准备独立公开工作区，复制 `public/` 和裁剪元数据；随后 MCTS 在隔离工作区使用其中的 `tasks/`。缺少或非法目录配置返回 `ZSOFT_TASKS_DIR_INVALID`；缺题返回 `ZSOFT_TASK_MISSING`；公开元数据不一致返回 `ZSOFT_TASK_MISMATCH`。内核题映射为 C 提交，与 userspace 互斥标记轨道。ZSoft 只接受原生任务目录工作区，不再回退历史公开包。

普通 Agent 使用 `single-file/v1` 收集固定的 `submission/poc`。MCTS 使用平台 Shell/Python 桥接，传入 `--mode zsoft`、`--runtime`、`--task-id` 与独立输出目录；ZSoft 插件不接受 SWE 专用的 `--testbench`、`--instance-id`、`--split`，平台不会传入这些参数。桥接替换最终官方判题回调，仅导出所选 PoC 原始字节，并阻止本地/远端正式 judge 入口。Python、C、binary 分别使用插件内部文件名 `poc.py`、`poc.c`、`poc`，平台产物统一为 `poc`。

`ZsoftTasksWorkspaceProvider` 优先使用原生 `public/repo-vul`；缺少时通过 `zsoft-source.cjs` 有界读取任务的 `private/source-manifest.json` 和 `<tasks-dir>/../source-locks/<source-id>.json`，校验路径、普通文件、源码 ID、一致性、无凭据且可安全交给 Shell 的公开 HTTP(S) URL 与固定版本。只在新工作区生成 `{source_id}` 及 `{source_id,kind,url,commit?,sha256?}`，未知字段不复制，不放宽 `validatePublicPath`。这两个控制文件仅供宿主 MCTS 读取；缺少或非法来源分别返回 `ZSOFT_SOURCE_MISSING`、`ZSOFT_SOURCE_INVALID`。现有公开源码不读取私有来源，原始公开文件与数据集指纹不变。

`mcts-zsoft-source.py` 提供无宿主缓存的沙箱下载步骤：归档有 SHA-256 时先校验再解压，Git 使用固定提交 shallow fetch 并核对 HEAD，不采用移动 ref。平台桥接替换 MCTS 的 `_download_script`，静态接口预检同时覆盖 materializer 文件与 `bundle_bytes`。每次 `bundle_bytes` 返回前，对 gzip tar 只读检查：文件集合与准备好的公开树、裁剪元数据及 README 派生文本完全匹配，逐文件大小和 SHA-256 相同，拒绝重复/越界名称、额外文件、链接和特殊文件，并限制数量、总大小。控制文件或判题文件混入返回 `ZSOFT_AGENT_BUNDLE_INVALID`，不进入沙箱上传。控制文件随工作区清理；不更新数据库、API 或评测侧资产。

MCTS 输出 `platform-export.json`（`mcts-poc-export/v1`），包含 `taskId`、`submissionKind`、`evaluation: deferred` 和 `mctsContract`（版本 `mcts-zsoft-contract/v1`、源码 SHA-256、支持的提交类型）。静态接口预检检查调用签名、注册点、CLI 和提示文件；桥接启动时再次检查摘要，运行器核对导出摘要与启动前的契约一致。运行器核对公开任务元数据、导出身份、类型和题目大小限制，拒绝符号链接，成功取得唯一根 Trace 后复制到 `submission/poc`。正式结果来自平台 ZSoft Evaluator，不采用 MCTS 回调布尔值。

桥接按提交类型适配任务消息和五个系统角色提示，提示副本写在公开工作区内；题目原文及公开 README 保留。C 要求提交源码，binary 要求按公开架构/ABI 编译并提交原始字节；两者不使用内置 Python preflight，候选验证仍依赖公开契约和生成的 `verify.py`。binary 的候选读取器提供长度和 SHA-256 摘要，避免 UTF-8 解码二进制；这不能替代执行证据或正式判题。

ZSoft 的 MCTS 目标需额外就绪能力 `mcts-zsoft-export/v1`。公共依赖不含 SWE 的 `datasets` 和启动脚本；SWE 另行检查这些依赖，新客户端声明 `mcts-swe-bench/v1` 时该能力必须就绪，未声明的旧客户端沿用原规则。上传、取消、工作区清理和恢复继续复用通用执行器状态机；上传失败前先持久化产物，恢复上传不会重跑搜索。MCTS 输出及 Trace 位于外部 MCTS 仓库的运行输出目录，沿用现有 MCTS 的保留策略，公开工作区由通用清理器移除。

执行链路目前以合成数据、伪插件和伪运行器验证。此前 userspace Case 镜像已在 119 构建发布；本轮内核适配没有执行内核编译、ZSoft 官方验证、实际 PoC 或真实判题。

### ZSoft 公有镜像与冻结资产

ZSoft 接入包声明 `imageProvider: ./images.cjs`。Adapter 的 `imagePreparationInput` 提供题目 ID、大小/提交类型、官方题目内容摘要 `sourceTaskDigest` 与可选 revision，支持统一镜像窗口预取；Controller 按同一 payload 准备实际评测镜像。Provider 核对题目内容摘要和请求中存在的 revision，并校验评测机本地冻结清单后生成引用，不接受任务直接指定任意镜像。

`zsoft-assets/v1` 新增可选 `tasks[taskId].registryImages`，键与 `images` 完全一致，值为公有仓库的固定 `repo@sha256`；该字段参与 task/bundle 摘要。原 `images` 保存 Docker config Image ID。公共镜像池冻结 `preparedImages`，Python 入口核对题目 key 与实际 Image ID，Compose 代理使用固定 ID 和 `pull_policy=never`。未配置 `registryImages` 的当前清单要求本地已装镜像；缺少 `sourceTaskDigest` 的旧清单不再支持。平台题目身份与评测机私有资产构建摘要分别管理，Evaluator 不连接平台数据库。

Runtime 发布与解析共用 `services/evaluator/src/runtime-image.cjs`。构建端可使用 `--image-prefix`，Controller 配置 `EVALUATOR_RUNTIME_IMAGE_PREFIX`；显式 `--push` 才上传。ZSoft 默认复用本地 Runtime，缺失时尝试 pull，失败后自动 build，仍核对 Catalog artifact 标签。本部署方案将 Case 镜像和完整冻结资产镜像上传公有 SWR；Controller 启动后自动安装资产，自动构建 Runtime 不会重新构建题目环境。镜像池保持公有匿名 Docker API 拉取，不读取宿主 `docker login` 凭据。完整环境准备、发布和安装命令见 [ZSoft 部署指南](zsoft-deployment-guide.md#zsoft-镜像准备与公有-swr-部署)。

内核题复用同一个 ZSoft Evaluator Runtime、任务协议和结果归一化。接入包将 `runner_image` 交给通用镜像池；`.task-state/<task-id>/{vuln,fix}/artifacts/` 中的 `bzImage`、metadata 和模块作为独立的冻结文件资产，按流式 SHA-256 校验，不作为 Docker 引用。资产打包支持合并同官方 revision、同框架摘要的冻结快照，评测机始终不访问数据库。

ZSoft 平台配置为 `benchmarks.zsoft-l1.dataset.{autoImport,source,revision}`，`autoImport` 默认 `true`，其余默认 `null` 使用接入包固定的官方来源与版本。`start.sh` 在数据库同步后顺序调用 SWE-bench 和 ZSoft 的 bootstrap；共用日志与非阻塞失败处理，分别按 YAML 开关跳过或调用准备入口。ZSoft 调用 `ensure-dataset.ts --benchmark zsoft-l1`，先复用已安装数据集；失败只警告，日志为 `<AGENT_INSIGHT_HOME>/logs/zsoft-l1-bootstrap.log`，下次启动重试。这里的非阻塞失败指不阻止后续启动，准备本身仍同步等待。关闭开关不影响管理员手动调用或显式刷新。评测配置为 `benchmarks.zsoft-l1.assetsDir`（默认 `null`）和 `kernelAccel`（默认 `tcg`，可选 `kvm`）；旧四个 ZSoft 业务变量仅提示迁移、不再生效。Controller 向 Runtime 传递校验后的 `AGENT_INSIGHT_EVALUATOR_CONFIG_JSON` 快照，Python 从该快照读取加速模式，不直接解析 YAML 或读取旧用户变量。MCTS 的 `ZSOFT_TASKS_DIR` 不属于平台业务配置，保持原契约。

平台 Judge 所在 Runtime 不挂 KVM 设备，官方 Judge 的配置阶段仍通过内部环境注入 TCG；受控 Compose 代理向实际 runner 设置 YAML 选定的 `KERNEL_ACCEL`，KVM 模式只开放 `/dev/kvm:rw`。实际评测在已准备的 runner 镜像中检查宿主机 KVM API，失败返回基础设施错误。资源预算按两服务分摊，并在启动前校验每版内核声明的 CPU、内存及 512 MiB 额外内存；提交编译失败保持 `submission_invalid`，超时、取消和容器/网络清理复用已有路径。doctor 校验资产、轨道和加速配置，不在冷缓存时拉镜像或启动 QEMU；KVM 可用性在实际评测前检查。
