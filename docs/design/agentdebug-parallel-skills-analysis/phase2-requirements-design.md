# AgentDebug 与 Skills 分析并行化需求设计

## 存储模型

新增 `AgentDebugSkillsAnalysis`，作为 AgentDebug 专用的 Skills 步骤核验存储。

字段：

| 字段 | 说明 |
|-|-|
| `id` | 主键 |
| `executionId` | 对应 `Execution.id`，唯一 |
| `user` | 用户名 |
| `interactionsHash` | 当前 trace interactions hash，用于判断缓存是否匹配 |
| `status` | `pending` / `running` / `done` / `failed` |
| `errorMessage` | 失败原因 |
| `analysisJson` | `AgentDebugSkillsAnalysis` JSON |
| `keyActionCount` | 关键动作条数，便于列表和排障 |
| `ranAt` | 首次运行时间 |
| `updatedAt` | 最近更新时间 |

设计约束：

- 新表是 Skills 分析唯一来源。
- `AgentDebugReport.reportJson.skillsAnalysis` 不再读、不再写。
- 删除 AgentDebug 报告时，同时删除对应 Skills 分析缓存，保持“重新诊断”语义清晰。

## API 行为

### `GET /api/observe/executions/:executionId/agent-debug`

返回主诊断报告和主诊断 row，不再把 Skills 分析合并进 `report`。

### `POST /api/observe/executions/:executionId/agent-debug`

只负责主诊断：

1. 判断同 `interactionsHash` 的主诊断缓存。
2. 运行或复用 AgentDebug 主诊断。
3. 写入 `AgentDebugReport`。
4. 不读旧 Skills 嵌入字段，不把 Skills 结果合并回报告。

### `GET /api/observe/executions/:executionId/agent-debug/skills-analysis`

新增读取接口：

1. 解析 execution。
2. 计算当前 `interactionsHash`。
3. 从 `AgentDebugSkillsAnalysis` 读取结果。
4. 如果 hash 不匹配，则返回空结果或旧状态不可用。

### `POST /api/observe/executions/:executionId/agent-debug/skills-analysis`

独立运行 Skills 分析：

1. 不要求 `AgentDebugReport` 已存在。
2. 如果同 `interactionsHash` 已有 `done` 且非 force，直接返回缓存。
3. 如果同 `interactionsHash` 已是 `running`，返回 409 running。
4. 否则写 running row，运行分析，再写 done/failed row。

## 前端状态

`AgentDebugCard` 维护两类状态：

- `report`：主诊断报告。
- `skillsAnalysis`：独立 Skills 分析。

启动流程：

1. 用户点击“启动智能诊断”。
2. 前端同时发起主诊断 POST 和 Skills 分析 POST。
3. 主诊断按 `/agent-debug` 轮询。
4. Skills 区块按 `/agent-debug/skills-analysis` 轮询。
5. 任一请求完成后只更新自己的状态。

## 故障追问上下文

`/api/fault/diagnosis/stream` 构建 AgentDebug 上游上下文时：

- 主诊断摘要来自 `AgentDebugReport`。
- Skills 摘要来自 `AgentDebugSkillsAnalysis`。
- 如果 Skills 新表没有结果，则标记为 unavailable，不读取旧嵌入字段。

