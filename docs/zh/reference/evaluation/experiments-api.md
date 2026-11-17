---
title: "实验 HTTP 接口"
description: "普通实验的创建、启动、查询、重命名及取消删除约定。"
keywords: ["Agent Insight", "实验接口", "评测任务", "异步执行"]
changefreq: "monthly"
---

本页覆盖普通实验的常用调用及异步语义。Benchmark、Skill、LLM 对比实验走同一平台的不同分支，不能假定请求和响应完全相同；界面操作见[实验指南](../../how-to/evaluation/experiments.md)。用户解析见 [HTTP 接口与用户身份](../platform/http-api.md)。

## 查询

| 接口 | 参数与响应 |
| --- | --- |
| `GET /api/experiments` | 查询 `limit`（默认 `20`，范围 `1`～`100`）、`offset`（默认 `0`）、可选 `skillName`；返回 `{ items, total, limit, offset }`。普通列表排除逻辑删除、草稿及若干 Skill 专属 scope |
| `GET /api/experiments/:id` | 返回实验详情，包含 Case、评估结果和阶段信息；返回字段会按实验类别变化，不应复用列表 item 类型解析所有详情 |
| `GET /api/experiments/cancellations` | 返回当前用户最多 100 条 `pending` 取消记录：`{ cancellations }`，不是全部历史取消列表 |

调用时携带当前账号 Key，避免仅用可覆盖身份的 `user` 参数。缺少身份的普通列表可能扩大查询范围，不能据此确认 Key 有效；写操作和详情归属检查按各自分支处理。

实验详情中的执行进度通过只读事务获取一致性快照。单次事务最长 30 秒，两次尝试共享 35 秒等待预算；仅 `P1008/P2028/P2034` 最多重新读取一次，重读会记录错误码及耗时。读取仅选择必要字段，持续失败仍返回错误，不重跑 Agent 或评估任务，也不改写实验记录。

## 创建普通单组实验

`POST /api/experiments` 使用 JSON。下面示例是已有输入/输出的普通实验，不触发 Agent 生成 Trace：

```json
{
  "name": "Example experiment",
  "type": "single",
  "evaluatorIds": ["preset-agent-task-completion"],
  "cases": [{
    "input": "Return the sum of 1 and 1",
    "actualOutput": "2",
    "referenceOutput": "2"
  }]
}
```

`name` 去除首尾空白后不能为空；`evaluatorIds` 至少一项。非监听模式至少一个 Case；监听模式需 `watchMode: true` 和非空 `agentName`。Case 可关联已有 `executionId` / `taskId`，还支持 `datasetInput`、参考答案和评估上下文。评估器是否需要参考答案取决于其注册元数据。普通分支成功返回 `200` 和 `{ id }`，此时创建的是草稿，尚未完成评估。

Benchmark 数据集分支使用其绑定、Case 选择和执行配置，成功可能返回 `201`；普通实验不允许直接选用 `benchmark:` 评估器。不要把普通示例套给 Benchmark 或 Skill 冻结快照实验。运行参数见[评估器运行与输出契约](./evaluator-output.md)，执行环境检查见[环境准备接口](./execution-environment.md)。

## 启动与终态

`POST /api/experiments/:id/run` 启动已创建的实验。普通分支通常返回 `{ status: "running" }`；已经运行时返回 `alreadyRunning: true`。Benchmark 分支返回 `202`，可能带 `runId`；其他分支还可能包含执行生成或故障注入信息。HTTP 响应只是启动/受理结果，随后查询详情。

| 状态层次 | 读取方式与限制 |
| --- | --- |
| 实验状态 | 详情的 `status`；常见为 `draft/running/done/failed`，监听及取消流程另看相应字段 |
| 单行评估状态 | Case × evaluator 结果的 `status`，如 `pending/running/done/failed/cancelled`；`failed` 表示评估执行失败，和有效结果 `verdict: fail` 不同 |
| Trace 生成阶段 | Agent 退出后仍可能等待采集和入库；保留 Trace ID，查询错误阶段，不能只看 Agent 进程结束 |
| 取消状态 | 看取消记录和各目标退出确认；删除标记或指令回执成功不等于实际进程退出 |

网络中断后先查实验状态再决定是否重试。创建实验接口没有通用客户端幂等键承诺，不要在未知结果时反复创建。重评规则和运行超时由各评估配置控制，不能把模型连接测试超时当作评估超时。

## 重命名与停止监听

`PATCH /api/experiments/:id` 每次只修改一个字段：

- `{ "name": "New name" }`：名称去空白后为 `1`～`120` 个字符；成功 `{ success: true, name }`。不修改状态、冻结配置或历史结果。
- `{ "watchMode": false }`：停止继续监听新 Trace；成功 `{ success: true, watchMode: false }`。它不等同于终止已有执行。

两类修改不能合并到一个请求；`watchMode: true` 不属于该 PATCH 的支持操作。

