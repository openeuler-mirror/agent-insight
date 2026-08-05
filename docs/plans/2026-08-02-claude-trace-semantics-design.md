# Claude Trace 语义修正设计

## 背景

MR !244 用 Claude Code 专属补传器补齐官方 OTel 跨机上报缺失的 system prompt、hook additionalContext、工具输出和子 Agent 映射。119 实测 task `2a1b9675-13d5-40b7-b3f1-0590e88d0109` 暴露出四类语义错误：

- Claude 内部的标题生成、输入建议和离开回顾被当成业务对话；
- 首批聚合写入的 `Claude Code Session <UUID>` 没被后续真实用户输入替换；
- 子 Agent 的真实类型是 `general-purpose`，父 task 却被默认成 `agent`，现有建树器无法认领；
- 补传 system prompt 没有 root/子 Agent 归属，标题生成提示词也被混入根节点。

## 目标

1. `generate_session_title`、`prompt_suggestion`、`away_summary`、`agent_summary` 全部不进入业务 Trace。
2. Trace 列表 query 使用第一条真实用户输入，不保留 Claude 占位标题。
3. Claude 子 Agent 复用平台现有 Agent tree 和派生 Execution 机制，不新增一套 UI。
4. 根 Agent 和每个子 Agent 只展示各自实际使用的 system prompt。
5. 高频 hook 不重复拉起 worker；补传失败仍保留本地队列，不能影响 Claude 会话。
6. 所有改动限定在 `claudecode` 和 Claude 补传契约，既有框架行为不变。

## 非目标

- 不修改 Claude Code 官方 OTel 事件格式。
- 不改变通用 OTLP 接收端点、OpenCode/Hermes/CodeAgent 聚合语义。
- 不在本 MR 中并行化服务端 OTel consumer；30 个完整 Session/s 的持续容量需单独压测和容量设计。
- 不回写已经被 retention 清理原始 spool 的历史 Trace。

## 方案

### 1. 过滤 Claude 内部辅助调用

聚合器维护 Claude 内部 `query_source` 白名单：

- `generate_session_title`
- `prompt_suggestion`
- `prompt_suggestion_generate`（兼容观测事件命名差异）
- `away_summary`
- `agent_summary`

这些调用的 `assistant_response` 不生成 interaction、不更新 `finalResult`。客户端扫描 raw request body 时也识别标题生成请求，不把它的专用 system prompt补传。真实 root 请求和子 Agent 请求不受影响。

### 2. system prompt 精确归属

补传器从主 transcript 的 Agent/Task `tool_use.input.prompt` 建立 `prompt → toolUseId`，并读取子 Agent meta 中的 `toolUseId/agentType`。对于包含 `cc_is_subagent=true` 的 raw request body：

1. 优先用其用户消息中的任务 prompt 精确匹配父调用；
2. 无法精确匹配时，才在有界时间窗内按 raw body 与 meta 的 mtime 最近匹配；
3. 匹配成功的 `system_prompt` 补传 `toolUseId` 和 `agentType`；无法可靠匹配时不误挂到 root。

服务端将无 `toolUseId` 的 prompt 归 root，将带 `toolUseId` 的 prompt 归对应 `subagent_session_id`。同机部署仍优先读取真实 `body_ref`，不改变现有路径。

### 3. 子 Agent 建树

服务端解析 `subagent_map` 后，用其 `agentType` 回填对应父 task 的 `subagent_type`，覆盖跨机路径产生的默认值 `agent`。这样父 task 与 `role=subagent` 的类型一致，现有 `buildAgentCallTree` 能建立 child 并将 task 作为结构链接渲染。

仅把 `claudecode` 加入子 Agent Execution 派生范围，使 Claude child 与其他已支持框架一样拥有 `parentExecutionId/rootExecutionId/isSubagent`；其它框架集合和建树器规则不改。

### 4. query 纠正

保留现有“已写 query 默认不可覆盖”保护，只扩展占位值识别：当 framework 为 `claudecode` 且 query 匹配 `Claude Code Session <sessionId>` 时，允许由 interactions 中第一条非空 user 内容替换。任何真实 query、其他 framework query 均不可覆盖。

### 5. 高频补传保护

队列继续按 Session 文件合并。新增 worker 启动令牌：

- hook 写完队列后以 `open(..., 'wx')` 原子争抢启动令牌；只有获胜者 spawn worker；
- worker 排空队列后释放令牌，并再次检查是否有竞态写入的新任务；
- 启动失败立即释放；异常退出留下的令牌超过固定时限后可恢复；
- `.drain.lock` 仍保证同一时间只有一个实际上传者。

这消除 30 hooks/s 时每个 hook 都额外启动 worker 的进程风暴，但不改变队列、重试和上传顺序。

## 兼容与性能边界

- 补传器只由 Claude setup 安装，入口仍是 `/api/ingest/claude/context`；其他框架不会调用。
- 本地实测纯队列写入约 6,384 ops/s，不是瓶颈；30 次 Node 冷启动约 0.65s，现有“每次再拉一个 worker”才是需要消除的开销。
- 到 119 的 HTTP RTT 多数 26–36ms，单 worker 串行处理 30 个不同 Session/s 已接近上限。相同 Session 的高频轮次会被队列合并；30 个完整新 Session/s 持续输入仍可能形成可恢复积压。
- 服务端采用 spool + 单飞 consumer，接收成功不等于立即可见。若 30 个完整 Session/s 是正式容量指标，应另做持续压测并评估多 consumer/分区存储，不能在本次语义修复里直接放开并发。

## 验证

- 用生产样本形状覆盖四类内部调用、占位 query、两个 `general-purpose` 子 Agent 和三个 system prompt scope。
- 先观察测试在当前代码上失败，再实现最小修复。
- 断言建树结果包含两个 child、父 task 均有 `spawnedChildId`，root/child system prompt 各归其位。
- 对 OpenCode、Hermes、CodeAgent 和 Claude 同机 body_ref 既有用例做回归。
- 对 300 次 burst enqueue 验证只 spawn 一个 worker，并覆盖完成后再启动、陈旧令牌恢复和失败队列保留。
- 最后运行 Claude 专项、完整 `npm run test`、`npx tsc --noEmit`，再在 119 进行真实 Claude Code 端到端验证。
