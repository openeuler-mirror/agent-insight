# 文档迁移结果与待审清单

第一阶段迁移文档、更新引用和导航、适配文档下载与打包路径，保留了全部 432 个原文件。随后按维护者确认清理下列第 1、2、3、4 项，保留第 5、6 项，并更新其余已识别的过时说明。首次迁移基线为 `1bb2585c`；提交前已同步至上游 `62b9bbfb`，新增设计与图片按相同规则归位。2026-10-28 维护者另行确认删除第 6 项旧 RPM 指南，第 5 项开发者 HTML 继续保留。各阶段的验证范围和结果分别记录在下方。

## 迁移范围

| 项目 | 结果 |
| --- | --- |
| 原 `docs/` 文件 | 首次 432 个，随后同步上游新增 5 个，共映射 437 个；累计授权清理 5 个，保留 432 个原文件；本轮另新增 3 篇运维正文 |
| 移动文件 | 首次移动 317 个，随后迁移上游新增 4 篇设计 |
| 公开文档区域 | 首次迁入 98 个原文件，其中 94 篇 Markdown/MDX 正文；随后清理 1 份重复 HTML，随后再清理旧 RPM 指南，保留 96 个原文件 |
| 内部设计区域 | 首次迁入 217 个原文件；随后清理 1 份退役档案并同步新增 4 篇设计，保留 220 个原文件 |
| 支撑资源 | 首次保留 117 个原文件；随后清理 2 个未引用片段并同步新增 1 张图片，保留 116 个原文件，第三方 bundle 未变 |
| 中文正文分类 | 首次教程 5、操作指南 48、参考 6、解释 35；本轮删 1 篇操作指南、新增 2 篇操作指南与 1 篇参考；不含导航页 |
| 英文 | 已建立四类目录及翻译待补齐入口；未新增正文译文，不视为双语达标 |

旧路径逐文件对应关系见 [path-map.json](path-map.json)，已补齐同步上游时新增的 5 个条目；删除结果以本页处理结果及 verification.json 各阶段记录为准。共享图片和片段保留原位置；两份第三方 Mermaid bundle 各自保留并调整许可清单中的位置，没有去重或重新打包。

公开入口：[文档导航](../../../docs/README.md)。内部设计继续使用[需求清单](../../README.md)登记状态，源码三模块迁移不在本轮范围内。

## 已识别的内容缺口

这里区分“缺少内容”和“内容已有但未整理”。四类目录齐全不等于内容已完整；六个业务领域也不要求机械地各写四篇。

| 项目 | 当前情况 | 后续可做的工作 |
| --- | --- | --- |
| 英文正式文档 | 当前迁入的 94 篇正文主要为中文，英文入口明确标记待补齐 | 先确定对外范围，再按中文权威版本逐篇翻译和校对 |
| 服务 API 参考 | [API 与契约](../../../docs/zh/reference/platform/api-and-contracts.md)混合 HTTP 端点、内部函数、数据模型与实现说明 | 将对外 REST API 按业务拆分，补齐鉴权、请求、响应和错误；不能把旧导航缺失的 SDK 页面当成已存在 SDK 的证明 |
| 评测协议与配置参考 | 契约散落在[评估器开发](../../../docs/zh/how-to/evaluation/develop-evaluator.md)、[Benchmark 开发](../../../docs/zh/how-to/evaluation/benchmarks/develop-benchmark.md)和 API 总览 | 抽取输出契约、参数、状态/错误码到 reference/evaluation，操作步骤保留 how-to |
| 运行和部署配置 | 已新增[运行配置参考](../../../docs/zh/reference/platform/configuration.md)，集中运行根、端口、数据库、模型和评测配置 | 后续随功能变更维护；不宣称穷举所有采集器与调优参数 |
| 升级、回滚、备份恢复 | 已新增[升级与回滚](../../../docs/zh/how-to/platform/upgrade-and-rollback.md)和[备份与恢复](../../../docs/zh/how-to/platform/backup-and-restore.md) | 生产环境、外部数据库与容器恢复仍需按实际部署演练，不将文档示例检查当成真实恢复验证 |
| 独立观测入门教程 | 首次接入和查看 Trace 已包含在[快速开始](../../../docs/zh/tutorial/platform/01-quick-start.md)中，没有单独 tutorial/observability 教程 | 可从现有内容提炼，不需要新造功能或立即为每个领域创建教程 |
| 三模块职责说明 | 原外部设计是目标结构，当前源码位置尚未整体迁移 | 更新公开架构说明时区分当前实现与目标结构，平台内置评估不归为独立 evaluator 服务 |
| 混合主题与篇幅 | 30 篇公开正文超过 20 个 Markdown 标题；部分同时包含教程、操作、契约和原理 | 逐篇拆分和互链，本轮保留原文，见下方完整清单 |
| 历史坏链接 | 原 80 处已分类处理：63 处路径修复、1 处指向当前数据模型、7 处历史源码固定提交、8 处缺失材料标注、1 处为代码示例误报 | 原始记录见 [existing-link-gaps.json](existing-link-gaps.json)，处理结果见下方；8 处缺失原件未恢复 |
| 旧站点占位导航 | 原导航中 19 个页面目标不存在 | 新导航已按实际文档重建；原目标及核对建议见 [previous-navigation-gaps.json](previous-navigation-gaps.json) |

