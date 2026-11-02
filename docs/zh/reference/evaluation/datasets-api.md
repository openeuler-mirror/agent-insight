---
title: "评测数据集 HTTP 接口"
description: "数据集读写、Trace 回流、历史 Trace 自动生成及取消删除的请求和响应。"
---

本页覆盖当前 `/api/agent-datasets` 前缀下 9 个路由文件的 13 个 HTTP 方法。数据集以 `id` 寻址，`targetSkill` 使用 Skill 名称；通用身份与接口分类见 [HTTP 接口与用户身份](../platform/http-api.md)。界面流程见[评测数据集](../../how-to/evaluation/datasets.md)，创建实验见[实验 HTTP 接口](./experiments-api.md)。基于 Skill 起草样本、Benchmark 管理命令不属于本前缀。

## 身份与返回形式

这些路由并不统一采用 `resolveUser`：

| 入口 | 当前身份行为 |
| --- | --- |
| 普通列表、创建、更新、详情、删除、Trace 草稿与回流 | 从查询参数或 JSON 请求体读取非空 `user`，普通分支并不把该值验证为凭证。存储查询按该用户名及系统公开 Benchmark 的可见性过滤，不能据此证明调用者身份已验证 |
| Trace 自动生成、生成选项、生成进度、取消、删除进度 | `traceIdentity` 只验证请求头 `x-witty-api-key`，不接受查询参数 `apiKey` 或显式 `user` 替代；缺少或无效 Key 返回 `401` |
| 普通路由访问 Trace 自动生成的数据集 | 额外检查有效 Key 对应账号、`user` 与数据集归属一致；不匹配返回 `404`，删除中返回 `409`；更新还要求已发布。列表仅在 Key 账号等于查询 `user` 时包含此类数据集 |

集成调用应始终携带当前账号 Key，并在需要 `user` 的接口传入相同账号。普通分支的兼容参数不是安全隔离证明；对外边界见 [HTTP 身份说明](../platform/http-api.md)。下表成功响应均为 `200`，另有标注的除外。

## 查询与普通读写

| 方法与路径 | 请求 | 成功响应与约束 |
| --- | --- | --- |
| `GET /api/agent-datasets` | 必填查询 `user`；可选 `targetSkill=<名称>`、`targetSkill=__none__`（未绑定 Skill）、`view=summary` 或 `view=reference` | 直接返回数组，没有分页包装；默认完整数据集，`summary` 为无 `cases` 的元数据与 `caseCount`，`reference` 另带不含轨迹的参考 Case 投影。默认完整列表按更新时间降序 |
| `POST /api/agent-datasets` | JSON：必填 `user/name`；可选 `description/targetAgent/targetSkill/tags/datasetKind/fields/cases` | `{ success: true, dataset, warnings }`，创建 UUID 数据集；显式创建 `benchmark` 返回 `403`。普通类型支持 `ideal_output/trajectory/reliability`，未识别值归一为 `ideal_output` |
| `PATCH /api/agent-datasets` | JSON：必填 `user/id`，其余可写字段同创建 | `{ success: true, dataset, warnings }`。只修改提供的字段；提供 `cases` 时替换整个样本数组，提供 `fields` 时替换字段定义，不是单条追加。没有版本号或通用条件更新承诺 |
| `GET /api/agent-datasets/:id` | 必填查询 `user`；可选 `view=items` 或 `view=case&caseId=<Case ID>` | 默认完整数据集；`items` 将轨迹字段转为前 600 字符并附省略号的预览；`case` 返回单个完整 Case。不要把 `items` 预览写回全量数据 |
| `DELETE /api/agent-datasets/:id` | 必填查询 `user` | 普通数据集返回 `{ success: true }`；不存在为 `404`。Trace 生成集可能返回 `202 { deletionId, status }` 或无正文 `204`，须按下文查询删除状态 |

普通创建/更新的 `name` 去首尾空白后不能为空。`fields` 的每项使用 `key/label/type`，可含 `id/path/displayType/width/format/truncate/description/system`；`key` 须匹配 `^[A-Za-z][A-Za-z0-9_]*$` 且唯一，字段名称按忽略大小写去重。类型为 `text/number/boolean/json`，省略或空字段数组使用类型默认字段。可靠性集会补回系统字段。

Case 使用 `id/input/expectedOutput/evaluationFocus/tags/trajectory/values`；未传 `id` 时普通样本生成 UUID。自定义字段存于 `values`，标准预期输出键为 `reference_output`。普通样本不强制有非空参考答案；可靠性样本要求非空 `input` 和已注册的 `values.fault_injection_type`，失败返回 `422` 和 `details: [{ caseId, field }]`。保存本身不触发模型提取关键观点；首次相关评测再按需计算缓存。

