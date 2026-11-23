# Benchmark 前端接入设计与实现

> 原则：复用现有数据集、四步实验向导、实验详情和通用 API；标准展示范围内不为单个 Benchmark 增加 React 分支。

状态：通用 Presentation 展示已实现并纳入自动化测试；浏览器 golden path 与边界场景待人工确认后执行。

## 1. 展示数据来源

| 来源 | 前端用途 |
|-|-|
| `dataset.fields` | 数据集详情的业务列快照 |
| `presentation.caseTable` | Case 搜索、列名、顺序、类型和格式 |
| `presentation.referencePanel` | 隐藏评测契约的标题、说明和公开定位列 |
| `presentation.evaluator` | 自动绑定评估器的名称、描述、运行方式和输出说明 |
| `presentation.result.primaryMetric` | Case 主指标标签、布尔文案和数字格式 |
| `presentation.artifacts` | Submission/Evidence 的可选标签和顺序 |
| Adapter 归一化结果 | `summary`、`primaryMetric`、`points[]` |
| 平台 API | 状态、完整文件列表、大小、摘要和受控下载地址 |

Presentation 只允许受控字段和格式，不能注入 React、HTML 或 JavaScript，也不能决定是否保存或隐藏 Artifact。

## 2. 公共渲染规则

- 数据集详情按冻结的 `dataset.fields` 顺序渲染；内部 ID、权限和操作列仍由平台控制。
- `input`、`externalCaseId`、嵌套 `values.*` 统一由 `src/lib/benchmark/presentation.ts` 解析；不存在 SWE-bench 字段回退。
- `text/code/number/boolean` 及 `plain/percentage/bytes/duration-ms/date-time` 使用平台内置格式化，未知值安全回退为文本。
- 创建实验和实验详情共用 `caseTable.columns`；无可用执行目标时只提示检查客户端和执行目标，不显示具体 Workspace/Artifact 能力。
- 自动绑定 ID 使用 `benchmark:<evaluatorKey>`，不假设 `evaluatorKey === adapterKey`。
- 评分点直接展示 Adapter 返回的 `label/value/total/format`，不从 Evidence 推断 `passed/total`。
- 趋势继续复用 `ExperimentBaselineTrend`，Benchmark 名称优先使用 `aggregateLabel`，不存在 Adapter 特判。

## 3. Artifact 规则

详情 API 返回完整 `submissions[]` 和 `evidenceArtifacts[]`。前端合并后按以下顺序匹配 Presentation：

1. 精确 `source + name`；
2. `source + kind`；
3. 未匹配时使用原始 `name`。

规则只改变 `label/order`。未配置、配置失效或 Evaluator 新增的文件仍会显示。文本、JSON、Diff、图片和 PDF 可以预览，其他媒体类型保留下载入口。

## 4. 代码落点

| 职责 | 文件 |
|-|-|
| 统一字段、格式与 Artifact 匹配 | `src/lib/benchmark/presentation.ts` |
| 数据集字段快照展示 | `src/components/DatasetItemsPage.tsx` |
| Case、参考契约、动态 Evaluator | `src/components/eval/ExperimentWizard.tsx` |
| 动态 Case 列、主指标和提交物状态 | `src/components/eval/ExperimentDetail.tsx` |
| 归一化评分点和完整文件入口 | `src/components/eval/ExperimentCaseDetail.tsx` |
| Artifact 列表、预览和下载 | `src/components/eval/BenchmarkArtifactActions.tsx` |
| 聚合指标名称 | `src/lib/engine/experiment/baseline-trend.ts` |

## 5. 接入边界与验收

新的标准 Benchmark 只需在接入包中提供 Manifest Presentation、Adapter 公共投影和归一化结果，不需要修改前端。若现有受控列类型、格式或预览器无法表达需求，应先扩展可复用的公共能力。

验收至少覆盖：

- 第二个非 SWE-bench 接入包无需新增 React 分支即可完成数据集、向导、详情、指标、Artifact 和趋势展示；
- 多提交物、任意名称 Evidence、未匹配 Presentation 的文件都不丢失；
- `evaluatorKey` 与 `adapterKey` 不同时仍能正确自动绑定和聚合；
- 调整展示标签和顺序不改变文件产出、校验或评测结果；
- 普通实验的数据集、评估器、详情和趋势行为不回归。

完成上述非 SWE-bench 验证后，可对外发布统一《Benchmark 接入开发指南》。这是一套开发规范，不是零代码、纯配置接入承诺。

## 6. 执行进度投影与展示

实验详情的 Case 明细表将执行状态集中到独立的“执行进度”列和步骤弹窗，提交物列只展示文件，不再展示参考契约列；单个 Case 详情页及 `presentation.referencePanel` 契约保持不变。阶段名称使用平台通用映射，本轮不新增 Manifest 配置。“Agent 执行”步骤读取当前 `caseRun` 的 `traceId/executionId`，唯一根 Execution 入库后在新标签页通过 `executionId + taskId` 精确打开。未收到根 ID 时显示“等待本次主 Agent 链路关联”，已收到但尚未入库时显示“主 Agent 链路上传中”，导入提交物时隐藏入口。新重试使用新的 Run，立即撤下历史链接；Case 上残留的旧 `taskId` 不参与当前执行进度关联。详情同时返回 `runId/runAttemptNo/generation/revision/evaluationAttemptNo`，前端按执行轮次、快照版本和阶段过滤迟到响应，保留同轮已确认的链路；新评测轮次允许重评。

现有 `GET /api/experiments/:id` 的 `cases[].benchmark.progressDetails` 返回当前最新 Run 的创建/结束时间、执行启动/最近上报/可选阶段开始时间，以及最新评测 attempt 的阶段、创建/启动/结束时间、最近上报和失败原因。仅投影这些公开状态字段，不返回原始进度 JSON。评测开始后使用评测侧的上报时间，重评活动状态优先于 Run 旧终态。步骤由实际状态映射，不推算百分比；没有可靠开始时间时不显示阶段耗时，也不编造历史阶段耗时。

运行期间沿用详情页 5 秒轮询，轮询失败保留快照并明确提示，恢复后清除提示。非排队活动阶段超过 5 分钟无上报时提示观测延迟；从未收到上报则从该流程启动时间计时。此提示不改变后端状态，不将阶段回调视为心跳，不触发重试或超时终止。导入提交物跳过执行阶段，终态停止转圈并冻结总耗时。