## 已确认的清理与更新（2026-10-27）

编号沿用维护者确认的逐项清单；仅第 1、2、3、4 项获准删除。没有删除业务代码、第三方 bundle 或其他历史资料。

| 编号 | 文档 | 处理结果与原因 |
| --- | --- | --- |
| 1 | `docs/snippets/install-sdk.mdx` | 已删除。无页面引用，Python/JS SDK 的描述与当前平台包用途不符；不据此断言外部同名包不存在 |
| 2 | `docs/snippets/setup-env.mdx` | 已删除。无页面引用，示例项目变量没有当前代码读取点，Key 示例与本地接入不符 |
| 3 | `design/platform/legacy/eval-dashboard.md` | 已删除。明确标记 RETIRED 的旧组件源码档案，不是运行中的组件 |
| 4 | `docs/zh/explanation/platform/user-overview.html` | 已删除。与开发者 HTML 正文基本重复，未找到当前入口引用 |
| 5 | [开发者 HTML 概览](../../../docs/zh/explanation/platform/developer-overview.html) | 按维护者要求暂时保留，正文未改；仍为历史快照，不作为当前实现的完整说明 |
| 6 | `docs/zh/how-to/platform/build-rpm.md` | 2026-10-27 暂时保留；2026-10-28 经维护者确认删除，同时移除操作指南和文档站导航入口。原文只适用于旧 830 分支与版本 |
| 7 | [项目定位](../../../docs/zh/explanation/platform/positioning.md) | 已更新包名、Apache-2.0、Node 要求、文档入口和协作上游；移除无依据的旧测试数量与成熟度推断 |
| 8 | [架构说明](../../../docs/zh/explanation/platform/architecture.md) | 已更新包名、安装命令、Skill 当前导航、旧入口兼容说明及测试覆盖边界；初稿基线与本次核对范围分开记录 |
| 9 | [开发者导航](../../../docs/zh/explanation/platform/developer-index.md) | 已更正 npm 包名，保留导航和术语表，不加入逐次变更日志 |
| 10 | [LlamaIndex 接入指南](../../../docs/zh/how-to/observability/llamaindex-trace-collector.md) | 已将自有采集器代码许可说明改为 Apache-2.0，并说明第三方许可边界；继续用于下载 ZIP 和 npm 分发 |
| 11 | [诊断循环问题分析](../../../docs/zh/explanation/diagnosis/agent-debug/diagnosis-loop-analysis.md) | 已补充 @0.6 的专项检测调度、报告兼容和能力边界；@0.1 现场、旧行号和原方案明确标为历史依据 |
| 12 | [Hermes 落盘分析](../../../docs/zh/explanation/observability/hermes-storage-analysis.md) | 已核对并注明单 span 增量提交、session 分片和分块读取已实现；history 双字段仍存在，但不沿用旧样本推断当前开销 |
| 13 | [Skill 工作台工程设计](../../optimization/skill-workbench-refactor/phase2-requirements-design.md) | 保留工程方案，明确仓外产品设计与仓内工程记录的关系，更新当前入口和历史切流计划；未修改仓外产品方案 |
| 14 | [示例成本参考](../../../docs/zh/reference/platform/example-cost.md) | 保留历史数字，明确原记录缺少测量日期、代码版本与精确配置，补充当前重新估算的方法；未虚构数据或重新调用模型 |
| 15 | [文档站配置](../../../docs/docs.json) | 将 GitHub 占位页脚替换为当前协作上游的 GitCode 文本链接，保留所有活动导航目标 |