已存在的内置可靠性集及 Benchmark 在普通 `PATCH/DELETE` 分支返回 `403`；Benchmark 应使用[管理员受控流程](../../how-to/evaluation/datasets.md#管理员导入-benchmark-数据集)维护。不要将某个分支的检查推断为所有写入口的相同保证。

```json
{
  "user": "example-user",
  "name": "Arithmetic regression",
  "datasetKind": "ideal_output",
  "cases": [{
    "id": "case-1",
    "input": "Return the sum of 1 and 1",
    "expectedOutput": "2"
  }]
}
```

这是普通 `POST` 请求体示例，不执行 Agent，也不创建实验。创建没有通用幂等键，响应不明时先查询列表，不要盲目重复创建。

## 从已有 Trace 构建草稿并回流

| 方法与路径 | 请求 | 成功响应与边界 |
| --- | --- | --- |
| `POST /api/agent-datasets/trace-drafts` | 必填 JSON `user`，以及 `executionId` 或 `taskId`；同时提供时优先 `executionId` | `{ draft: { values: { input, output, trace }, traceSource: { taskId, executionId?, capturedAt } }, warnings }`。读取该用户的 Execution 和 Session，提取原始交互形成草稿，尚未写入数据集；缺 Trace/Session 为 `404`，交互 JSON 无效为 `422` |
| `POST /api/agent-datasets/backflow` | JSON `user`、`mode: "existing"/"new"`、`cases: [{ values, traceSource? }]`；已有集需 `datasetId`，新集需 `datasetName`，可选 `datasetDescription` | `{ success: true, datasetId, caseId?, caseIds, inserted, skippedDuplicates, addedFields }`。兼容未传 `mode` 时从目标 ID/名称推断，以及单条 `values/traceSource` 请求 |

新集可传 `fields`，已有集可传 `newFields`；字段至少一个、key 合法唯一、label 非空且忽略大小写唯一、type 为四种支持类型之一。省略新集 `fields` 时从候选 `values` 推断旧格式字段。每条 `values` 只能含已定义字段；JSON 字段的非空字符串必须能解析为 JSON。

`fieldMappings` 为 `[{ key, source }]`，`source` 仅 `input/output/trace/none`；省略时采用标准字段的默认映射。它指定哪些已提交值成为规范输入、预期输出和轨迹，不会重新从源 Trace 拉取内容。新集包含 `trace` 或 `trajectory` 键时类型为 `trajectory`，否则为 `ideal_output`。

回流按 `traceSource.taskId` 对已有样本和本批次去重；没有该来源标识的样本没有此去重保证。全为重复时不写入新增字段。内置可靠性集禁止回流；Trace 自动生成集要求在详情页使用固定双字段导入，回流入口返回 `422`。回流去重不是所有 POST 的通用幂等承诺，也不代表来源答案已经过模型或人工正确性审查。

## 从历史 Trace 异步生成

这组接口抽取并采样已有 Trace 的独立文本问答，不启动 Agent、不调用模型。参考答案来自历史输出，不能由生成成功推断其事实正确性。当前服务依赖 SQLite 与常驻 Node Worker；初始化未完成为 `503 FEATURE_INITIALIZING`，不可用为 `503 FEATURE_UNAVAILABLE`，响应分别携带 `Retry-After: 2/30` 和 `Cache-Control: no-store`。

| 方法与路径 | 请求 | 成功响应 |
| --- | --- | --- |
| `GET /api/agent-datasets/generation-options` | 可选查询 `platform/from/to`；省略时间时最近 7 天，提供任一时间参数时须成对提供 | `{ platforms: [{ id, label }], agents: [{ agentKey, name, traceCount }] }`。平台来自该账号历史框架目录；选择平台后返回所选时间窗口内 Agent。使用返回的 `agentKey`，不要用显示名称代替 |
| `POST /api/agent-datasets/trace-generation` | 下表 JSON 配置，不传 `user` 来覆盖 Key 账号 | `202 { datasetId, jobId }`，只表示接受或重放已有任务；随后查询生成进度 |
| `GET /api/agent-datasets/:id/generation` | 路径为数据集 ID | `{ datasetId, jobId, status, stage, stageIndex, totalStages, generatedCount, summary, error, generationConfig, canCancel, canReturn, canFinish }` |
| `DELETE /api/agent-datasets/:id/generation` | 路径为数据集 ID | 无正文 `204`，仅释放当前查看者的临时筛选明细缓存，不删除数据集、不停止任务 |
| `POST /api/agent-datasets/:id/generation/cancel` | 路径为数据集 ID | `202 { deletionId, status }` 或无正文 `204`；取消会清理生成任务及其数据集，不是暂停后续恢复。已发布时返回 `409 ALREADY_COMPLETED` |
| `GET /api/agent-datasets/deletions/:deletionId` | 使用取消或删除响应中的 ID | `{ deletionId, status: "deleting"/"cleanup_failed"/"deleted", error }`；清理失败错误码为 `CLEANUP_FAILED`；其他账号或未知记录为 `404` |

| 生成字段 | 校验 |
| --- | --- |
| `name` | 去空白后 1～50 字符 |
| `description` | 可省略，字符串，最多 200 字符 |
| `platform/agentKey` | 字符串，Agent 必须属于该账号在窗口内可访问的所选平台；无来源为 `422 SOURCE_NOT_AVAILABLE` |
| `from/to` | UTC ISO 时间，支持秒或三位毫秒并以 `Z` 结尾；窗口恰为 24 小时、7 天或 30 天，结束时间不得超过服务端当前时间 5 分钟 |
| `limit` | 必填整数 1～500；不是保证生成条数 |
| `requestId` | 调用方生成的 UUIDv7；新请求时间须在过去 24 小时内且不得超前 5 分钟 |

同一账号、同一 `requestId` 和同一归一配置会返回同一 `datasetId/jobId`；相同 ID 配置不同为 `409 IDEMPOTENCY_CONFLICT`。任务已删除、回执已结束或新请求过期为 `410 REQUEST_EXPIRED`；成功任务在有效回执期内仍可重放，不能把“24 小时”理解为所有状态的固定重放期限。全局待处理任务（含清理中）达到 20 时新建返回 `429 QUEUE_LIMIT`。

进度 `status` 为 `generating/failed/published`，与内部队列状态不同。`stage` 可为 `queued/read/dedup/stratify/sample/convert/save/complete/failed`；不要按阶段字符串数量计算进度，应使用返回的 `stageIndex/totalStages`。失败时有 `error: { code, message }` 和可用于修改配置的 `generationConfig`。`summary` 是临时筛选明细，可能为 `null`，不保证跨重启或关闭窗口后恢复。

生成集发布后固定为 `ideal_output` 和两个文本字段 `input/reference_output`；更新 Case 时每条必须有唯一非空 `id`、非空文本双字段，不能添加其他值键。生成中/失败态不能按普通 PATCH 修改。删除或取消返回 `202` 时仍须读取正文 `status` 并查询清理记录，不能仅凭状态码断定还在运行或已经删除；重复已完成的 Trace 删除可返回 `204`。原始 Trace 不随数据集删除而删除。

## 错误与实现依据

普通路由常用 `{ error: "说明" }`，可靠性样本校验另有 `details`；Trace 生成相关错误使用 `{ error: { code, message, details? } }`，删除中的 `details` 可含 `deletionId`。JSON 解析错误在 Trace 错误处理器中为 `400 INVALID_CONFIG`，不能假定普通分支也使用这一结构。普通参数问题为 `400`，查找失败为 `404`，存储/未知服务问题可为 `500`。

本页按本地实现基线 `ccf6bcf8` 核对现有行为，不声明所有部署或后续版本均相同：

- [集合读写路由](https://gitcode.com/openeuler/agent-insight/blob/ccf6bcf80fe7c4831d20448b329f137ed5285edd/src/app/api/agent-datasets/route.ts)、[详情与删除](https://gitcode.com/openeuler/agent-insight/blob/ccf6bcf80fe7c4831d20448b329f137ed5285edd/src/app/api/agent-datasets/%5Bid%5D/route.ts)
- [回流路由](https://gitcode.com/openeuler/agent-insight/blob/ccf6bcf80fe7c4831d20448b329f137ed5285edd/src/app/api/agent-datasets/backflow/route.ts)、[数据集字段与持久化](https://gitcode.com/openeuler/agent-insight/blob/ccf6bcf80fe7c4831d20448b329f137ed5285edd/src/server/agent_datasets_storage.ts)
- [Trace 身份与错误](https://gitcode.com/openeuler/agent-insight/blob/ccf6bcf80fe7c4831d20448b329f137ed5285edd/src/server/trace-datasets/http.ts)、[配置契约](https://gitcode.com/openeuler/agent-insight/blob/ccf6bcf80fe7c4831d20448b329f137ed5285edd/src/lib/trace-datasets/contracts.ts)、[生成、幂等与清理](https://gitcode.com/openeuler/agent-insight/blob/ccf6bcf80fe7c4831d20448b329f137ed5285edd/src/server/trace-datasets/manager.ts)

[English](../../../en/reference/evaluation/datasets-api.md)
