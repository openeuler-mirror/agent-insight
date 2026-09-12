# 跨 Session 协作 Trace：需求设计

## 1. 权威边界

系统保留三类互不覆盖的数据：

```text
Pi/Codex/其他框架 ──现有接入──> Execution + Session
.gp ──现有 Goal Plus 快照──> GoalPlus* + GoalPlusExecutionLink
                                │
                                └─服务端投影──> CollaborationEvent
外部 Hook/执行程序 ──事件 API─────────────────> CollaborationEvent
```

- Execution 是原生执行过程权威源。
- GoalPlus* 是 Goal、Run、Candidate、worker 成员关系的语义权威源。
- CollaborationEvent 是跨 Session 联系事实；EndpointResolution 是可变化的关联结果。
- 关系层只引用 Execution，不修改原生父子树，也不反向写 `.gp`。

## 2. 数据模型

### Collaboration

按 `(user, collaborationId)` 唯一，保存 `sourceType`、`sourceRef`、诊断和时间。`sourceType` 当前为：

- `reported`：外部事件接口上报。
- `goal-plus-semantic`：内部 Goal Plus 投影，外部接口不可指定。

### CollaborationEvent

按 `(collaborationDbId, eventId)` 唯一。保存两端 Session ID、说明、可选时间/内容/定位器、来源、稳定正文与 SHA-256。正文不可变；关联状态不进入正文 hash。

### CollaborationEndpointResolution

每个事件固定 `from`、`to` 两行，状态为 `pending | linked | ambiguous | superseded`。它可保存 Execution 引用、关联方法、证据以及 from 端步骤候选状态，因此 Trace 晚到或语义补全时允许重算，不破坏事件幂等。

## 3. 外部事件接入

`POST /api/ingest/collaborations/events` 使用 `x-witty-api-key`，只创建 `sourceType=reported` 的事件。请求最多 64 KiB，ID、Session、description、content 与 fromLocator 均有长度和严格结构校验。

`collab_gp_` 前缀由内部 Goal Plus 确定性投影保留，外部事件不能占用，避免同一用户下的来源身份冲突。

同一事件正文规范化后计算 hash：对象 key 顺序和 JSON 空白不影响结果；字段值、数组顺序和可选字段变化会产生冲突。description、content 和定位字符串在服务端再次执行 secret/path 脱敏。

端点只在当前用户下按 `taskId` 或 `agentSessionId` 精确匹配。零个结果为 pending，一个为 linked，多个为 ambiguous；不按同名 Agent 或时间邻近匹配。

## 4. 发起位置候选

fromLocator 支持工具名完全匹配和已识别 Shell 工具的命令片段匹配：

- 单一弱匹配为 `candidate`，不会写成 confirmed。
- 同组事件与调用数量相同、双方时间完整且无并列、调用时间带可信来源时，可返回 `time_ordered`。
- 数量不等、时间缺失或来源不可信时为 `ambiguous`。
- 无定位条件但既有 Execution 具有直接父子关系时可复用为 `confirmed`。

所有位置结果只服务只读协作展示，不改写 Execution。

## 5. Goal Plus 投影

Goal Plus 不调用新增 HTTP API，也不改变 collector。语义 ingest 或新 Execution 触发既有 `relinkGoalPlusSource` 后，内部 projector 读取 GoalPlusGoal、GoalPlusAgentSession 与 GoalPlusExecutionLink，并调用同一持久化服务。

稳定身份：

```text
collaborationId = collab_gp_ + sha256(sourceId, goalPlusId)
mainSessionId   = goal-plus:<sourceId>:goal:<goalPlusId>:main
workerSessionId = goal-plus:<sourceId>:<agentSessionId>
eventId         = evt_gp_ + sha256(sourceId, goalPlusId, orchestrated,
                                   runId, agentSessionId, role)
```

逻辑主节点保证事件正文不因 Execution 晚到或重新关联而变化：

- 唯一 `role=main, linkState=linked` 时，from 端解析到该 Execution。
- 多个候选时 from 端为 ambiguous，并记录 `ambiguous-main-session`；不任选父级。
- 尚无主 Trace 时为 pending，worker 关系仍可保存。
- worker 端仅复用 GoalPlusExecutionLink；不使用 task name/time_ordered 降低 Goal Plus 的确定性标准。
- 投影关系固定 `relationKind=orchestrated`，默认不上传 content、不提供 fromLocator。

角色或成员关系变化产生新的稳定事件；不再属于当前投影的旧事件保留审计事实，但其端点状态改为 superseded。

## 6. 查询与重算

- `GET /api/observe/collaborations`：按用户分页列出协作。
- `GET /api/observe/collaborations/:collaborationId`：返回节点、事件、端点解析和定位依据；读取前重算 reported 事件。
- `POST /api/observe/collaborations/relink`：按协作重算 reported 端点。

Execution 保存后只重算端点 ID 命中该 Execution 的 reported 事件；Goal Plus 先重跑确定性链接再重建对应关系投影。

### Goal Plus 主 Trace 内嵌展示

通用 Trace 详情可复用已经 linked 的 Goal Plus `orchestrated` 关系，在查询响应中把独立 worker Session 合成为虚拟 TASK 与子 Agent 子树。该展示遵守以下边界：

- 只处理主、worker 两端均已唯一关联的 Goal Plus 内部关系；不读取 pending、ambiguous 或 superseded 端点。
- 合成 interaction 只存在于响应内，带来源与锚点状态，不写回 Session / Execution / Collaboration。
- Goal Plus 没有原生 spawn 锚点时，虚拟 TASK 仅表示“编排成员关系”，不插入或绑定到某一次原生工具调用。
- 子节点保留 worker `taskId`，允许继续打开独立 Trace；原生列表、评估与导出数据口径保持不变。
- 单次投影设成员数和交互数上限，截断状态通过响应元数据显式返回。
- Goal Plus 内嵌树直接读取既有 `GoalPlusExecutionLink` 的唯一关联，不以 `CollaborationEvent` 已经物化为前提；两者使用相同的确定性身份和可信度边界。
- 通用 Trace 列表的仅主范围隐藏已投影 worker，仅子范围仍可检索 worker；该分类是查询覆盖层，不回写 `isSubagent`。
- Pi 原生 `<nativeSessionId>__taskN` 仅在框架为 `pi-agent`、query 明确为 `/goal-plus`、基础 Session 唯一命中 Goal 且权威 main link 唯一时作为只读根别名；精确 link 优先，歧义时关闭别名。该兼容逻辑不进入 reported collaboration 解析器。

## 7. 安全与故障隔离

- 所有写入和读取按已认证 user 隔离。
- 外部 API 不能声明内部 `goal-plus-semantic` 来源。
- 默认不保存 Goal Plus 输出、评分、结果摘要、绝对路径或 hidden gold。
- 关系投影与端点重算异常只记录警告，不让原生 Trace 或 Goal Plus 快照失败。
- 关系状态不参与 Goal Plus completeness、业务状态或 Execution 成败。
