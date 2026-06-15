---
topic: jiuwenswarm-tracing
title: 把 agent-insight 接入 openJiuwen / JiuwenSwarm —— 一次执行的端到端追踪（OTEL seam）
status: validated
created: 2026-06-13
spike_dir: .spike/jiuwenswarm-tracing/
related_code: []   # 落地后填：bridge / exporter 的最终位置
human_summary: ../../humans/jiuwenswarm-tracing/index.html
---

# 把 agent-insight 接入 openJiuwen / JiuwenSwarm —— 一次执行的端到端追踪（OTEL seam）

## What this is
验证 **agent-insight（agent 观测/评估平台）能否观测 openJiuwen / JiuwenSwarm（多 agent 系统）的一次执行**，并在 trace UI 里看到完整链路。结论：**能，且零改 jiuwen 业务代码**。已端到端跑通并 UI 验证了三种执行形态——单 agent、多 agent team（消息总线、成员互相通信）、Task fan-out（隔离子 agent、无通信）；过程中还顺手修复了 jiuwen observability 的三个真实 bug（流式 span 不收尾、agent span 未挂 context 致子 span 孤儿、agent.id=unknown；均已提 issue+PR），并定位了多 agent 子节点渲染的精确约定。这条路天然支撑"openJiuwen 缺的 jiuwen-ops 由 agent-insight 来补"的合作叙事。

## Goal & context
- **更大的图景**：openJiuwen 社区有编排（jiuwen-studio）、执行（agent-core / jiuwenswarm），但缺一个 agent 观测/评估平台（原计划的 `jiuwen-ops` 还没做）。agent-insight 正好做这块能力 → 若接得通，可谈合作。
- **本次范围（in）**：把一次 jiuwenswarm 执行的 trace（agent/子 agent 树 + LLM 调用 + 工具调用 + token/延迟）送进 agent-insight 并在 trace UI 可视化。先单 agent 打通管道，再补多 agent。
- **范围外（out）**：生产级实时上报、把 jiuwen agent 注册成 agent-insight 的"已注册 agent"、正式的 OTLP collector 链路、正式提 PR——都列入实现计划/后续，不在本次验证内。
- **合作前提**：唯一合入层是 gitcode（`gyctl` / `openJiuwen`）；任何回馈上游走 gitcode，不用 GitHub PR 流程。

## Alignment conclusions
- **先跑起来、观察天然产出，再定 seam**；seam 由实现者（本 spike 里是 Claude）依据证据决定，不预先赌。
- **成功标准 = 先单 agent 打通端到端管道，再补一个多 agent 执行做完整 demo**（"先单后多"）。
- **模型用 deepseek**（OpenAI 兼容端点 `https://api.deepseek.com`，`deepseek-v4-flash`）。key 只放 gitignored `.env`，**绝不进源码**。
- **网络**：本机 github.com 被 GFW 重置；**gitcode.com 可用**。jiuwenswarm 用 `gh-proxy.com` 镜像 clone；agent-core 直接从 gitcode clone（`git+https://gitcode.com/openJiuwen/agent-core.git@develop`）。
- **安全**：jiuwenswarm 仓库的 `llm_config.txt` **硬编码了一个 deepseek key（已失效）**——上游把 secret 提交进了公开仓库，是个可在合作中善意提醒的点。

## 架构关系（关键认知）
```
JiuwenSwarm（应用层：gateway / agentserver / web / tui）   ← 自身 0 处 OTEL
        └─ 依赖 openjiuwen / agent-core（真正运行时）        ← OTEL + callback 都在这
              ├─ core/runner            Runner.run_agent / run_agent_team_streaming
              ├─ core/foundation/llm    Model / model_clients（openai 兼容→deepseek）
              ├─ core/runner/callback   一等公民回调框架（LLM/Tool/Agent 事件）
              └─ agent_teams/observability   ★ 内建 OTEL 子系统（接住回调→emit span）
```
**接入点不在 jiuwenswarm，在 agent-core 的 `agent_teams/observability`。** 它提供：
`init_observability(config: ObservabilityConfig, *, span_exporter_override: SpanExporter|None)`，会把 `OtelCallbackHandler` 注册到 `Runner.callback_framework`，对 **单 agent 与 team 都会 fire**。`config.exporter ∈ {otlp_grpc, otlp_http, console}`（全 protobuf 系），但 **`span_exporter_override` 接受任意 `SpanExporter`** —— 这是整个 seam 的钥匙。

