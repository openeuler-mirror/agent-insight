# Agent Insight Benchmark 架构与代码导航

本页提供架构关系和阅读路线；[代码导航清单](benchmark-protocol.sources.json)中的路径、职责和关键符号仅用于定位目标项目当前代码。按本次问题选读，不要求遍历全部文件。字段、方法签名、状态、限制与支持范围以当前类型、校验器、实现及相关测试为准；路径移动时检索符号，不要求匹配 Skill 发布时的 commit 或文件摘要。

先按 [discovery.md](discovery.md) 查询实际客户端能力和 Benchmark 执行/扩展合同，从支持范围的交集中确认执行对象，再围绕当前模块深入读取相关代码。必要适配和真实能力缺口直接记录在已有接入方案，不另建差异核对单。

## 1. 架构职责与数据流

```text
官方来源 → Loader / 原始 Case → Adapter 校验、拆分、公开投影 → 数据集安装
  → 按数据集与所选 Agent 检查、准备执行环境
  → AgentTask → 公共执行器 → Submission Artifacts
  → Adapter 校验、构造 EvaluationJob → Evaluator / 官方 Harness
  → 原生结果与 Evidence → Adapter 归一化 → 公共结果展示
```

| 组件 | 阅读时确认的职责与边界 |
|---|---|
| 公共平台 | 状态机、执行目标匹配、传输、调度、存储与展示；复用公共能力 |
| Adapter | Case 拆分、任务构造、提交校验、评测请求、结果归一化；沿基类校验链实现业务逻辑 |
| 执行环境模块 | 检查并准备当前选择所需的环境，准备后复查 |
| Evaluator | 调用官方评分入口，交付原始结果与证据，处理清理 |
| Manifest / Presentation | 声明接入资源、契约与受控展示，使用明确的业务指标 |

以目标项目的 `docs/zh/explanation/evaluation/benchmarks/navigation.md` 和当前开发规范为入口，选择任务输入、提交、评分和环境要求最接近的已有接入作为参考。历史接法不自动成为新接入标准。执行与评分生命周期分开不代表官方任务可离线判分；反馈、环境状态与隐藏材料边界必须保持官方语义。

## 2. 接入包、Manifest 与配置

先读目标项目 `docs/zh/how-to/evaluation/benchmarks/develop-benchmark.md`，再沿下列入口核实：

| 问题 | 当前代码查找线索 |
|---|---|
| 包布局、必需声明、资源路径与 Catalog 校验 | `scripts/benchmark/generate-catalog.cjs`，从 `loadPackageForOnboarding` 追踪严格校验；与 `BenchmarkManifest` 类型交叉阅读 |
| Loader、执行环境、Evaluator 及展示如何注册 | `packages/benchmark-protocol/src/contracts.ts` 与目标 `benchmarks/<key>/benchmark.yaml`；不要假设 YAML 与运行时类型完全同形 |
| 业务配置的默认值、覆盖、校验与消费 | `packages/project-config/index.cjs` 的 `loadProjectConfig`、对应类型及 `config/benchmark/`；沿本次消费者追踪安装分发和生效位置 |
| 测试位置与默认发现规则 | 当前开发规范、`test/<key>/` 及项目测试命令 |

配置接入要求见目标开发规范第 3.4 节“配置接入与发现”；默认启动导入要求见“启动自动导入”（`#startup-dataset-import`），真实启动及落库验收见其第 12.10 节。实现和验收均读取目标章节，路径移动时沿项目导航查找。

新增接入通过 Catalog 发现，不直接编辑生成目录。业务配置复用项目加载和校验链；声明或 YAML 解析成功不等于部署实际生效。具体配置与部署验证见 [discovery.md](discovery.md)，不复制一份易变的字段或后端列表。

## 3. Case、数据来源与可见边界

沿 `contracts.ts` 中 Loader/Preparer 类型、`json-schema.ts` 中可见性校验与 `src/lib/benchmark/adapter-base.ts` 中 Case 拆分逻辑，确认当前 ID、公开/私有 Payload、目录投影及指纹合同。再追踪数据安装入口与存储实现、相关测试。

