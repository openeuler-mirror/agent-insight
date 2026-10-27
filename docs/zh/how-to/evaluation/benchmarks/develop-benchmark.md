---
title: "Benchmark 接入开发规范"
description: "规定 Benchmark 接入包的目录、数据契约、适配器和验证流程，指导开发者实现可运行的评测集成。"
keywords: ["Agent Insight", "Benchmark", "接入开发", "数据契约", "评测适配器"]
changefreq: monthly
---

# Benchmark 接入开发规范

> 面向 AI 编码 Agent 和 Benchmark 接入开发者。当前协议版本：`execution-environment/v1`、`agent-task/v1`、`benchmark-evaluation/v1`。

## 1. 目标与非目标

本规范定义如何把一个具体 Benchmark 实现为可安装接入包：

```text
自然语言需求
  → 需求发现与确认单
  → benchmarks/<key> 接入包
  → Catalog 校验
  → 数据集安装
  → 按数据集与所选 Agent 检查、准备执行环境
  → Agent 执行与 Submission
  → Evaluator 判定与结果归一化
  → 公共前端展示
```

接入采用“公共框架 + Benchmark 实例实现”：

- 公共平台负责任务状态机、执行目标匹配、Artifact 传输、评测调度、结果保存和统一页面；
- Adapter 负责具体 Benchmark 的 Case 拆分、任务构造、提交校验、评测请求和结果归一化；
- 接入包内的执行端环境模块负责按数据集与所选 Agent 声明、检查和准备本次运行要求；
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
- 各 Agent 的执行环境要求、可自动准备项、需用户配置项及耗时动作；
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

确认后按顺序完成：Schema → Manifest → Adapter → 执行端环境模块 → Evaluator → Dataset Loader → Presentation → 单元测试 → Smoke → 端到端验收。

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
├── executor/
│   └── environment.cjs         # 执行环境检查与准备，按所选 Agent 判断
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
  environmentPreparation:
    protocol: execution-environment/v1
    implementation: ./executor/environment.cjs
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

### 5.5 执行环境准备协议

执行环境准备以数据集为入口，判断依据是本次选择的数据集版本、Case、主机、Agent、模型、执行方式和实验参数。同一数据集可以因所选 Agent 不同而需要不同环境；同源数据集共用接入实现，不为每个数据集记录复制代码。

Benchmark 的实现放在 `benchmarks/<key>/executor/environment.cjs`，属于接入包协议的一部分，独立于平台侧 Adapter 的五个业务 Hook。普通数据集和可靠性数据集使用相同方法合同，通过公共注册入口加载，不需要实现 Benchmark 评测协议。新增 Benchmark 应在上述 Manifest 字段中声明此入口；旧接入包未声明时不会自动获得环境准备能力，客户端找不到对应实现会提示更新，不会退回普通数据集检查并报告就绪。

#### 方法与上下文

模块使用 CommonJS，导出两个异步方法：

```js
module.exports = { checkEnvironment, prepareEnvironment }

// 只读检查，返回 { issues: [{ code, message }], prepare: string[] }
async function checkEnvironment(context, services) { /* ... */ }

// 执行自动准备；正常完成即可，最终是否就绪由复查决定
async function prepareEnvironment(context, services, reportProgress) { /* ... */ }
```

`context` 来自平台校验后的选择快照，字段以 [`EnvironmentContext`](../../../../../packages/benchmark-protocol/environment.d.cts) 为准：

| 字段 | 含义 |
|---|---|
| `protocol` | 固定为 `execution-environment/v1` |
| `clientId` | 本次执行主机 |
| `dataset` | `id`、`adapterKey`、`revision`、`caseIds`、`faultTypes` |
| `platform` / `agent` | 选定 Agent Runtime 与 Agent |
| `model` / `agentOptions` | 所选模型及可选 Agent 参数；原生默认模型可不指定具体名称 |
| `experiment` | `mode`、`timeoutSeconds`、`concurrency` |

上下文只传公开选择与配置，不传 API Key、隐藏测试或私有评测数据。模型凭据由执行机本地配置解析。

`services` 由通用执行器注入，提供 Agent、沙箱、故障注入、MCTS 等已有检查与准备能力。接入模块组合这些能力，并按 `context` 选择要求；公共编排服务和前端不判断 Benchmark 名称。新增可复用的环境能力时先扩展公共服务，再由接入模块调用。

#### 检查结果与编排

| 返回内容 | 通用执行器行为 |
|---|---|
| `issues` 非空 | 返回 `needs_action`，提示用户配置；本轮不执行自动安装 |
| `issues` 为空、`prepare` 非空 | 调用一次 `prepareEnvironment`，然后重新检查 |
| 两个数组均为空 | 返回 `ready` |
| 准备抛错，或复查后仍有待准备项 | 返回失败，可再次点击“下一步”重试 |

`issues` 表示需用户处理的问题，例如缺少模型 API 配置、Docker 权限或系统构建工具；`message` 应说明去执行机处理什么，不输出凭据或原始安装日志。`prepare` 是接入模块内部的待准备项标识，例如 `sandbox`；通用执行器仅据其是否为空决定是否调用准备方法，不把它当作远程命令。

检查必须只读，不能在检查方法中下载、编译或安装。准备方法应能重复调用并复用已满足的环境，通过公共服务复用安装锁与版本校验；只准备当前数据集和所选 Agent 需要的组件，不因其他 Runtime 缺少组件阻断本次实验。无需自动安装的接入也应导出准备方法，此方法不会在 `prepare: []` 时调用。

普通检查和任务恢复均不调用或等待 `refreshCapabilityReports` 全量扫描。公共环境服务复用本轮已验证事实，增量上报所选平台与相关 Profile；可靠性检查只读取所选 Agent 的 FI 适配及数据集需要的故障定义，不枚举其他平台或完整模型目录。Profile 身份变化时，未检查 Runtime 不沿用旧身份下的就绪状态。客户端启动、定时和手动全量刷新保留独立运行。

下面以 SWE-bench 的现有接入为例，按实际执行绑定选择检查方式：

```js
async function checkEnvironment(context, services) {
  const binding = services.executionBinding(context)
  if (binding?.backendKey === 'xgovernor') return services.checkSandbox(context, binding)
  if (context.platform === 'pi-mcts') return services.checkMcts(context, 'swe-bench')
  return { issues: await services.checkAgent(context), prepare: [] }
}

async function prepareEnvironment(context, services, reportProgress) {
  const binding = services.executionBinding(context)
  if (!binding || binding.backendKey !== 'xgovernor') throw new Error('所选执行方式没有自动准备操作')
  await services.prepareSandbox(context, binding, reportProgress)
}

module.exports = { checkEnvironment, prepareEnvironment }
```

