# Agent Insight Benchmark 接入协议快照

## 来源、版本与适用范围

- 快照版本：`2026-10-29.3`。这是 Skill 内说明的修订号，不是平台统一协议版本。
- 来源仓库：[openeuler/agent-insight](https://gitcode.com/openeuler/agent-insight)。读取基准为本地 Git commit `6d7913b6039173ffdbea60e1289a7449af2dd833`；未额外验证该 commit 在远端可达。
- 来源方式：源码契约读取该 commit；开发规范同时包含本次工作副本尚未提交的验收补充，基准摘要、修改后摘要及可重放的 [指南补丁](protocol-guidance.patch) 单独记录，不声称补充已存在于该 commit。逐文件来源、用途和 SHA-256 见 [benchmark-protocol.sources.json](benchmark-protocol.sources.json)。
- 该版本声明的线协议：`execution-environment/v1`、`agent-task/v1`、`benchmark-evaluation/v1`、`evaluator-entrypoint/v1`、`evaluator-output/v1`。

目标项目当前版本的文档、类型、校验器及实现是唯一权威。本快照用于理解架构和开始设计；完整字段、可选扩展与大小限制必须对照目标源码。先运行 [protocol-check.cjs](../scripts/protocol-check.cjs)，记录与快照的差异，再按 [discovery.md](discovery.md) 查询实际能力。文件内容一致不代表执行机或部署就绪，协议版本字符串相同也不保证字段未变化。

本快照不列可用 Agent、Git 来源、Workspace Provider、Collector、执行后端、Runtime 镜像或在线客户端；这些由目标项目和本次部署查询得出。新增未实现的能力名不能代替实现。

## 1. 架构职责与数据流

```text
官方来源 → Loader / 原始 Case → Adapter 校验、拆分、公开投影 → 数据集安装
  → 按数据集与所选 Agent 检查、准备执行环境
  → AgentTask → 公共执行器 → Submission Artifacts
  → Adapter 校验、构造 EvaluationJob → Evaluator / 官方 Harness
  → 原生结果与 Evidence → Adapter 归一化 → 公共结果展示
```

| 组件 | 职责 | 边界 |
|---|---|---|
| 公共平台 | 状态机、执行目标匹配、Artifact 传输、调度、存储与展示 | 不加入按 Benchmark 名称分支的业务实现 |
| Adapter | Case 拆分、任务构造、提交校验、评测请求、结果归一化 | 不执行 Harness，不绕过基类校验 |
| 执行环境模块 | 检查和准备所选数据集、Agent 本次运行所需环境 | 检查只读，准备可重复，结果需复查 |
| Evaluator | 运行权威评分逻辑，产出原生结果、Evidence 和清理事实 | 不重写官方成功标准，不依赖平台数据库或平台本机路径 |
| Manifest / Presentation | 声明契约、资源与受控展示 | 不用展示层猜测业务分数 |

执行与评测在平台上有独立请求和生命周期，但不保证任意 Benchmark 都能只凭文本离线重评。若官方评分依赖环境状态、快照或执行中反馈，接入必须保存这些语义；缺少公共表达或实现时按目标仓库流程处理扩展。

来源：开发规范第 1、7、8、9 节；`evaluation-contracts.ts`、`evaluator-contracts.ts`。

## 2. 接入包与 Manifest

```text
benchmarks/<key>/
├── benchmark.yaml
├── adapter/index.ts
├── dataset/index.ts                  # 有 Loader 时
├── executor/environment.cjs
├── evaluator/evaluator.yaml
├── evaluator/<entrypoint 与所需资源>
├── schemas/case.schema.json
├── schemas/result.schema.json
├── fixtures/<小型样例>
├── smoke/<真实 Smoke 入口与输入>
└── tests/<专项测试>
```

Catalog 从接入包发现实现；不直接编辑 `generated/benchmark-catalog/`。该快照的校验桥接入口是 `scripts/benchmark/generate-catalog.cjs` 导出的 `loadPackage`，目标入口变化时先调整桥接。

Manifest 至少围绕下列契约组织，具体必填项以目标 Catalog 为准：

- `key` 是接入标识，运行时映射为 `adapterKey`；`evaluation.evaluatorKey` 是独立标识，不能假设两者相等。
- `protocols` 声明任务与评测线协议；`implementation` 指向 Adapter、Evaluator 及适用的 Loader/Preparer。
- `schemas.case/rawResult` 指向原始 Case 与原生评测结果 Schema。
- `executor` 声明环境准备入口、所需能力和执行超时。能力标识必须通过目标实现和部署验证。
- `submission.artifacts` 声明名称、真实 MIME、Collector 和大小上限。名称唯一，所有声明项均必需，Collector 必须出现在所需能力中。
- `evaluation` 的资源与超时必须和 Evaluator 配置一致。
- `result.primaryMetric` 的 key、类型和聚合与 Adapter 结果一致；该版本支持 `boolean-rate`（布尔值）和 `mean`（有限数值）。
- 声明 Loader 时同时声明数据 Profile；Presentation 只引用允许的公开投影和规范化结果。

来源：开发规范第 4、5、7、10 节；`BenchmarkManifest`、Catalog 校验器。不要把 YAML 字段结构与运行时 `BenchmarkManifest` 类型当成完全相同的对象。

## 3. Case、数据来源与可见边界

原始 Case Schema 用 `x-agent-visibility: public/private` 标记业务字段。`splitCase` 生成稳定、非空的 `externalCaseId`、`publicPayload`、`privatePayload` 和 `catalogProjection`；基类生成公共与私有指纹。

- Agent 指令、`benchmarkPayload`、目录投影、日志和公开 Artifact 不得泄露隐藏答案、私有测试或凭据。
- 目录投影为公开的 `input`、`values` 和可选 `tags`；Presentation 的 Case 字段使用 `input`、`externalCaseId`、`values.*`。
- Loader 的 `loadCases(sourcePath): AsyncIterable<JsonValue>` 只解析来源为原始 Case，校验与拆分留给 Adapter。
- 可选 Preparer 的 `prepareSource()` 返回来源路径及可选名称；固定来源版本、缓存与依赖由接入实现负责，平台统一安装。
- 数据安装后保持冻结身份；变更版本不能静默覆盖已被实验引用的数据。
- 安装验收检查实际文件/对象内容、数据库或索引记录、转换后的内容/指纹与资源引用一致性，以及隔离数据集上的重复导入和失败恢复。查询当前存储实现，明确安装范围、真实/模拟证据和等价校验；访问不足或缺证据不能通过。L2/L3 使用本次版本的数据检查结果，重装后重新核对。具体操作见 [数据集安装验收](live-validation.md#数据集安装验收必检)。

来源：开发规范第 6、7、12.10 节（12.10 为本次未提交补充）；`contracts.ts`、`json-schema.ts`、Adapter 基类。

## 4. Adapter 的五个业务 Hook

继承 `AbstractBenchmarkAdapter`，实现以下受保护方法，不覆盖基类公开生命周期方法。模板见 [adapter.ts.tmpl](../assets/templates/adapter.ts.tmpl)。

| Hook | 输入与产出 | 必须保持的语义 |
|---|---|---|
| `splitCase` | 原始 Case → 公开/私有 Payload、稳定 ID、公开投影 | 语义校验与可见边界；不复制整份原始 Case 到公开数据 |
| `createAgentTask` | 公开 Payload、运行配置、上下文 → `AgentTaskEnvelope` | 使用传入上下文；仅公开数据；提交契约与 Manifest 一致 |
| `validateBenchmarkSubmission` | 已经通用校验的只读 Artifacts → 内容校验 | 基类校验归属、必需集合、名称、MIME、非空字节、大小和摘要；实例补充业务格式语义 |
| `createEvaluationRequest` | 冻结上下文、公开/私有 Payload、Artifacts、资源 → `EvaluationJob` | 保持 ID、内容哈希、Artifact 与资源身份；只组装请求，不运行 Harness |
| `createNormalizedResult` | Job、Completion、Evidence → 统一结果 | 保留原生指标；区分业务未通过与执行故障 |

`AgentTaskEnvelope` 包含 `schemaVersion`、Benchmark 标识、上下文、指令与公开数据、工作区、策略、提交契约和 Agent 配置。工作区与执行绑定按目标实际能力生成；不能在任务中塞入任意 shell 命令、凭据或私有 Payload。网络声明必须由实际后端落实，目录拆分本身不证明隔离。

来源：`contracts.ts`、`evaluation-contracts.ts`、`adapter-base.ts`。

## 5. 执行环境检查与准备

`executor/environment.cjs` 导出 `checkEnvironment(context, services)` 和 `prepareEnvironment(context, services, reportProgress)`。上下文标识为 `execution-environment/v1`，包含数据集版本、Case、客户端、Agent、模型和实验选择，不传隐藏评测数据与密钥。

检查返回 `{ issues, prepare }`：`issues` 非空表示需处理的配置条件；没有 issues 且 prepare 非空才执行准备；准备后必须重新检查；两者为空才表示此次环境就绪。准备只处理当前所选运行要求，并复用公共服务、锁和版本验证。

注入的服务方法及实际可准备项通过目标项目查询；“客户端在线”“执行目标可选”“环境检查通过”分别留证据。

来源：开发规范第 5.5 节；`environment.d.cts`。

## 6. 评测请求、结果与 Evidence

`EvaluationJob` 使用 `benchmark-evaluation/v1`，保留 evaluation/execution ID、experiment/case ID、datasetContentHash、Benchmark/Evaluator 标识、Artifact 描述、业务 payload 和资源限制。业务 payload 可以包含私有评测数据，只交给评测端。

Evaluator Entrypoint 提供 `doctor` 和 `evaluate --request <request.json> --output <result.json>`：

- 输入使用 `evaluator-entrypoint/v1`，携带 EvaluationJob 和只读 Artifact 相对路径。
- 输出使用 `evaluator-output/v1`，包含 `completion` 与 `evidenceFiles`。Evidence 文件必须实际位于输出目录，返回全部已产生证据，不因展示配置缺失而丢弃。
- `completion.status` 为 `completed`（得到业务结果）、`submission_invalid`（业务提交不可评）或 `failed`（运行基础设施失败）；原生结果遵守 Schema，另保留运行和清理事实。
- `NormalizedBenchmarkResult` 的正常完成为 `status: done`，具有 verdict、0～100 的 score、非空主指标、points、evidence 和 nativeMetrics。基础设施失败为 `failed` 且 score 为 `null`，不能当作模型零分。
- 主指标的 key/aggregation 必须匹配 Manifest，布尔聚合与数值聚合不能混用。归一化不能丢掉官方指标或修改官方阈值。

评测 Runtime、依赖、镜像与网络按目标实现选择；执行隔离和评测隔离分别验证。Doctor 就绪仅说明对应检查结果，不能代替本次 Case 的真实执行。

来源：开发规范第 8.4、8.5、9 节；`evaluation-contracts.ts`、`evaluator-contracts.ts`、`evaluator-registry.cjs`。

## 7. 分层真实验收

先建立目标版本的阶段入口测试矩阵，再按 L1 接口契约、L2 分段真实集成、L3 完整端到端顺序验证。每阶段固定前置数据、身份、正常/异常输入、HTTP/业务/文件断言、异步终态、期限、证据与清理；实际入口由目标项目查询，不要求全部阶段使用 REST API。

- L1 检查字段、权限、状态机、归属、摘要与幂等，可以使用受控夹具或 Mock，明确标记范围。
- L2 执行段运行真实 Agent 并核对真实提交；评分段把固定提交交给真实官方 Harness，与独立官方判分比较。状态/反馈耦合无法独立时，事先说明替代的耦合真实验证和覆盖证据。
- L3 从实际用户创建/启动入口发起，观察执行、上传、官方评分、查询和清理。业务回调由执行器及 Evaluator 自行上报，不能手写终态或替换 Agent 提交；L2 成功不自动成为 L3 成功。
- 逐 Case 关联数据集版本、Case、实验、执行 Run、Artifact/摘要、评测 attempt 与 Evidence；区分业务未通过和基础设施失败。
- 设置请求、阶段、总试验与清理期限，有限轮询/退避；传输结果未知时先查已有任务，遵循实际幂等合同，所有结束路径收敛本次资源。
- 本次生成的驱动程序负责前置门禁、真实调用、断言和清理；通用 CLI 不自动推导业务依赖或验证平台证据真实性。按层次报告结果和未验证项。

来源：开发规范第 12.6～12.9 节（本次未提交补充）。Skill 内操作见 [live-validation.md](live-validation.md)，计划见 [验证矩阵模板](../assets/templates/validation-matrix.md.tmpl)。

## 8. 核对、更新与验收

1. 定位用户指定项目，读取本快照及来源清单；运行只读协议核对命令。`match` 只说明所列文件字节一致，不是能力或验收结论。
2. 出现 `review_required` 时，按差异阅读目标文件；路径移动则重新定位。记录“无关/文档变化”“模板需适配”或“公共协议缺口”的实际依据。不能仅因 HEAD 不同判定不兼容，也不能仅因版本字符串相同跳过差异。
3. 在包外 `protocol-review.json` 记录核对结果、目标版本、实际来源摘要与逐项处置。将这些文件和目标协议源码纳入冻结输入，随后查询动态能力、调整生成的模板和检查桥接。协议冲突无法判断时才请求补充决策。
4. 接入仍须经过 Catalog、Schema/可见性测试、同一提交的官方评分对照、真实运行和回归；具体见 [acceptance.md](acceptance.md)。该文件定义 Skill 验收记录，不是本平台接入协议的替代品。

发布新版 Skill 时，从明确的目标 Git commit 重新提炼此说明，更新来源清单的 revision、文件摘要、说明及模板摘要，并递增快照/Skill 版本。尚未提交的规范补充须单独标明工作副本来源、基准/修改后摘要及可重放补丁；提交后改用包含补充的实际 commit，不能把工作副本内容归到旧 commit。不能仅改摘要以掩盖尚未审阅的协议变化；普通接入运行不修改已安装 Skill。目标协议不匹配时优先适配本次生成代码，并将通用桥接更新作为单独包维护变更记录。