隐藏答案、私有测试和凭据不得进入 Agent 输入或公开产物。数据版本与实验身份必须可追溯，安装检查覆盖真实内容、持久化、转换一致性及必要恢复行为；不能以小样本运行替代安装范围验证。操作见 [数据集安装验收](live-validation.md#数据集安装验收必检)。

## 4. Adapter 与实际执行

从 `AbstractBenchmarkAdapter` 的公开生命周期追踪受保护的业务扩展点，再读对应类型和校验器；[Adapter 模板](../assets/templates/adapter.ts.tmpl)只是实现起点，导入和签名须按当前代码调整。

| 查找符号 | 需要确认的当前合同 |
|---|---|
| `splitCase` | 原始数据到公开/私有字段、稳定 ID 与投影 |
| `createAgentTask` / `AgentTaskEnvelope` | 运行上下文、公开输入、工作区、策略与提交要求 |
| `validateBenchmarkSubmission` / `ValidateSubmissionInput` | 公共校验已保证什么、业务还须校验什么 |
| `createEvaluationRequest` / `EvaluationJob` | 提交、隐藏材料、身份及资源怎样交给评分端 |
| `createNormalizedResult` / `NormalizedBenchmarkResult` | 原生指标、业务结果和基础设施错误如何区分 |

参数生效、同配置实验、复用同配置、重试 Case 与重试评测的行为及必需断言，统一读取目标开发规范“参数生效、配置复用与重试验收”（`#configuration-reuse-and-retry`）。

执行 Profile、配置分派、客户端上报、目标匹配及实际后端的入口见代码导航清单。只沿所选路径核对配置解析、就绪探测、实际执行与安装分发，不把某个后端的依赖当作公共要求，不通过删字段或换后端绕过不兼容。Agent、模型、Collector 和后端是否可用必须查本次部署。

## 5. 执行环境检查与准备

从 `packages/benchmark-protocol/environment.d.cts`、Catalog 校验器和目标环境模块读取检查、准备、进度及返回状态合同，再追踪调用它们的实际用户入口。当前查找符号包括 `checkEnvironment`、`prepareEnvironment` 和 `environmentPreparation`；签名、必需条件及不适用边界以当前代码和测试为准。

客户端在线、执行目标可选、当前 Case 环境就绪分别取证。准备只处理已选择的运行条件，复用公共服务和恢复机制，准备后重新检查。部署操作先读目标项目服务部署指南，不能只凭模板或进程存在宣称就绪。

## 6. 评测请求、结果与 Evidence

沿 `evaluation-contracts.ts`、`evaluator-contracts.ts` 与 `services/evaluator/src/evaluator-registry.cjs` 确认请求、Entrypoint、结果及错误合同；继续追踪 `evidence-collection.cjs`、`service.cjs`、`evaluation-callback-service.ts` 与 `evidence-artifacts.ts`，核实产物收集、上传、回调校验和下载。完整路径见代码导航清单。

评分规则与产物范围按固定版本的官方 Benchmark 文档和实际评分代码确定。保留实际结果的原名、相对目录和字节；只有接口返回时仅忠实序列化实际返回值并注明来源，接入层不得增补字段拼成官方报告。缓存和中间文件不自动成为证据，摘要不能代替原始输出，公共目录扫描不能代替业务范围判断。

逐 Case 核对提交、评分结果、附件与身份关联；不要硬编码固定产物数或字段值。平台合同从当前源码读取，本次验收证据要求见 [acceptance.md](acceptance.md#评测产物核对)，实际操作见 [live-validation.md](live-validation.md)。

## 7. 验收与维护

验收分组、前置条件、真实 Case 数量、类型覆盖及缩减范围规则，统一读取目标项目 `docs/zh/how-to/evaluation/benchmarks/develop-benchmark.md` 第 12.6 节“分层验证顺序与测试矩阵”；数据安装与配置验收要求分别见第 12.10、12.11 节。路径或章节移动时沿目标项目导航按标题定位。执行及证据记录见 [live-validation.md](live-validation.md)，结果结构见 [acceptance.md](acceptance.md)，命令见 [usage.md](usage.md)。

本次实际使用的项目版本、官方来源版本与验证输入保留在运行记录中；输入变化按影响审阅和重测。Skill 维护只更新失效的导航、架构说明或模板，不追随每次项目 commit 更新摘要，也不替目标项目维护第二份字段合同。普通接入运行不修改已安装 Skill。