#### 进度与前端约定

准备方法通过 `await reportProgress({ state: 'preparing', durationHint? })` 上报进度，不自己生成前端文案：

| `durationHint` | 使用时机 | 前端准备提示 |
|---|---|---|
| 不传 | 普通自动准备 | 正在准备运行环境 |
| `first_install_minutes` | 确实开始首次耗时安装或编译 | 正在准备运行环境，首次可能需要几分钟 |
| `minutes` | 其他确实需要数分钟的准备动作 | 正在准备运行环境，可能需要几分钟 |

只有进入实际耗时动作才报告耗时提示，不能因为选择了某个数据集或后端就预先报告。通用执行器负责 `checking → preparing → checking → ready / needs_action / failed` 的任务状态，接入模块不得跳过复查直接报告就绪。

前端在实验向导第二步 Trace 来源点击“下一步”时触发检查。已满足时直接进入下一步；自动准备时只在底部按钮上方提示并锁定配置；需人工处理时在同处提示，用户配置后再次点击“下一步”重新检查。切换配置后使用新上下文，旧检查结果不复用。仅使用已有 Trace、无需运行 Agent 的流程跳过此环节。

恢复尚未完成的任务时先查询其状态；缓存任务已结束则重新检查当前组合。任务不存在、过期或上下文冲突时清除失效引用，下一次点击可提交新请求；网络状态不明时保留请求标识保证重试幂等。检查结束刷新候选列表后，必须仍使用刚检查的主机与 Agent，不能自动切换到列表第一项并放行。ACK 使用原有短期限，不能等待整个安装期限；数据集版本或主机健康变化后，旧就绪结果失效。

#### 分发与阶段边界

Catalog 校验协议和包内 `.cjs` 入口，并将执行端文件纳入接入包内容摘要与分发清单；客户端加载时校验两个方法是否存在。环境准备入口不依赖 `gitSourcePolicy`。发布安装包必须带上 `generatedEnvironmentPreparationDescriptors` 和对应 executor 文件，不能只在源码仓库中可用。新接入不需要在公共平台或前端增加 Benchmark 专属分支。

此环节准备执行主机的共享运行环境；Case 工作区、Case 容器等仍由执行后端按任务生命周期管理。它也不同于第 7.1 节的平台数据集来源准备，以及 Evaluator 的评测 Runtime 准备。客户端安装只完成客户端及链路跟踪接入，保存配置上下文，不提前编译本次实验可能用不到的执行后端。

通用实现见 [`services/executor/src/environment/`](../../../../../services/executor/src/environment/)，完整设计见[实验执行环境准备](../../../../../design/evaluation/experiment-environment-preparation/phase2-requirements-design.md)。

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

#### 执行后端与能力

执行环境可通过可选 `AgentTaskEnvelope.execution` 表达冻结的公开 Profile、OCI 镜像引用、架构与工作目录。当前 SWE-bench Adapter 仅依据公开 `instanceId` 和选定架构生成官方镜像规格，仍保留原有 Git 基线与提交契约。只有声明 `execution-backend/v1` 且 Profile/Runtime 就绪的客户端可接收这种任务；现有 `agent-task/v1` 未升级为全局必需环境，不影响其他目标。

客户端 `ExecutionBackendRegistry` 按 `backendKey` 选择 `prepare/runAgent/collect/cancel/close/recover` 六方法实现。Runner 仅保存不透明句柄，统一处理阶段期限、产物落盘、上传重试与清理恢复，不解析后端目录或 session。已有工作区/运行时/策略组件由 `LocalExecutionBackend` 包装；`XGovernorExecutionBackend` 负责每 Case daemon、Docker、Runtime 会话、Patch 与完整 Trace 导出。

实验 Agent 列表区分当前就绪与可准备：就绪目标进入 `benchmarkKeys`，在线、健康且支持 `PREPARE_EXECUTION_ENVIRONMENT` 的目标进入 `preparableBenchmarkKeys`；后者即使缺少组件也允许在主机选项中选择。原因仍由 `benchmarkUnavailableReasons` 返回。第二步点击下一步才触发检查；安装后刷新客户端能力，再使用最终 Profile 冻结实验。`executionProfiles.targetReadiness` 按 platform 返回检查结果，选择一个 Runtime 不会因另一个 Runtime 缺少组件而被阻止；未安装执行后端也不影响已就绪的普通 Agent 执行能力。

#### 执行环境准备协议

