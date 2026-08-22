# 通用实验 Trace 生成：需求设计

## 总体流程

普通评测数据集使用已有客户端控制面，可靠性数据集保留现有 FI 执行链路：

```text
dataset case.input
  ├─ reliability → FI run → Session/Execution → ExperimentCase → evaluators
  └─ other kinds → RUN_EXPERIMENT_CASE → Session/Execution → ExperimentCase → evaluators
```

前端在启动请求中显式传递 `fiOrchestrate`，服务端不再把 `traceSource=generate` 等同于 FI。这样数据集类型只决定执行方式，不改变后续统一评估入口。

## 数据模型

`ExperimentCase` 增加：

- `traceGenerationCommandId String?`：普通生成使用的 `ReliabilityCommand.commandId`，用于跨请求查询状态。
- `traceGenerationError String?`：客户端失败、Trace 为空或等待超时的用户可见错误。

已有 `fiTaskId` / `fiRunId` 继续只服务可靠性故障注入，不复用、不混写。

## 普通 Trace 编排

1. 校验所选客户端属于当前用户、在线、声明 `RUN_EXPERIMENT_CASE`，并提供所选 Agent/平台。
2. 按 Case 串行创建并投递 `RUN_EXPERIMENT_CASE`，避免同一客户端并发运行实验 Case。
3. payload 只包含 `platform`、`agent`、`model`、`input`、超时和实验/Case 关联标识，不包含命令、参数数组、工作目录或可执行文件。
4. 将 `commandId` 写入 Attempt 与 Case 最新状态投影，等待客户端回报 Trace ID 或进入终态。
5. 平台适配器必须取得本次运行的 `sessionID`；客户端解析到后立即以 `RUNNING(state=TRACE_STARTED, traceId)` 上报，不等待 Agent 进程退出，进程退出时再以终态回执补充 exitCode。没有 Trace ID 时返回 `TRACE_ID_MISSING`，不得按输入猜测。
6. 服务端收到运行中或终态回执里的 Trace ID 后，只按当前用户与 `Execution.taskId = traceId` 等待根 Execution，并确认对应 Session 已结束且 interactions 非空。
7. 绑定 `executionId` / `taskId` / `actualOutput`；全部 Case 处理完成后只对成功 Case 调用 `startExperimentRun`。

普通生成不保留输入匹配兜底。旧客户端必须通过 capability 声明 `runExperimentCase.returnsTraceId=true` 才进入可执行目标；未声明时向导禁用该目标并提示升级。

## Attempt 与重试

普通生成的每次执行记录为 `ExperimentTraceAttempt`，保存 Case、attemptNo、运行目标、commandId、traceId、状态与结构化失败码。默认首次执行加两次自动重试，退避 5 秒、20 秒。

- 指令未送达、ACK/命令超时、客户端忙、进程启动失败、Trace 入库等待超时可重试。
- WSS 即时投递返回 `delivered=false` 不等于指令失败：命令保持 `CREATED`，允许客户端通过 long-poll 领取；只有命令进入终态失败或过期后才进入重试。
- 客户端执行超时后先终止整个 Agent 进程组，5 秒未退出则强制结束，确保 long-poll 串行队列能领取下一次 Attempt。
- 目标/Agent/模型不支持、非法参数、鉴权失败、客户端未返回 Trace ID不可重试。
- Agent 任务失败但 Trace 已入库且 interactions 非空，属于有效 Trace，不触发生成重试，交给评估器判断任务质量。
- 自动重试前只检查当前生成周期内此前 Attempt 的 traceId，并从关联 `ReliabilityCommand.resultJson` 补回晚到的 Trace ID；本周期 Trace 延迟入库后立即绑定，避免重复执行。
- 同一客户端仍串行执行 Case；一个 Case 重试等待不阻塞后续 Case 的首次执行。

自动重试耗尽后，详情页 Case 操作列显示统一“重试”按钮。`POST /api/experiments/:id/cases/:caseId/retry` 根据实验的 Trace 来源分流，而不根据 Case 当前是否已绑定 Execution 分流：选择已有 Trace 的实验只重评失败结果；生成 Trace 的实验始终开启新的生成周期，首轮强制创建新 Attempt 并执行客户端命令，不绑定任何历史周期中的 Trace，成功后重评该 Case 的全部评估器。本次手动重试触发的后续自动重试只可恢复同一新周期内的晚到 Trace。正在运行的 Case 返回 409。

## 状态与失败

- Case 有 `traceGenerationCommandId` 且已绑定可用 Trace：`ready`。
- 指令仍在非终态或实验仍运行：`pending`。
- `traceGenerationError` 非空，或实验结束仍无可用 Trace：`failed`。
- Attempt 处于 queued/dispatching/running/waiting_trace/retry_wait：`pending`，页面展示当前重试次数。
- 部分成功：只为成功 Case 创建评估结果；失败 Case 不计入综合分。
- 全部失败：实验状态为 `failed`。

## 兼容性

- 可靠性数据集仍通过 `faultInjectionType` 和 FI Run 生成 Trace。
- 已有实验记录的新增字段为空，不影响查询与评分。
- 使用已有 Trace 的实验不创建通用生成指令。