## What we tried — decision log
1. **orientation**：两个 Explore agent 摸清 agent-insight 摄入侧；grep 发现 jiuwenswarm 应用层无 OTEL，真正运行时是 agent-core，且 agent-core 已内建 observability + callback 框架。
2. **候选三方案**：
   - **A 事后 uploader**（读 jiuwen 落盘轨迹→上传）：最解耦，但要找落盘格式。
   - **B OTLP 直连**（agent-core OTLP exporter → agent-insight OTEL 端点）：最标准/最适合谈合作。
   - **C 原生 callback handler**（自接回调→富端点）：最实时但耦合最深、代码最多。
3. **跑 01（单 agent，console exporter）→ 决定性证据**：
   - callback/OTEL seam **单 agent 也 fire**（traceback 经过 `core/runner/callback/decorator.py` 包住 `BaseModelClient.invoke`）。不必非 team 模式。
   - emit 的 span 形状：`llm.call`(CLIENT) 带 `gen_ai.usage.prompt_tokens/completion_tokens/total_tokens`、**indexed** `gen_ai.prompt.{i}.content` / `gen_ai.completion.0.content`、`gen_ai.request.model`；`tool.{name}` 带 `gen_ai.tool.name/input/output`；`agent.{id}` 带 `agentteam.agent.*`。
   - **agent span 与 llm span 不同 trace_id**（单 agent 下 agent span 未设为 current context）→ 按 traceId 分组会把一次执行拆成两段。
4. **B（直连 OTEL 薄端点）被否**，两个硬伤：
   - **协议**：agent-core 的 OTLP exporter 发 **protobuf**；agent-insight 的 `/api/ingest/otel/v1/traces` **只收 application/json**（protobuf → 415）。Python OTLP/http exporter 实际不支持 JSON 编码，此路基本死。
   - **属性 mismatch**：agent-insight OTEL 端点读 `gen_ai.usage.input_tokens` / **flat** `gen_ai.prompt` / `tool.name`；agent-core 发的是 `prompt_tokens` / indexed `gen_ai.prompt.N` / `gen_ai.tool.name` → 直连会 **model 对、token=0、prompt/completion 空、工具名丢失**。且该端点只落"薄 Execution"（无多 agent 树字段），按 traceId 分组（见上）。
5. **定稿 seam（B 的机制 + 打到富端点）**：用 `span_exporter_override=InMemorySpanExporter()` 接住 agent-core 自己 emit 的 OTEL span（复用它做好的关联/嵌套），跑完读 finished spans → 在 bridge 里转成 agent-insight 的**富 JSON** → `POST /api/ingest/upload`。**零改 jiuwen 业务代码。**

## The approach（已验证设计）

### 控制流
```
init_observability(ObservabilityConfig(enabled=True, exporter="console",
                   service_name="jiuwenswarm"), span_exporter_override=InMemorySpanExporter())
→ Runner.run_agent(...)  /  Runner.run_agent_team_streaming(...)   # 跑 jiuwen
→ exporter.get_finished_spans()                                    # 拿全量 ReadableSpan
→ shutdown_observability()
→ transform_*(spans) → agent-insight 富 payload
→ POST {INSIGHT}/api/ingest/upload  (header x-witty-api-key 或 payload.user)
```
> 关键：**别按 traceId 分组**。一次执行的 span 散落在多个 trace_id（agent vs llm、各成员各自 trace）。我们用"整次 run 的全部 finished spans"作为分组边界，由 bridge 重组。

