# jiuwen token 归属：已修项与上游限制

> 背景：jiuwen task fan-out（带 `task_tool` 派生子 agent）的 trace 在 token 统计上有三个缺口。
> 经抓真实 OTLP span 核实后，一个可在 agent-insight 侧修复，两个受限于 jiuwen 的 OTLP 导出，
> 本侧改不了。本文记录结论与证据，供后续（含推动 jiuwen 上游）参考。

## 复核方法

在 `/api/ingest/otel/v1/traces` 临时挂了文件开关控制的原始 span dump，跑一条 jiuwen 对话，
落盘后用 `collectJiuwenSpans` 解析。关键观察（同一 session、17 span 为例）：

- 每个 span **各自一个 trace id**，全部挂同一个 `agentteam.session.id` / `session.id`；
- **没有任何 agent 标识 attribute**（`agentteam.agent.id` / `gen_ai.agent.name` 均无）；
- `llm.call` 的 usage 只有 `gen_ai.usage.prompt_tokens / completion_tokens / total_tokens`；
- 工具 span 的 `parentSpanId` 不指向 `llm.call`（仅 `llm.reasoning` 是 `llm.call` 的子 span）。

对账（子 agent 失败、无子 agent span 的一条）：jiuwen `chat.usage_summary` 与 agent-insight
入库 token **精确相等**（5 calls / 122,009 in / 1,610 out / 123,619 total），证明 agent-insight
的 root 口径 = session 内所有 `llm.call` 累加。当子 agent 成功时，其 `llm.call` span 也按
session id stitch 进来，于是 root 总数自然包含子 agent（这是产品期望的口径）。

## ✅ 已修：per-step token 归位（agent-insight 侧）

**现象**：`transformTask` 此前把 N 次 `llm.call` 的 token 全堆在一条合成的「收尾」turn 上，
其余 LLM 步 usage 为空 → 时间线里每步看不到 token。

**修复**：重写 `transformTask`，按时间走 span，**每次 `llm.call` 出一条协调者 turn 并携带它
自己的 usage**；工具 span 按时间归到其所属的 LLM 调用下（工具无 parent 链，故按时间关联）。
totals（llm 数、tool 数、token 总和）不变——只是从「堆一条」改为「分摊到各步」，各步 usage 之和
等于总数。子 agent turn、工具排序、skill 检测均保留。

落点：`src/lib/ingest/otel/jiuwen/aggregate.ts` 的 `transformTask`。
测试：`test/jiuwen-task-per-step-tokens.test.ts`。

## ❌ 上游限制 1：无法按「单个子 agent」拆 token

**想要**：把每个子 agent 用掉的 token 单独归到它自己的行/turn（而不是只并入 root 总数）。

**为何做不到**：子 agent 的 `llm.call` span 与协调者的 span 同处一个 session、各自独立 trace id、
**且没有任何 agent 标识 attribute**。因此无法可靠判断「某个 `llm.call` 属于哪个子 agent」——
缺少归属键。`task_tool` 的输出里虽有 `agent_id`，但子 agent 的 `llm.call` span 并不带回这个 id，
两者无法关联。

**影响范围**：root 行 token 已含子 agent（符合期望），仅「再往下按子 agent 拆分」做不到。

**解法（需上游）**：jiuwen 的 OTLP 在子 agent 的 span 上补一个 agent 标识 attribute
（如 `agentteam.agent.id` 或子 session id），agent-insight 即可据此分组并建子 agent 行
（`deriveSubagentExecutions` 的机制已就绪，缺的只是归属键）。

## ❌ 上游限制 2：cache / reasoning token 数未导出

**想要**：展示 input 中命中缓存的比例（cache token）、以及 reasoning token 数。

**为何做不到**：jiuwen **内部** history（`chat.usage_metadata`）里有 `cache_tokens`
（一条任务里常占 input 的大头，例如 22,229 input 中 22,144 是 cache），但 **OTLP 导出里没有**
——span 的 usage 只有 prompt/completion/total。reasoning 只有文本（`gen_ai.reasoning.content` /
`llm.reasoning` 子 span），没有 token 计数。

**影响**：agent-insight 的 `cacheReadInputTokens` / `cacheCreationInputTokens` /
`reasoningTokens` 对 jiuwen 恒为空——并非没接，而是**源头没发**。注意 agent-insight 的下游
（`AgentNodeStats` / `projectAgentNodeExecution`）已支持这些字段，turn 的 usage 一旦带上
`cache:{read,write}` / `reasoning` 就会自动聚合；只要 jiuwen 把这些值发到 OTLP 即可生效。

**解法（需上游）**：jiuwen OTLP exporter 在 `llm.call` span 上补充
`gen_ai.usage.cache_tokens`（或 OTel 语义的 `cache_read_input_tokens`）与
`reasoning_tokens`。

## 一句话小结

- per-step token：已在本侧修好。
- 子 agent 拆分、cache/reasoning：数据在 jiuwen OTLP 里根本没发出来，**本侧无能为力**，
  需要 jiuwen 的 exporter 补字段。root 总数本就含子 agent，符合现有期望。