上述处理基于当前本地代码、引用和打包入口；未发现仓内引用不代表没有外部旧链接。两份 Mermaid bundle 和许可材料保持不变。第 5 项以及下面的历史计划、原型仍保留；第 6 项按 2026-10-28 的单独授权清理。

## 历史计划和原型

以下仅按“历史材料”登记，不根据日期判定废弃，也未合并同名或相似方案：

- `design/observability/historical-plans/`：8 份 Claude/OpenClaw 采集与 Trace 语义计划。
- `design/evaluation/historical-plans/`：1 份触发评测超时重试计划。
- `design/optimization/historical-plans/`：1 份 Skill issue 合并冲突计划。
- [RAS 历史原型](../../reliability/agent-ras/assets/demo/reliability-prototype.html)。
- [Goal Plus 原型](../../observability/goal-plus-observability/agent-insight-goal-plus-hifi.html)。
- [实验原型](../../evaluation/eval-experiment/eval-experiment-hifi.html)与[另一份实验原型](../../evaluation/eval-experiment/评测实验-高保真.html)。
- [质量监控原型](../../evaluation/quality-monitoring/quality-monitor.html)。
- [Jiuwenswarm 渲染材料](../../observability/jiuwenswarm-tracing/index.html)及随附 Python 验证脚本。

## 待评估拆分的长文档

以下按去除代码块后的 Markdown 标题统计，并随本次说明更新刷新计数；只说明篇幅或归类需要复核，不表示内容过期。完整计数见 [long-documents.json](long-documents.json)。