### 富 payload 形状（`/api/ingest/upload`）
顶层：`task_id, framework="jiuwenswarm", agentName, model, tokens, input_tokens, output_tokens, tool_call_count, llm_call_count, latency, final_result, interactions[], user`。
`interactions[]` 元素（agent-insight 的 `AgentTraceView.buildAgentCallTree` 从这个扁平列表建树）：
- 根/leader 轮次：`{role:"assistant", agent:<leader>, content, usage:{input,output,total}, tool_calls:[...], timeInfo}`
- 子 agent 轮次：`{role:"subagent", agent:<member>, subagent_name:<member>, subagent_session_id:<id>, content, tool_calls:[...]}`
- 工具调用：`tool_calls[] = {id, type:"function", function:{name, arguments}, state, output}`
完整样例见 `assets/{single-agent,team,task-fanout}-payload*.json`。

### span → payload 的映射（`assets/insight_bridge.py`）
- `llm.call` → 一个 assistant/subagent 轮次：`content`=`gen_ai.completion.0.content`，usage=`gen_ai.usage.*_tokens`，model=`gen_ai.request.model`，时间取 span start/end。
- `tool.{name}` → `tool_calls[]`：name=`gen_ai.tool.name`，arguments=`gen_ai.tool.input`，output=`gen_ai.tool.output`。
- `agent.{id}` → agent 边界 / 最终汇总（取最长的 `agentteam.agent.output`）。
- **成员归属**（团队模式 `agent.id` 是 `"unknown"`，靠 `gen_ai.tool.id` 后缀 `..._<team>_<member>` 还原成员；llm.call 无成员 id，按 trace_id→该 trace 主导 tool 成员投票归属）。

### ★ 多 agent 子节点联动配方（让 AGENTS 正确计数、子 agent 成独立可下钻节点）
`buildAgentCallTree`（`src/lib/engine/observability/agent-trace.ts`）建子节点需 **两个条件同时满足**：
1. 父 agent 发一个 **tool_call，`function.name == "task"`**，且 `arguments` 为结构化 JSON 含 **`subagent_type: "<X>"`** → 注册一个待认领的 spawn（键=X）；
2. 子 agent interaction 为 `role:"subagent"`，其 `subagent_name` 经 `inferSubagentType()`（取首词、小写）**== X** → 认领该 spawn → 建独立子节点（计入 AGENTS、带 Trace 下钻）。
认领不到就**退回 root**（AGENTS 不增）。所以：team 的 `spawn_teammate` 要**映射成 `task` + `subagent_type=成员名`**；成员名用干净 token（`reporter-1`，别用带 `#` 的 `general-purpose#1`，`#` 会被 `inferSubagentType` 截断）。`transform_team_spans_v2` 已实现该联动。

### 三种执行形态（都已验证成树）
| 形态 | jiuwen 入口 | 通信 | trace 签名（实测） |
|---|---|---|---|
| 单 agent | `ReActAgent` + `Runner.run_agent` | — | AGENTS 1 / LLM 1 / TOKENS 164 |
| **team**（消息总线，成员互通） | `TeamAgentSpec` + `Runner.run_agent_team_streaming` | `send_message`/`claim_task`/`list_members`（peer comms） | AGENTS 3 / TOOL CALLS 27 / LLM 34 / TOKENS 335k |
| **Task fan-out**（隔离子 agent） | `create_deep_agent(add_general_purpose_agent=True)` + `task` 工具 | 无（hub-and-spoke，派发→返回） | AGENTS 3 / TASK SPAWNS 2 / TOOL CALLS 0 / LLM 3 |
> agent-insight 原生区分 **TASK SPAWNS（任务派生）** 与 **TOOL CALLS（工具调用）**：把派生 tool_call 命名 `task` 它就渲成 `spawn → subagent`。

### 实测截图（trace UI）
![单 agent：AGENTS 1 / LLM TURNS 1 / TOKENS 164](assets/trace-single.png)
![team：AGENTS 3（team_leader + counter-1 + counter-2），成员工具归位、子 AGENT 带 Trace 下钻](assets/trace-team.png)
![Task fan-out：AGENTS 3（coordinator + worker-1 + worker-2），TASK SPAWNS 2，子 agent 隔离](assets/trace-task.png)

