# jiuwenswarm-tracing — spike 工件使用说明

本目录是 [`../design.md`](../design.md) 这次 spike 的**已验证工件**(reference artifacts),不是产品代码。
核心是 `insight_bridge.py`(把 agent-core 的 OTEL span 转成 agent-insight 富 payload 并上报),
`scripts/` 下 8 个脚本是不同执行形态的端到端复现。产品化计划见 design.md「Implementation plan」第 1 条。

> 设计/映射/踩坑的完整说明在 [`../design.md`](../design.md);本文件只讲**怎么用、怎么跑**。

## 目录布局与一个必读的运行前提

```
assets/
├── insight_bridge.py          # 桥(被 scripts 直接 import)
├── single-agent-payload.json  # 三种形态的样例富 payload(只读样例)
├── team-payload-linked.json
├── task-fanout-payload-linked.json
├── team_min.yaml              # team 蓝图样例(与 scripts/team_min.yaml 同内容)
├── trace-*.png                # trace UI 实测截图
└── scripts/
    ├── 01-08*.py             # 复现脚本,均 `from insight_bridge import ...`
    └── team_min.yaml         # 脚本实际读这一份(03/04 从 HERE 加载)
```

⚠️ **运行前提**:脚本里写的是 `from insight_bridge import ...` 且 `sys.path.insert(0, HERE)`(HERE=脚本所在的 `scripts/`),
而 `insight_bridge.py` 落在上一级 `assets/`。spike 当时所有文件在同一个扁平目录跑,归档时拆成了两级。
**要复现,先让桥能被 import**——三选一:

```bash
# 方案 A:把桥拷/软链到 scripts/ 旁边
cp ../insight_bridge.py ./            # 在 scripts/ 下
# 方案 B:设 PYTHONPATH 指向 assets/
PYTHONPATH=.. python 02-run-and-upload.py
# 方案 C:从 assets/ 跑,改用 -m(需自己调整 import 路径,最麻烦,不推荐)
```

`.env` 同理:脚本从 `scripts/.env` 加载(`load_dotenv(HERE/".env")`),需在 `scripts/` 下放一份(见下「环境变量」)。

## `insight_bridge.py` 对外函数

| 函数 | 用途 | 关键入参 |
|---|---|---|
| `make_exporter()` | 造一个 `InMemorySpanExporter`,作为 `init_observability(span_exporter_override=...)` 传入,接住 agent-core 自己 emit 的 span | — |
| `transform_spans(spans, *, task_id, query, framework="jiuwenswarm", user=None, agent_name="jiuwenswarm")` | **单 agent**:run 后的全部 finished span → 富 payload | `agent_name` 显示名 |
| `transform_team_spans_v2(spans, *, task_id, query, team_name, leader="team_leader", framework, user)` | **team(当前版)**:用 span 父链精确把 LLM/工具归属到成员;含多 agent 子节点联动配方 | 需上游 #1025 修复后的 span 才精确 |
| `transform_team_spans(...)` | team **v1**(时间近邻启发式归属):仅作**未打上游修复的 jiuwen** 的 fallback,新代码用 v2 | — |
| `transform_task_spans(spans, *, task_id, query, coordinator="coordinator", framework, user)` | **Task fan-out**:隔离子 agent(hub-and-spoke)→ 富 payload | — |
| `post_to_insight(payload, *, base_url, api_key) -> (status, text)` | POST 到 `{base_url}/api/ingest/upload`;`api_key` 走 header `x-witty-api-key`,无 key 时靠 `payload.user` scope | — |

## scripts/ 各脚本

`01/03/05` 只跑+dump span(看原生形状,**不上报**);`02/04/06` 端到端(转换+POST);`07/08` 不重跑、只对已存 payload 做"子 agent 联动重链"再 POST。