| 文档 | 标题数 |
| --- | --- |
| [qa](../../../docs/zh/how-to/platform/qa.md) | 79 |
| [develop-benchmark](../../../docs/zh/how-to/evaluation/benchmarks/develop-benchmark.md) | 64 |
| [ras-fi-insight-relationship](../../../docs/zh/explanation/reliability/agent-fault-injection/modules/ras-fi-insight-relationship.md) | 47 |
| [view-traces](../../../docs/zh/how-to/observability/view-traces.md) | 44 |
| [develop-evaluator](../../../docs/zh/how-to/evaluation/develop-evaluator.md) | 42 |
| [skill-workflow](../../../docs/zh/how-to/optimization/skills/skill-workflow.md) | 39 |
| [api-and-contracts](../../../docs/zh/reference/platform/api-and-contracts.md) | 37 |
| [faq](../../../docs/zh/how-to/platform/faq.md) | 36 |
| [datasets](../../../docs/zh/how-to/evaluation/datasets.md) | 35 |
| [diagnosis](../../../docs/zh/how-to/diagnosis/agent-debug/diagnosis.md) | 34 |
| [deploy-services](../../../docs/zh/how-to/evaluation/benchmarks/deploy-services.md) | 30 |
| [experiments](../../../docs/zh/how-to/evaluation/experiments.md) | 29 |
| [access-control](../../../docs/zh/how-to/platform/settings/access-control.md) | 26 |
| [static-evaluator](../../../docs/zh/explanation/evaluation/skills/static-evaluator.mdx) | 26 |
| [llamaindex-trace-collector](../../../docs/zh/how-to/observability/llamaindex-trace-collector.md) | 25 |
| [overview](../../../docs/zh/explanation/observability/overview.md) | 24 |
| [manage](../../../docs/zh/how-to/optimization/skills/manage.md) | 24 |
| [data-control-flow](../../../docs/zh/explanation/platform/data-control-flow.md) | 25 |
| [recovery](../../../docs/zh/explanation/reliability/agent-ras/modules/recovery.md) | 24 |
| [diagnosis-loop-analysis](../../../docs/zh/explanation/diagnosis/agent-debug/diagnosis-loop-analysis.md) | 25 |
| [web-search](../../../docs/zh/how-to/platform/settings/web-search.md) | 23 |
| [architecture](../../../docs/zh/explanation/platform/architecture.md) | 23 |
| [develop-trace-collector](../../../docs/zh/how-to/observability/develop-trace-collector.md) | 23 |
| [evaluators](../../../docs/zh/how-to/evaluation/evaluators.md) | 23 |
| [model-registry](../../../docs/zh/how-to/platform/settings/model-registry.md) | 22 |
| [otlp-attribute-contract](../../../docs/zh/reference/observability/otlp-attribute-contract.md) | 22 |
| [detectors](../../../docs/zh/explanation/reliability/agent-ras/modules/detectors.md) | 22 |
| [platform-adapter](../../../docs/zh/explanation/reliability/agent-ras/modules/platform-adapter.md) | 22 |
| [monitor](../../../docs/zh/explanation/reliability/agent-ras/modules/monitor.md) | 21 |
| [local-install-process](../../../docs/zh/how-to/reliability/agent-ras/local-install-process.md) | 21 |

## 迁移验证

本节记录首次迁移的验证结果；授权清理后的本轮结果另见 verification.json 的 approvedCleanup。

原有 1066 处有效本地目标引用已保留，重建的 98 个站点导航目标均存在。检查范围为仓内文档文件和本地资源，不包含外部 URL 可达性与片段锚点的浏览器解析。

验证结果见 [verification.json](verification.json)。文档专项 18 项：17 通过、1 跳过；全量 4329 项：4306 通过、3 失败、2 取消、18 跳过。3 个失败已在未迁移的上游基线复现；2 个实验取消用例也在相同环境的上游基线复现。本轮未修复这些既有测试问题。npm dry-run 已确认新路径的采集器文档进入发布包，内部 design 材料未被打入包。本轮不启动开发服务，未在浏览器中验证，也未执行完整 Docker 镜像构建；本地文档引用、HTML 资源和 npm 打包内容按静态和自动化检查验证。

产品行为相关代码只调整采集器文档读取路径；其余源文件改动应仅为文档引用注释。依赖版本、package.json scripts、API 契约、数据库模型字段和业务流程不在此次变更范围内。

## 授权清理后的验证