Manifest 声明、执行端方法、返回值、进度和分发约定统一见[第 5.5 节](#55-执行环境准备协议)。这两个方法独立于本节的平台 Adapter 方法。

#### 受管理安装与版本

curl 安装所选 Pi/xiaoO 时，`install-ras-client.js` 仅通过 `saveSetupContext` 保存配置查找上下文。实验第二步下一步触发 SWE-bench 执行端接入检查，需要安装时调用 `xgovernor/setup.cjs` 准备固定兼容源码版本；同版本且制品校验通过时复用，构建限并行，工具链和制品均独立于 MCTS。xGovernor 依赖仍可由 `scripts/xgovernor.cjs` 手动管理，`update [--version <tag或commit>]` 从官方源码构建配套组件，`status` 校验版本，`rollback` 回退。安装版客户端分发该脚本和后端管理模块，安装位置为 `AGENT_INSIGHT_HOME/dependencies/xgovernor`，不占用平台、Evaluator 或全局 Agent 安装。`installation.cjs` 校验原子 current/previous 指针、清单、架构和实际制品摘要；没有手动组件路径的 Profile 自动解析受管理组件，随后由 `executionCapabilities()` 生成带实际 commit 与 `artifactDigest` 的公开摘要。现有客户端 PUT capabilities 与平台接收路由均须保留 `executionProfiles` 与 `targetReadiness`，否则实际版本或对应 Runtime 就绪结果会丢失。

固定版本及工具链定义集中在执行端源码，当前值如下；变更兼容版本前应验证适配协议：

| 定义 | 当前值 / 行为 |
|---|---|
| `setup.cjs` 的 `COMPATIBLE_REVISION` | `d08e67e366b89e622af9383383e251c4f40eb728` |
| Node.js | 要求 >=22.19；不足时安装独立 Node 22.19.0 并校验下载摘要 |
| Rust / Cargo | 缺失或版本不足时安装独立 Rust 1.97.1；构建并行度为 2 |
| 系统依赖 | 实验准备只检查 Git、C/C++ 构建工具、pkg-config 等，缺少时提示管理员处理；不隐式执行系统包管理器 |
| 凭据桥接版本 | `native-credentials-build.cjs` 的 `BRIDGE_VERSION: 1`，状态中对应 `components.xiaooCredentials.version` |
| 工具链目录 | `dependencies/xgovernor/toolchain/`，不修改用户 shell 配置 |

安装器注册并启动客户端；耗时构建推迟到实验环境准备阶段，不占用一次性安装令牌的有效期。`setup.lock` 防止重复准备工具链，`update.lock` 保护更新、回退与版本回收；实验准备通过锁的 PID 核对进程，确认已退出后清理遗留锁，存活时等待并在获得锁后重新验证兼容安装，避免重复编译。失败保留工具链、构建或 Docker 阶段及安全错误分类，写入 `setup.json` 并报告未就绪，客户端仍可在线。`setup.json` 仅保存 Runtime、原配置路径与状态，不保存模型凭据。MCTS 使用自己的检查流程，不接管同机 MCTS 的服务、配置或仓库。

客户端安装目录默认由 `AGENT_INSIGHT_HOME` 定位，以下命令只管理原生执行端的 xGovernor：

```bash
node ~/.agent-insight/client/runtime/xgovernor.cjs status
node ~/.agent-insight/client/runtime/xgovernor.cjs update --version <tag或完整commit>
node ~/.agent-insight/client/runtime/xgovernor.cjs rollback
```

源码入口为 `node scripts/xgovernor.cjs`。手动 `update` 不指定版本时使用官方 HEAD，curl 自动安装始终使用平台固定兼容版本。`status` 验证制品，实际模型与 Docker Case 须另行验收；更新 xGovernor 本身不要求重部署平台或 Evaluator。不要将托管目录指向 MCTS。

每个 release 包含源码、构建产物和 `installation.json`；`current.json` 原子保存 current/previous 指针。下载、构建、扩展类型检查与 server 健康、鉴权、会话接口探测全部通过才切换，失败保留原版本。SIGINT/SIGTERM 会取消构建并清理本次未激活目录；SIGKILL/掉电遗留的锁须确认进程已退出后再处理。

受管理构建在最终 `releases/<commit>-<安装标识>/source` 目录执行，避免 Cargo 嵌入的 Pi 探测扩展路径随临时目录移动失效。`installation.json.build` 保存 `layoutVersion: 1` 与规范化的 `sourceDirectory`，安装和回退均校验二者；无布局标记或目录被移动的历史版本，即使 commit 相同也必须重建，只有验证通过才原子激活。旧制品保留给在途任务，回退同样要求布局校验。

#### 原生执行高级配置

安装版配置加载器读取运行时内置 `config/benchmark/executor.yaml` 后，只合并 `$AGENT_INSIGHT_HOME/config/executor.local.yaml`（默认 `~/.agent-insight/config/executor.local.yaml`）。执行 Profile、镜像策略、Git 源和 Runtime 默认参数使用同一入口；旧运行时目录的 local 文件不读取、不迁移。源码运行仍合并仓库 `config/benchmark/executor.local.yaml`。显式 `AGENT_INSIGHT_CONFIG_DIR` 保留原语义，指定目录中的文件独立生效。用户配置按声明文件解析相对路径，升级只更新内置默认文件并保留用户配置。

常规 curl 安装无需填写 Profile。下例用于手动部署或显式模型覆盖，示例可执行路径、模型和 endpoint 需替换为实际值；镜像配置独立见 [SWE-bench 部署指南](deploy-swe-bench.md#原生-pixiaoo-的-case-镜像)。

```yaml
execution:
  profiles:
    xgovernor-local-docker:
      serverExecutable: /opt/xgovernor/bin/xgovernor-server
      dockerExecutable: docker
      dockerSocket: /var/run/docker.sock
      traceApiKeyEnv: AGENT_INSIGHT_API_KEY
      resources: { cpu: 2, memoryMiB: 4096, pids: 512 }
      timeouts: { prepareSeconds: 1800, cleanupSeconds: 120 }
      models:
        example/model:
          provider: example
          model: model
          api: openai-completions
          apiBase: https://model.example.com/v1
          apiKeyEnv: BENCHMARK_MODEL_API_KEY
      runtimes:
        pi-agent:
          kind: pi
          namespace: runtime_pi
          agents: [pi-agent]
          workerExecutable: /opt/xgovernor/bin/pi-worker
          executable: /opt/xgovernor/extension/node_modules/.bin/pi
          extensionDirectory: /opt/xgovernor/extension
          defaultModel: example/model
        xiaoo:
          kind: xiaoo
          namespace: xiaoo
          agents: [defaultagent]
          workerExecutable: /opt/xgovernor/bin/xgovernor-server
          defaultModel: example/model
  bindings:
    - benchmarks: [swe-bench]
      platforms: [pi-agent, xiaoo]
      profile: xgovernor-local-docker
```

`serverExecutable` 与 Runtime 的 worker/CLI/扩展路径须为绝对路径。存在这些自定义路径时完整采用手动安装，不与受管理组件混用；迁移到托管安装需移除路径覆盖。手动安装按实际制品计算摘要，`sourceRevision` 显示 `unknown`，旧版手填的 revision 不能证明二进制来源。xiaoo 原生凭据桥接须位于 worker 同目录，详见下方模型说明。

`runtimes` 表示完整运行集合；托管 Profile 按安装时所选 Runtime 过滤，安装器仍构建配套组件。启用的 worker 或 Trace 依赖未就绪会使 Profile 不可用，模型凭据则在准备本次任务时单独校验。`workerEnvironment` 可覆盖 Worker 变量名，Pi/xiaoO 默认为 `XGOVERNOR_PI_WORKER` / `XGOVERNOR_XIAOO_WORKER`。`settings` 只补充受信 Runtime 扩展，隔离参数由驱动固定；原生后端不接受 MCTS 等 Runtime 的 `agentOptions`。

#### 回收与恢复

`retention.cjs` 在客户端恢复后及每小时清理本地过期记录，每轮重读正整数 `retention.days`（默认 7）。`FileRunStore` 保存稳定的 `terminalAt`，重复写入终态不延长保留期；Runner 在完成回调成功后写入 `completionDeliveredAt`。删除前核对终态、cleanup、逐项 Artifact 上传、closed lease 与 Trace 字节 checkpoint，并避开活动任务和上传锁；缺少确认、损坏、符号链接及旧记录缺少终态时间时保留。

确认后的记录先移入客户端专属 `retention-trash/` 再删除，确认信息独立保存，中断后可继续；清理错误记录后下轮重试，不删除镜像或平台记录。Trace 上传器关闭自身按日期过期删除，统一遵循 Case 保留策略。版本回收等待执行空闲，使用 `update.lock`，按安装时间清理过期受管理版本，保护 current、previous 及未关闭/待恢复任务引用的版本。清理逻辑不进入任务信封或冻结 Profile，不改变调度与 Evaluator。

每个 Case 使用独立 daemon、状态目录、凭据及容器；两监听端口动态分配，端口冲突最多尝试 3 次。驱动核对实际镜像架构、image ID、无宿主挂载、非 root、capability、no-new-privileges 与资源限制。工具容器网络为 `none`，模型请求由宿主机发出；CPU/内存/PID 限额只约束工具容器。Pi 关闭个人资源发现，不自动携带全局 Skill。

Runner 为准备、Agent、收集与清理持久化期限，心跳不延长时限。取消与恢复按 PID 身份和 deployment ownership 清理，不执行全局 kill/prune；无法确认时保持 `cleanup_pending` 并占用预算。Patch/Trace 在关闭前落盘，上传失败只重传，不重新运行 Agent。真实链路验收应分别覆盖 Pi/xiaoO 单 Case、取消与重启恢复及平台评测结果。

#### 工作区、提交与诊断

`XGovernorClient` 的 HTTP 失败只回传固定词表内的安全原因与已知缺失/不支持字段名，最多读取 16 KiB、等待 1 秒，避免大响应或挂起响应拖住清理。模型错误按大小写无关的固定短语识别，支持 Pi 与 xiaoO 的扁平 `message`、`error.message`、字符串 `error` 和纯文本响应。模型预检查超时/失败分别返回 `MODEL_PREFLIGHT_TIMEOUT` / `MODEL_PREFLIGHT_FAILED`；认证、模型不存在、连接、限流、响应异常分别使用 `MODEL_AUTHENTICATION_FAILED`、`MODEL_NOT_FOUND`、`MODEL_CONNECTION_FAILED`、`MODEL_RATE_LIMITED`、`MODEL_RESPONSE_INVALID`，请求超时/配置错误及服务错误使用 `MODEL_REQUEST_TIMEOUT`、`MODEL_REQUEST_INVALID`、`MODEL_SERVICE_ERROR`。只返回固定中文原因与处理指引，原始错误 JSON、任意 details、URL、headers 和凭据不进入完成回调。无法识别时保留 `XGOVERNOR_REJECTED`，显示“执行环境请求失败（HTTP 状态码）”，不能仅凭 HTTP 400/401 等推断模型原因。错误码和安全消息经现有完成链路保存，Case 顶部、列表摘要与评测结果沿用同一原因；摘要直接显示模型问题的处理提示。历史只有 HTTP 状态的记录不推断补写原因。该映射不改变 xGovernor 的模型预检查期限或自动重试策略。

`execution-workspace.cjs` 将 SWE-bench 的镜像工作区准备分派到执行端 `benchmarks/swe-bench.cjs`，其他 Benchmark 保留原有工作区准备策略。SWE-bench 不再 reset/clean 或校验 origin：官方镜像可移除 origin，并在数据集基线之后提交安装调整。执行端验证初始 HEAD、数据集 commit 存在且为 HEAD 祖先、初始状态干净，分别持久化 `datasetRevision` 和用于 Patch 的 `baseCommit`，不修改任务信封中的 `workspace.revision`。替换 Backend 时可注入自己的 `exec` 复用该工作区策略，不依赖 xGovernor 会话实现或 Evaluator。

`GitPatchCollector` 将修改暂存并相对持久化基线生成二进制完整 diff，禁用外部 diff/textconv，继续排除提交物自身、校验大小和路径。收集时不使用当前 HEAD 替换基线，因此 Agent commit、暂存及未暂存修改和新增/删除文件均可包含；缺少持久化基线时明确失败。`command-diagnostics.cjs` 将沙箱非零退出/超时映射为固定安全说明，写入 `diagnostic.json` 与 `runFacts.sandboxDiagnostic`；Runner 合并失败事实与已有运行事实，保留收集失败前的 Trace。诊断只存固定操作和原因、阶段、退出码及超时标记，不持久化原始命令或 stderr，随 Case 的保留策略清理。

#### 模型与凭据

`model-resolver.cjs` 在执行端解析原有模型配置，Backend 将结果映射为 xGovernor 会话参数。环境就绪与模型认证独立，模型问题在 prepare 阶段报告；只有本次选中模型的凭据通过私有管道返回。

模型选择顺序为实验显式 model → Runtime 的 defaultModel → 唯一高级模型映射（仅配置一个时）→ 原生 Agent 默认模型；高级 `models` 映射仅覆盖当前选中的模型，不检查其他模型的凭据。配置路径与用户目录从安装上下文恢复，在独立登录 Shell 中解析登录环境；密钥不进入命令参数、Profile、能力上报或 lease，只注入本次 Case 的专用进程环境。Trace 认证沿用 `$AGENT_INSIGHT_HOME/.env`，显式环境变量优先，不使用设备凭据替代采集认证。

Pi 通过配套 SDK 的 ModelRuntime/ModelRegistry 读取原有 models.json/auth.json，并用纯内置目录（modelsPath: null、离线模式）结构化比对 compat 和 headers；无法保留的自定义差异只报告字段名。reasoning、input、contextWindow、maxTokens 映射到 llm.capabilities，输出上限不得超过上下文。Pi OAuth/订阅仍不支持，不静默降级。

xiaoo 的 max_tokens/context_window 映射到 capabilities，reasoning_effort 按原生别名规范为 off/high/max（支持 none/disabled/xhigh/maximum），每轮请求发送。解析值固定在本次句柄中，不受之后配置变化影响；两个 KV cache 开关不配置或为 false 可执行，true 时明确报契约不支持。TOML 与凭据解析由原生 Rust 桥接完成，不依赖 Python TOML 脚本。

xiaoo 凭据由安装时构建的 `insight-xiaoo-credentials` 解析：从 `cargo metadata --locked` 定位 xGovernor 实际锁定的 xiaoO 源码，直接编译其 `SecretProvider`，链接同一源码的 `vault` 与 `llm-client`，不在 JS 中复制解密算法。桥接读取原有 config.toml，默认采用 active_profile，实验显式模型优先匹配启用的 provider/model 配置；凭据引用采用显式 api_key_env 或原生 provider 默认值。按原生顺序读取同目录 llm_secrets.json 的 api_keys、tokens，再回退环境变量，使用原生白盒/SDF 实现；损坏库不会悄悄回退到另一 Key，也不修改原配置或凭据库。桥接用 stdin 接收配置路径和模型选择，fd3 返回本次模型与凭据，stdout/stderr 丢弃；不发送模型请求、不启动原生服务。桥接使用独立 Cargo manifest/lock，首次解析复用上游现有锁文件，不改动 xGovernor 原始 manifest/lock；components.xiaooCredentials 记录桥接版本及原生源码来源。新增制品进入安装清单和 artifactDigest，即使上游 commit 相同，缺失或版本不兼容也需重跑 curl 自动重建。修改桥接实现时应同步递增 BRIDGE_VERSION。手动安装需在 worker 同目录提供该二进制。

凭据诊断区分 `MODEL_CREDENTIAL_MISSING`、`MODEL_CREDENTIAL_STORE_UNREADABLE`、`MODEL_CREDENTIAL_ADAPTER_UNAVAILABLE`；配置错误仍用 `MODEL_CONFIGURATION_INVALID`。跨登录 Shell 的私有解析进程保留这些错误码，公开消息仅采用固定原因和合法的凭据引用名，不回传原始解析/解密异常。Case 详情和列表显示具体原因及处理方式，明确本地失败尚未发出模型请求。原生允许免 Key 而当前 xGovernor 会话协议要求非空凭据的模型，明确报适配限制，不注入虚构 Key。Pi 保留 SDK ModelRuntime/ModelRegistry 解析及 OAuth/订阅限制。MCTS 仍使用自身已配置的服务环境与 XGOVERNOR_LLM_KEY_ENV 引用，不接入这个凭据读取过程。

升级仅切换后续任务的版本指针，执行句柄固定本次 Runtime/模型凭据引用和组件路径，运行与 Trace 导出不依赖新的 current；旧版本目录保留供在途任务及恢复使用。任务受理前仍核对冻结摘要，不自动迁移旧实验。安装 smoke 只检查源码布局、扩展类型和 server 基础协议，实际模型、工具隔离、完整 Trace 仍需执行链路验证。安装步骤见[部署指南 7.3](deploy-services.md#73-原生-pixiaoo-的-swe-benchxgovernor-本地-docker)。

#### 镜像与 Runtime 扩展

SWE-bench 执行端在 `services/executor/src/benchmarks/swe-bench-images.cjs` 独立维护镜像命名、架构选择、SWR 映射、代理及官方回退；Evaluator 保留 `benchmarks/swe-bench/evaluator/` 的原有实现。两端不互相导入、不依赖共用镜像模块，也不使用另一端的实现生成测试预期，可分别演进。执行端通过 `execution-images.cjs` 分派到自身 Benchmark 镜像适配器，再注入本机 Docker 调用。xGovernor 后端只使用准备结果，不内置 SWE-bench 仓库规则；替换后端仍可调用同一入口。两端分别维护各自的 `benchmarks.swe-bench.images` 配置定义并读取 `executor` 与 `evaluator` 配置，不自动同步。当前默认均支持本地缓存 → SWR → 代理 → 官方仓库，内置 SWR Verified 镜像仅适用于官方 x86_64。执行端模块随现有 `services/executor/src` 的客户端 bundle/npm/standalone 分发，不向 Evaluator 增加执行端依赖。

带 OCI 执行环境的后端在执行前解析并持久化本机 image ID，通过 `runFacts.execution.imageId` 记录实际使用的镜像，`runFacts.execution.imageResolution` 记录来源及解析结果。平台不将其作为 EvaluationJob 的强制镜像约束；SWE-bench 评测与重评沿用私有评测配置中的镜像引用，以及 Evaluator 既有的 SWR、代理与官方镜像解析和回退策略。镜像预热不依赖执行端回传 registry digest。

完整 Trace 使用现有上传端点与 durable spool。Pi 从本次唯一原生 JSONL 导出；xiaoo 通过透明 Worker 代理持久化完整 state，要求 runtime_kind=xiaoo、schema_version=1 及匹配的 ChatMessage 结构。摘要 SSE 不替代完整消息，SSE 断连不重新提交 Agent；业务 Trace ID 为 `xgovernor:<runId>`，Runtime/turn 必须精确归属。

可选 `traceExporter` 支持其他 Runtime 或快照格式：

| 调用 | 契约 |
|---|---|
| `--describe` | 返回 schemaVersion=execution-trace/v1、full=true 和 runtimeKinds 列表 |
| `--export` | stdin 接收本次 runId/runtimeId/stateDirectory 等元数据，返回同版本、full=true、匹配 runId/runtimeId 及完整 canonical events |
| 事件校验 | 唯一根会话为 `xgovernor:<runId>`，包含模型正文；还须实现上游会话参数映射并验证 Trace 语义 |

后续接 OpenCode 时，在 xGovernor 支持的前提下新增受信 Runtime 注册、模型/参数映射及完整 Trace 转换，再增加目标 binding；公共 Runner、SWE-bench 业务任务与 Evaluator 无需增加 OpenCode 分支。连 xGovernor 一起替换时，实现同一六方法合同、配置/能力描述及独立 Trace/产物适配，注册新 `backendKey`。目前 YAML 配置解析与预探测实现针对 xGovernor；增加其他后端须补充对应配置和能力装配。通用合同不代表其他后端已经完成适配。配置与导出合同见本节的 [原生执行高级配置](#原生执行高级配置) 与 Trace 导出说明；部署操作见 [通用部署指南 7.3](deploy-services.md#73-原生-pixiaoo-的-swe-benchxgovernor-本地-docker)。

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

`--evaluator-env` 的已知业务变量由 `packages/project-config` 的 `parseEvaluatorEnv()` 精确映射到配置字段，再覆盖 YAML 并统一校验，生成传给 Controller 与 Runtime 的同一份 JSON 快照。例如 `EVALUATOR_MAX_CONCURRENCY=4` 对应 `maxConcurrency: 4`；普通进程环境不恢复隐式覆盖。启动脚本通过 stdin 传入参数，校验器返回配置、挂载设置和非业务透传变量；业务变量不再原样注入 Runtime，避免两套配置互相覆盖。未知 SWE-bench/镜像池配置变量、非法值和多行赋值明确报错，错误不回显值。合法非业务变量保留原透传，端口、配置快照及内部磁盘参数仍由部署脚本管理。

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

OCI Runtime 的摘要同时覆盖 `services/evaluator/src/`、`packages/project-config/`、协议路径校验工具 `packages/benchmark-protocol/artifact-path.cjs` 和评测默认配置，公共依赖变化也会生成新的镜像 tag。SWE-bench Runtime 复制完整评测公共源码目录及协议工具，在 Docker 构建阶段加载实际评测 Entrypoint 与 Smoke 入口；缺少传递依赖时构建直接失败，不发布只能在运行时报告 `MODULE_NOT_FOUND` 的制品。测试按 Dockerfile 的 COPY 布局构造独立目录并加载入口，不能借用开发仓库文件或 node_modules 掩盖漏包。

接入包可选声明 `assets`：`image` 必须为固定 `repository@sha256`，同时声明镜像内 `sourcePath`、`releaseId`、`bundleDigest`、可选部署目录变量名 `directoryEnv`、`verifyCommand`（`python3` 或 `node`）及包内 `verifyEntrypoint`。Controller 在启动后台准备资产，调用校验器时依次传入目录、release ID、bundleDigest。校验器只读取文件与元数据，不执行 Judge 或构建任务。

通用安装器按镜像摘要创建版本目录，拉取后从未启动容器复制、校验，再原子发布；并发请求共享准备状态，重启重新校验缓存。默认存储根为 `<EVALUATOR_DATA_DIR>/benchmark-assets/<benchmarkKey>`；配置 Schema 注册了 `benchmarks.<key>.assetsDir` 的接入包使用该 YAML 字段，`null` 使用默认根目录，不再回退旧目录变量。未注册此字段的其他接入包仍可使用 `directoryEnv`。实际目录仍追加摘要。OCI 资产必须在 Controller 与 Runtime 共享卷内。Provider 的第三个参数 `assetsDir` 和 Runtime 环境 `EVALUATOR_ASSETS_DIR` 均为该接入实际解析出的版本目录，不从任务 payload 获取，也不修改全局环境变量。

准备期间 admission 返回可重试的 `EVALUATOR_ASSETS_PREPARING`、`EVALUATOR_ASSETS_DOWNLOADING` 或 `EVALUATOR_ASSETS_VERIFYING`；安装失败返回不可重试的具体错误。健康检查通过 binding 的 `runtimeFacts.assetStage/assetErrorCode` 暴露状态，平台在健康检查和下发响应两条路径均保留错误及详细原因。没有声明资产的接入包不增加准备流程，公共 Controller 不含 ZSoft 分支。

#### Runtime 镜像生命周期与清理

Runtime 镜像是可重新拉取或构建的评测制品，不是永久缓存，也不能作为提交物、Evidence 或运行日志的唯一存储位置。接入包复用公共 OCI 入口与清理策略，不自行扫描删除其他版本、不改写公共归属记录，也不执行全局 prune。

- **版本与归属**：继续使用 Catalog 生成的内容摘要 tag 和镜像 label。公共 `prepareOciRuntime()` 发起 pull/build 前，通过 `recordManagedImage()` 在 `<EVALUATOR_DATA_DIR>/managed-images/` 登记 `reference`、`daemonId`、`role: runtime` 和 `uncertain: true`；制品校验通过后补全本机 Image ID，并置为已确认。直接命中的预装/手工构建镜像只复用，不自动接管归属；不能仅凭仓库名认定镜像可删。
- **自动清理**：`scripts/evaluator.sh start` 在新 Controller 通过 Doctor 后，调用公共 `runtime-image-cleanup.cjs` 清理已登记的旧 Runtime；清理失败只警告，不停止已经启动的服务。正常启动只打印检查与清理摘要，异常仍保留具体原因。
- **在线管理**：`images list`、`images purge --dry-run` 和 `images purge` 均使用运行中 Controller 的 Catalog、配置和数据目录，不使用宿主工作区的 Catalog。`purge` 同时处理空闲 Case 镜像池和旧 Runtime；关闭 Case 镜像池不影响 Runtime 清理。预览不删除镜像或归属记录，手动命令保留完整结果。
- **保护边界**：只清理同一 Docker daemon、同一数据目录内归属已确认的旧 Runtime。当前 Catalog 所需的原始/有效镜像引用及相同 Image ID、被任意容器（包括已停止容器）引用、操作未确认、引用已改写或存在额外标签/其他仓库 digest 的镜像均保留。删除前重新核对归属，按已确认 Image ID 非强制删除；Docker 检查或删除发生冲突时报告并保留，不为清理而停止任务、删除容器或强制解除引用。
- **接入职责与范围**：实例运行和恢复必须沿用公共容器标签与独立工作目录，不能绕过公共入口创建无归属的 Runtime。此策略不接管 Case Runner、`assets` 资产镜像、未登记的历史镜像、无标签镜像或构建缓存；Case 镜像的保护和回收遵循第 9.5 节镜像池协议，不能把这些对象当作旧 Runtime 一并删除。

操作命令与保留原因见[部署指南：立即停止与镜像清理](deploy-services.md#11-立即停止与镜像清理)。不新增 Benchmark Manifest 字段或 HTTP 管理接口。

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

后台准备不占评测执行槽。重评创建新 Evaluation 后先尝试刷新窗口再下发评测；收到 `IMAGE_POOL_PREPARING` 时也刷新窗口，避免只重试评测而未触发准备。准备请求失败保留评测队列，后续重试及评测 watchdog 定期补偿。执行 watchdog 在启动恢复前注册，历史实验恢复逐条隔离异常，避免单条已取消任务阻断后续恢复或后台调度。无镜像依赖的包不需要实现以上 hook。主机配置、空间口径、异常恢复及性能指标见[部署指南](deploy-services.md#53-可选跨-benchmark-共享镜像池)。

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

声明环境准备入口时，还须验证协议兼容、入口与传递依赖随执行端安装包分发、文件变更更新内容摘要，以及未声明 `gitSourcePolicy` 时仍能加载环境模块。

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
  test/benchmark-experiment-wizard-ui.test.ts \
  test/execution-environment.test.ts \
  test/execution-environment-api.test.ts

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
| 环境已经满足 | 检查无安装副作用，直接进入下一步 |
| 同一数据集切换 Agent | 只检查当前 Agent 所需环境，旧结果不放行新配置 |
| 可自动准备 | 自动安装、复查后进入下一步；再次检查复用已有环境 |
| 缺少 API 配置或权限 | 底部提示执行机配置要求，配置后点击“下一步”重新检查 |
| 人工问题与可安装项并存 | 先提示人工问题，本轮不启动安装 |
| 首次耗时编译 | 仅实际进入编译时显示“首次可能需要几分钟” |
| 准备失败或复查仍不满足 | 不进入下一步，允许用户处理后重试 |

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
- [ ] 执行端环境模块、Manifest 声明、按 Agent 检查和准备测试；
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

- [Manifest](../../../../../benchmarks/swe-bench/benchmark.yaml)
- [Adapter](../../../../../benchmarks/swe-bench/adapter/index.ts)
- [执行端环境模块](../../../../../benchmarks/swe-bench/executor/environment.cjs)
- [Evaluator 配置](../../../../../benchmarks/swe-bench/evaluator/evaluator.yaml)
- [Evaluator Entrypoint](../../../../../benchmarks/swe-bench/evaluator/entrypoint.cjs)
- [Case Schema](../../../../../benchmarks/swe-bench/schemas/case.schema.json)
- [Raw Result Schema](../../../../../benchmarks/swe-bench/schemas/result.schema.json)
- [Adapter 测试](../../../../../benchmarks/swe-bench/tests/adapter.test.ts)
- [部署 Smoke](../../../../../benchmarks/swe-bench/smoke/index.cjs)

参考它的目录和生命周期，不要复制它的 `model.patch`、Resolved、FAIL_TO_PASS、镜像或 Evidence 业务语义。新的 Benchmark 必须使用自己的实例代码表达这些差异。

客户侧的自然语言协作方式见[《自定义 Benchmark 接入指南》](onboard-custom-benchmark.md)，各指南的使用顺序见[《Benchmark 文档关系与开发指南》](../../../explanation/evaluation/benchmarks/README.md)。

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

合成数据、伪插件和伪运行器测试只能验证契约；真实判题需按 [ZSoft 部署验收](deploy-zsoft.md#5-部署验收) 执行并保留部署环境的验收记录。

### ZSoft 公有镜像与冻结资产

ZSoft 接入包声明 `imageProvider: ./images.cjs`。Adapter 的 `imagePreparationInput` 提供题目 ID、大小/提交类型、官方题目内容摘要 `sourceTaskDigest` 与可选 revision，支持统一镜像窗口预取；Controller 按同一 payload 准备实际评测镜像。Provider 核对题目内容摘要和请求中存在的 revision，并校验评测机本地冻结清单后生成引用，不接受任务直接指定任意镜像。

`zsoft-assets/v1` 新增可选 `tasks[taskId].registryImages`，键与 `images` 完全一致，值为公有仓库的固定 `repo@sha256`；该字段参与 task/bundle 摘要。原 `images` 保存 Docker config Image ID。公共镜像池冻结 `preparedImages`，Python 入口核对题目 key 与实际 Image ID，Compose 代理使用固定 ID 和 `pull_policy=never`。未配置 `registryImages` 的当前清单要求本地已装镜像；缺少 `sourceTaskDigest` 的旧清单不再支持。平台题目身份与评测机私有资产构建摘要分别管理，Evaluator 不连接平台数据库。

Runtime 发布与解析共用 `services/evaluator/src/runtime-image.cjs`。构建端可使用 `--image-prefix`，Controller 配置 `EVALUATOR_RUNTIME_IMAGE_PREFIX`；显式 `--push` 才上传。ZSoft 默认复用本地 Runtime，缺失时尝试 pull，失败后自动 build，仍核对 Catalog artifact 标签。本部署方案将 Case 镜像和完整冻结资产镜像上传公有 SWR；Controller 启动后自动安装资产，自动构建 Runtime 不会重新构建题目环境。镜像池保持公有匿名 Docker API 拉取，不读取宿主 `docker login` 凭据。构建与发布流程见 [ZSoft 评测资产发布指南](release-zsoft-assets.md)，评测机安装见 [ZSoft 部署指南](deploy-zsoft.md#4-评测端准备)。

内核题复用同一个 ZSoft Evaluator Runtime、任务协议和结果归一化。接入包将 `runner_image` 交给通用镜像池；`.task-state/<task-id>/{vuln,fix}/artifacts/` 中的 `bzImage`、metadata 和模块作为独立的冻结文件资产，按流式 SHA-256 校验，不作为 Docker 引用。资产打包支持合并同官方 revision、同框架摘要的冻结快照，评测机始终不访问数据库。

ZSoft 平台配置为 `benchmarks.zsoft-l1.dataset.{autoImport,source,revision}`，`autoImport` 默认 `true`，其余默认 `null` 使用接入包固定的官方来源与版本。`start.sh` 在数据库同步后顺序调用 SWE-bench 和 ZSoft 的 bootstrap；共用日志与非阻塞失败处理，分别按 YAML 开关跳过或调用准备入口。ZSoft 调用 `ensure-dataset.ts --benchmark zsoft-l1`，先复用已安装数据集；失败只警告，日志为 `<AGENT_INSIGHT_HOME>/logs/zsoft-l1-bootstrap.log`，下次启动重试。这里的非阻塞失败指不阻止后续启动，准备本身仍同步等待。关闭开关不影响管理员手动调用或显式刷新。评测配置为 `benchmarks.zsoft-l1.assetsDir`（默认 `null`）和 `kernelAccel`（默认 `tcg`，可选 `kvm`）；旧四个 ZSoft 业务变量在普通进程环境中仅提示迁移；显式 `--evaluator-env ZSOFT_L1_ASSETS_DIR=...` / `ZSOFT_KERNEL_ACCEL=...` 可覆盖本次评测配置。Controller 向 Runtime 传递校验后的 `AGENT_INSIGHT_EVALUATOR_CONFIG_JSON` 快照，Python 从该快照读取加速模式，不直接解析 YAML 或读取旧用户变量。MCTS 的 `ZSOFT_TASKS_DIR` 不属于平台业务配置，保持原契约。

平台 Judge 所在 Runtime 不挂 KVM 设备，官方 Judge 的配置阶段仍通过内部环境注入 TCG；受控 Compose 代理向实际 runner 设置 YAML 选定的 `KERNEL_ACCEL`，KVM 模式只开放 `/dev/kvm:rw`。实际评测在已准备的 runner 镜像中检查宿主机 KVM API，失败返回基础设施错误。资源预算按两服务分摊，并在启动前校验每版内核声明的 CPU、内存及 512 MiB 额外内存；提交编译失败保持 `submission_invalid`，超时、取消和容器/网络清理复用已有路径。doctor 校验资产、轨道和加速配置，不在冷缓存时拉镜像或启动 QEMU；KVM 可用性在实际评测前检查。

### MCTS Runtime 接入实现

MCTS 采集启动器将凭据来源与 Case spool 分开：对于安装布局 `collectors/mcts-xgovernor-proxy/config.json`，从该安装根目录读取 `.env`，优先级为显式进程 Key → 公共 Key → 旧 JSON Key；自定义配置路径仍从 `AGENT_INSIGHT_HOME` 读取公共配置。显式清空公共 Key 不回退旧 JSON，配置读取失败则报错。`AGENT_INSIGHT_HOME` 在 Benchmark 中仍可指向独立 Case 输出目录，不改变轨迹隔离。

`preflightTrace` 复用现有 OTLP POST 接口，以 `{resourceSpans: []}` 验证采集鉴权，5 秒超时、拒绝重定向，检查平台 accepted/received=0 响应；不增加 API 路由或真实 Trace。安装写入前和 MCTS 子进程启动前均执行此检查；失败信息不包含 Key 或服务端响应正文。就绪能力探测仍是本地依赖检查，不能等同于已通过实时上传鉴权。运行中的凭据不热更新，历史 rejected/spool 的补传属于独立恢复操作。

部署操作见 [MCTS xGovernor 接入](../../observability/mcts-xgovernor.md#用于平台-benchmark-实验)，Benchmark 环境分别见 [SWE-bench](deploy-swe-bench.md) 与 [ZSoft](deploy-zsoft.md)。

实验候选接口会独立合并已就绪的 Benchmark 执行目标，因此仅声明 `runBenchmarkCase` 的 `pi-mcts` 可直接出现在 Agent 列表；它不依赖普通执行能力或历史 Trace。同一客户端、平台和 Agent 的目标合并后保留各自的执行能力标记。

`services/executor/src/mcts-config.cjs` 统一实现路径解析、Python 检查、连接读取和配置持久化，同时进入客户端 tar 包与 MCTS 采集器 zip 包。读取连接时在独立 Bash 子进程加载 `testcases_union/config.env`，仅提取 URL，丢弃其 stdout/stderr；检查 HTTP(S) URL，再进行 TCP/TLS 连接预检。连接预检不执行付费任务，也不代表模型/E2B 全链路验证。

MCTS 安装器将本次版本的上传模块放入采集器目录内的 `shared/`，运行时优先读取此副本，保留旧版 `../shared/` 的兼容读取。升级不覆盖其他采集器已有的共享模块，避免版本差异阻止重复安装。

MCTS 安装器只检查公共仓库文件和 Python 版本。客户端按 Benchmark 分别探测：SWE-bench 检查 `run_union.sh` 及 `importlib.util.find_spec("datasets")`，不导入 `datasets`；ZSoft 检查公共运行前提和专用插件契约，不检查 SWE 依赖。Python 和接口子进程各有 5 秒上限，超时、无法启动、缺包、异常退出与版本不足分别返回原因。`agent-runtime/pi-mcts/v1` 与搜索参数能力在任一 Benchmark 就绪时可用；新客户端额外上报 `mcts-swe-bench/v1`，SWE 目标需该组件就绪，旧客户端未声明该组件时保留原兼容规则。实际运行仍正常导入依赖；运行时导入失败按实际进程错误处理。

这些是执行机本地配置，不进入服务端下发的 Case 任务。公共 Python/Trace 前提不满足，或两个 Benchmark 均不可用时，客户端会将 `agent-runtime/pi-mcts/v1` 标为未就绪；SWE 脚本缺失不会单独阻止 ZSoft。`pi-mcts` 不会出现在普通生成 Trace 实验中。

执行器每次从 MCTS `config.env` 读取真实 xGovernor 地址，以 `--upstream` 传给严格模式 Trace 代理。代理将动态地址放入 `AGENT_INSIGHT_MCTS_PROXY_URL`；本次专用 `python` 脚本在 MCTS 加载配置之后，将 `XGOVERNOR_BASE_URL` 恢复为代理地址并 exec 原解释器。手动启动器也为每次运行创建独立 Python 包装目录，退出时清理。固定 URL 不会绕过采集，无需修改 MCTS 配置文件。未配置仓库的历史独立 Trace 安装仍读取 `upstreamUrl` / `AGENT_INSIGHT_MCTS_UPSTREAM_URL`。

SWE-bench Case 的执行命令由客户端固定为 `run_union.sh --mode sweverified --runtime pi --testbench sweverified --instance-id <Case ID> --split test --output-dir <runId>`，并通过严格模式 Trace 代理启动。搜索参数由执行机的 Runtime YAML 和本机默认值覆盖解析，并显式追加到 CLI；新建实验冻结页面参数，联调配置通过普通参数模板复用。显式 CLI 参数覆盖 MCTS `config.env` 中的对应环境配置。客户端创建本次运行专用的 `python` 启动脚本，直接 `exec` 配置的 Python 解释器，再运行原版 `run_union.sh`。启动脚本保留原解释器路径，使 Python 正确识别虚拟环境及 `datasets`；不要把 venv 解释器符号链接到外部目录后执行。MCTS 只将最终选中节点写入 `testcases_union/output/sweverified/<runId>/artifact.patch`；客户端检查 Patch 后应用到该 Case 的冻结 Git 工作区，再由现有 `git-patch/v1` Collector 生成并上传 `model.patch`。Trace 代理的本地状态按 Case 隔离，客户端从其运行记录取得根 Session ID（`mcts.run.<32 位十六进制>`），作为回调 `traceId`，与平台 `Execution.taskId` 保持一致。OTLP 的 32 位 Trace ID 仅用于传输，不直接用作页面跳转；历史误存 OTLP ID 的 Case 在读取时按同一账户下根 Session ID 的 SHA-256 精确映射，不按时间邻近猜测。停止实验时客户端向进程组发送 SIGINT，给 MCTS 的 `finally` 清理和 Trace 代理上传留出 30 秒，然后强制终止仍未退出的进程。

MCTS 的默认配置和可选执行 Schema 位于 `services/executor/runtimes/mcts/runtime.yaml`，通过 `delivery: argv`、`binding: { mode: passthrough }` 交付，不声明 flat/nested。上报给平台的通用描述只包含 `configuration: { version: 2, defaults }`。前端统一支持嵌套编辑，七个 MCTS 平铺默认字段仅是初始内容，修改草稿不会改变模板。执行客户端在启动前校验实际参数；不支持的嵌套值不会自动拆分。

没有显式实验配置时，从 YAML 模板及本机覆盖初始化完整值；显式值不补默认字段。MCTS 的 CLI 交付器仅在执行端拒绝对象、数组、null、非法 CLI key 及调度保留 flag。平台保存并下发原值，不按 MCTS 特判。CLI key 保留大小写、下划线和点号，布尔值按 true/false 字面量交付；新增实际支持的参数直接使用同名 key/value。

源码定义位于 `services/executor/runtimes/`，安装后实际读取 `${AGENT_INSIGHT_HOME:-$HOME/.agent-insight}/client/runtime/executor/runtimes/`。新客户端约每 30 秒重新读取并上报定义，改 YAML 后等待上报并刷新页面，或重启客户端加速生效。客户端在每个 platform 的 `parameterDefinitions` 上报描述和 `definitionDigest`，不包含执行绑定。共享模块为 `packages/agent-runtime/index.cjs`（协议、校验）、`parameter-json.cjs`（递归 JSON）与 `loader.cjs`（YAML、覆盖、交付）。任务使用 `agentOptions: { version: 2, runtimeKey, definitionDigest, values }`；平台和执行端按选定 platform/agent 验证，契约不一致返回 `AGENT_DEFINITION_CHANGED`。

默认值和预设变动只更新模板修订，不覆盖正在编辑的草稿。客户端契约摘要覆盖目标、交付方式、业务 Schema 和绑定，不含 flat/nested 声明；平台将摘要视为不透明标识。历史快照不回写，复用确认只将原配置用于新草稿，不更名、不拆层。OpenCode 新版客户端提供默认空对象的通用配置，当前使用 CLI 交付；JSON/YAML 等新入口由客户端按实际接口适配。