## 停止与逻辑删除

| 接口 | 语义 |
| --- | --- |
| `DELETE /api/experiments/:id?stop=true` | 请求取消关联任务并逻辑删除实验；成功 `{ deleted: true, cancellation }`，已确认 `200`，待确认 `202` |
| `DELETE /api/experiments/:id` | 保留草稿回滚删除语义；已经启动的实验可返回 `409`，不要拿它替代停止操作 |
| `DELETE /api/experiments/:id/cases/:caseId` | 删除所属 Case，并返回 `experimentDeleted`；最后一个有效 Case 被删除时实验也逻辑删除。Skill 用例分析/A/B 另支持 `dataset:<源CaseId>` 选择器 |

取消记录会持久化待确认状态并重试，迟到结果不能复活逻辑删除条目。HTTP 请求被取消只代表客户端结束等待；确认退出仍以服务端取消状态为准。

## 错误

常见为 `400` 参数/身份缺失、`404` 目标不存在或归属不匹配、`409` 状态冲突、`503` 无法创建 Trace 生成任务、`500` 服务失败。环境准备、Benchmark 和 Trace 生成错误可能另带 `code`；按[对应协议](./benchmark-protocol.md)读取。保存响应以定位问题，不把所有分支都解析成 `{ id }`。

实现依据：[实验路由](https://gitcode.com/openeuler/agent-insight/blob/master/src/app/api/experiments/route.ts)、[启动](https://gitcode.com/openeuler/agent-insight/blob/master/src/app/api/experiments/%5Bid%5D/run/route.ts)、[详情与控制](https://gitcode.com/openeuler/agent-insight/blob/master/src/app/api/experiments/%5Bid%5D/route.ts)。

[English](../../../en/reference/evaluation/experiments-api.md)

## 诊断运行与优化输入

单组实验创建时，数据集绑定中的 `contentHash` 由服务端读取数据集 Case 后计算，覆盖原始输入、预期输出、values（含评估器上下文目录）和 evaluationFocus，不信任客户端提交的指纹。匹配过程可规整空白，保存输入与参考答案时保留原文。诊断复测对带指纹的记录严格校验原文与指纹；旧记录只兼容原文或历史导入的 `trim().replace(/\s+/g, ' ')` 结果，不重写基线答案。诊断冻结后的输入、答案、执行与评分变化仍阻止复测，错误会指出具体字段。

新接口使用已登录用户的 API Key 校验实验、报告和 Skill 归属。前端提交 ID，服务端读取原始证据。

| 请求 | 行为 |
| --- | --- |
| GET /api/experiments/:id/cases/:caseId/diagnoses | 最近十条诊断记录 |
| POST 同一路径 | resultIds + preview=true 预览输入。确认时提交 requestKey 和 expectedInputHash，返回 runId。新的 requestKey 创建新任务，不按输入内容复用历史；相同 requestKey 和输入的重试返回同一任务。force 参数兼容旧客户端，新任务不再需要该参数。输入变化返回 409，无有效被测轨迹返回 422 |
| GET /api/diagnosis-runs/:runId | 状态、输入摘要、进展、最终发现及不可导入原因 |
| POST /api/diagnosis-runs/from-trace | 按 executionId 与 generatedAt 冻结现有最终报告，校验执行内容未变化 |
| GET /api/skills/by-name/:name/diagnosis-inputs?version=N | 核验有权限的 Skill 基线，返回文件和内容哈希 |
| POST /api/skills/by-name/:name/diagnosis-inputs | 提交 runId、findingIds、baseVersion、expectedContentHash、skillRelevanceConfirmed、constraints；baseVersion 必须等于执行时版本，expectedContentHash 必须匹配执行快照及对应历史版本。执行版本或快照哈希缺失返回 409，baselineVerified 不能绕过校验。返回工作台 sessionId |

同一用户的相同导入选择与约束可复用草案。Trace、报告和评测快照独立于原诊断缓存。单次快照上限 16 MiB；超限时返回错误，不截掉证据后继续执行。

前端使用返回的 runId 打开 `/fault?runId=…`，通过 GET `/api/diagnosis-runs/:runId` 读取该运行的证据、进度和报告，与仅 Trace 诊断的报告读取相互独立。旧 `/diagnosis-runs/:runId` 页面链接重定向到统一界面。

诊断最终报告严格解析完整 JSON，并校验必要字段与发现引用。`phase1Grid` 和 `issues` 的模块允许 `memory`、`reflection`、`planning`、`action`、`system` 及 `others`，与 Skill 报告协议一致；其他问题的证据与引用保留，不增加第六个认知模块。解析、读取或结构校验失败通过诊断运行的 `status=failed` 和 `errorMessage` 返回，不保存为成功空报告；结构合法的 `findings: []` 不等于证明执行正常。历史记录修复需要另行核对与确认。