- 本阶段仅删除清单第 1、2、3、4 项；第 5、6 项文件内容与阶段开始时一致。
- 本阶段业务代码、测试代码、依赖、package.json、脚本与第三方资源未修改；上阶段的文档路径适配仍保留。
- 文档专项 18 项：17 通过、1 跳过；覆盖采集器 ZIP README 内容和 standalone 文档复制。
- 全量 4329 项：4306 通过、3 失败、2 取消、18 跳过。数量及失败/取消名称与清理前一致；既有异常未在本阶段修复。
- npm dry-run 共 728 个文件，LlamaIndex 指南仍包含在包中，内部 design 和本次删除文件均未进入包。
- 本地目标引用、98 个活动导航与授权删除范围的检查结果见 verification.json 的 approvedCleanup；检查不包含所有外部 URL 和浏览器锚点解析。
- 文档站页脚按 [Mintlify footer 配置](https://www.mintlify.com/docs/organize/settings-structure#footer)使用文本链接；未启动文档站或应用 dev server，未在浏览器中验证，也未重新构建 Docker 镜像。

## 提交前同步与独立审查

已合入 `upstream/master` 的 `4e878243`，保留上游示例数据脱敏和旧 mock 脚本清理。本次 PR 相对该基线的 package.json 差异仅为 LlamaIndex 文档 files 路径，scripts 和依赖没有新增改动。

审查发现内部设计移到根 `design/` 后遗漏 standalone 排除：源码文件追踪确实捕获了该目录内两份 YAML，且 prepack 原先不会清理该目录。已在 `next.config.ts` 的文件追踪规则与 `scripts/prepare-npm-package.js` 的产物清理列表中补齐 design。新增真实目录打包用例先复现问题，再验证设计资料不进入产物，同时保留源码设计、server.js、采集器 README、诊断运行文件和许可材料。没有修改业务流程。

第一次同步后的代码验证基线为 `bd7c8921`：全量 4330 项，4309 通过、3 失败、0 取消、18 跳过；3 个断言失败仍为此前已在上游基线复现的用例。文档和打包专项 22 项，21 通过、1 个 Windows 专用用例跳过。最终 npm dry-run 726 个文件，数量减少来自上游删除的两个 mock 脚本；迁移后的采集器指南仍在包中，design 未进入包。98 个活动导航均存在，没有新增本地目标失效。

相对上游 `4e878243`，40 个源码或 CSS 文件的变更仅为注释引用，非注释变更限定于 Next 追踪排除、打包脚本文档复制/清理以及 LlamaIndex README 读取路径。独立差异审查无剩余阻塞项。未执行完整 Next/Docker 构建或浏览器验收；详情见 verification.json 的 submissionValidation。

## 最新上游同步与 PR 验证

提交期间 `upstream/master` 更新至 `62b9bbfb`，包含评估器超时和重试配置。已正常合并并解决三处文档冲突，将新增四篇设计归入 `design/evaluation/evaluator-execution-settings/`，保留新增图片、操作说明和设计状态。映射现有 437 个上游原文件，其中保留 433 个，仅删除此前批准的四项；第 5、6 项仍保持原样。98 个活动导航有效，历史本地目标问题仍为 80 处，无新增。

合并后的代码验证提交为 `f03df158`：全量 4356 项，4334 通过、4 失败、0 取消、18 跳过。其中三项与此前已复现的上游失败相同；新增的搜索超时断言在本次全量失败，但在当前分支和原样上游快照中各自单跑两项搜索测试均通过，未稳定复现，根因未确认。该测试及相关业务源码与上游一致，本次未修改。

原样上游 `62b9bbfb` 全量对照为 4355 项，4333 通过、4 失败、0 取消、18 跳过：复现上述三项共同失败，搜索超时项通过；另一项失败来自纯源码快照缺少未受版本管理的 Trae `dist/extension.js` 构建产物。因此两次全量的失败集合并不完全相同，不能将全量描述为通过或四项均为已确认的上游问题。

同步后的 npm dry-run 仍为 726 个文件，LlamaIndex 指南存在，design 未进入包。独立复核确认新增文档、图片及上游业务代码保留完整，无剩余文档冲突。未执行浏览器、完整 Next 或 Docker 构建验证。详情见 verification.json 的 latestUpstreamSync。

## 文档收尾（2026-10-28）

本阶段删除第 6 项旧 830 RPM 指南及入口，第 5 项开发者 HTML 原样保留。新增升级与回滚、备份与恢复、运行配置三篇中文正文；没有新增产品命令或修改安装、数据库及业务逻辑。

### 链接和站点适配

- 原 80 处目标问题的分类和去向见 [link-resolutions.json](link-resolutions.json)。其中 8 处原件仍缺失，只保留历史名称和原路径，不声称已经恢复。
- 公开文档中越出 `docs/` 的源码、设计与配置引用改为已核对目标存在的上游仓库链接。正文中的同目录、子目录链接补 `./`，避免 Mintlify 当作外部地址而打开带 `.md` 后缀的失效页面。
- Mintlify 默认排除 `README.md`。四类中文目录、Benchmark、RAS、FI 共 7 个导航页的正文迁到同目录 `navigation.md`；原 README 留下入口，站点旧路径配置重定向。未删除这些导航正文。
- 修复 4 处 MDX 解析问题；补入现有品牌 Logo 和 favicon 的文档站副本。开发者 HTML 与第三方 Mermaid bundle 均未修改。

### 未找到原件的历史材料

| 引用所在位置 | 缺失对象 | 当前处理 |
| --- | --- | --- |
| 内部需求清单 | `agentdebug-parallel-skills-analysis/` | 设计正文未收录；不据此改变原有实现状态 |
| 实验取消需求 | `评测服务文档/实验删除与评测服务停止清理方案.md` | 仓外方案未收录，保留原名称 |
| FI Server/Client 拆分需求 | `src/lib/fault-injection/queue.ts` | 未找到此路径的历史源码，保留历史引用说明 |
| RAS analysis-paralysis | `semantic-fault-injection-survey.md` | 引用的调研正文未找到 |
| RAS 客户端控制面设计 | `src/lib/reliability/clients-from-workers.ts` | 未找到此路径的历史源码 |
| FI 拆分可行性评审 | `src/lib/fault-injection/platforms.ts` | 未找到此路径的历史源码 |
| FI 拆分可行性评审 | `src/app/(main)/agent-ras/fault-injection/tasks/new/page.tsx` | 未找到此路径的历史页面 |
| OTel 积压修复计划 | `incident-2026-07-28-langfuse-trace-gap.md` | 现场记录未随仓库收录 |

这些是历史证据缺口，不等于当前功能缺失；需要原作者提供原件或确认其历史去向。

### 后续仍需推进

1. 按对外使用优先级补齐英文正文；当前英文入口仍为翻译状态说明。
2. 分业务整理对外 API 与评测协议参考，明确鉴权、请求响应和错误码。
3. 逐篇评估上列 30 篇长文档，分离操作、契约和原理；不按标题数量机械拆分。
4. 后续统一正文首个 H1 与 frontmatter 标题的重复展示；本轮保留既有页面的标题，Mintlify 的 75 项重复标题提示仍存在。
5. 外部链接可达性、全站所有图表/锚点、生产恢复演练及部署适配仍需按场景验证。本轮浏览器抽查不能代表这些范围全部通过。

### 本阶段验证结果

- Mintlify 严格构建通过，解析错误 0，站内链接检查 0 失效；75 项既有重复标题提示仍保留。100 个导航目标存在。没有批量验证外部 URL 可达性。
- Markdown/MDX 本地目标检查共 1185 处，目标缺失 0；不包含遗留 HTML、全部锚点或外部网址。8 处历史材料是显式缺失记录，不计作已恢复。
- 浏览器抽查通过：三份新指南、操作目录正文链接、备份页页内锚点、旧 README 入口、产品概览 Logo，以及修复后的 Skill 生成原理页。抽查页面控制台未见错误；未验证全部页面、图表或产品业务 UI。
- 备份文档 3 段 shell 语法检查通过；在临时 SQLite、配置和附件上完成冷备份恢复，4 个文件内容一致、SQLite 完整性检查通过。未对真实运行数据执行备份或恢复。
- 文档打包相关 6 项测试全部通过。隔离全量 UT：4437 项，4400 通过、15 失败、22 跳过、0 取消；失败名称与改动前一致，包含本机缺少 yaml、pydantic、pwsh 及注册示例断言问题。未在文档工作中修复这些问题。
- 仅文档、导航和品牌资源副本发生变化；只删除旧 RPM 指南，开发者 HTML 内容一致。详细结果见 [verification.json](verification.json) 的 `docsFollowup20261028`。
