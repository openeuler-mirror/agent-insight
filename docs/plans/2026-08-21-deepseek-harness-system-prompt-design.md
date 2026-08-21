# DeepSeek Harness System Prompt 聚合修复设计

## 背景与结论

DeepSeek Harness 已在官方 Session Telemetry 的 `request/header.body.header.system` 中上报完整 System Prompt。Agent Insight 的 Harness aggregator 当前只从该事件读取模型并直接跳过，导致持久化的 `Session.interactions` 不含 `role=system`，前端因而不展示 System Prompt 页签。

## 方案比较

1. **服务端 aggregator 规范化（采用）**：把 `header.system` 转为平台已有的 `role=system` interaction。复用 Trace 构建与 UI 展示契约，根 Agent、子 Agent 和历史 spool 重聚合都能使用同一路径。
2. **客户端额外上报上下文**：像 Claude 补传一样新增接口。Harness 原始 telemetry 已包含数据，重复上报会增加去重、鉴权和版本兼容成本，因此不采用。
3. **前端直接解释 Harness 原始事件**：绕过 `Session.interactions`。会让框架特例进入 UI，并且当前 Session API 不返回原始 spool，因此不采用。

## 数据流

对每个 `request/header`：

- 保留现有模型提取；
- 读取非空字符串 `body.header.system`；
- 每个 source Session 只产生一条 System Prompt interaction；
- 根 Session 使用 `role=system`、根 Agent 名称；
- 子 Session 额外写入 `subagent_session_id`，使现有 Agent Tree 将提示词挂到对应子节点；
- 写入 `system_prompt_length` 与事件时间，不把 System Prompt 计入时间线、LLM 调用数或用户 query。

前端现有 `buildAgentTrace` 会把 `role=system` 转为节点元数据，并在节点详情显示 System Prompt 页签，无需修改 UI。

## 验收

1. 聚合器测试先证明当前根 Agent System Prompt 缺失，再证明修复后只保留一份。
2. 构造带父子 Session、根/子 `request/header` 的测试，断言子提示词携带正确 `subagent_session_id` 且只挂到子节点。
3. 使用真实 `dsh` 执行强约束 query：主 Agent 必须通过子 Agent 工具派发一个简单只读任务，禁止主 Agent 自行完成。
4. 同时核对原始 spool 的子 Session descriptor/header、数据库 `Session.interactions` 的 root/child system 记录，以及 Trace API/Agent Tree 的子节点 System Prompt。
5. 运行 Harness 定向测试、相关 Trace 构建测试、`git diff --check` 和 Node 22 生产构建。

## 边界

- 本次不新增客户端协议或前端框架分支。
- 真实模型仍可能违反自然语言约束；验收以原始 `subagent/descriptor`、父子 Session 关系和 Trace 子节点三者同时存在为准。若模型未派发子 Agent，调整 query 后重跑，不用伪造运行结果。
- 已有 Trace 需要显式重新聚合历史 spool 才会补出 System Prompt；代码发布本身不改写已持久化记录。
