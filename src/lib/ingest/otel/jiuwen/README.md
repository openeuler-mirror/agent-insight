# jiuwen OTEL 接入 —— 本地怎么跑、看到数据（开发 runbook）

> ⚠️ **原型 / RFC**。这条路让 jiuwen（openJiuwen / JiuwenSwarm，跑在 agent-core 上）
> 像 opencode/hermes 一样**"一跑就自动接入"**观测：用 agent-core **自带的 OTLP
> exporter** 一行配置直推我们的 `/api/ingest/otel/v1/traces`，**零脚本、零插件**。
> 产品化待办见文末「Caveats」。

整件事就两个进程：
1. **agent-insight dev**（本分支，带 jiuwen OTEL adapter）—— 收 span、建 trace。
2. **一次 jiuwen 运行** —— 把 agent-core 的 OTLP exporter 指向上面那个进程。

---

## 1) 起 agent-insight（带本 adapter）

在本分支的 checkout 里：

```bash
npx next dev -p 3011        # 端口随便，记住它（下面用 3011）
```

本分支在 `/api/ingest/otel/v1/traces` 按 `service.name=jiuwenswarm` branch 出 jiuwen 自己的
摄入路径（见「怎么工作的」）。其它框架（claude/hermes/opencode）的路径不受影响。

## 2) 备好 jiuwen 侧（agent-core）

需要一个 **openJiuwen/agent-core `develop`（rework `8b2a384`+）的 checkout** + 隔离 venv：

```bash
# 在本 examples/ 目录下
uv venv .venv && uv pip install --python .venv/bin/python -e /path/to/agent-core \
  opentelemetry-api opentelemetry-sdk opentelemetry-exporter-otlp-proto-http \
  aiosqlite httpx python-dotenv pyyaml
#   GFW：加 --index-url https://pypi.tuna.tsinghua.edu.cn/simple（pypi.org 易超时）
#   agent-core 自身没声明 OTEL 依赖，靠上面手动补；aiosqlite 是 team DB 要的

cp .env.example .env        # 填 LLM key + 确认 INSIGHT_OTLP 端口对上第 1 步
```

## 3) 跑 jiuwen → 自动推 OTLP

```bash
.venv/bin/python otlp-single.py     # 单 agent
.venv/bin/python otlp-team.py       # team（多 agent，~50s，会分多批推 span）
```

**整个"接入"就是脚本里这一行**（不写 bridge、不收桶、不跑上传脚本）：

```python
init_observability(ObservabilityConfig(
    enabled=True, exporter="otlp_http", service_name="jiuwenswarm",
    endpoint="http://localhost:3011/api/ingest/otel/v1/traces"))
# 之后正常 Runner.run_agent / run_agent_team_streaming，span 自动实时推送、自动成 trace
```

> task fan-out 形态：同理，把跑 `create_deep_agent(add_general_purpose_agent=True)` 的脚本
> 里的 observability 换成上面这段即可（task fan-out 与 team 是**两种不同机制**，见
> `docs/design/jiuwenswarm-tracing/design.md`）。

## 4) 看 trace

脚本会 print task_id（team 形如 `jiuwen-otlp-team-xxxxxx`；单 agent 是 `jiuwen-<traceId>`）：

```
http://localhost:3011/trace?ownership=all&scope=all&time=all&taskId=<task_id>
```

⚠️ **必须带 `ownership=all&scope=all&time=all`** —— 外部 agent 默认被过滤掉看不到。

---

## 怎么工作的（给改代码的人）

```
jiuwen (agent-core OTLP exporter, protobuf)
   │  POST /api/ingest/otel/v1/traces
   ▼
route.ts ── service.name==='jiuwenswarm'? ──► ingest.ts (spool 攒批 + 重聚合)
   │  否                                          │
   ▼                                              ▼
共享 claude-otel normalizer (扁平 llm/tool)    aggregate.ts (原始 span → ExecutionRecord)
                                                  │
                                              saveExecutionRecord
```

- `route.ts`（`src/app/api/ingest/otel/v1/traces/route.ts`）：按 `service.name` 分流。
- `aggregate.ts`：原始 span → `ExecutionRecord` —— 父链归属成员 / 子 agent 联动 /
  顺序拆分 / timing / tool-output 解包（**由验证过的 Python bridge 移植**，
  `docs/design/jiuwenswarm-tracing/assets/insight_bridge.py`）。
- `ingest.ts`：OTLP 分批推送 → 按 `agentteam.session.id` 攒批的 spool + 每批重聚合
  （配 adapter 的 `snapshot-replace` 覆盖）。
- `adapters/jiuwen.ts`：FrameworkDescriptor（`onboard=env`, `snapshot-replace`）。

**为什么不走共享 normalizer**：它把 raw OTLP 压成扁平 `OtelTraceEvent`（`kind: llm|tool`），
会丢掉 jiuwen 的结构性 `agent.* / team.*` span（嵌套多 agent 树装不进扁平模型）。所以 jiuwen
在 normalize **之前** branch 出自己的 raw-span 路径。**完整校准点 / 踩坑**（新 span 形状、
联动/顺序/timing 规则、同 task_id 重传合并、ghost session 等）见
`docs/design/jiuwenswarm-tracing/design.md`「接新 develop（8b2a384）重验」节。

## Caveats（原型 → 产品化待办）

- **spool 是内存态**（单 dev 进程）→ 产品化落到 claude-otel 那套**持久 spool**。
- **user 归属**：上面 OTLP 没带鉴权 → 记录落"无主"用户（靠 `ownership=all` 才看得到）。
  产品化让 jiuwen 配 `x-witty-api-key` 头（agent-core OTLP 支持自定义 header），
  route 已读该头解析 user。
- **task fan-out** 没单独跑过 OTLP 验证（单 agent + team 已覆盖 spool/树/protobuf 三个难点；
  task 走同一份 `transformTask`，已在 batch bridge 验证过）。
- 类型收紧（去 `any`）+ 单测待补。
