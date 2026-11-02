# Trace 问题分析与修改方案

本文整理两个 trace 的异常现象、根因判断和修复路径，目标是把“问题是什么、是不是这次改代码带来的、下一步怎么修”一次讲清楚，方便后续讨论和落地。

## 1. 结论先说

这两个 trace 不是同一个 bug。

1. `223fe26b-3a4b-45df-98fb-72918712dcef`
   - 表现为 Claude 的所有 tool call 都没有 `output`。
   - 这更像是 Claude 工具结果正文在采集 / 归一化链路里丢了，不是展示层简单漏渲染。

2. `ses_15490df0dffebkwYrw5b4sx1Nh`
   - 表现为两个 `subagent` 被 trace 树错误合并，子树被“乘以 2”式地压成一棵。
   - 这来自 `buildAgentCallTree` 对并行同类型 task 的合并策略，属于树构建逻辑问题。

从“是不是这次改代码直接引入”的角度看：

- `223fe...` 不是这次改动里直接改坏的 `agent-trace` 逻辑，但当前存储 / 归一化链路没有把 Claude 的 tool result 正文补回去，所以在现在的系统里会持续暴露。
- `ses_15490...` 的根因在旧的 tree builder 里，本身就存在；不过现在 `deriveSubagentExecutions` 复用这棵树，导致错误被固化到派生执行记录里，用户侧就看到了。

## 2. 问题一：`223fe...` 的 Claude tool call 没有 output

### 现象

这个 trace 里，Claude 的 tool 调用有数量，但 `tool_calls[].output` 全空：

- `topLevelToolCalls = 12`
- `topLevelToolCallsWithOutput = 0`
- `contentToolUseBlocks = 12`
- `contentToolResultBlocks = 0`

这说明不是“UI 没读到”，而是“存进去的数据里就没有结果正文”。

### 目前判断

链路上至少有两层值得看：

1. `src/lib/engine/observability/claude-parser.ts`
   - 这里负责把 Claude 的原始交互解析成内部 interactions。
   - 当前逻辑能识别 `tool_use`、能记录计数和 timing，但没有把后续 `tool_result` 的正文回填到对应的 `tool_calls[].output` 或 `result` 字段。

2. `src/lib/ingest/claude-otel/aggregator.ts`
   - 这里已经有更完整的合并模式，会把 `tool_result` 事件合并回对应 tool call。
   - 这说明系统里并不是没有现成的做法，而是 Claude 另一条解析路径没有跟上。

### 根因判断

我更倾向于把它看成“Claude 结果正文持久化缺口”，而不是展示层 bug。

如果上游只给了 `size_bytes` 一类元信息，而没有正文，那就只能保留“结果未采集”的状态，不能凭空造 output。  
但如果 raw trace 里其实已经有结果正文，那就应该在 parser / aggregator 里补回去。

### 修复方向

1. 在 Claude 解析链路里补齐 `tool_result -> tool_calls[].output` 的回填。
2. 保留已有的 `output_size_bytes`、timing、error 等元信息，不破坏现有统计。
3. 如果上游确实没有正文，就明确显示“未采集”，不要伪造内容。

## 3. 问题二：`ses_15490...` 的两个 subagent 子树被错误合并

### 现象

这个 trace 里，根节点下实际发生了两个 `task(general)`，并且能看到两个不同的 `subagent_session_id`。  
但当前 trace 树只生成出一个 child node，另一个 child 被吞掉了，结果看起来像同一棵子树被重复挂载或合并。

对照正确样本 `8f0bc0a7-abf3-45cc-9bcd-62359bc94cb2`，正确形态应该是：

- root 下有两个独立 child
- 两个 child 都是 `subagentType: "agent"`
- 每个 child 对应一个独立的 task / session

### 根因判断

问题在 `src/lib/engine/observability/agent-trace.ts` 的树构建逻辑里：

- 同一个父 turn 内的并行 task 会按 `subagent_type` 分组。
- `pendingByType` 也是按 `subagent_type` 做队列。
- 结果是多个同类型 task 被压成一个“待认领的 child”。
- 后续 subagent interaction 来了之后，只能认领到第一条 claim，第二条就会落空或被错误复用。

这意味着当前算法的假设是“同类型 task 在同一父 turn 下最多只会对应一个 child”，而现实里并不成立。

### 与当前存储流程的关系

`src/lib/storage/data-service.ts` 现在会通过 `buildAgentCallTree` 继续派生 subagent executions。  
因此这个 tree builder 的问题不只是“图画错了”，还会进一步影响到数据库里派生出来的 child execution 记录。

### 修复方向

1. 不再按 `subagent_type` 把同一父 turn 的并行 task 强行合并成一个 child。
2. 改成“每个 task 都先形成一个独立 claim”。
3. 子 interaction 认领时优先按 `subagent_session_id` 精确匹配。
4. 如果没有 session id，再退回到同父 turn 下的 FIFO 匹配，但也要按 task 粒度消化，而不是按 type 粒度。

## 4. 修改方案

### 方案 A：先修 Claude tool output 持久化

- 修改 Claude 解析 / 聚合逻辑，把 `tool_result` 正文回填到对应 tool call。
- 保留已有统计字段，不改 trace 结构的大方向。
- 补一个回归测试，覆盖“tool call 有结果正文”的场景。

### 方案 B：修正 subagent tree 构建

- 调整 `buildAgentCallTree` 的 pending/claim 模型。
- 让并行的同类型 subagent task 生成多个独立 child。
- 补一个回归测试，覆盖“同一父 turn 下两个 general subagent 并行出现”的场景，断言 root 下应有两个 child。

### 方案 C：历史数据处理

- 代码修好后，新的 trace 展示会正确。
- 但已经落库的派生 execution 可能还是旧树。
- 需要评估是否要对受影响记录做一次 backfill / 重新派生，避免历史数据继续误导用户。

## 5. 建议的验证项

1. `npx tsc --noEmit`
2. `test/claude-otel-ingest.test.ts` 增加 tool result output 回填回归
3. `test/agent-trace-dedupe.test.ts` 或相邻测试文件增加并行 subagent 树回归
4. 用这三个 trace 复查：
   - `223fe26b-3a4b-45df-98fb-72918712dcef`
   - `ses_15490df0dffebkwYrw5b4sx1Nh`
   - `8f0bc0a7-abf3-45cc-9bcd-62359bc94cb2`

## 6. 风险和待确认事项

1. Claude 的 raw source 是否真的包含 tool result 正文
   - 如果没有，就只能标注“未采集”，不能补造。
2. 并行子 agent 的匹配规则是否只靠 `session_id` 就够
   - 如果有些历史 trace 没有 session id，需要确定 fallback 规则是否足够稳定。
3. 是否需要对历史 execution 做 backfill
   - 如果只修代码不回填，旧数据仍然会展示错误树。

## 7. 这次改动的推荐落点

先按数据链路修，不先动 UI：

1. Claude 侧补齐 tool result 的输出回填。
2. `agent-trace` 侧修正并行子 agent 的树构建。
3. 用回归测试把这两个 trace 的问题钉住。
4. 再决定是否要做历史数据回填。