| 脚本 | 形态 | 干什么 | 产物 |
|---|---|---|---|
| `01-run-single-agent.py` | 单 agent | console exporter 跑一次,看 agent-core 原生 emit 什么(无 agent-insight 接线) | stdout |
| `02-run-and-upload.py` | 单 agent | `transform_spans` → POST,端到端 | `last-payload.json` |
| `03-run-team-dump.py` | team | `run_agent_team_streaming` 跑一次,dump 多 agent span 形状 | stdout |
| `04-run-team-and-upload.py` | team | `transform_team_spans_v2` → POST(已含流式 span 修复 + 多 agent 联动) | `last-team-payload.json` |
| `05-run-task-subagent-dump.py` | Task fan-out | `create_deep_agent(add_general_purpose_agent=True)` + `task` 工具派发,dump span | stdout |
| `06-run-task-and-upload.py` | Task fan-out | `transform_task_spans` → POST | `last-task-payload.json` |
| `07-relink-and-repost.py` | Task fan-out | 读 `last-task-payload.json`,把派发 tool_call 改名 `task`+`subagent_type=worker-N`、子轮次 `subagent_name` 对齐,重 POST(证明 AGENTS=1 是缺联动而非追踪能力,期望 AGENTS=3) | `last-task-payload-linked.json` |
| `08-relink-team-and-repost.py` | team | 同理对 `last-team-payload.json` 补 leader 的 spawn tool_call + 成员 token 清洗,重 POST(期望 AGENTS=1+N) | `last-team-payload-linked.json` |
| `team_min.yaml` | — | `03/04` 读的 team 蓝图(`TeamAgentSpec`);`runtime.initial_query` 是 query | — |

> 注意 `07/08` 依赖 `06/04` 先跑出 `last-task-payload.json` / `last-team-payload.json`。

## 环境变量(放 `scripts/.env`,gitignored,**绝不进库**)

| 变量 | 用途 | 备注 |
|---|---|---|
| `MODEL_PROVIDER` | LLM provider | 默认 `OpenAI`(OpenAI 兼容端点) |
| `API_BASE` | LLM 端点 | spike 用 `https://api.deepseek.com` |
| `API_KEY` | LLM key | **只放 .env** |
| `MODEL_NAME` | 模型名 | spike 用 `deepseek-v4-flash` |
| `LLM_SSL_VERIFY` | SSL 校验 | 默认 `False` |
| `INSIGHT_BASE_URL` | agent-insight 地址 | 默认 `http://localhost:3000`(team/task 脚本里写的是 `:3010`,**按你 dev/worktree 实际端口改**——摄入与查看必须同库,见 design.md「边界/踩坑」) |
| `INSIGHT_API_KEY` | 上报鉴权 | 经 `/api/auth/apikey` 取;每次调用会**轮换** user 的 key |
| `INSIGHT_USER` | 上报归属 user | 无 api_key 时靠它 scope |
| `SPIKE_QUERY` | 单 agent query | 仅 `02` 用,有默认值 |

## 最小复现

```bash
# 1) 装 agent-core 到隔离 venv(+ 补 OTEL/aiosqlite,agent-core 自身未声明 OTEL 依赖)
uv venv .venv && uv pip install --python .venv/bin/python -e /path/to/agent-core \
  opentelemetry-api opentelemetry-sdk opentelemetry-exporter-otlp-proto-http aiosqlite

# 2) 进 scripts/,放好桥与 .env(见上「运行前提」「环境变量」)
cd scripts && cp ../insight_bridge.py ./ && $EDITOR .env

# 3) 跑(端到端)
../.venv/bin/python 02-run-and-upload.py   # 单 agent
../.venv/bin/python 04-run-team-and-upload.py   # team
../.venv/bin/python 06-run-task-and-upload.py   # Task fan-out

# 4) 查看(注意 ownership/scope/time,否则外部 agent 默认被过滤)
#    {INSIGHT_BASE_URL}/trace?ownership=all&scope=all&time=all&taskId=<task_id>
```