### 边界 / 踩坑（实现时务必注意）
- **摄入与查看必须同一 server / 同一 DB**：主 checkout dev（:3000）与 worktree dev（:3010）读不同 DB（worktree 无本地 `DATABASE_URL`→home 库；主 checkout `.env` 有自己的）。POST 去 A、却在 B 看 = 看不到。
- **`/api/auth/apikey` 每次调用轮换该 user 的 key**（旧 key 失效）。浏览器 localStorage 用 `user_id` + `api_key`；多次 mint 会把之前的踢掉。
- **trace 列表默认 `ownership=user` 只显示已注册 agent**；jiuwen 这类外部 agent 是 `agentOwnership=unregistered`，默认被过滤 → 看似 0 条。用 `/trace?ownership=all`（看子 agent 加 `scope=all`，时间 `time=all`），或把 agent 注册进 `RegisteredAgent`。
- **trace 页取数 `apiFetch` 不带鉴权头**，纯按 `?user=<email>` scope（`/api/observe/data?user=...&includeEvaluations=0`）。
- **latency 单位**：传秒会被详情页头部按未知 framework 当成 ms 显示（"3ms" vs 右栏 span 时间 "3.0s"）。要么传 ms，要么给 framework 注册单位换算。
- agent-core **自身没声明 opentelemetry 依赖**（靠 jiuwenswarm 带），独立装 agent-core 要补 `opentelemetry-{api,sdk,exporter-otlp-proto-http}` + `aiosqlite`（team DB）。

## 顺带修复 / 已回馈 openJiuwen 的三个上游 bug
spike 过程中暴露并修复了 agent-core observability 的三个真实 bug，均已提 issue + PR（走 gitcode fork → `openJiuwen/agent-core` `develop`，各带回归单测）。**这三处改动属于 agent-core 仓库、以下方各自的下游 PR 为唯一 source of truth，agent-insight 不再镜像 diff**；三者正交、可独立 review，②③ 改 `on_agent_invoke_input/output` 相邻行，合入按顺序 rebase 即可。

