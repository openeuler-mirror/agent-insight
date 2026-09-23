# Goal Plus 观测接入

Agent Insight 对 Goal Plus 的当前接入目标是：当 Goal Plus 运行在 Pi 中时，链路追踪保留 Pi 原生主 Trace，并把 Goal Plus 启动的 Pi worker 作为子 Agent 展示在该主 Trace 下。

Agent Insight 只读采集 Pi session，并在真实 `/goal-plus` 启动后自动登记对应的 `.gp` 目录；不会修改 Goal Plus 状态、工作区文件或 Pi 原始 session。

## 支持范围

- 仅支持重构后的 Goal Plus session 格式：`agent_harness`、`runtime_provider`、`execution_scope`、`session_handle`。
- 不兼容旧的 `host` / `host_handle` 格式；检测到旧格式时会报告 `unsupported_goal_plus_schema`，不会猜测或降级关联。
- 当前复合展示保证只覆盖 **Pi 主 Trace + Goal Plus Pi worker Trace**。Codex 等其他采集器仍按各自原生方式工作，不参与本页描述的 Goal Plus 主从合并。
- 用户只需安装 Pi Agent 采集器。Goal Plus 观察器随 Pi 采集器内置，默认休眠，不需要单独安装或手工 attach。

## 数据如何进入 Agent Insight

```text
Pi 原生 session
  └─ Pi Agent Collector
       ├─ OTLP Trace：主 Trace
       └─ Session 绑定：main → <native-session>__taskN

由 Pi 自动确认并登记的 .gp
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

Pi collector 只在实际执行 `/goal-plus` 或 `/goal-plus-with-final-check` 的任务上报主绑定并尝试激活观察器；`edit`、`summary`、`pause`、`resume`、`clear` 等管理命令不会创建主从关系。激活前还会核验 `.gp/goal-plus/<goalId>/goal.json` 中存在属于当前 Pi native session 的 start invocation，避免误采集同机器上的其他工作区。Goal Plus collector 从该 invocation 读取主 session，并为当前 run 中每个受支持的 worker 上报确定性关系。

主 Trace 与 worker Trace 分别通过现有 OTLP 接口上传，主/worker 绑定通过 `/api/ingest/collaborations/sessions` 上传，关系通过 `/api/ingest/collaborations/events` 上传。两端数据可以乱序到达；Trace 晚到时，Agent Insight 会在后续查询或重关联时完成解析。

## 安装与自动激活

前置条件：

- Agent Insight 服务可从运行 Pi 的机器访问，并已有当前用户 API Key。
- Node.js 版本不低于 22.19.0。
- Goal Plus 已安装在 Pi 中并使用当前 session 格式。

在“安装指导”中只勾选 **Pi Agent**，执行生成的一键接入命令。安装器会配置 Pi 原生采集器，并在其安装包中放入 Agent Insight 自有的 Goal Plus worker/关系观察器；不会安装或修改 Goal Plus 本体。

此时观察器状态为 `DORMANT`，不会扫描 home 目录，也不会启动 watcher：

1. 普通 Pi 任务只采集 Pi 主 Trace。
2. 用户在 Pi 中执行 `/goal-plus` 或 `/goal-plus-with-final-check`。
3. Pi 扩展收到 Goal Plus 写入的结构化 `goal_plus_id` 后，从当前 Pi `cwd` 定位 `.gp`；若设置了 `GOAL_PLUS_ROOT`，绝对路径直接使用，相对路径相对当前 `cwd` 解析。
4. 只有 Goal ID、当前 Pi native session 和 `goal.json.host_command_invocations` 全部匹配时，观察器才自动登记 source、首次 scan 并确保 watcher 运行。
5. `.gp` 不存在、Goal Plus 未安装、证据不匹配或观察器失败时，Pi 主 Trace 继续正常采集，增强状态记为 `DEGRADED`。

旧的 `frameworks=goal-plus` 安装链接仍可使用，但会在服务端映射为 Pi Agent 安装，不再执行第二套 Goal Plus 安装。已有 `goal-plus-collector`、source registry 和 spool 保持兼容。自动登记对同一 canonical root 幂等；服务重启后 `ensure` 会恢复已有 source 的 watcher。

## 展示与状态

Goal Plus worker 的关系事件和 worker binding 到达后，链路追踪的“仅主 Agent”列表就会隐藏对应的独立 worker 行，不等待主 binding 或主 Trace 完成；因此运行过程中不会先把 worker 当成主记录展示、结束后再突然消失。切换到“仅子 Agent”或“主 Agent + 子 Agent”仍可独立查询 worker Trace。

主 binding、主 Trace 与某个 worker Trace 都可唯一解析后，打开 Pi 主 Trace 会在原生交互之后增加该 worker 对应的“Goal Plus 编排” `TASK → 子 Agent` 子树。每个 worker 独立进入详情：已经上报正文的 worker 会在主任务运行期间随页面刷新出现，尚未上报首批正文的 worker 保持等待，不会阻塞其他 worker。列表隐藏和详情合并采用两个阶段：前者只确认“这是 Goal Plus worker”，后者确认当前 worker 的完整、安全主从关系；缺主 Trace 时不会把 worker 错误挂入其他 Trace。

这个子树是只读查询投影：不会改写 Execution 的原生父子关系，也不会把 worker 内容复制回主 Session。关系证据只说明 worker 属于本次 Goal Plus 编排；没有精确调用位置时，不会按时间猜测它对应主 Trace 中的某个工具调用。

数据可能按以下顺序逐步出现：

1. Pi 识别结构化 Goal Plus start 后立即异步上传主 binding；
2. Goal Plus worker Trace、worker binding 和关系事件独立到达，已声明 worker 从默认主列表隐藏；
3. Pi 主 Trace 到达，或任务结束时对尚未送达的主 binding 再次重试；
4. 主端和任一 worker 两端完整解析后，查询层立即投影该 worker，不等待同组其他 worker 或主 Trace 执行结束。

因此新 worker 可能比主 Trace 晚数秒出现。关系上传采用本地持久 outbox：断网、429 或 5xx 会保留并重试；确定性 4xx（包括正文冲突）会进入 rejected，`self-check` 会报告异常，不会静默丢弃或无限重试。

## 诊断

高级排障仍可直接运行内置 collector：

```bash
node "$HOME/.agent-insight/collectors/goal-plus/goal-plus-collector.cjs" self-check
node "$HOME/.agent-insight/collectors/goal-plus/goal-plus-collector.cjs" status
```

重点检查：

- 执行真实 Goal Plus start 后，`activation.status` 为 `ACTIVE`、`sourceCount` 大于 0 且 watcher 为 running；未运行 Goal Plus 时 `DORMANT` 是正常状态；
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

卸载 Pi Agent 采集器时会停止由 Pi 管理的 Goal Plus watcher，并保留观察器包、source registry 和待上传 spool，避免丢失数据：

```bash
node "$HOME/.agent-insight/collectors/pi-agent/scripts/uninstall.cjs"
```

兼容的独立 Goal Plus 卸载脚本仍然保留；只有确认不再需要 pending 数据时才对它增加 `--purge-spool`。任何卸载或 purge 都不会修改 `.gp`。
