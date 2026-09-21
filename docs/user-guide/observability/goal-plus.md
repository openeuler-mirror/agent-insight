# Goal Plus 观测接入

Agent Insight 对 Goal Plus 的当前接入目标是：当 Goal Plus 运行在 Pi 中时，链路追踪保留 Pi 原生主 Trace，并把 Goal Plus 启动的 Pi worker 作为子 Agent 展示在该主 Trace 下。

Agent Insight 只读采集 Pi session 和显式 attach 的 `.gp` 目录，不修改 Goal Plus 状态、工作区文件或 Pi 原始 session。

## 支持范围

- 仅支持重构后的 Goal Plus session 格式：`agent_harness`、`runtime_provider`、`execution_scope`、`session_handle`。
- 不兼容旧的 `host` / `host_handle` 格式；检测到旧格式时会报告 `unsupported_goal_plus_schema`，不会猜测或降级关联。
- 当前复合展示保证只覆盖 **Pi 主 Trace + Goal Plus Pi worker Trace**。Codex 等其他采集器仍按各自原生方式工作，不参与本页描述的 Goal Plus 主从合并。
- `.gp` 必须显式 attach。未 attach 时 Pi 主 Trace 仍正常采集，但无法把 Goal Plus worker 挂到主 Trace 下。

## 数据如何进入 Agent Insight

```text
Pi 原生 session
  └─ Pi Agent Collector
       ├─ OTLP Trace：主 Trace
       └─ Session 绑定：main → <native-session>__taskN

已 attach 的 .gp
  └─ Goal Plus Collector
       ├─ OTLP Trace：每个 Pi worker
       ├─ Session 绑定：worker → goal-plus:<sourceId>:<agentSessionId>
       └─ 关系事件：main → worker

Agent Insight 查询层
  └─ 主 Trace
       └─ TASK（Goal Plus 编排）
            └─ 子 Agent worker
                 └─ LLM / Tool / Skill / MCP
```

Pi collector 只在实际执行 `/goal-plus` 或 `/goal-plus-with-final-check` 的任务上报主绑定；`edit`、`summary`、`pause`、`resume`、`clear` 等管理命令不会创建主从关系。Goal Plus collector 从 `host_command_invocations` 中读取该 Goal 的 Pi start session，并为当前 run 中每个受支持的 worker 上报确定性关系。

主 Trace 与 worker Trace 分别通过现有 OTLP 接口上传，主/worker 绑定通过 `/api/ingest/collaborations/sessions` 上传，关系通过 `/api/ingest/collaborations/events` 上传。两端数据可以乱序到达；Trace 晚到时，Agent Insight 会在后续查询或重关联时完成解析。

## 安装与 attach

前置条件：

- Agent Insight 服务可从运行 Pi 的机器访问，并已有当前用户 API Key。
- Node.js 版本不低于 22.19.0。
- Goal Plus 已安装在 Pi 中并使用当前 session 格式。

在“安装指导”中勾选 **Pi Agent** 和 **Goal Plus**，执行生成的一键接入命令。安装器会配置 Pi 原生采集器和 Goal Plus worker/关系采集器，不会安装或修改 Goal Plus 本体。

如果安装命令在包含 `.gp` 的工作区根目录执行，脚本会自动 attach、首次 scan 并启动 watcher。否则手工执行：

```bash
goal-plus-collector attach /absolute/path/to/workspace/.gp --label my-workspace
goal-plus-collector scan
goal-plus-collector start --interval-ms 5000
goal-plus-collector status
```

`attach` 对同一 canonical root 幂等。`list` 查看已登记 source，`detach <sourceId>` 只删除 Agent Insight 的登记，不删除 `.gp`。`start` 重复执行不会启动第二个 watcher；服务重启后 `ensure` 会尝试恢复已配置的 watcher。

## 展示与状态

关系两端唯一关联后，链路追踪的“仅主 Agent”列表隐藏独立 worker 行；打开 Pi 主 Trace 时，在原生交互之后增加一个标记为“Goal Plus 编排”的 `TASK → 子 Agent` 子树。切换到“仅子 Agent”或“主 Agent + 子 Agent”仍可独立查询 worker Trace。

这个子树是只读查询投影：不会改写 Execution 的原生父子关系，也不会把 worker 内容复制回主 Session。关系证据只说明 worker 属于本次 Goal Plus 编排；没有精确调用位置时，不会按时间猜测它对应主 Trace 中的某个工具调用。

数据可能按以下顺序逐步出现：

1. Pi 主 Trace 到达；
2. Goal Plus worker Trace 到达；
3. 主/worker 绑定和关系事件上传成功；
4. 查询层将 worker 投影到主 Trace。

因此新 worker 可能比主 Trace 晚数秒出现。关系上传采用本地持久 outbox：断网、429 或 5xx 会保留并重试；确定性 4xx（包括正文冲突）会进入 rejected，`self-check` 会报告异常，不会静默丢弃或无限重试。

## 诊断

```bash
goal-plus-collector self-check
goal-plus-collector scan --no-upload
goal-plus-collector status
```

重点检查：

- `sourceCount` 大于 0 且 watcher 为 running；
- `relationshipRejected` 为 0；
- worker metadata 使用当前四个字段，并且 `agent_harness=pi`；
- Goal 的 `host_command_invocations` 含 `agent_harness=pi`、`action=start` 和 `session_id`；
- Pi 中启动 Goal Plus 的真实任务是 `/goal-plus` 或 `/goal-plus-with-final-check`。

可覆盖的专属配置包括：

- `AGENT_INSIGHT_GOAL_PLUS_API_KEY`
- `AGENT_INSIGHT_GOAL_PLUS_BASE_URL`
- `AGENT_INSIGHT_GOAL_PLUS_OTLP_ENDPOINT`
- `AGENT_INSIGHT_GOAL_PLUS_COLLABORATION_SESSIONS_ENDPOINT`
- `AGENT_INSIGHT_GOAL_PLUS_COLLABORATION_EVENTS_ENDPOINT`

Pi 主绑定端点也可分别通过 `AGENT_INSIGHT_PI_COLLABORATION_SESSIONS_ENDPOINT` 和 `AGENT_INSIGHT_PI_COLLABORATION_EVENTS_ENDPOINT` 覆盖。通常只配置 base URL 即可，安装器会生成默认接口地址。

## 隐私与卸载

collector 会对 Trace 正文执行现有 secret/path 脱敏。关系事件只保存确定性 ID、角色、run/candidate 标识和调用定位信息，不保存 worker 输出、评分或 workspace 内容。

卸载 Goal Plus collector 默认保留待上传 spool：

```bash
node "$HOME/.agent-insight/collectors/goal-plus/uninstall.cjs"
```

只有确认不再需要 pending 数据时才增加 `--purge-spool`。卸载或 purge 都不会修改 `.gp`。