1. **流式 LLM span 不收尾** — issue [#1023](https://gitcode.com/openJiuwen/agent-core/issues/1023) · PR [1648](https://gitcode.com/openJiuwen/agent-core/pull/1648)：team/成员走 streaming（`LLM_STREAM_*`），`callback_handler.py` 只在非流式 `LLM_INVOKE_OUTPUT` 关 span，`on_llm_stream_output` 仅 `peek` 不 close → 流式 span 开了不关 → exporter 收不到 → **team 导出 0 个 llm.call span（没 token）**。修：终止 chunk（`finish_reason`/`usage`）时真 pop + 写合并 completion + `span.end()`（`LlmSpanState` 加 `completion_parts`/`closed`）。**效果：llm.call 0 → 38；UI LLM TURNS 1/TOKENS 0 → 34/335k。**
2. **agent span 未挂为当前 OTel context → 子 LLM/Tool span 全成孤儿根** — issue [#1025](https://gitcode.com/openJiuwen/agent-core/issues/1025) · PR [1652](https://gitcode.com/openJiuwen/agent-core/pull/1652)：`on_agent_invoke_input` 建 agent span 却没 `otel_context.attach`（对比 `_open_llm_span` 有）→ team 下每个 span 各自独立 trace、无 parent → 无法按 agent 归属（成员"只有 tool 没 LLM"）。修：input attach / output detach（`push/pop_agent_span` 带 context token）。**效果：llm.call 孤儿根 38 → 0；distinct trace 63 → 2；成员 LLM/工具精确嵌套到其 agent span 下。**
3. **agent span `agentteam.agent.id == "unknown"`** — issue [#1024](https://gitcode.com/openJiuwen/agent-core/issues/1024) · PR [1650](https://gitcode.com/openJiuwen/agent-core/pull/1650)：`_AgentMeta` 包绑定的 `instance.invoke`，`self.card` 不进事件，真实入参无 agent id → 落 unknown。修：`_AgentMeta` 用 `emit_before/after(..., extra_kwargs={"agent_id": card.name or card.id})` 注入，handler 优先读。选 `card.name`（可读、与 tool id 后缀一致）。**效果：单 agent span `agent.unknown` → `agent.spike_agent`。**

> PR 号映射按 #1023→1648 / #1024→1650 / #1025→1652 记录；若 1650/1652 实际对调，互换即可。

## Open questions & risks
- **成员归属（已随上游修复转为精确）**：修复 #1025（agent span attach）后 llm.call 嵌套在其 agent span 下，bridge 改用 **span 父链**精确归属（`transform_team_spans_v2`；时间近邻启发式仅作未修版 jiuwen 的 fallback）。实测 team LLM 分布 leader 26 / reporter-1 7 / reporter-2 12。
- **本次是"事后批量上传"**（跑完一次性 POST）。生产要实时/增量上报：把 `InMemorySpanExporter` 换成自定义 `SpanExporter`，在 `export()` 里增量转换 + POST（或 OTLP collector 转发）。
- **OTLP 标准路径未打通**：若想"任何 OTEL agent 直连"，需 agent-insight OTEL 端点①支持 protobuf、②兼容 `gen_ai.usage.prompt_tokens`/indexed prompt/`gen_ai.tool.name` 这套 OpenLLMetry 实际命名。是更通用但更大的改动。
- **deepseek key 失效/限流**（历史上偶发 ECONNRESET）会让真跑失败，与集成无关。

## Implementation plan
1. **把 bridge 收敛成一个产品化模块**：定一个自定义 `SpanExporter`（消费 agent-core span），内含 `transform`（合并 single/team/task 三种映射 + 多 agent 联动配方）+ POST 客户端；起点是 `assets/insight_bridge.py`（含 `transform_spans` / `transform_team_spans_v2` / `transform_task_spans`）。
2. **接线方式**：给 jiuwen 用户一个"一行接入"——`init_observability(..., span_exporter_override=AgentInsightExporter(base_url, api_key))`，跑完自动上报。文档化 env：`INSIGHT_BASE_URL` / `INSIGHT_API_KEY`（`/api/auth/apikey` 取）。
3. **多 agent 联动落到 exporter**：派生 tool_call 命名 `task` + `subagent_type=成员名`；成员 interaction `role=subagent` + `subagent_name` 对齐（干净 token）。
4. **latency 单位 + agent 注册（已做）**：bridge 上报 latency 改 ms（详情页头部显示正确，如 47.52s）；jiuwen agent 已注册进 `RegisteredAgent`（`POST /api/agents`，platform=jiuwenswarm），默认列表即可见。
5. **回馈上游（已提：3 issue + 3 PR）**：见上「顺带修复」节——#1023/1648、#1024/1650、#1025/1652 均已提，各带回归单测，待 maintainer review/merge。
6.（可选，更大）**标准 OTLP 直连路径**：agent-insight OTEL 端点支持 protobuf + 兼容 OpenLLMetry 实际属性名 → 任何 OTEL-emitting agent 直接接。

## 复现命令（最小）
> 桥的对外函数、8 个脚本逐个说明、完整环境变量、以及"桥与脚本不同级、需先让 import 生效"的运行前提，见 [`assets/README.md`](assets/README.md)。
```bash
# 1) 装 agent-core 到隔离 venv（+ 补 OTEL/aiosqlite）
uv venv .venv && uv pip install --python .venv/bin/python -e /path/to/agent-core \
  "opentelemetry-api" "opentelemetry-sdk" "opentelemetry-exporter-otlp-proto-http" "aiosqlite"
# 2) .env 配 deepseek（API_BASE/API_KEY/MODEL_NAME=deepseek-v4-flash/MODEL_PROVIDER=OpenAI）
#    + INSIGHT_BASE_URL + INSIGHT_USER（apikey 经 /api/auth/apikey 取）
# 3) 跑 + 上传（单 / team / task），脚本见 assets/scripts/（01-08 + team_min.yaml）
.venv/bin/python 02-run-and-upload.py        # 单 agent
.venv/bin/python 04-run-team-and-upload.py   # team（已含流式 span 修复 + 多 agent 联动）
.venv/bin/python 06-run-task-and-upload.py   # Task fan-out
# 查看：{INSIGHT}/trace?ownership=all&scope=all&time=all&taskId=<task_id>
```
