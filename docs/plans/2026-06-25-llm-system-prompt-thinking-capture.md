# 各框架「系统提示词 / 思考过程」接入完整度分析与补齐方案

> 分析稿 + 实施计划，基于 2026-06-25 对 OpenCode / Claude Code / Hermes / JiuwenSwarm 四条接入链路的代码排查。
> 结论先行：**四个框架的 trace 里，只有 OpenCode 能完整看到每次 LLM 调用的系统提示词与思考过程；其余三个都看不到，但"看不到"的根因各不相同。**
> 本文给出统一的下游契约、四框架现状对照，以及按成本排序的补齐方案，供后续开发分批落地。

---

## 1. 背景

OpenCode 接入做得最完整：在 trace 详情里能逐次 LLM 调用地看到模型拿到的**系统提示词**和模型的**思考过程（thinking / reasoning）**。Claude Code、Hermes、JiuwenSwarm 目前都看不到这两项。

需要厘清的关键点：这三个"看不到"并不是同一回事——
- 有的是**原始数据其实已经采到了，只是 adapter 没解析 / 前端没对接**（补起来很便宜）；
- 有的是**上游遥测从源头就没把正文导出**（要先改插件 / exporter，甚至框架本身）。

分清这一点，才能把补齐工作按真实成本排期。

---

## 2. 下游契约：统一交互模型只认两个形状

前端和存储层不认框架，只认归一化后的统一交互（`interactions[]`）里的两个约定。任何框架的 adapter 只要把数据填进这两个形状，前端就能展示。

### 2.1 系统提示词

adapter 需要产出一条 `role: 'system'` 的交互：

```jsonc
{ "role": "system", "content": "<系统提示词正文>",
  // 可选，帮助去重 / 展示元信息
  "system_prompt_sha256": "...", "system_prompt_length": 1234,
  "system_prompt_modelID": "...", "system_prompt_providerID": "..." }
```

`buildAgentTrace` 会把 `role === 'system'` 的交互收集到对应 agent 节点的 `systemPrompts` 上并按 sha256/text 去重，前端再渲染成 "System Prompt" 卡片。

