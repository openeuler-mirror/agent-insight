---
title: "Benchmark 接入开发规范"
description: "规定 Benchmark 接入包的目录、数据契约、适配器和验证流程，指导开发者实现可运行的评测集成。"
keywords: ["Agent Insight", "Benchmark", "接入开发", "数据契约", "评测适配器"]
changefreq: monthly
---

<a id="benchmark-接入开发规范"></a>
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
- 按第 3.4 节确认的配置归属、默认值、校验与消费路径、部署传递和生效验证；无需新增配置时记录依据；
- 主指标、聚合方式、评分点及页面展示；
- 按第 3 节查询得到的能力匹配结论、证据和待验证项，以及可能的公共扩展。

没有权威成功标准、数据授权或关键私有边界时，不得把假设写成正式实现。

### 2.3 判断接入包还是公共扩展

先按[第 3 节](#3-能力发现与兼容性判断)查询，再判断接入范围。任务、工作区、执行策略、提交物和评测输入输出能够由目标版本的协议表达，且对应公共组件已有实现时，只开发 `benchmarks/<key>`。执行机尚未安装依赖、缺少配置或服务未就绪，应先走已有部署和环境准备流程，不能直接判为缺少公共能力。

协议无法表达需求，或确实缺少可复用组件时，先提交公共能力扩展设计，说明查询依据、协议变化、复用对象、安全边界、兼容性和测试。未经确认不要在实例 Adapter、公共 API 或 React 页面中绕过限制。证据不足时标记待验证，不凭文档示例宣称已支持或不支持。

### 2.4 实现与验证

在用户授权范围与仓库约束内完成确认后，按实际依赖逐个推进可验证产物，覆盖 Schema、Manifest、Adapter、执行端环境模块、Evaluator、Dataset Loader 和 Presentation。每个产物完成受影响专项检查后继续；不依赖评分基线的数据解析、Schema 和准备工作可先推进。正式验收遵循第 12.6 节的前置与通过条件，独立官方评分基线不得由待验证的接入实现生成。

### 2.5 使用包内自动接入工具

[benchmark-onboarding](../../../../../skills/benchmark-onboarding/SKILL.md) 根据本规范分析并实现接入，提供[架构与代码导航](../../../../../skills/benchmark-onboarding/references/benchmark-protocol.md)。Agent 按需读取目标项目当前类型、校验器、实现和测试，不要求匹配 Skill 发布时的 commit 或摘要；必要适配记录在接入方案。源码分析与工具自测不代替实际部署和本次接入验收。

使用该 Skill 时，按[发现与协议核对](../../../../../skills/benchmark-onboarding/references/discovery.md)、[CLI 用法](../../../../../skills/benchmark-onboarding/references/usage.md)和[验收记录约定](../../../../../skills/benchmark-onboarding/references/acceptance.md)操作。新接入的 Catalog 检查统一遵循[第 12.1 节](#121-catalog)，环境准备合同见[第 5.5 节](#55-执行环境准备协议)。

## 3. 能力发现与兼容性判断

本规范维护架构、接入契约、查询方法和验收要求。可选 Workspace、Agent Runtime、Collector、执行后端及其版本以目标版本的代码和部署状态为准，不在本文维护完整能力清单。后文配置示例用于说明契约，不代表全部支持范围，也不保证某台机器已经可用。

### 3.1 从需求定位实现

先把 Benchmark 的要求拆成工作区输入、Agent 运行方式、网络与数据隔离、提交物、评测环境和结果格式，再逐项核对以下入口。类型声明说明可以表达什么；校验器和实际执行路径决定是否接受、如何执行，必须一起阅读。

| 要确认的问题 | 查询入口 | 必须核对的内容 |
|---|---|---|
| 任务与工作区能否表达 | [任务契约与校验器](https://gitcode.com/openeuler/agent-insight/blob/master/packages/benchmark-protocol/src/contracts.ts)、[执行 Profile 契约](https://gitcode.com/openeuler/agent-insight/blob/master/packages/benchmark-protocol/execution.cjs) | `AgentTaskEnvelope`、`validateTaskEnvelope` 及其调用的校验函数；所选工作区的字段、来源与版本限制，Profile 与 Agent、策略的匹配要求 |
| 是否有实际执行和采集实现 | [执行器装配入口](https://gitcode.com/openeuler/agent-insight/blob/master/services/executor/src/index.cjs) | `createBenchmarkExecutor` 中的 Provider、Runtime、Collector、Backend 注册与配置覆盖；沿所选实现追踪准备、执行、采集及清理路径 |
| Git 等输入来源如何解析 | 所选 Provider 的校验与准备实现；Git 来源策略从 [git-source-workspace.cjs](https://gitcode.com/openeuler/agent-insight/blob/master/services/executor/src/git-source-workspace.cjs) 继续追踪 | 任务允许声明的来源、实际下载来源、认证及固定版本校验；来源映射不能绕过任务信封的校验限制 |
| 能力如何上报与匹配 | [客户端能力装配](https://gitcode.com/openeuler/agent-insight/blob/master/scripts/reliability-client.cjs)、[执行 Profile 探测](https://gitcode.com/openeuler/agent-insight/blob/master/services/executor/src/execution-config.cjs)、[目标匹配](https://gitcode.com/openeuler/agent-insight/blob/master/src/lib/benchmark/execution-targets.ts) | Manifest 要求如何与组件、动作、Agent 和 Profile 匹配；组件存在、已启用和运行就绪分别依据什么判断 |
| Evaluator 能否承载官方判定 | [Catalog 生成与校验](https://gitcode.com/openeuler/agent-insight/blob/master/scripts/benchmark/generate-catalog.cjs)、[Evaluator 注册与运行](https://gitcode.com/openeuler/agent-insight/blob/master/services/evaluator/src/evaluator-registry.cjs) | 描述文件可用字段、运行方式、依赖与资源约束，以及 Entrypoint 的输入输出和隔离实现 |
| 上述结论如何验证 | [协议测试](https://gitcode.com/openeuler/agent-insight/tree/master/packages/benchmark-protocol/tests)、[公共与 Benchmark 专属测试](https://gitcode.com/openeuler/agent-insight/tree/master/test)、[历史接入包](https://gitcode.com/openeuler/agent-insight/tree/master/benchmarks)内的测试 | 已覆盖的正常与拒绝路径、测试是否使用真实组件；新增专属测试统一放在 `test/<key>/` 并纳入默认回归，Mock 通过不能证明部署就绪 |

在仓库根目录可以先用以下只读查询定位，再阅读命中的函数及调用链：

```bash
git rev-parse HEAD
rg -n 'AgentTaskEnvelope|validateTaskEnvelope|validateExecution|validateProfile' packages/benchmark-protocol
rg -n 'createBenchmarkExecutor|workspaceProviders|agentRuntimes|collectors|executionBackends' services/executor/src
rg -n 'requiredCapabilities|missingCapabilities|targetReadiness|RUN_BENCHMARK_CASE' src/lib/benchmark/execution-targets.ts scripts/reliability-client.cjs
```

记录所查代码的 commit 和相关本地改动，并核对平台、客户端及 Evaluator 的实际部署版本。开发仓库里存在实现，不代表已发布或已部署；入口移动时按符号继续检索。配置字段和枚举须以所选版本的校验器为准，不能通过在 Manifest 中填写新字符串获得实现。

### 3.2 核对目标机器和本次运行

1. **接入前做静态匹配。** 尚未安装数据集时，先核对协议、注册实现、分发内容与现有测试，部署可用性标记为待验证。
2. **安装后查执行目标。** 先核对当前登录账号/租户与数据集、客户端的可见范围，再在平台已认证的上下文中调用 `GET /api/benchmark/v1/execution-targets?datasetId=<数据集ID>`；[接口实现](https://gitcode.com/openeuler/agent-insight/blob/master/src/app/api/benchmark/v1/execution-targets/route.ts)要求数据集已就绪且用户可访问。检查返回的 Agent、模型、`executionProfile`、`ready`、`canPrepare`、`missingCapabilities` 和 `unavailableReasons`。空结果或不可用结果需结合身份权限、客户端上报与匹配逻辑定位，不能直接推断平台没有此能力。客户端在线或已匹配不等于本次环境检查通过，也不代表新接入代码已部署到平台和 Evaluator。
3. **检查选定 Case 的环境。** 按[第 5.5 节](#55-执行环境准备协议)，使用本次数据集、执行机、Agent、模型及参数触发检查；需要准备时完成准备并复查。目标能力匹配通过不代替 Case 依赖、模型凭据和评测资产检查，`canPrepare` 也不表示已经就绪。
4. **验证执行与评测链路。** 按[第 12 节](#12-测试与验收)验证提交物与权威判定，分别完成执行端检查及 Evaluator Doctor/Smoke。网络和隐藏数据隔离要核对实际后端并验证；任务中声明策略、使用独立目录或执行评测分进程，本身不能证明隔离生效。

没有部署环境时仍可完成静态分析与接入包测试，但须保留运行验证待办，不能写成端到端验收通过。

### 3.3 留下可复核的判断

接入确认单按每项需求记录：采用的组件与配置、源码/测试依据及版本、目标机检查结果、待验证项与下一步。查询结论保存在本次接入或验收记录中，不回填成本文的全量能力清单。

- **已有实现且满足需求**：复用公共组件，开发接入包并完成验收。
- **已有实现但部署未就绪**：列出版本、依赖、配置或权限问题，按已有流程准备后重新检查。
- **协议或实现确有缺口**：说明不能表达或执行的具体要求，进入公共扩展设计。
- **证据不足**：明确还需查询或运行什么，完成验证后再作结论。

### 3.4 配置接入与发现

Benchmark 业务配置统一使用 `config/benchmark/` 和公共配置加载器，不新增依赖普通进程环境变量的业务配置入口。端口、数据库连接、凭据、运行根目录及服务通信地址仍遵循已有部署合同；官方工具要求环境变量时，由适配器将已校验配置映射到本次受控子进程，不形成另一份用户配置。不要把密钥移入可提交的 YAML。

先阅读 README 引用的[公共部署指南](./deploy-services.md)，从[公共加载器](../../../../../packages/project-config/index.cjs)的 `loadProjectConfig`、Schema、默认值与字段校验追踪到实际消费者；类型定义见[配置类型](../../../../../packages/project-config/index.d.cts)。路径移动时按符号检索。下表说明配置职责，不是支持字段清单；具体字段、枚举及覆盖行为以目标版本实现为准。

| 配置范围 | 查询起点 | 本次应确认的职责 |
|---|---|---|
| 平台 | `config/benchmark/platform.yaml` | 数据来源、准备或自动导入，以及平台侧业务策略 |
| 执行端 | `config/benchmark/executor.yaml` | 所选执行组件、来源策略及本机运行参数 |
| 评测端 | `config/benchmark/evaluator.yaml` | 评测依赖、资产、镜像和评测服务业务参数 |
| 接入包描述 | `benchmarks/<key>/benchmark.yaml`、`evaluator/evaluator.yaml` | Catalog 元数据、执行/评测契约及默认资源；不替代项目级部署配置 |

接入确认单必须给出“需要新增或复用哪些配置”以及“哪些范围无需变更”的实现依据，不要求每个 Benchmark 都增加三份配置。接入标识存在于 Catalog，不代表公共配置加载器会接受同名字段；当前加载器拒绝未知字段。确需新增字段时，按目标项目模式补齐 Schema/默认值、类型、适用的默认 YAML、实际消费者、发布分发、测试及指南；不能只向 YAML 添加 `benchmarks.<key>`，也不能关闭未知字段校验来放行。公共配置扩展仍遵循仓库的设计与确认约束。

逐项记录以下配置合同：

1. **来源与覆盖**：字段的类型、允许值、默认值、必填条件、合并顺序、数组及 `null` 语义、加载和重启时机。缺省、`null` 和空字符串不能未经验证视为等价；已迁移业务变量不能作为隐式回退。现有显式部署覆盖（如 `--evaluator-env`）仅按目标实现使用，沿公共转换和校验入口处理，不为新 Benchmark 另建环境变量体系。
2. **目录与路径**：源码部署默认读取项目的 `config/benchmark/<scope>.yaml` 与对应 `*.local.yaml`；安装版执行客户端使用内置默认配置和 `$AGENT_INSIGHT_HOME/config/executor.local.yaml`。显式 `AGENT_INSIGHT_CONFIG_DIR` 的目录选择与优先级继续查询加载器。相对路径按声明文件及加载器规则解析，切换 cwd、安装目录或容器后不能悄悄指向其他资产；用户覆盖不能被升级覆盖。无需读取或复制真实密钥。
3. **消费与交付**：从配置解析值追踪到 Loader/Preparer、执行组件、Evaluator Controller 和所选 Runtime 的实际消费点。确认安装包包含必要默认配置与加载器，资产路径和挂载在目标端可访问。当前评测链通过已校验的 `AGENT_INSIGHT_EVALUATOR_CONFIG_JSON` 传递配置快照；它是内部传递合同，不是新的用户业务变量，不得绕过校验或手工篡改。资源与超时还应满足 Manifest 和 Evaluator 描述的一致性要求。
4. **证据与变更**：保存字段归属、来源路径/版本、消费者、脱敏有效配置和验证方法。实际本地覆盖、配置目录选择及部署快照变化后，旧验收结论必须重新核对；凭据文件不进入公开证据或冻结输入。详细验收见第 12.11 节。

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
└── smoke/
    ├── case.json
    └── index.cjs

test/<key>/                     # Benchmark 专属测试，文件按验证对象划分
├── adapter.test.ts
└── interface.test.ts
```

接入包通过 Catalog 自动发现，不需要在公共注册表手工 import。生成物位于 `generated/benchmark-catalog/`，不得直接修改。

Benchmark 专属测试统一放在仓库根目录的 `test/<key>/`，其中 `<key>` 与 Manifest 的 `key` 一致，测试文件以 `.test.ts` 结尾，确保由默认 `npm run test` 递归发现和执行。根据实际范围补齐 Adapter、Evaluator、执行环境和接口测试，不要求每类固定一个文件；公共协议和共享组件测试保留在现有公共测试位置。新增专属测试不放在 `benchmarks/<key>/tests/`，也不另建薄入口转发这些测试。历史接入包中的测试可以作为实现参考，其目录不作为新增接入的约定。

## 5. `benchmark.yaml`

下面以 Git 工作区和 Patch 提交物说明 Manifest 结构。使用前须按第 3 节确认目标版本及执行机适用；能力标识、提交物、资源和展示字段应根据实际任务填写，不要将此例复制为所有 Benchmark 的默认方案：

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

Benchmark 的实现放在 `benchmarks/<key>/executor/environment.cjs`，属于接入包协议的一部分，独立于平台侧 Adapter 的五个业务 Hook。普通数据集和可靠性数据集使用相同方法合同，通过公共注册入口加载，不需要实现 Benchmark 评测协议。新增或重新验收的可执行接入必须在上述 Manifest 字段中声明此入口；`executor.supported` 省略或为 `true` 均视为支持执行，不因环境简单或无需安装而豁免。仅导入已有提交的接入须显式设置 `executor.supported: false`，无需声明环境准备入口，也不能声明执行端环境模块。

新接入验收使用 `loadPackageForOnboarding`，缺失声明时在 Catalog 阶段失败，不等到页面或客户端执行时才发现。普通 `loadPackage` 与 Catalog 生成保留历史包兼容：未声明的旧包可以继续构建，但不会自动获得环境准备能力，不能据构建成功宣称通过新的接入验收。客户端找不到对应实现时仍提示更新，不会退回普通数据集检查并报告就绪。仅补声明而没有包内有效入口也不能通过现有路径、格式和协议校验；实际环境检查与准备行为仍须按本节及第 12 节验证。

#### 方法与上下文

模块使用 CommonJS，导出两个异步方法：

```js
module.exports = { checkEnvironment, prepareEnvironment }

// 只读检查，返回 { issues: [{ code, message }], prepare: string[] }
async function checkEnvironment(context, services) { /* ... */ }

// 执行自动准备；正常完成即可，最终是否就绪由复查决定
async function prepareEnvironment(context, services, reportProgress) { /* ... */ }
```

`context` 来自平台校验后的选择快照，字段以 [`EnvironmentContext`](https://gitcode.com/openeuler/agent-insight/blob/master/packages/benchmark-protocol/environment.d.cts) 为准：

| 字段 | 含义 |
|---|---|
| `protocol` | 固定为 `execution-environment/v1` |
| `clientId` | 本次执行主机 |
| `dataset` | `id`、`adapterKey`、`revision`、`caseIds`、`faultTypes` |
| `platform` / `agent` | 选定 Agent Runtime 与 Agent |
| `model` / `agentOptions` | 所选模型及可选 Agent 参数；原生默认模型可不指定具体名称 |
| `experiment` | `mode`、`timeoutSeconds`、`concurrency` |

上下文只传公开选择与配置，不传 API Key、隐藏测试或私有评测数据。模型凭据由执行机本地配置解析。

`services` 由通用执行器注入，提供所选执行方式需要的公共检查与准备能力。接入模块组合这些能力，并按 `context` 选择要求；公共编排服务和前端不判断 Benchmark 名称。新增可复用的环境能力时先扩展公共服务，再由接入模块调用。

#### 检查结果与编排

| 返回内容 | 通用执行器行为 |
|---|---|
| `issues` 非空 | 返回 `needs_action`，提示用户配置；本轮不执行自动安装 |
| `issues` 为空、`prepare` 非空 | 调用一次 `prepareEnvironment`，然后重新检查 |
| 两个数组均为空 | 返回 `ready` |
| 准备抛错，或复查后仍有待准备项 | 返回失败，可再次点击“下一步”重试 |

`issues` 表示需用户处理的问题，例如缺少模型 API 配置、Docker 权限或系统构建工具；`message` 应说明去执行机处理什么，不输出凭据或原始安装日志。`prepare` 是接入模块内部的待准备项标识，例如 `sandbox`；通用执行器仅据其是否为空决定是否调用准备方法，不把它当作远程命令。

检查必须只读，不能在检查方法中下载、编译或安装。准备方法应能重复调用并复用已满足的环境，通过公共服务复用安装锁与版本校验；只准备当前数据集和所选 Agent 需要的组件，不因其他 Runtime 缺少组件阻断本次实验。无需自动安装的接入也应导出准备方法，此方法不会在 `prepare: []` 时调用。

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

通用实现见 [`services/executor/src/environment/`](https://gitcode.com/openeuler/agent-insight/tree/master/services/executor/src/environment)，完整设计见[实验执行环境准备](https://gitcode.com/openeuler/agent-insight/blob/master/design/evaluation/experiment-environment-preparation/phase2-requirements-design.md)。

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

导入数据集时，默认保留官方数据集名称。

手动安装命令：

```bash
npx tsx scripts/benchmark/install-dataset.ts \
  --benchmark <key> \
  --profile <profile> \
  --source <dataset-file-or-directory> \
  --name <display-name>
```

目录来源按解析后的 Case 规范化内容计算指纹，文件来源保留文件字节摘要。目录不得使用导入后删除来源选项。

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

统一准备入口为 `npx tsx scripts/benchmark/ensure-dataset.ts --benchmark <key>`。数据库已存在当前 Profile 版本且未指定 `--refresh` 时，跳过全部来源访问与本机准备依赖。显式刷新仍遵守实验数据冻结：已引用的数据集不能覆盖，可指定新 `--name` 安装另一版本。

<a id="startup-dataset-import"></a>

### 7.2 启动自动导入

新增 Benchmark 接入必须接通平台正常启动命令 `bash scripts/start.sh` 的数据集自动导入流程，并在 `config/benchmark/platform.yaml` 提供默认启用的导入配置。沿第 3.4 节的公共配置链贯通 Schema、默认值、类型、加载器、Loader/Preparer 和启动消费者，默认启动后应能查询到已安装的数据集。具体字段按目标版本实现确定，单独提供手动导入命令不满足该要求。

- 默认配置声明所需来源与安装范围，授权凭据沿已有安全配置入口提供。首次安装所需授权或资源缺失时，启动结果和日志应明确指出导入未完成及处理方式，不能将平台页面可访问视为数据集导入成功。
- 重复启动应复用已完成的同版本安装，避免重复 Case 或覆盖被实验引用的数据。失败后按安装事务与恢复合同重试，释放本次锁和临时资源，部分记录不能被标记为已安装。版本更新沿既有刷新和冻结规则处理。
- 用户明确关闭自动导入时，通过部署覆盖配置表达，项目默认配置仍保持启用；安装或升级应保留用户覆盖。验收在隔离部署验证默认启用路径，用户部署按其覆盖配置运行。

真实启动与落库验收见第 12.10 节。

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

Runtime 参数沿用[公共参数合同](../../../reference/platform/api-and-contracts.md#runtime-json-参数接入)，由客户端声明、校验和交付，平台冻结完整配置及契约摘要。默认模板变化不覆盖已有草稿或历史快照；执行前核对实际目标与合同版本。具体 Runtime 的配置和调用方式按需查阅专属指南。

#### 执行后端与能力

可选 `AgentTaskEnvelope.execution` 表达冻结的公开 Profile 与环境：`oci-image` 包含镜像、架构与工作目录，`workspace` 复用任务已有的工作区声明。公共层验证结构、身份和摘要；后端验证能否兑现网络、资源和环境要求。仅在目标声明 `execution-backend/v1` 且 Profile/Runtime 就绪时生成；旧信封可解析不表示旧客户端支持新执行方式，也不能通过剥离字段改变已冻结的执行策略。

执行配置采用 `profiles.<key>.backend/options`，后端专属字段由对应配置模块校验，执行端按后端探测并汇总。`xgovernor` 负责 Docker/cgroup、安装、Worker 与 Trace 检查；`local` 复用原生 Runtime 和工作区，要求可回传 Trace，只接受 `client-default` 网络和无沙箱声明，不宣称 Docker 资源隔离。独立后端的失败不阻断其他就绪目标。具体配置与旧格式兼容见[部署指南](./deploy-services.md#执行-profile-的后端配置)。

客户端上报 `executionBindings` 与公开 Profile；平台据此匹配，缺少必需 Profile 不回退到本地。只有旧客户端未提供 bindings 时才使用旧 SWE-bench 默认约束。配置阶段拒绝同一 Benchmark/平台的多个绑定；异常重复候选明确为不可用，不按数组第一项选择。新增后端须在配置解析、探测与实际执行注册处实现并分发，不接受 YAML 指向任意代码。

执行后端实现 `prepare/runAgent/collect/cancel/close/recover` 六方法。Runner 只持久化不透明句柄，统一管理阶段期限、产物、上传和清理；资源创建前记录归属，取消及恢复只处理本次资源，状态不明时不得假定清理完成。提交物和 Trace 先持久化再上传，恢复上传不得重跑 Agent。

执行环境检查与准备统一遵循[第 5.5 节](#55-执行环境准备协议)，独立于 Adapter 的五个 Hook。所选环境的网络、凭据、文件可见性和资源边界须实际验证；具体后端的安装、模型解析和镜像适配见[执行器开发设计](../../../../../design/evaluation/benchmark/executor.md)及[原生后端开发设计](../../../../../design/evaluation/benchmark-xgovernor-local-docker/phase2-requirements-design.md)。

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
- 主指标和得分须保持官方评分语义。未展示为指标的内容，不得因此从应交付的原始评测证据中删除。
- 不让前端从 Evidence 猜测业务计数；
- `nativeMetrics` 保留 Benchmark 原生指标，归一化 `evidence` 保存审计引用和简要事实；它们不替代用户可查看、下载的原始评测附件。

## 9. Evaluator 开发规范

部署入口 `scripts/evaluator.sh start` 只启动通用 Controller，不接受 Benchmark 选择、Runtime 预热或应用层鉴权参数。Controller 收到任务后，才根据 `benchmark.key + evaluator.key` 从 Catalog 解析并准备对应 Runtime；相同内容摘要的镜像直接复用。Agent Insight 与 Controller 之间不发送或校验 Bearer Token，部署者必须使用白名单、安全组或防火墙限制双向访问。这里的服务互访边界与 `evaluator.yaml` 的 `network` 不同：后者只约束实例 Runtime 执行评测时的容器网络策略。

Evaluator 业务配置沿用[第 3.4 节](#34-配置接入与发现)的公共加载与校验路径；Catalog 描述、部署配置和内部配置快照分别承担各自职责。

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
- `network`：`deny` 或 `allow`。`deny` 使用 Docker `network_mode=none` 隔离外部网络，同时保留容器内部 `localhost` 解析与回环套接字；`allow` 使用 bridge 网络。实例创建的嵌套 Case 容器也必须落实所声明策略。

Entrypoint、Smoke 和 Dockerfile 必须位于接入包内。Catalog 按接入包内容摘要生成 Runtime 镜像 tag，并在运行时校验镜像 label；发布方可用 `node scripts/benchmark/build-evaluator-runtime.cjs <key>` 构建该制品，增加 `--image-prefix registry/namespace --push` 可上传到指定仓库。默认 OCI 准备路径优先复用本地匹配制品，缺失时按已配置的来源拉取或构建；具体回退由声明和目标版本实现决定。声明 `requiresPrebuiltRuntime: true` 的接入包禁止该回退，本地引用必须预装，远程引用允许按需拉取。运行依赖归接入包制品所有，不要加入通用 Controller 基础依赖，也不要在 Controller 公共代码中加入 Benchmark 分支。

Runtime 制品摘要必须覆盖实际运行所需的接入包与公共依赖；构建验证应在独立分发目录加载真实 Entrypoint 和 Smoke，防止开发仓库的文件或依赖掩盖漏包。摘要计算和打包布局以[Catalog 生成器](../../../../../scripts/benchmark/generate-catalog.cjs)及实例 Dockerfile 为准。

接入包可选声明 `assets`：`image` 必须为固定 `repository@sha256`，同时声明镜像内 `sourcePath`、`releaseId`、`bundleDigest`、可选部署目录变量名 `directoryEnv`、`verifyCommand`（`python3` 或 `node`）及包内 `verifyEntrypoint`。Controller 在启动后台准备资产，调用校验器时依次传入目录、release ID、bundleDigest。校验器只读取文件与元数据，不执行 Judge 或构建任务。

通用安装器按镜像摘要创建版本目录，拉取后从未启动容器复制、校验，再原子发布；并发请求共享准备状态，重启重新校验缓存。默认存储根为 `<EVALUATOR_DATA_DIR>/benchmark-assets/<benchmarkKey>`；配置 Schema 注册了 `benchmarks.<key>.assetsDir` 的接入包使用该 YAML 字段，`null` 使用默认根目录，不再回退旧目录变量。未注册此字段的其他接入包仍可使用 `directoryEnv`。实际目录仍追加摘要。OCI 资产必须在 Controller 与 Runtime 共享卷内。Provider 的第三个参数 `assetsDir` 和 Runtime 环境 `EVALUATOR_ASSETS_DIR` 均为该接入实际解析出的版本目录，不从任务 payload 获取，也不修改全局环境变量。

准备期间 admission 返回可重试的 `EVALUATOR_ASSETS_PREPARING`、`EVALUATOR_ASSETS_DOWNLOADING` 或 `EVALUATOR_ASSETS_VERIFYING`；安装失败返回不可重试的具体错误。健康检查通过 binding 的 `runtimeFacts.assetStage/assetErrorCode` 暴露状态，平台在健康检查和下发响应两条路径均保留错误及详细原因。没有声明资产的接入包不增加准备流程，公共 Controller 不含 Benchmark 专属准备分支。

#### Runtime 镜像生命周期与清理

Runtime 镜像是可重新拉取或构建的评测制品，不是永久缓存，也不能作为提交物、Evidence 或运行日志的唯一存储位置。接入包复用公共 OCI 入口与清理策略，不自行扫描删除其他版本、不改写公共归属记录，也不执行全局 prune。

- **版本与归属**：继续使用 Catalog 生成的内容摘要 tag 和镜像 label。公共 `prepareOciRuntime()` 发起 pull/build 前，通过 `recordManagedImage()` 在 `<EVALUATOR_DATA_DIR>/managed-images/` 登记 `reference`、`daemonId`、`role: runtime` 和 `uncertain: true`；制品校验通过后补全本机 Image ID，并置为已确认。直接命中的预装/手工构建镜像只复用，不自动接管归属；不能仅凭仓库名认定镜像可删。
- **自动清理**：`scripts/evaluator.sh start` 在新 Controller 通过 Doctor 后，调用公共 `runtime-image-cleanup.cjs` 清理已登记的旧 Runtime；清理失败只警告，不停止已经启动的服务。正常启动只打印检查与清理摘要，异常仍保留具体原因。
- **在线管理**：`images list`、`images purge --dry-run` 和 `images purge` 均使用运行中 Controller 的 Catalog、配置和数据目录，不使用宿主工作区的 Catalog。`purge` 同时处理空闲 Case 镜像池和旧 Runtime；关闭 Case 镜像池不影响 Runtime 清理。预览不删除镜像或归属记录，手动命令保留完整结果。
- **保护边界**：只清理同一 Docker daemon、同一数据目录内归属已确认的旧 Runtime。当前 Catalog 所需的原始/有效镜像引用及相同 Image ID、被任意容器（包括已停止容器）引用、操作未确认、引用已改写或存在额外标签/其他仓库 digest 的镜像均保留。删除前重新核对归属，按已确认 Image ID 非强制删除；Docker 检查或删除发生冲突时报告并保留，不为清理而停止任务、删除容器或强制解除引用。
- **接入职责与范围**：实例运行和恢复必须沿用公共容器标签与独立工作目录，不能绕过公共入口创建无归属的 Runtime。此策略不接管 Case Runner、`assets` 资产镜像、未登记的历史镜像、无标签镜像或构建缓存；Case 镜像的保护和回收遵循第 9.5 节镜像池协议，不能把这些对象当作旧 Runtime 一并删除。

操作命令与保留原因见[部署指南：立即停止与镜像清理](./deploy-services.md#11-立即停止与镜像清理)。不新增 Benchmark Manifest 字段或 HTTP 管理接口。

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

`rawResult` 必须符合 `schemas/result.schema.json`。Evidence 的 `name` 可以是安全、唯一的相对路径（如 `judge-evidence/vuln-result.json`），总长不超过 512、最多 16 段，每段长度为 1～128，支持中文、Unicode 与内部空格；禁止绝对路径、空段、反斜线、控制/双向控制字符、`:`、`<>"|?*`、尾随空格/点和 `.`/`..`。`path` 及其真实文件路径必须位于输出目录。证据支持零字节日志，单文件仍限制 64 MiB；提交物的非空要求不变。平台按 Artifact ID 存储文件，保留原相对路径用于前端可展开目录与证据包，不直接将其作为落盘文件名。每个实际产生的 Evidence 都应返回，不能因 Presentation 未配置而丢弃。

Benchmark 专属证据的文件集合、业务一致性与采集限制由实例实现定义，按需查阅[Evaluator 开发设计](../../../../../design/evaluation/benchmark/evaluator.md)。

#### 原始产物交付与来源

**先按对应版本的官方文档确定证据范围，再用官方评分程序核实或补充。**

1. 官方文档明确说明正式报告、结果文件或相关日志时，以其定义作为首要范围依据，并核对固定版本及本次运行参数实际产生的文件，保留原名、相对目录和内容。
2. 文档未说明或不完整时，追踪同版本官方评分入口的文件写出、返回值和诊断输出，补齐证据范围及业务含义。没有原生文件时记录实际返回，不能为套展示模板制造“官方报告”。
3. 文档与程序不一致时，先核对文档/代码版本、入口和参数，记录差异及处置依据；不能默默选择一边、编造缺失产物或忽略应交付的结果。差异有明确依据时如实说明；影响判分或证据范围且仍无法确定时，与用户对齐后再推进依赖步骤。

程序产生的所有文件不一定都是评测证据。缓存、输入副本、依赖资产和中间文件不能仅因出现在输出目录就全部展示；本次实际错误和必要诊断可以作为来源明确的补充，不冒充官方规定的必需报告。在已有接入确认单中记录官方文档链接/仓内位置、版本和章节，以及程序核实、补充或冲突处置依据和纳入/排除范围，不另建重复清单。

官方评测实际输出的文件集合、名称、相对目录和内容决定用户获得的证据，不统一改名为 `report.json` 或 `evaluation.json`，不以平台摘要替代原件。协议通信文件 `result.json` 不属于官方报告；示例中的附件名仅为占位。官方只返回内存结果时，接入层应忠实序列化实际返回值，不丢弃明细、不冒充 CLI 原生报告；官方未提供的信息不补造。

Entrypoint 可以在输出 JSON 增加 `evidenceRoot`，值为输出目录内的相对目录（`.` 表示输出目录），声明本次官方产物根目录。公共层遍历输出目录（排除顶层通信文件 `result.json`），自动补收未列入 `evidenceFiles` 的普通文件；根目录内的文件名称必须等于相对该根目录的原路径，改名或压平目录会失败。输出目录只写按上述依据选定、需要交付用户的结果和诊断；私有输入、凭据、依赖缓存和任意临时数据不得写入该目录。公共层扫描用于防漏传，不判断文件业务含义，evidenceRoot 也不是过滤输出目录其他文件的开关。若官方工作目录混有缓存或中间文件，接入层应先按已确认范围把原始产物交付到受控输出目录，保持原名、相对目录与字节，不改变官方评分逻辑；不能先输出全部文件再期待平台自动筛选。符号链接、越界、名称冲突和超限文件会形成明确采集问题，不静默删改。

`evidenceFiles` 每项可声明 `source`：`official-file`（官方文件）、`official-return`（官方接口返回记录）、`runtime-output`（运行输出）或 `platform`（平台补充）。未声明时为 `runtime-output`；`kind: official-report` 本身不是官方来源证明。来源是接入方声明，仍须由专项测试验证官方调用与产物映射。旧实例无需变更输入即可运行，但公共输出目录采集不能证明其代码没有在写文件前丢弃官方返回值。

Controller 在 `runtimeFacts.evidenceCollection` 保存 `schemaVersion: evidence-collection/v1`、`scope`（`official-directory`、`output-directory` 或直接实现的 `declared`）、`complete`、`issues` 以及逐文件的 `name/source/sha256/sizeBytes/artifactId`。这表示声明范围内的采集情况，不认证官方算法或返回值完整性。上传前核对原始清单，回调端核对清单与所引用附件的名称、摘要、大小和归属；携带不完整清单的正常完成不予接受。无清单的历史回调保持兼容，不能据此宣称满足新接入的证据验收。

脚本/容器进程非零退出或超时后，仍收集已经产生的文件，保存 stdout/stderr 原始日志，并附平台错误诊断；错误文字中的短摘要不替代日志。平台日志使用独立名称，冲突时调整平台日志名称，不改变原生产物名称。取消后仍遵从原取消流程，不承诺已取消任务一定完成证据上传。单文件超过 64 MiB 时报告交付缺口，受控运行目录保留原件，不截断冒充完整附件。

平台按 Artifact ID 存储，下载提供 Unicode 原名；单文件下载保留末级名称，页面目录树保留相对目录。分别下载同名文件不能保留目录结构；需要完整目录时由评测输出提供原生归档，当前未新增批量归档接口。附件使用公共预览器，摘要、分数和结论单独展示。来源标签区分接入声明、运行输出和平台诊断。

所有附件进入 Adapter 前均核对字节完整性。JSON 仅作便利解析：无法解析的诊断附件继续保留原字节，并提供 `jsonParseError`；依赖该附件判分的 Adapter 必须拒绝缺失的 `jsonContent`。`completion.rawResult` 的结果 Schema 校验和实例必需报告校验继续严格执行，不能因保留诊断而放松评分正确性。

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

后台准备不占评测执行槽。重评创建新 Evaluation 后先尝试刷新窗口再下发评测；收到 `IMAGE_POOL_PREPARING` 时也刷新窗口，避免只重试评测而未触发准备。准备请求失败保留评测队列，后续重试及评测 watchdog 定期补偿。执行 watchdog 在启动恢复前注册，历史实验恢复逐条隔离异常，避免单条已取消任务阻断后续恢复或后台调度。无镜像依赖的包不需要实现以上 hook。主机配置、空间口径、异常恢复及性能指标见[部署指南](./deploy-services.md#53-可选跨-benchmark-共享镜像池)。

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

### 执行中的主链路回调

执行器发现本次唯一根会话后，立即使用现有 `POST /api/benchmark/v1/runs/{runId}/progress` 上报，不等待 Agent 结束：

```json
{
  "kind": "execution",
  "stage": "agent_running",
  "progress": { "message": "正在运行 Agent", "traceId": "本次根会话 ID" },
  "occurredAt": "2026-10-27T06:00:00.000Z"
}
```

`progress.traceId` 是可选的业务根会话键（对应 `Execution.taskId`），不是 OTLP 的十六进制 trace hash。未发现根时省略；同轮后续阶段和心跳持续携带同一个 ID。公共本机 Runtime 通过 `input.onTraceId({ traceId })` 通知 Runner，其他执行后端使用 `context.onTraceId({ traceId })`；回调只补链路，不能推进或重置执行阶段。动态派生会话不得替换根会话。

服务端以 `runId + 已认证 clientId` 校验归属，在事务中锁定对应 Case，再首次绑定 `runFactsJson.traceId`。相同 ID 幂等，不同 ID 返回 `TRACE_ID_CONFLICT`，其他重试已使用的 ID 返回 `TRACE_ID_REUSED`；非法 ID 返回 `TRACE_ID_INVALID`。完成回调的 `runFacts.traceId` 必须与提前绑定一致，省略时保留原值。旧 Run 的迟到上报只补旧 Run；终态允许补根 ID，但不改阶段、终态或计时。阶段顺序为 `preparing → agent_running → collecting → uploading → cleaning`，较早阶段及同阶段较旧回调不能覆盖当前阶段或阶段时钟，即使它们携带此前未收到的根 ID。更新采用条件写入，竞争失败后重新读取，避免进度与完成回调相互覆盖。

### 10.2 Evaluator

`presentation.evaluator` 提供 `displayName/description/runMode/outputDescription`。这些是实例业务文案，公共 React 组件不应根据 Benchmark key 推断名称。

### 10.3 主指标

`presentation.result.primaryMetric.path` 当前固定为 `primaryMetric.value`。可以声明：

- `label`：Case 指标名称；
- `aggregateLabel`：趋势聚合名称；
- `trueLabel/falseLabel`：布尔文案；
- `format/precision/unit`：受控数字格式。

`format: percentage` 接收已经换算好的百分数。对正确率等 `0～1` 的比例，展示输入应换算为 `0～100`，例如传入 `42.5` 显示为 `42.5%`。公共格式化只按精度取舍并追加 `%`。接入时应明确转换发生在哪一层，确保 Case、评分点和适用的汇总视图各换算一次，官方原始指标及证据仍保留原值。

### 10.4 Artifact

`presentation.artifacts` 每项必须且只能按以下一种方式匹配：

- 精确 `source + name`；
- `source + kind`。

`source` 为 `submission` 或 `evidence`。规则只设置 `label/order`；前端匹配顺序是精确名称、类型、原始名称兜底。API 始终返回完整 `submissions[]` 和 `evidenceArtifacts[]`。

新增 Benchmark 接入时，应检查官方评测产物的格式及阅读方式。平台尚不支持查看，或现有文本展示无法满足该格式的正常阅读需求时，应将补齐公共查看能力纳入接入交付范围。优先复用公共格式识别与渲染组件，缺失能力通过公共层扩展实现，并使用本次真实产物验证内容完整性和必要交互。

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

上述生成命令用于兼容构建；新接入验收必须调用 `loadPackageForOnboarding(packageDir)`，自动接入工具也使用该入口。环境声明的适用范围、豁免和历史兼容规则以[第 5.5 节](#55-执行环境准备协议)为准。目标缺少严格入口时先核对协议和适配桥接，不能静默退回兼容加载后报告通过。

声明环境准备入口时，还须验证协议兼容、入口与传递依赖随执行端安装包分发、文件变更更新内容摘要，以及未声明 `gitSourcePolicy` 时仍能加载环境模块。回归须同时证明历史兼容构建仍可用、新接入缺入口被拒绝、仅导入提交的豁免有效，以及合法环境模块能够通过并进入分发清单。

Catalog 目录扫描排除 `__pycache__/`、`*.pyc`、`*.pyo` 和 `.DS_Store`，这些运行缓存不参与包摘要、Runtime 摘要或执行器文件清单。真实源码、依赖配置与评测资产仍参与原有摘要计算；新增或修改缓存不应改变生成物，修改真实输入必须更新对应摘要。

### 12.2 Adapter 单元测试

专项测试位于 `test/<key>/`，可以单独执行以快速验证当前接入：

```bash
node --import tsx --test "test/<key>/**/*.test.ts"
```

专项运行不代替默认回归；交付前还必须按第 12.4 节运行 `npm run test`，确认本次新增测试实际被发现并执行，保存结果及覆盖范围。测试文件存在或专项命令通过，不能独立证明默认测试流程已经覆盖该接入。

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

测试必须等待本次后台任务收敛后再释放数据库、恢复配置和删除临时目录，不能仅凭 Case 终态认定后台工作已结束。具体测试 Helper 与收尾顺序见[开发测试约定](../../platform/conventions-and-extension.md#benchmark-测试的后台任务收尾)。

```bash
node --import tsx --test \
  test/benchmark-extension-conformance.test.ts \
  test/benchmark-presentation.test.ts \
  test/benchmark-experiment-wizard-ui.test.ts \
  test/execution-environment.test.ts \
  test/execution-environment-api.test.ts

npm run test
```

交付前将适用的接口和专项测试合并进一次默认回归，避免先逐项执行再完整重复同一批测试。开发和修复阶段先跑受影响的专项测试。真实链路与边界覆盖按第 12.6～12.9 节组织，不将每个验收场景都扩展为一次真实 Agent 运行。

### 12.5 验收矩阵

验收记录应关联第 3 节的能力查询结论，记录实际版本、目标配置和测试结果。未验证的能力或环境单独列出，不将静态匹配、Mock 测试或组件注册当作端到端通过。

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

### 12.6 分层验证顺序与测试矩阵

默认验收按三组组织；L1/L2/L3 表示证据覆盖层次，不要求分别启动三轮运行：

| 组别 | 默认执行内容 | 通过依据 |
|---|---|---|
| 本地检查（L1） | 复用已有测试与夹具，检查数据、可见性、Catalog、Adapter、环境入口及本次改动；交付前合并运行仓库要求的默认回归 | 输入、权限、身份、提交与结果合同的正反断言通过，明确真实/Mock 范围 |
| 固定提交评分对照（L2 评分） | 使用冻结的正确、错误、非法和边界提交，验证真实评分服务并对照官方基线，不启动 Agent | 请求、终态、返回结果与同一输入的官方结果一致，清理完成 |
| 跨类型完整用户链路（L3，含 L2 执行证据） | 至少 3 个、通常 3–5 个不同类型的代表性 Case，逐例从环境检查/准备到创建、执行、上传、评分、结果查询与清理 | 实际 Agent 提交与评测身份、字节和证据贯通；首例直接计入结果，不为 L2 执行另跑模型 |

验收计划只补本次新增、改变及关键边界的断言；已有公共接口测试直接引用其命令、版本与覆盖范围，不为每次接入重写完整平台测试。数据安装仍验证声明安装范围，小样本真实运行不等于全量数据通过。接口成功、Doctor、Mock、评分对照均不能单独证明端到端成功。

选样先查官方仓库/数据集的类别、子任务或元信息；没有官方分类时按任务语义、输入/提交形式或执行路径差异说明依据。记录 Case ID、类型、选取理由和未覆盖类型，不能只选同类型容易题凑数。类型少于 3 类时覆盖全部类型并选至少 3 个不同 Case；官方可用 Case 总数不足 3 个时全部覆盖并注明限制。超过 5 个按覆盖缺口追加；成本或环境需缩减时先与用户对齐并声明覆盖不足，本地夹具和固定提交不抵扣真实 Case 数。

本地检查和固定提交评分对照通过后运行首例完整链路，再完成其余冻结样本；首例计入结果但不能单独代表完整验收。独立执行段或额外真实失败运行仅在任务语义、改动风险或明确覆盖需求要求时增加，并在计划中说明；非法提交、摘要错误、状态拒绝等优先在本地或固定提交评分组覆盖。至少保留一个本次相关的边界/失败覆盖，注明层次，不要求所有矩阵场景都通过真实模型执行。执行与评分因官方反馈/状态语义耦合时，事先明确验证方案，不以缺环境为由省略必需证据。

逻辑检查可以由同一驱动的不同操作或已有测试命令实现，不要求每个类别单独创建脚本。计划记录来源和版本、身份、输入、关键断言、异步终态、期限、证据及清理即可；详细数据、配置和证据要求分别见第 12.10、12.11、12.9 节。

### 12.7 按阶段验证实际入口

以下为当前项目的定位线索，使用前核对目标版本源码与身份机制；请求示例中的标识必须来自本次合法测试数据。用户会话、设备身份和服务间请求合同分别使用各自认证机制，不在脚本、矩阵或报告中保存密钥。

| 阶段 | 当前入口线索 | 关键断言 |
|---|---|---|
| 数据安装 | `scripts/benchmark/install-dataset.ts`、Loader/Preparer；安装后的数据查询入口 | 数据版本、数量、Case ID、公开/私有指纹符合锁定来源；不可覆盖已引用的冻结数据 |
| 目标匹配 | `GET /api/benchmark/v1/execution-targets` | 数据集和账号归属正确，目标的 Agent、能力、配置和不可用原因与实际情况相符 |
| 环境准备 | `POST /api/experiments/environment-preparations` 与对应任务 GET | `202` 是接受；等待 `ready` 才放行，`needs_action/failed` 保留原因；同一选择和版本的复查证据可关联 |
| 创建与启动 | `POST /api/experiments`、`POST /api/experiments/:id/run` | 数据集、Case、Agent、资源和接入版本正确冻结；实际任务被派发；启动的接受响应不当作完成 |
| 执行进度与完成 | `/api/benchmark/v1/runs/:runId/progress`、`/complete` | 设备归属、任务上下文、进度与终态合法；重复和迟到回调遵守实际状态机；错误不伪装成成功 |
| 提交上传和读取 | `POST /api/benchmark/v1/artifacts`、对应 Artifact content GET | 下载后重新计算真实字节摘要，核对归属、名称、MIME、大小、必需集合与私有边界 |
| 评分及评测回调 | Evaluator 的 `POST /api/v1/evaluations`；平台 evaluations 下 progress/artifacts/complete | 请求摘要、上下文和提交身份一致；官方 Harness 真正执行；原生结果、归一化结果和 Evidence 一致 |
| 查询、重评和停止 | Benchmark 实验结果 GET、目标版本实际重评/取消入口 | 查询到对应 attempt 的终态与指标；适用重评复用原提交；停止后任务、子进程、容器及待派发工作实际收敛 |

L1 可以构造回调请求检查合同和异常，但使用隔离测试身份与记录，不改写其他实验。L3 中不能由验收程序伪造 execution/evaluation complete、上传预制答案替换真实 Agent 提交，或绕过平台调度直接拼接结果。API 模拟测试和真实运行保留独立记录。

### 12.8 分段真实集成与完整端到端操作

#### 执行段（默认随首例完整链路采证）

以下断言放入本节“完整端到端”的首例，不另创建任务；只有已说明的语义或风险需要时才独立执行。

1. 固定官方 Case、接入包摘要、Agent/模型、执行配置及预算；准备的输入仅含公开数据，核对本次执行环境。
2. 在首例完整链路中通过实际入口让 Agent 执行；等待执行终态，保存实际运行记录、适用的 Trace/进程证据及失败原因。
3. 获取该执行产生的 Submission，读取真实字节并验证摘要、格式、归属和最小业务语义。Agent 未答对不等于执行链路失败，但缺失或不合法提交不能宣称本段提交链通过。
4. 检查任务所需的文件、网络和隐藏数据策略；记录本段资源清理。此时不因尚未评分而编造业务通过结论。

#### 评分段

1. 使用第 12.3 节要求的已知结果样例及冻结的正确、错误、非法/缺失和边界提交，保留官方独立判分结果与输入摘要。
2. 通过实际 Evaluator 入口交付合法请求和该提交，等待对应评测 attempt 终态，保存 Harness 原生输出、运行版本、Evidence 和清理事实。
3. 核对同一输入的官方判分与接入判分，包括状态、原生指标、归一化、主指标和聚合；Judge/随机过程按事先锁定的模型、Prompt、参数、重复次数和容差判断。
4. 若评分依赖环境快照、句柄或执行中反馈，验证真实恢复/交接过程及其充分性；不能仅用文本日志替代状态，也不能移除官方反馈时序。无法独立运行时采用已记录的耦合真实验证方案，缺能力则保留待办。

#### 完整端到端

1. 确认本地检查和固定提交评分对照通过，本次接入已部署至所需组件；记录版本，安装或验证冻结数据，按第 12.6 节的选样要求冻结 Case ID 与选样依据。
2. 查询匹配目标，按本次数据集、Case、Agent 和配置完成环境检查/准备并等待就绪。Doctor、客户端在线和可选目标分别记录，均不代替本次就绪结果。
3. 默认在页面完成环境检查/准备后，从实际用户入口创建、启动实验；采用等价自动化入口时，也必须覆盖该准备及复查链路，不直接跳到创建接口。立即保存请求标识及返回的实验/任务标识；后续恢复先查已有任务，不重复创建。
4. 有界查询实验和关联运行，观察真实执行、提交上传、评测派发与官方判分；实际执行器和 Evaluator 负责上报进度和完成。
5. 对真实提交和评测证据核对字节、摘要、版本及身份关联。评分可重放时，将本次 Agent 提交交给独立官方入口比较；不可独立时保留同状态下的权威判定证据及限制，不以预制提交的评分对照冒充本次执行结果。
6. 查询最新 attempt 及每个选定 Case 的业务结果、指标、证据和实验聚合。分页查询须覆盖全部声明 Case，区分“业务失败且链路正常”与基础设施故障。
7. 在隔离测试范围内验证适用的重评、重复请求、取消/超时或恢复路径。至少保留一个与本次接入相关的边界/失败测试；说明它在 L1、L2 或 L3 的覆盖层次，不把合成失败案例写成真实端到端覆盖。
8. 在成功、失败及异常退出路径执行并核对清理，再保存最终分层结果。环境缺失、任务未结束、证据缺失或必需清理未完成时保留待办，不输出完整验收通过。

### 12.9 异步等待、关联证据与清理

- **身份关联**：区分 Skill 的接入记录 ID 与平台运行 ID，逐 Case 记录数据集 ID/版本、externalCaseId 与内部 Case ID、实验 ID、执行 Run ID、Artifact ID/摘要、评测 ID/attempt、Evidence ID/摘要。各阶段必须对应同一冻结数据和提交；重评允许产生新评测 attempt，不能混用旧终态和新结果。
- **证据记录**：每次调用保存层次/阶段、时间、方法与实际入口、脱敏请求/响应、HTTP 状态、业务状态、断言结果及关联 ID；大文件保留受控位置和摘要。服务端真实查询与 Agent/运行时、Harness 的原始证据一并保留，不能只保存最终 `pass`。鉴权头、密钥与隐藏数据不进入公开报告。
- **异步等待**：按目标合同区分已接受、运行中、需处理和终态，设置单次请求、阶段、总试验和清理期限。轮询采用有上限的间隔/退避；等待必须释放控制权，允许宿主汇报进度。到期保存最后响应和在途 ID，再取消或查询，任务达到明确终态且清理确认后立即结束等待；不能无限等待或重复发起。
- **重试边界**：只按接口实际幂等合同和可重试错误处理。传输结果未知时先查询已有任务；未提供幂等或状态不可确认时进入待处理。评分一致不能由“两边都发生基础设施错误”得出。
- **清理与收敛**：使用测试资源清单，等待属于本次试验的任务、子进程、容器、后台派发与临时工作区收敛；保留提交、日志及 Evidence 的受控副本。只处理本次资源，不能扫描删除共享镜像或其他实验；环境准备可能复用缓存，记录保留原因，不要求删除共享资产。
- **进入与通过条件**：真实测试驱动必须核对本地检查、固定提交评分及其输入摘要后执行 L3；L2 执行断言在该首例中完成，不作为独立运行前置；前置失败即停止对应后续步骤并留证据。通用验收 CLI 按计划调用命令，并不自动推导这些依赖或轮询接口；驱动程序需实现相应门禁。必需项未执行、缺条件和语义不适用分别记录，不通过修改可选性掩盖缺口；仅声明范围内全部必需检查和清理完成才可验收通过。

修复前先说明受影响的代码、数据、配置、部署或驱动断言。开发期只重测受影响项，修复确认后再发起正式验收；证据复用须核对相关输入、版本、摘要及覆盖范围。仅评分变化时优先沿目标支持的重评入口复用原提交；真实执行受影响时重跑对应 Case。不能仅因一次格式或断言错误重启所有已完成任务，也不能把旧通过结论写成新版本验收。

### 12.10 数据集安装：文件、持久化与一致性验收

新增接入须在隔离数据目录和空数据库中，通过真实 `bash scripts/start.sh` 验证第 7.2 节的默认自动导入。保留默认启用配置，使用项目默认资产路径，只设置隔离运行所需的数据目录和通信参数。默认不创建 `*.local.yaml`。用户明确要求使用非默认部署配置时，单独记录覆盖项和验证范围；覆盖路径成功不能证明默认路径可用。保存脱敏有效配置、启动日志及启动后的持久化查询，并完成下列内容核对。手动安装接口或直接调用导入脚本仅提供补充证据。缺少默认启动自动导入证据时，按原因记为受阻或失败。

数据集安装必须验证实际内容与持久化结果，不能只凭安装接口成功、文件存在或数量相等判定通过。先查询目标 Loader、安装事务、查询接口、数据模型及存储配置，确定实际表/索引、文件/对象存储位置和版本；这些属于目标项目的动态发现结果。

| 必检项 | 实际操作与通过依据 |
|---|---|
| 文件或对象内容完整性 | 读取并解析实际内容，核对来源 revision/split、Schema、大小、摘要、数量、Case ID 集合和唯一性；发现缺失、损坏、截断或解析错误。远端 HEAD/ETag 不能独立证明内容正确，大型数据可流式核验。 |
| 数据库或索引正确性 | 通过能证明持久化结果的查询接口、只读 ORM 或数据库查询，核对安装状态、数据集/版本、账号或租户归属、Case 映射、关联和公开/私有字段存放位置；分页覆盖声明安装范围。无数据库时验证真实索引/清单。 |
| 持久化记录与文件一致性 | 按 Loader/Adapter 的确定性转换规则核对 Case 集合、字段映射、版本、内容指纹和资源引用；列出漏导、重复、多余记录、串版本、错误路径、悬空引用及本次资源清单中的残留文件。规范化前后不要求字节相同，按目标规则重算指纹；内容内联入库时核对转换后内容，不强求逐 Case 文件。 |
| 重复导入与失败恢复 | 原样复用公共安装能力时，可引用其重复导入、回滚和恢复测试的版本与适用范围；本次行为变化、已有覆盖不足或明确要求真实演练时，在隔离测试数据集上再次导入相同版本，验证合同规定的复用、拒绝或新版本行为，不无故重复 Case 或覆盖已被实验引用的数据。用受控错误输入或隔离故障验证失败状态、回滚/可恢复部分记录、临时文件和锁释放；修复后按合同重试/续传，再核对前三项。 |

冻结预期清单、转换规则和范围，不冻结运行中数据库文件。区分官方全量、声明安装范围与执行子集；集合和内容检查覆盖声明安装范围，子集运行不能声称全量数据验收。没有某种存储载体时记录实际替代载体和等价内容校验；访问不足或必要字段无法查询属于待处理，不能记为“不适用”。私有内容在受控端比较，公开报告只留摘要和差异统计。

每项保存读取/查询时间、存储与版本标识、预期/实际数量和 ID 集合摘要、差异明细、脱敏原始查询及清理结果。重复导入和失败恢复场景标明 L1/L2/L3 层次及真实存储/Mock 范围，不在共享数据上制造损坏。数据检查失败或缺证据时，停止依赖该数据的真实执行；L3 新建或重新安装数据后重新验证。

自动接入 Skill 将这些断言放入 `source` 逻辑检查（可由共享驱动实现），并汇总专项测试和真实安装证据。检查程序与配置纳入实现摘要，预期清单纳入冻结输入。公共 CLI 负责运行命令和检查结果结构，不会自动连接数据库，也不自动推导存储一致性。

### 12.11 配置接入验收

按第 3.4 节形成配置矩阵，作为既有分层验收的一部分。只验证本次使用或修改的配置范围；未改变配置行为时引用已有测试及其适用范围，新增字段或改变加载/消费行为时补充受影响专项。未新增字段时仍验证已有配置如何被本次路径使用，无配置依赖时记录代码依据。

- **L1 配置合同**：在临时配置目录/隔离夹具中调用公共加载器和消费者专项测试，验证默认值、本地覆盖、适用的数组/`null` 合并、显式配置目录、相对路径与 cwd 无关、未知字段/错误类型/非法值拒绝；适用时验证旧业务变量不覆盖 YAML、显式部署覆盖经过统一校验，以及安装升级保留用户覆盖。不要修改用户实际 `*.local.yaml`、`.env` 或凭据做故障注入。
- **L2 实际生效**：复用本次数据准备、执行及评分段的调用和日志，确认实际服务/安装客户端读取了预期配置，Controller 与 Runtime 接收到一致的脱敏快照或所需字段，路径和挂载指向本次资产。证明配置被消费者采用，不能仅以 YAML 存在、解析成功或 `/health` 返回 200 判定。该证明不要求另跑一次模型或官方评分。
- **L3 前置与证据**：将配置专项测试纳入既有接口/回归前置，核对服务版本及有效配置与本次验收输入一致后运行端到端。相关程序、非敏感默认/覆盖文件或受控端生成的脱敏配置指纹纳入实现输入；不冻结整个运行数据库或凭据文件。配置变更使受影响的前置结论失效，修复后重验；缺少生效证据记为待验证，不宣布通过。

涉及执行 Profile 时，本地检查覆盖本次配置、绑定、摘要及所选后端的策略不匹配处理；真实执行证据核对实际绑定、冻结 Profile 与兑现的网络、资源和环境条件。不得把原生运行标为已隔离；复用同次执行证据，不为此另跑 Agent 或探测未使用的后端。

配置证据应覆盖“声明 → 加载/校验 → 部署交付 → 实际消费”，逐项报告通过、失败、受阻或有依据的不适用。具体字段和入口来自本次目标项目查询，不在验收程序中维护另一份全量支持清单。

<a id="configuration-reuse-and-retry"></a>

### 12.12 参数生效、配置复用与重试验收

接入涉及执行参数、执行器或评分适配时，必须沿正式用户入口验证下表操作。参数在请求、持久化配置、任务派发及实际执行或评分消费者之间应保持语义一致；受支持的非默认值必须实际生效，不得被接入层忽略或被客户端默认值覆盖。非法或不支持的参数按配置合同明确拒绝。

实验应冻结影响任务语义的有效参数及适用试次计划，包括目标支持的重复次数、扰动和随机种子。重试所需的计划或重建依据须可持久化、可追溯，客户端默认配置变化不能改变旧实验的语义。新运行身份、时间和工作目录等运行字段可重新生成；部署路径与凭据按现行部署合同解析。历史实验缺少必要冻结信息时，应有明确兼容规则和可追溯来源，无法还原时提示重新配置，不能静默采用当前默认值冒充旧计划。

| 操作 | 行为与验收依据 |
|---|---|
| 同配置实验 | 从原实验创建具有新身份的实验，核对其语义配置与原实验一致，并证明真实执行采用该配置。身份与时间等新建字段单独核对。 |
| 复用同配置 | 使用页面回填所用配置和实际提交规则创建实验。验证原样提交保留参数，再修改一个受支持且有辨识度的参数，核对保存值和实际消费值均采用新值。 |
| 重试 Case | 新建执行及提交，沿用原实验冻结的参数和适用试次计划。在隔离执行环境改变客户端默认值后重试，核对冻结配置仍生效，随后恢复隔离配置。 |
| 重试评测 | 复用原提交物及其摘要，产生新的评分尝试，核对 Agent 执行次数未增加、评分终态与 Case 结果及实验汇总正确更新。 |

从已有真实 Case 中选择合适样本复用环境和证据，重新执行类操作须覆盖真实 Agent 执行和评分，重评复用已有提交。没有可修改参数时记录合同依据，仍验证配置保留；官方评分确实依赖执行中状态时，按第 12.8 节明确状态交接及适用边界，不能仅因缺少环境跳过验证。

可通过页面实际调用的正式 API 验证业务链路，页面回填、按钮和交互覆盖单独记录。保存操作类型、原/新实验及执行/评分身份、请求、有效配置、终态、提交物摘要和清理结果。配置生效以实际执行请求、有效运行配置或原生产物为证，模型回答变化或保存成功响应不能单独证明生效。相同运行可支撑多项断言，结果纳入已有 runtime 验收；明确适用项、失败与缺证据项。

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
- [ ] `test/<key>/` 下的专属测试、公共一致性测试，以及默认 `npm run test` 实际执行这些测试的记录和覆盖范围；
- [ ] 成功、业务失败、无提交和基础设施失败验收；
- [ ] 目标入口测试矩阵、L1 接口测试、L2 分段真实记录、L3 端到端记录与分层结论；
- [ ] 逐 Case 的跨阶段身份/摘要、异步等待与重试边界，以及成功和失败路径清理证据；
- [ ] 数据文件内容、持久化记录、双向映射与资源一致性，以及重复导入/失败恢复的检查证据和声明范围；
- [ ] 私有数据、路径、摘要、资源和日志安全检查；
- [ ] 用户指南、部署说明和版本要求；
- [ ] 配置矩阵、Schema/默认值/消费与分发路径、覆盖与拒绝测试，以及本次有效配置生效证据；不适用项有依据；
- [ ] 浏览器验证数据集、实验、Case、Artifact 和趋势页面。

## 15. 参考实现

按当前模块的输入、提交、评分和环境要求，选择最接近的已有接入作为参考。公共能力优先复用；Benchmark 业务语义以其官方定义为准，接入要求以当前协议为准。已有实现用于说明接法，其历史目录、配置和业务约定不自动成为新接入标准。

已有接入见仓库的 [benchmarks/](../../../../../benchmarks/) 目录。部署与使用指南保留安装、配置、操作、验收和必要排障；实例内部契约放在对应开发文档，字段、默认值和实现清单优先从源码查询，避免重复维护。

客户侧的自然语言协作方式见[《自定义 Benchmark 接入指南》](./onboard-custom-benchmark.md)，各指南的使用顺序见[《Benchmark 文档关系与开发指南》](../../../explanation/evaluation/benchmarks/navigation.md)。
