---
title: "实验 HTTP 接口"
description: "普通实验的创建、启动、查询、重命名及取消删除约定。"
---

本页覆盖普通实验的常用调用及异步语义。Benchmark、Skill、LLM 对比实验走同一平台的不同分支，不能假定请求和响应完全相同；界面操作见[实验指南](../../how-to/evaluation/experiments.md)。用户解析见 [HTTP 接口与用户身份](../platform/http-api.md)。

## 查询

| 接口 | 参数与响应 |
| --- | --- |
| `GET /api/experiments` | 查询 `limit`（默认 `20`，范围 `1`～`100`）、`offset`（默认 `0`）、可选 `skillName`；返回 `{ items, total, limit, offset }`。普通列表排除逻辑删除、草稿及若干 Skill 专属 scope |
| `GET /api/experiments/:id` | 返回实验详情，包含 Case、评估结果和阶段信息；返回字段会按实验类别变化，不应复用列表 item 类型解析所有详情 |
| `GET /api/experiments/cancellations` | 返回当前用户最多 100 条 `pending` 取消记录：`{ cancellations }`，不是全部历史取消列表 |

调用时携带当前账号 Key，避免仅用可覆盖身份的 `user` 参数。缺少身份的普通列表可能扩大查询范围，不能据此确认 Key 有效；写操作和详情归属检查按各自分支处理。

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