- 收集：[`agent-trace.ts:302`](../../src/lib/engine/observability/agent-trace.ts#L302)（`if (it.role === 'system')` → `SystemPromptEntry`，定义见 [`:161`](../../src/lib/engine/observability/agent-trace.ts#L161)）
- 展示：[`AgentTraceView.tsx:1828`](../../src/components/observe/AgentTraceView.tsx#L1828)、Tab 见 [`:2815`](../../src/components/observe/AgentTraceView.tsx#L2815)、`SystemPromptsBlock` [`:3403`](../../src/components/observe/AgentTraceView.tsx#L3403)

### 2.2 思考过程

adapter 需要在 assistant 交互上挂一个 `parts` 数组，其中含 `type: 'reasoning'` 的块：

```jsonc
{ "role": "assistant", "content": "<可见回答文本>",
  "parts": [ { "type": "reasoning", "text": "<thinking 正文>" },
             { "type": "text",      "text": "<可见回答文本>" } ] }
```

前端**只**从 `parts[type=reasoning]` 取思考内容，不看 `content_blocks` 等其它字段。

- 提取：[`AgentTraceView.tsx:1764`](../../src/components/observe/AgentTraceView.tsx#L1764)（`extractReasoningText`，过滤 `type === 'reasoning'`）

> ⚠️ 这是补齐时最容易踩的坑：把 thinking 存进别的字段（如 Claude Code 的 `content_blocks`）前端也不会显示，**必须**落到 `parts[type=reasoning]`。

---

## 3. 四框架现状对照

| 框架 | 系统提示词 | 思考过程 | 性质 |
|---|---|---|---|
| **OpenCode** | ✅ 采到 + 展示 | ✅ 采到 + 展示 | 完整（参照系） |
| **Claude Code** | ⚠️ 原始体里**有**，未提取 | ⚠️ 原始体里**有**（存进 `content_blocks`），未对接前端 | 解析缺口 |
| **Hermes** | ⚠️ span 里**有**（`input.value`），adapter 只取最后一条 user | ❌ 上游插件根本没采 | 系统：解析缺口；思考：上游缺失 |
| **JiuwenSwarm** | ⚠️ span 里**有**（`gen_ai.prompt.*`），仅用于取 query | ❌ design 已规划 `llm.reasoning` span，TS 未读 | 系统：解析缺口；思考：需确认上游 |

### 3.1 OpenCode（参照系）

- 上传器专门发 `system.prompt` 事件、并完整保留 `reasoning` 类型 parts：`scripts/opencode_uploader_client.js`
- 前端从 `parts[type=reasoning]` 取 thinking、从 `node.systemPrompts` 渲染系统提示词——即第 2 节描述的契约就是按 OpenCode 的形状设计的。

### 3.2 Claude Code —— 数据已采到，未解析

接入时配置了 `OTEL_LOG_USER_PROMPTS=1` + `OTEL_LOG_RAW_API_BODIES=file:...`，把**完整 API 请求/响应体落盘**，aggregator 也确实读 `api_request_body` / `api_response_body`：

- 落盘配置：[`setup/auto/route.ts:433`](../../src/app/api/ingest/setup/auto/route.ts#L433)（`OTEL_LOG_USER_PROMPTS` / `OTEL_LOG_RAW_API_BODIES`）
- 读 body：[`claude-otel/aggregator.ts:439`](../../src/lib/ingest/claude-otel/aggregator.ts#L439)

但：

- **系统提示词没被提取**：Anthropic 请求体的系统提示词在顶层 `body.system`，而代码只读了 `body.messages`（且只为取 `tool_result`）：[`aggregator.ts:133`](../../src/lib/ingest/claude-otel/aggregator.ts#L133)。全 `claude-otel/` 目录无任何读 `body.system` 的代码。
- **thinking 存了但前端读不到**：响应内容整体塞进 `content_blocks`（thinking 块 `type:'thinking'`）：[`aggregator.ts:389`](../../src/lib/ingest/claude-otel/aggregator.ts#L389)；但归一化只把 content 拼成可见文本（`stringifyClaudeContent` 只取 `.text`），且前端只认 `parts[type=reasoning]`，Claude 交互没有 `parts` 数组 → 永远不展示。

### 3.3 Hermes —— 系统提示词已采到未解析；思考过程上游没采

- **系统提示词**：插件 `pre_api_request` 已把**完整 `request_messages`（含 system）**塞进 `input.value` / `llm.input_messages`：[`hermes_agent_insight_plugin.py:649`](../../scripts/hermes_agent_insight_plugin.py#L649)。但 adapter 的 `latestUserMessageFromJson` 只挑最后一条 `role=user`，把 system 丢了：[`otel/adapters/hermes.ts:205`](../../src/lib/ingest/otel/adapters/hermes.ts#L205)。
- **思考过程**：插件 `post_api_request` 用 `_response_text` 只抽**可见文本**：[`plugin.py:664`](../../scripts/hermes_agent_insight_plugin.py#L664)、`_response_text` 见 [`:98`](../../scripts/hermes_agent_insight_plugin.py#L98)。span 里只有 `reasoning_tokens`（计数），没有 thinking 正文。

### 3.4 JiuwenSwarm —— 系统提示词已采到未解析；思考过程需确认上游

- **系统提示词**：每个 `llm.call` span 都带 indexed 的 `gen_ai.prompt.{n}.role` / `gen_ai.prompt.{n}.content`，system 就在 `role=system` 那条。`userPromptContent` 已在遍历这些属性，但只为找 user query，遇到 system 直接跳过：[`jiuwen/aggregate.ts:171`](../../src/lib/ingest/otel/jiuwen/aggregate.ts#L171)。
- **思考过程**：`completion()` 只读 `gen_ai.completion.0.content`，对 reasoning 零处理：[`jiuwen/aggregate.ts:108`](../../src/lib/ingest/otel/jiuwen/aggregate.ts#L108)。设计文档已规划**新增 `llm.reasoning` span（挂 llm.call 下）**：[`design.md:171`](../designs/agents/jiuwenswarm-tracing/design.md#L171)，但当前 TS bridge 不读取它，且需确认线上 agent-core 是否真的 emit 了 reasoning 正文。

---

## 4. 补齐方案（按成本排序）

### 阶段一（P0）：系统提示词 —— 纯 adapter 改动，数据已在 span 里

> 零上游依赖，两个框架当天可上。

**Hermes**（改 [`src/lib/ingest/otel/adapters/hermes.ts`](../../src/lib/ingest/otel/adapters/hermes.ts)）：
1. 仿 `latestUserMessageFromJson` 加 `systemMessagesFromJson(input.value)`，取出 `role=system` 的消息文本。
2. 仿 `makeUserInteraction`（[`:353`](../../src/lib/ingest/otel/adapters/hermes.ts#L353)）加 `makeSystemInteraction`（`role:'system'`，可顺手算 sha256 填 `system_prompt_sha256` 助去重）。
3. 在 `aggregateHermesTraceEvents` 的 `contentHosts` 循环里、push user 之前（[`:490`](../../src/lib/ingest/otel/adapters/hermes.ts#L490)）按 owner/session 各 push 一次 system 交互。

**JiuwenSwarm**（改 [`src/lib/ingest/otel/jiuwen/aggregate.ts`](../../src/lib/ingest/otel/jiuwen/aggregate.ts)）：
1. 加 `systemPromptContent(attrs)`：遍历 `gen_ai.prompt.{n}`，取 `role=system` 的 content。
2. 在 `transformSingle/Team/Task` 构造 `interactions` 头部（如 [`:248`](../../src/lib/ingest/otel/jiuwen/aggregate.ts#L248)、[`:341`](../../src/lib/ingest/otel/jiuwen/aggregate.ts#L341)、[`:396`](../../src/lib/ingest/otel/jiuwen/aggregate.ts#L396) 的 `[{role:'user', content:query}]`）插入一条 `{role:'system', content}`。
3. system 在每个 `llm.call` 上重复，靠 agent-trace 的 text/sha 去重即可；先做 root agent，team/task 的 per-agent system 后续再细化。

### 阶段二（P1）：JiuwenSwarm 思考过程 —— 先确认上游，再改 adapter

1. **确认 agent-core**：核对实际版本 emit 的 `llm.reasoning` span 把 reasoning 正文放在哪个属性（attr 名 / span body）。examples 里目前没有 reasoning，若线上版本尚未 emit，需先升级 / 改 agent-core exporter。
2. **改 adapter**：`collectJiuwenSpans` 本就保留全部 span；在 `transformSingle/Team/Task` 里对每个 `llm.call`，按 `parentSpanId` 找其子 `llm.reasoning` span 取 content，挂到对应 assistant turn 的 `parts:[{type:'reasoning', text}]`（push assistant 的三处：[`:274`](../../src/lib/ingest/otel/jiuwen/aggregate.ts#L274)、[`:318`](../../src/lib/ingest/otel/jiuwen/aggregate.ts#L318)、[`:420`](../../src/lib/ingest/otel/jiuwen/aggregate.ts#L420)）。

### 阶段三（P2）：Hermes 思考过程 —— 三层都要改，成本最高

1. **Hermes 框架**：先确认回调 kwargs（`assistant_message` / `response`）里是否带 reasoning（DeepSeek `reasoning_content`、Anthropic `type:'thinking'` 块、OpenAI o-系列 reasoning）。若框架没透出 → 需先改 Hermes core。
2. **插件**（[`scripts/hermes_agent_insight_plugin.py`](../../scripts/hermes_agent_insight_plugin.py)）：在 `post_api_request` 加 `_reasoning_text(kwargs)`，把 thinking 写进新 span 属性（如 `llm.output.reasoning`，挨着 [`:669`](../../scripts/hermes_agent_insight_plugin.py#L669)）。
3. **adapter**：`makeAssistantInteraction`（[`:405`](../../src/lib/ingest/otel/adapters/hermes.ts#L405)）读该属性，给交互加 `parts:[{type:'reasoning', text}]`。

### （附）Claude Code 补齐 —— 用户本次未要求，记录备查

数据已落盘，属"解析缺口"，成本中等：
- 系统提示词：在 `api_request_body` 处理（[`aggregator.ts:439`](../../src/lib/ingest/claude-otel/aggregator.ts#L439)）读 `body.system`，emit `{role:'system'}` 交互。
- 思考过程：在归一化阶段把 `content_blocks` 里 `type:'thinking'` 的块转成 `parts:[{type:'reasoning', text: block.thinking}]`。

---

## 5. 工作量与优先级一览

| 项 | 数据现状 | 改动范围 | 成本 |
|---|---|---|---|
| Hermes 系统提示词 | span 里**已有** | 仅 `hermes.ts` | 🟢 低 |
| Jiuwen 系统提示词 | span 里**已有** | 仅 `aggregate.ts` | 🟢 低 |
| Jiuwen 思考过程 | design 已规划，需确认 agent-core 实装 | 确认/改 agent-core + `aggregate.ts` | 🟡 中 |
| Claude Code 系统提示词/思考 | 原始体**已落盘** | `claude-otel/` 解析 + 归一化 | 🟡 中 |
| Hermes 思考过程 | 上游**完全没采** | 插件 +(可能)Hermes core + adapter | 🔴 高 |

**建议落地顺序**：P0（两边系统提示词，纯 adapter）→ P1（Jiuwen 思考，确认 agent-core 后接 adapter）→ 视需要补 Claude Code → P2（Hermes 思考，最重）。

---

## 6. 验证方法

每项改动至少跑通"原始数据 → 入库 → trace 详情可见"全链路：

1. 用对应框架的本地示例产生一条 trace（Jiuwen 见 `src/lib/ingest/otel/jiuwen/examples/`；Hermes 走插件；Claude Code 走 OTel logs）。
2. 确认归一化后的 `interactions` 中出现 `role:'system'` 交互 / assistant 交互带 `parts[type=reasoning]`。
3. 打开 trace 详情，确认 "System Prompt" Tab 出现、思考块（"Thought for Ns" 折叠）渲染正确。

---

## 7. 关键代码位置索引

| 用途 | 位置 |
|---|---|
| 系统提示词收集（下游契约） | [`agent-trace.ts:302`](../../src/lib/engine/observability/agent-trace.ts#L302) |
| 思考过程提取（下游契约） | [`AgentTraceView.tsx:1764`](../../src/components/observe/AgentTraceView.tsx#L1764) |
| 系统提示词展示 | [`AgentTraceView.tsx:3403`](../../src/components/observe/AgentTraceView.tsx#L3403) |
| Claude 读 body / content_blocks | [`claude-otel/aggregator.ts:389`](../../src/lib/ingest/claude-otel/aggregator.ts#L389)、[`:439`](../../src/lib/ingest/claude-otel/aggregator.ts#L439) |
| Hermes 插件发 request_messages | [`hermes_agent_insight_plugin.py:649`](../../scripts/hermes_agent_insight_plugin.py#L649) |
| Hermes 插件抽可见文本 | [`hermes_agent_insight_plugin.py:98`](../../scripts/hermes_agent_insight_plugin.py#L98)、[`:664`](../../scripts/hermes_agent_insight_plugin.py#L664) |
| Hermes adapter 只取 user | [`otel/adapters/hermes.ts:205`](../../src/lib/ingest/otel/adapters/hermes.ts#L205) |
| Jiuwen prompt/completion 解析 | [`jiuwen/aggregate.ts:108`](../../src/lib/ingest/otel/jiuwen/aggregate.ts#L108)、[`:171`](../../src/lib/ingest/otel/jiuwen/aggregate.ts#L171) |
| Jiuwen `llm.reasoning` span 规划 | [`design.md:171`](../designs/agents/jiuwenswarm-tracing/design.md#L171) |
